"""Blender worker, launched only by format_bridge with a controlled JSON job spec."""
import json
import math
import os
import struct
from pathlib import Path
import sys
import time
import traceback
import bpy

SPEC = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text(encoding="utf-8-sig"))
ROOT = Path(SPEC["workdir"]).resolve()
WARNINGS = []
LUMEN_METADATA = None


def write_json(name, data):
    target = ROOT / name
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    # Windows readers briefly deny replacement while progress is being polled.
    for attempt in range(30):
        try:
            os.replace(temporary, target)
            break
        except PermissionError:
            if attempt == 29:
                raise
            time.sleep(0.01)


def progress(stage, label, step=None, total=None):
    write_json("progress.json", {"stage": stage, "stage_label": label, "step": step, "total": total})


def import_file(path):
    extension = path.suffix.lower()
    progress("importing", "读取 " + extension[1:].upper() + " 场景")
    if extension in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=True, import_scene_extras=True)
    elif extension == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path), use_anim=True, use_image_search=False, anim_offset=0)
        WARNINGS.append("FBX 的约束、驱动、专用着色器不能一一映射；保留支持的层级、变换、网格、材质与烘焙动画。")
    elif extension == ".obj":
        bpy.ops.wm.obj_import(filepath=str(path))
        WARNINGS.append("OBJ 是静态几何格式，不携带父子层级、骨骼和动画；材质通过 MTL 尽量保留。")
    elif extension == ".abc":
        if not bpy.app.build_options.alembic:
            raise RuntimeError("本机 Blender 未包含 Alembic 支持")
        bpy.ops.wm.alembic_import(filepath=str(path), as_background_job=False, set_frame_range=True, always_add_cache_reader=True)
        WARNINGS.append("Alembic 不保留完整材质、骨骼或约束；几何与变换缓存会采样，稳定拓扑转为形态键。")
        if bpy.app.version < (5, 2, 0) and any(obj.type == "CAMERA" for obj in bpy.context.scene.objects):
            WARNINGS.append("本机 Blender 4.5 的纯 Alembic 导入只读取相机首帧焦距。请用 FBX 交换焦距动画，或同时导入 Lumen 提供的 .lumen.json 场景包以还原镜头轨道。")
    else:
        raise RuntimeError("不支持的输入格式")
    for image in list(bpy.data.images):
        if image.packed_file or image.source == "GENERATED" or not image.filepath:
            continue
        image_path = Path(bpy.path.abspath(image.filepath)).resolve()
        if not image_path.is_relative_to(ROOT):
            WARNINGS.append("忽略文件包之外的纹理：" + image.name)
            bpy.data.images.remove(image)


def action_end():
    ends = []
    for action in bpy.data.actions:
        ends.append(float(action.frame_range[1]))
    if ends:
        bpy.context.scene.frame_end = max(1, math.ceil(max(ends)))
    else:
        bpy.context.scene.frame_end = bpy.context.scene.frame_start


def apply_lumen_metadata(path, settings_only=False):
    global LUMEN_METADATA
    metadata = None
    if path.suffix.lower() not in {".glb", ".gltf"}:
        sidecar = path.with_suffix(path.suffix + ".lumen.json")
        if sidecar.is_file():
            metadata = json.loads(sidecar.read_text(encoding="utf-8")).get("lumenPrevis")
        data = {}
    elif path.suffix.lower() == ".glb":
        with path.open("rb") as stream:
            header = stream.read(20)
            data = json.loads(stream.read(struct.unpack("<I", header[12:16])[0]))
    else:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    metadata = metadata or data.get("extras", {}).get("lumenPrevis")
    if not metadata and data.get("scenes"):
        metadata = data["scenes"][data.get("scene", 0)].get("extras", {}).get("lumenPrevis")
    if not isinstance(metadata, dict):
        return
    LUMEN_METADATA = metadata
    fps = float(metadata.get("fps", SPEC.get("fps", 24)))
    if not math.isfinite(fps) or not 1 <= fps <= 60:
        raise RuntimeError("镜头附加数据的帧率须为 1–60")
    bpy.context.scene.render.fps = round(fps)
    if settings_only:
        return
    for camera in metadata.get("camera", [])[:64]:
        obj = bpy.data.objects.get(camera.get("node", ""))
        if obj is None or obj.type != "CAMERA":
            WARNINGS.append("找不到焦距轨道的相机节点：" + str(camera.get("node", "未命名")))
            continue
        if camera.get("sensorWidth") is not None:
            obj.data.sensor_width = max(1, min(100, float(camera["sensorWidth"])))
        for key in camera.get("keys", [])[:7201]:
            time_value, focal = float(key["time"]), float(key["focal"])
            if not all(math.isfinite(value) for value in (time_value, focal)) or not 0 <= time_value <= 300 or not 1 <= focal <= 5000:
                raise RuntimeError("镜头焦距关键帧数值超出范围")
            obj.data.lens = focal
            obj.data.keyframe_insert("lens", frame=1 + time_value * fps)
    WARNINGS.extend(str(message)[:2000] for message in metadata.get("warnings", [])[:30])
    if any(key not in {"version", "fps", "duration", "camera", "warnings", "limitations"} for key in metadata):
        WARNINGS.append("附加灯光/材质等自定义轨道保存在 lumenPrevis 数据中，当前桥只映射相机焦距；其他软件不会自动还原这些轨道。")


def retain_metadata(path):
    if LUMEN_METADATA is None:
        return
    if path.suffix.lower() not in {".glb", ".gltf"}:
        sidecar = path.with_suffix(path.suffix + ".lumen.json")
        sidecar.write_text(json.dumps({"lumenPrevis": LUMEN_METADATA}, ensure_ascii=False), encoding="utf-8")
        return
    if path.suffix.lower() == ".gltf":
        data = json.loads(path.read_text(encoding="utf-8"))
        data.setdefault("extras", {})["lumenPrevis"] = LUMEN_METADATA
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return
    raw = path.read_bytes()
    length = struct.unpack("<I", raw[12:16])[0]
    data = json.loads(raw[20:20+length])
    data.setdefault("extras", {})["lumenPrevis"] = LUMEN_METADATA
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    tail = raw[20+length:]
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, 20+len(encoded)+len(tail)) + struct.pack("<I4s",len(encoded),b"JSON") + encoded + tail)


def bake_alembic():
    scene = bpy.context.scene
    start, end = scene.frame_start, scene.frame_end
    total = end - start + 1
    sample_limit = min(120, max(2, int(SPEC.get("sample_frames", 60))))
    frames = list(range(start, end + 1)) if total <= sample_limit else sorted({round(start + index * (end - start) / (sample_limit - 1)) for index in range(sample_limit)})
    if len(frames) < total:
        WARNINGS.append(f"Alembic 共 {total} 帧，采样 {len(frames)} 帧并插值；高速或非线性变形可能有差异。")
    objects = list(scene.objects)
    transforms = {obj.name: [] for obj in objects}
    lenses = {obj.name: [] for obj in objects if obj.type == "CAMERA"}
    meshes = {obj.name: [] for obj in objects if obj.type == "MESH"}
    topology = {}
    invalid = set()
    budget = 3_000_000
    used = 0
    for index, frame in enumerate(frames):
        progress("sampling", "采样 Alembic 几何与变换", index + 1, len(frames))
        scene.frame_set(frame)
        depsgraph = bpy.context.evaluated_depsgraph_get()
        for obj in objects:
            evaluated = obj.evaluated_get(depsgraph)
            transforms[obj.name].append((frame, evaluated.matrix_world.copy()))
            if obj.name in lenses:
                lenses[obj.name].append(float(evaluated.data.lens))
            if obj.name not in meshes or obj.name in invalid:
                continue
            mesh = evaluated.to_mesh()
            signature = (len(mesh.vertices), tuple(tuple(poly.vertices) for poly in mesh.polygons))
            if obj.name not in topology:
                topology[obj.name] = signature
            if signature != topology[obj.name] or used + len(mesh.vertices) > budget:
                invalid.add(obj.name)
                meshes[obj.name] = []
                WARNINGS.append(obj.name + "：拓扑变化或缓存超出 300 万采样顶点预算，GLB 仅保留首帧几何；变换动画仍采样。")
            else:
                meshes[obj.name].append([vertex.co.copy() for vertex in mesh.vertices])
                used += len(mesh.vertices)
            evaluated.to_mesh_clear()
    scene.frame_set(start)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        if obj.type == "MESH":
            evaluated = obj.evaluated_get(depsgraph)
            obj.data = bpy.data.meshes.new_from_object(evaluated, depsgraph=depsgraph)
        obj.modifiers.clear()
        obj.constraints.clear()
        obj.animation_data_clear()
    # Assign parent-local transforms after caches are removed; preserve hierarchy.
    for frame_index, frame in enumerate(frames):
        scene.frame_set(frame)
        matrices = {obj.name: transforms[obj.name][frame_index][1] for obj in objects}
        for obj in objects:
            local = matrices[obj.parent.name].inverted_safe() @ matrices[obj.name] if obj.parent else matrices[obj.name]
            obj.matrix_parent_inverse.identity()
            obj.matrix_basis = local
            obj.rotation_mode = "QUATERNION"
            obj.keyframe_insert("location", frame=frame)
            obj.keyframe_insert("rotation_quaternion", frame=frame)
            obj.keyframe_insert("scale", frame=frame)
            if obj.name in lenses:
                obj.data.lens = lenses[obj.name][frame_index]
                obj.data.keyframe_insert("lens", frame=frame)
    for obj in objects:
        samples = meshes.get(obj.name)
        if not samples or len(samples) < 2:
            continue
        obj.shape_key_add(name="Basis")
        for sample_index in range(1, len(samples)):
            key = obj.shape_key_add(name="Cache_" + str(frames[sample_index]))
            for vertex, position in zip(key.data, samples[sample_index]):
                vertex.co = position
            for frame_index, frame in enumerate(frames):
                key.value = 1.0 if frame_index == sample_index else 0.0
                key.keyframe_insert("value", frame=frame)
    scene.frame_set(start)


def export_file(path):
    extension = path.suffix.lower()
    progress("exporting", "写入 " + extension[1:].upper())
    if extension in {".glb", ".gltf"}:
        bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB" if extension == ".glb" else "GLTF_SEPARATE", export_cameras=True, export_lights=True, export_animations=True, export_animation_mode="SCENE", export_force_sampling=True, export_frame_range=True, export_morph=True, export_morph_animation=True, export_extras=True, export_pointer_animation=True)
        if any(camera.animation_data for camera in bpy.data.cameras):
            WARNINGS.append("相机焦距动画使用 KHR_animation_pointer 扩展；接收软件须支持该扩展，Lumen 附加轨道同时保留。")
    elif extension == ".fbx":
        bpy.ops.export_scene.fbx(filepath=str(path), use_selection=False, add_leaf_bones=False, bake_anim=True, bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False, bake_anim_step=1, bake_anim_simplify_factor=0, path_mode="COPY", embed_textures=True)
        WARNINGS.append("FBX 输出会烘焙动画；PBR 材质、灯光与自定义扩展在其他软件中可能不同。形态键动画不保证跨软件一致。")
    elif extension == ".obj":
        texture_dir = path.parent / "textures"
        for index, image in enumerate(bpy.data.images):
            if image.packed_file and image.size[0] and image.size[1]:
                texture_dir.mkdir(parents=True, exist_ok=True)
                image.filepath_raw = str(texture_dir / f"texture-{index:03d}.png")
                image.file_format = "PNG"
                image.save()
                image.unpack(method="REMOVE")
        bpy.ops.wm.obj_export(filepath=str(path), export_animation=False, export_materials=True, path_mode="COPY")
        WARNINGS.append("OBJ 只导出当前首帧静态网格；不支持动画、骨骼、相机和父子层级。MTL/纹理随 ZIP 一起提供。")
    elif extension == ".abc":
        if not bpy.app.build_options.alembic:
            raise RuntimeError("本机 Blender 未包含 Alembic 支持")
        bpy.ops.wm.alembic_export(filepath=str(path), start=bpy.context.scene.frame_start, end=bpy.context.scene.frame_end, flatten=False, uvs=True, normals=True, face_sets=True, export_custom_properties=True, as_background_job=False)
        WARNINGS.append("Alembic 输出为几何/变换缓存；不保留可编辑骨骼、约束及完整材质。")


def main():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    source, output = Path(SPEC["source"]).resolve(), Path(SPEC["output"]).resolve()
    if not source.is_relative_to(ROOT) or not output.is_relative_to(ROOT):
        raise RuntimeError("转换文件必须在任务目录内")
    scene = bpy.context.scene
    scene.render.fps = int(SPEC.get("fps", 24))
    apply_lumen_metadata(source, settings_only=True)
    import_file(source)
    apply_lumen_metadata(source)
    if source.suffix.lower() == ".abc":
        bake_alembic()
    else:
        action_end()
    scene.frame_set(scene.frame_start)
    if scene.frame_end - scene.frame_start > 7200:
        raise RuntimeError("动画超过 7200 帧，请缩短片段")
    if not scene.objects:
        raise RuntimeError("文件中没有可导入对象")
    statistics = {"objects":len(scene.objects), "meshes":sum(obj.type=="MESH" for obj in scene.objects), "materials":len(bpy.data.materials), "actions":len(bpy.data.actions), "frame_start":scene.frame_start,"frame_end":scene.frame_end,"fps":scene.render.fps,
                  "hierarchy":[{"name":obj.name,"parent":obj.parent.name if obj.parent else None,"type":obj.type} for obj in scene.objects]}
    first_lenses = {obj.name: obj.data.lens for obj in scene.objects if obj.type == "CAMERA"}
    scene.frame_set(scene.frame_end)
    statistics["camera_lens"] = [{"node":obj.name,"start_mm":first_lenses[obj.name],"end_mm":obj.data.lens} for obj in scene.objects if obj.type == "CAMERA"]
    scene.frame_set(scene.frame_start)
    output.parent.mkdir(parents=True, exist_ok=True)
    export_file(output)
    retain_metadata(output)
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("转换没有产生有效文件")
    write_json("result.json", {"ok":True,"warnings":WARNINGS,"statistics":statistics,"blender_version":bpy.app.version_string})
    progress("complete", "转换完成")

try:
    main()
except Exception as error:
    write_json("result.json", {"ok":False,"error":str(error),"warnings":WARNINGS})
    traceback.print_exc()
    sys.exit(2)
