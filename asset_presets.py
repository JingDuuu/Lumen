"""Named board-reference presets with collected local media and portable ZIPs."""
import copy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import struct
import threading
import tempfile
import time
import uuid
import zipfile

from flask import Blueprint, current_app, jsonify, request, send_file
import reference_inputs
from previs_store import atomic_json, contained_path, safe_relative, validate_id, scene_urls, replace_urls, PrevisStore

CATEGORIES = {"character":"角色", "scene":"场景", "action":"动作", "camera":"镜头", "style":"风格", "general":"自由素材"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv"}
PREVIS_EXTENSIONS = {".glb", ".gltf", ".bin", ".png", ".jpg", ".jpeg", ".webp", ".ktx2", ".bmp"}
MAX_JSON = 32 * 1024 * 1024
MAX_FILE = 200 * 1024 * 1024
MAX_TOTAL = 500 * 1024 * 1024
_LOCK = threading.RLock()


def digest(path):
    hasher = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def gltf_dependencies(path):
    """Inspect both glTF containers before a browser can resolve their URIs."""
    if path.suffix.lower() not in {".glb", ".gltf"}:
        return []
    if path.suffix.lower() == ".glb":
        with path.open('rb') as stream:
            header = stream.read(20)
            if len(header) != 20 or header[:4] != b'glTF' or struct.unpack('<I',header[4:8])[0] != 2 or header[16:20] != b'JSON':
                raise ValueError("预设中 GLB 文件头无效")
            length = struct.unpack('<I',header[12:16])[0]
            if length > MAX_JSON:
                raise ValueError("预设中 GLB JSON 过大")
            document = json.loads(stream.read(length))
    else:
        if path.stat().st_size > MAX_JSON:
            raise ValueError("预设中 glTF JSON 过大")
        document = json.loads(path.read_text(encoding='utf-8-sig'))
    if not isinstance(document,dict) or not isinstance(document.get('asset'),dict) or document['asset'].get('version') != '2.0':
        raise ValueError("预设需要有效 glTF 2.0 资产")
    dependencies = []
    for entry in document.get('buffers',[]) + document.get('images',[]):
        if not isinstance(entry,dict) or (entry.get('uri') is not None and not isinstance(entry['uri'],str)):
            raise ValueError("glTF 依赖条目无效")
        uri = entry.get('uri')
        if uri and not uri.startswith('data:'):
            relative = safe_relative(uri).as_posix()
            dependency = contained_path(path.parent, relative)
            if not dependency.is_file():
                raise ValueError("glTF 依赖缺失或不是安全的本地文件")
            dependencies.append((relative,dependency))
    return dependencies


def validate_payload(data):
    if not isinstance(data, dict):
        raise ValueError("预设内容须为 JSON 对象")
    if not isinstance(data.get("name"), str) or not 1 <= len(data["name"].strip()) <= 160:
        raise ValueError("请输入 1–160 字的预设名称")
    if data.get("category", "general") not in CATEGORIES:
        raise ValueError("预设类别无效")
    if not isinstance(data.get("description", ""), str) or len(data.get("description", "")) > 20000:
        raise ValueError("预设描述最多 20000 字")
    items = data.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        raise ValueError("预设须包含 1–100 张画板卡片")
    ids = set()
    for item in items:
        if not isinstance(item, dict) or item.get("kind") not in {"text", "image", "video"}:
            raise ValueError("预设包含无效卡片")
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id or len(item_id) > 200 or item_id in ids:
            raise ValueError("卡片 ID 须有效且不重复")
        ids.add(item_id)
        reference_inputs.validate_metadata(item)
        for key in ("x", "y", "w", "h"):
            if key in item and (not isinstance(item[key], (int, float)) or not math.isfinite(item[key])):
                raise ValueError("卡片位置和尺寸须为有限数字")
        if item["kind"] == "text":
            if item.get("role") not in {"char","scene","action","camera","audio","style","layout","storyboard","extra"} or not isinstance(item.get("content", ""), str) or len(item.get("content", "")) > 20000:
                raise ValueError("文字卡片用途或内容无效")
        else:
            name = item.get("file")
            if not isinstance(name, str) or not name:
                raise ValueError("媒体卡片缺少文件")
            safe_relative(name)
            allowed = IMAGE_EXTENSIONS if item["kind"] == "image" else VIDEO_EXTENSIONS
            if Path(name).suffix.lower() not in allowed:
                raise ValueError("预设媒体格式无效")
    connections = data.get("connections", [])
    if not isinstance(connections, list) or len(connections) > 1000:
        raise ValueError("预设最多保存 1000 条内部连线")
    edges = set()
    for edge in connections:
        if not isinstance(edge, dict) or not isinstance(edge.get("id"), str) or not edge["id"] or edge["id"] in edges or edge.get("from") not in ids or edge.get("to") not in ids or edge["from"] == edge["to"]:
            raise ValueError("预设只能保存选中卡片之间的有效连线")
        if not isinstance(edge.get("label", ""), str) or len(edge.get("label", "")) > 2000:
            raise ValueError("连线说明最多 2000 字")
        edges.add(edge["id"])
    reference_inputs.normalize_zones(data.get("zones", []))
    if not isinstance(data.get("params", {}), dict):
        raise ValueError("生成参数须为 JSON 对象")
    try:
        encoded = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValueError("预设含有无法保存的 JSON 数值") from error
    if len(encoded) > MAX_JSON:
        raise ValueError("预设 JSON 超过 32 MiB")


class AssetPresetStore:
    def __init__(self, root, input_dir, previs_root):
        self.root = Path(root).resolve()
        self.input_dir = Path(input_dir).resolve()
        self.previs_root = Path(previs_root).resolve()

    def folder(self, preset_id):
        return self.root / validate_id(preset_id)

    def read(self, preset_id):
        path = self.folder(preset_id) / "preset.json"
        if not path.is_file():
            raise ValueError("素材预设不存在")
        return json.loads(path.read_text(encoding="utf-8"))

    def asset_path(self, preset_id, relative):
        preset = self.read(preset_id)
        if relative not in {item["path"] for item in preset.get("assets", [])}:
            raise ValueError("此文件不属于该素材预设")
        path = contained_path(self.folder(preset_id), relative)
        if not path.is_file():
            raise ValueError("预设依赖文件缺失")
        return path

    def _copy(self, target, relative, source, asset_type, folder, assets):
        if any(item["source"] == source and item["type"] == asset_type for item in assets):
            return
        if asset_type == 'previs' and target.suffix.lower() not in PREVIS_EXTENSIONS:
            raise ValueError("预设布局仅收集 GLB/glTF、二进制和纹理文件")
        size = target.stat().st_size
        if size > MAX_FILE or size + sum(item["size_bytes"] for item in assets) > MAX_TOTAL or len(assets) >= 2048:
            raise ValueError("预设依赖超过单文件 200 MiB、总计 500 MiB 或 2048 个文件的限制")
        destination = contained_path(folder, relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            shutil.copyfile(target, destination)
        assets.append({"source":source,"type":asset_type,"path":relative,"sha256":digest(destination),"size_bytes":size})

    def save(self, data):
        validate_payload(data)
        preset_id = uuid.uuid4().hex
        folder = self.folder(preset_id)
        temporary = self.root / ("." + preset_id + ".tmp")
        with _LOCK:
            temporary.mkdir(parents=True)
            try:
                assets = []
                for item in data["items"]:
                    if item["kind"] != "text":
                        source = item["file"]
                        target = contained_path(self.input_dir, source)
                        if not target.is_file():
                            raise ValueError("媒体文件不存在，请重新上传：" + source)
                        self._copy(target, "media/" + digest(target) + target.suffix.lower(), source, "input", temporary, assets)
                    for source in dict.fromkeys(scene_urls(item.get("layout", {}))):
                        if source.startswith("data:"):
                            continue
                        target = PrevisStore(self.previs_root).resolve_asset(source)
                        group = hashlib.sha256(source.encode()).hexdigest()[:24]
                        self._copy(target, "previs/"+group+"/"+target.name, source, "previs", temporary, assets)
                        for uri,dependency in gltf_dependencies(target):
                            self._copy(dependency, "previs/"+group+"/"+uri, source.rsplit("/",1)[0]+"/"+uri, "previs", temporary, assets)
                now = time.time()
                preset = {"version":1,"id":preset_id,"name":data["name"].strip(),"category":data.get("category","general"),"description":data.get("description",""),
                          "items":copy.deepcopy(data["items"]),"connections":copy.deepcopy(data.get("connections",[])),"zones":copy.deepcopy(data.get("zones",[])),"params":copy.deepcopy(data.get("params",{})),
                          "assets":assets,"created_at":now,"updated_at":now}
                atomic_json(temporary/"preset.json", preset)
                os.replace(temporary, folder)
                return preset
            finally:
                if temporary.exists():
                    # This path is a freshly generated child of this preset library.
                    if temporary.resolve().parent != self.root:
                        raise RuntimeError("拒绝清理库外路径")
                    shutil.rmtree(temporary)

    def summary(self, preset):
        first = next((item for item in preset["items"] if item["kind"] in {"image","video"}), None)
        asset = next((asset for asset in preset["assets"] if first and asset["type"] == "input" and asset["source"] == first["file"]), None)
        return {key:preset[key] for key in ("id","name","category","description","created_at","updated_at")} | {
            "item_count":len(preset["items"]),"connection_count":len(preset["connections"]),"media_count":sum(item["kind"]!="text" for item in preset["items"]),
            "preview_kind":first["kind"] if first else None,"preview_url":f"/api/asset-presets/{preset['id']}/media/{asset['path']}" if asset else None}

    def list(self, q="", category=None):
        if category and category not in CATEGORIES:
            raise ValueError("预设类别无效")
        rows = []
        for path in self.root.glob("*/preset.json"):
            if path.parent.name.startswith("."):
                continue
            preset = json.loads(path.read_text(encoding="utf-8"))
            text = " ".join([preset["name"],preset["description"],*[str(item.get("content", ""))+str(item.get("notes", "")) for item in preset["items"]]])
            if (not category or preset["category"] == category) and q.casefold() in text.casefold():
                rows.append(self.summary(preset))
        rows.sort(key=lambda item:item["updated_at"], reverse=True)
        return rows[:1000]

    def update(self, preset_id, data):
        if not isinstance(data, dict) or set(data)-{"name","category","description"}:
            raise ValueError("仅可更新预设名称、类别与描述")
        with _LOCK:
            preset = self.read(preset_id)
            preset.update(data)
            validate_payload(preset)
            preset["name"] = preset["name"].strip()
            preset["updated_at"] = time.time()
            atomic_json(self.folder(preset_id)/"preset.json", preset)
            return preset

    def delete(self, preset_id):
        with _LOCK:
            folder = self.folder(preset_id)
            self.read(preset_id)
            # Removing this generated library entry never touches input files or boards.
            if folder.resolve().parent != self.root:
                raise ValueError("预设路径无效")
            shutil.rmtree(folder)

    def instantiate(self, preset_id):
        with _LOCK:
            preset = self.read(preset_id)
            replacements, models = {}, {}
            model_id = uuid.uuid4().hex
            for asset in preset["assets"]:
                source = self.asset_path(preset_id, asset["path"])
                if digest(source) != asset["sha256"]:
                    raise ValueError("预设依赖校验失败，请重新导入预设包")
                if asset["type"] == "input":
                    candidate = contained_path(self.input_dir, asset["source"])
                    if candidate.is_file() and digest(candidate) == asset["sha256"]:
                        replacements[asset["source"]] = asset["source"]
                        continue
                    name = "preset_" + uuid.uuid4().hex + source.suffix.lower()
                    self.input_dir.mkdir(parents=True, exist_ok=True)
                    temporary = self.input_dir/("."+name+".tmp")
                    try:
                        shutil.copyfile(source, temporary)
                        os.replace(temporary,self.input_dir/name)
                    finally:
                        temporary.unlink(missing_ok=True)
                    replacements[asset["source"]] = name
                else:
                    relative = asset["path"][len("previs/"):]
                    destination = contained_path(self.previs_root/"assets"/model_id, relative)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
                    models[asset["source"]] = f"/api/previs/assets/{model_id}/{relative}"
            item_ids = {item["id"]:"c"+uuid.uuid4().hex[:16] for item in preset["items"]}
            zone_ids = {zone["id"]:"z"+uuid.uuid4().hex[:16] for zone in preset["zones"]}
            items = copy.deepcopy(preset["items"])
            for item in items:
                item["id"] = item_ids[item["id"]]
                item["zone_id"] = zone_ids.get(item.get("zone_id"))
                if item["kind"] != "text":
                    item["file"] = replacements[item["file"]]
                if "layout" in item:
                    item["layout"] = replace_urls(item["layout"], models)
                item["preset_id"] = preset_id
                item["preset_name"] = preset["name"]
            connections = [{**copy.deepcopy(edge),"id":"e"+uuid.uuid4().hex[:16],"from":item_ids[edge["from"]],"to":item_ids[edge["to"]]} for edge in preset["connections"]]
            zones = [{**copy.deepcopy(zone),"id":zone_ids[zone["id"]]} for zone in preset["zones"]]
            return {"ok":True,"name":preset["name"],"category":preset["category"],"items":items,"connections":connections,"zones":zones,"params":copy.deepcopy(preset["params"])}

    def package(self, preset_id):
        preset = self.read(preset_id)
        output = io.BytesIO()
        with zipfile.ZipFile(output,"w",zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("asset-preset.json",json.dumps(preset,ensure_ascii=False,allow_nan=False))
            for asset in {asset["path"]:asset for asset in preset["assets"]}.values():
                archive.write(self.asset_path(preset_id,asset["path"]),asset["path"])
        output.seek(0)
        return output

    def import_package(self, stream):
        # Python 3.10's multipart SpooledTemporaryFile lacks seekable(), which
        # ZipFile's shared reader requires. Copy with an explicit size bound.
        with tempfile.TemporaryFile() as seekable:
            total = 0
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                total += len(block)
                if total > MAX_TOTAL + MAX_JSON:
                    raise ValueError("预设 ZIP 包超过 532 MiB")
                seekable.write(block)
            seekable.seek(0)
            return self._import_seekable(seekable)

    def _import_seekable(self, stream):
        preset_id = uuid.uuid4().hex
        folder = self.folder(preset_id)
        temporary = self.root/("."+preset_id+".tmp")
        with _LOCK:
            temporary.mkdir(parents=True)
            try:
                with zipfile.ZipFile(stream) as archive:
                    infos=archive.infolist()
                    if len(infos)>2049 or sum(entry.file_size for entry in infos)>MAX_TOTAL+MAX_JSON or len({entry.filename for entry in infos})!=len(infos):
                        raise ValueError("预设包过大或包含重复文件")
                    for entry in infos:
                        safe_relative(entry.filename.rstrip("/"))
                        if (entry.external_attr>>16)&0o170000==0o120000:
                            raise ValueError("预设包不允许符号链接")
                    if "asset-preset.json" not in archive.namelist() or archive.getinfo("asset-preset.json").file_size>MAX_JSON:
                        raise ValueError("预设包缺少有效的 asset-preset.json")
                    preset=json.loads(archive.read("asset-preset.json"))
                    validate_payload(preset)
                    assets=preset.get("assets")
                    if not isinstance(assets,list) or len(assets)>2048:
                        raise ValueError("预设依赖清单无效")
                    sources=set()
                    for asset in assets:
                        if not isinstance(asset,dict) or asset.get("type") not in {"input","previs"} or not isinstance(asset.get("source"),str):
                            raise ValueError("预设依赖条目无效")
                        relative=safe_relative(asset.get("path","")).as_posix()
                        expected_prefix = "media" if asset["type"] == "input" else "previs"
                        if relative.split('/')[0] != expected_prefix or relative not in archive.namelist() or archive.getinfo(relative).file_size>MAX_FILE:
                            raise ValueError("预设包素材缺失或超限")
                        if asset["type"]=="input":
                            safe_relative(asset["source"])
                            extension = Path(asset["source"]).suffix.lower()
                            if extension not in IMAGE_EXTENSIONS | VIDEO_EXTENSIONS or Path(relative).suffix.lower() != extension:
                                raise ValueError("预设包媒体扩展名无效")
                        elif not asset["source"].startswith('/api/previs/assets/'):
                            raise ValueError("预设不能引用外部模型URL")
                        elif Path(relative).suffix.lower() not in PREVIS_EXTENSIONS:
                            raise ValueError("预设布局资产类型无效")
                        source_key=(asset['type'],asset['source'])
                        if source_key in sources:raise ValueError("预设依赖重复")
                        sources.add(source_key)
                        target=contained_path(temporary,relative);target.parent.mkdir(parents=True,exist_ok=True)
                        with archive.open(relative) as reader,target.open('wb') as writer:shutil.copyfileobj(reader,writer)
                        if digest(target)!=asset.get('sha256'):raise ValueError("预设包素材校验失败")
                        asset['size_bytes']=target.stat().st_size
                    for asset in assets:
                        if asset['type'] == 'previs':
                            gltf_dependencies(contained_path(temporary, asset['path']))
                    for item in preset['items']:
                        if item['kind']!='text' and ('input',item['file']) not in sources:raise ValueError("预设包缺少媒体依赖")
                        for source in scene_urls(item.get('layout',{})):
                            if not source.startswith('data:') and ('previs',source) not in sources:raise ValueError("预设包缺少布局依赖")
                    now=time.time();preset.update(id=preset_id,version=1,created_at=now,updated_at=now)
                    atomic_json(temporary/'preset.json',preset);os.replace(temporary,folder)
                    return preset
            finally:
                if temporary.exists():
                    if temporary.resolve().parent!=self.root:raise RuntimeError("拒绝清理库外路径")
                    shutil.rmtree(temporary)


def create_blueprint(root_provider, input_provider, previs_provider):
    blueprint=Blueprint('asset_presets',__name__,url_prefix='/api/asset-presets')
    def store():
        return AssetPresetStore(current_app.config.get('ASSET_PRESETS_ROOT') or root_provider(),input_provider(),current_app.config.get('PREVIS_ROOT') or previs_provider())
    @blueprint.get('')
    def listing():return jsonify(ok=True,presets=store().list(request.args.get('q',''),request.args.get('category')))
    @blueprint.post('')
    def save():return jsonify(ok=True,preset=store().save(request.get_json()))
    @blueprint.get('/<preset_id>')
    def read(preset_id):return jsonify(ok=True,preset=store().read(preset_id))
    @blueprint.patch('/<preset_id>')
    def update(preset_id):return jsonify(ok=True,preset=store().update(preset_id,request.get_json()))
    @blueprint.delete('/<preset_id>')
    def delete(preset_id):store().delete(preset_id);return jsonify(ok=True)
    @blueprint.post('/<preset_id>/instantiate')
    def instantiate(preset_id):return jsonify(store().instantiate(preset_id))
    @blueprint.get('/<preset_id>/media/<path:relative>')
    def media(preset_id,relative):return send_file(store().asset_path(preset_id,relative),conditional=True)
    @blueprint.get('/<preset_id>/package')
    def package(preset_id):return send_file(store().package(preset_id),mimetype='application/zip',as_attachment=True,download_name='lumen-reference-'+validate_id(preset_id)[:8]+'.zip')
    @blueprint.post('/import')
    def import_package():
        if 'file' not in request.files:raise ValueError("请选择素材预设 ZIP 包")
        try:return jsonify(ok=True,preset=store().import_package(request.files['file'].stream))
        except zipfile.BadZipFile as error:raise ValueError("不是有效的素材预设 ZIP 包") from error
        finally:request.files['file'].close()
    return blueprint
