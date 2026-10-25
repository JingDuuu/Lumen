"""Bounded local Blender conversion jobs and Previs HTTP endpoints."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import tempfile
import time
import uuid
import zipfile

from flask import Blueprint, current_app, jsonify, request, send_file

from previs_store import PrevisStore, atomic_json, contained_path, safe_relative, validate_id, MAX_ASSET_BYTES, MAX_PACKAGE_BYTES

FORMATS = {"glb", "gltf", "obj", "fbx", "abc"}
_MANAGERS = {}
_MANAGERS_LOCK = threading.Lock()
_SCRIPT = Path(__file__).with_name("blender_bridge.py")


def blender_path():
    configured = os.environ.get("LUMEN_BLENDER")
    if configured:
        path = Path(configured).resolve()
        return path if path.is_file() and path.name.lower() in {"blender.exe", "blender"} else None
    roots = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Blender Foundation"
    candidates = list(roots.glob("Blender */blender.exe"))
    candidates.sort(key=lambda path: tuple(int(value) for value in re.findall(r"\d+", path.parent.name)), reverse=True)
    return candidates[0] if candidates else None


def inspect_gltf(path, folder):
    if path.suffix.lower() == ".glb":
        import struct
        with path.open("rb") as stream:
            header = stream.read(20)
            if len(header) != 20 or header[:4] != b"glTF" or struct.unpack("<I", header[4:8])[0] != 2 or header[16:20] != b"JSON":
                raise ValueError("GLB 文件头无效；不能用更改扩展名代替转换")
            length = struct.unpack("<I", header[12:16])[0]
            if length > 32 * 1024 * 1024:
                raise ValueError("GLB JSON 过大")
            data = json.loads(stream.read(length))
    else:
        if path.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("glTF JSON 过大")
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict) or not isinstance(data.get("asset"), dict) or data["asset"].get("version") != "2.0":
        raise ValueError("须提供有效 glTF 2.0 场景")
    for item in data.get("buffers", []) + data.get("images", []):
        if not isinstance(item, dict):
            raise ValueError("glTF 资产条目无效")
        uri = item.get("uri")
        if uri is not None and not isinstance(uri, str):
            raise ValueError("glTF 资产 URI 无效")
        if uri and not uri.startswith("data:"):
            target = contained_path(path.parent, uri)
            if not target.is_relative_to(folder.resolve()) or not target.is_file():
                raise ValueError("glTF 依赖缺失，请把 .gltf、.bin 和纹理一起打包为 ZIP")


def validate_obj_dependencies(path):
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("mtllib "):
            material = contained_path(path.parent, line[7:].strip())
            if not material.is_file():
                raise ValueError("OBJ 缺少 MTL，请把模型、MTL 和纹理一起打包为 ZIP")
            for mtl_line in material.read_text(encoding="utf-8", errors="replace").splitlines():
                if mtl_line.startswith(("map_", "bump ", "disp ", "decal ")):
                    # Options may precede the filename. Blender never gets an absolute/remote path.
                    value = mtl_line.split()[-1]
                    if not contained_path(material.parent, value).is_file():
                        raise ValueError("MTL 纹理缺失或路径不安全：" + value)


def receive_source(upload, folder, exporting=False):
    folder.mkdir(parents=True, exist_ok=True)
    extension = Path(upload.filename or "").suffix.lower()
    if extension != ".zip" and extension[1:] not in FORMATS:
        raise ValueError("支持 GLB、glTF、OBJ、FBX、Alembic 或含本地依赖的 ZIP")
    source = folder / ("upload" + extension)
    upload.save(source)
    if source.stat().st_size > MAX_ASSET_BYTES:
        raise ValueError("输入文件超过 200 MB")
    if extension == ".zip":
        extracted = folder / "source"
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            if len(infos) > 2048 or sum(info.file_size for info in infos) > MAX_PACKAGE_BYTES:
                raise ValueError("解压后超过 500 MB 或 2048 个文件")
            for info in infos:
                relative = safe_relative(info.filename.rstrip("/"))
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("文件包不允许符号链接")
                target = contained_path(extracted, relative.as_posix())
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as reader, target.open("wb") as writer:
                        shutil.copyfileobj(reader, writer)
        models = [path for path in extracted.rglob("*") if path.is_file() and path.suffix[1:].lower() in FORMATS]
        if len(models) != 1:
            raise ValueError("ZIP 中须有且仅有一个主模型文件")
        source = models[0]
    if exporting and source.suffix.lower() not in {".glb", ".gltf"}:
        raise ValueError("导出转换须提交已烘焙动画的 GLB/glTF")
    if source.suffix.lower() in {".glb", ".gltf"}:
        inspect_gltf(source, folder)
    if source.suffix.lower() == ".obj":
        validate_obj_dependencies(source)
    return source


class BridgeManager:
    def __init__(self, root, timeout=180):
        self.root = Path(root).resolve()
        self.timeout = timeout
        self.jobs = {}
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="previs-convert")
        self.stopped = False

    def submit(self, upload, direction, output_format="glb", fps=24, sample_frames=60):
        executable = blender_path()
        if not executable:
            raise ValueError("未找到本机 Blender，无法进行真实格式转换")
        if output_format not in FORMATS:
            raise ValueError("导出格式无效")
        if not 1 <= fps <= 60 or not 2 <= sample_frames <= 120:
            raise ValueError("帧率须为1–60，缓存采样数须为2–120")
        with self.lock:
            if self.stopped:
                raise RuntimeError("格式转换器正在关闭")
            if sum(job["status"] in {"queued", "running"} for job in self.jobs.values()) >= 4:
                raise RuntimeError("已有4项格式任务等待或转换中，请稍后再试")
            job_id = uuid.uuid4().hex
            folder = self.root / "jobs" / job_id
            source = receive_source(upload, folder, exporting=direction == "export")
            output = folder / "output" / ("model." + output_format)
            spec = dict(workdir=str(folder), source=str(source), output=str(output), fps=fps, sample_frames=sample_frames)
            atomic_json(folder / "spec.json", spec)
            job = {"id":job_id,"status":"queued","stage":"queued","stage_label":"等待本地格式转换", "progress":None,
                   "direction":direction,"source_format":source.suffix[1:].lower(),"format":output_format,"created_at":time.time(),"started_at":None,
                   "finished_at":None,"error":None,"warnings":[],"result":None,"cancel_requested":False,"process":None}
            self.jobs[job_id] = job
            self._persist(job)
            self.pool.submit(self._run, job_id, executable, folder, output)
            return self.public(job)

    def public(self, job):
        data = {key:value for key,value in job.items() if key not in {"process", "cancel_requested"}}
        data["elapsed_seconds"] = round((job.get("finished_at") or time.time()) - job["created_at"], 1)
        return data

    def _persist(self, job):
        atomic_json(self.root / "jobs" / job["id"] / "job.json", self.public(job))

    def get(self, job_id):
        validate_id(job_id)
        with self.lock:
            if job_id in self.jobs:
                return self.public(self.jobs[job_id])
        path = self.root / "jobs" / job_id / "job.json"
        if not path.is_file():
            raise ValueError("格式任务不存在")
        job = json.loads(path.read_text(encoding="utf-8"))
        if job["status"] in {"queued", "running"}:
            job.update(status="interrupted",stage="interrupted",stage_label="应用关闭导致转换中断",error="请重新提交转换；原文件仍保留")
        return job

    def cancel(self, job_id):
        with self.lock:
            job = self.jobs.get(validate_id(job_id))
            if job is None:
                return self.get(job_id)
            if job["status"] in {"queued", "running"}:
                job["cancel_requested"] = True
                process = job["process"]
                if process and process.poll() is None:
                    process.terminate()
            return self.public(job)

    def _run(self, job_id, executable, folder, output):
        job = self.jobs[job_id]
        try:
            with self.lock:
                if job["cancel_requested"]:
                    job.update(status="cancelled",stage="cancelled",stage_label="已取消")
                    return
                job.update(status="running",stage="starting",stage_label="启动本地 Blender",started_at=time.time())
                self._persist(job)
            command = [str(executable), "--background", "--factory-startup", "--disable-autoexec", "--threads", "2", "--python-exit-code", "2", "--python", str(_SCRIPT), "--", str(folder / "spec.json")]
            with (folder / "blender.log").open("wb") as log:
                process = subprocess.Popen(command, cwd=str(folder), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, shell=False,
                                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                job["process"] = process
                while process.poll() is None:
                    if job["cancel_requested"] or self.stopped:
                        process.terminate()
                        try:
                            process.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            process.kill()
                        break
                    if time.time() - job["started_at"] > self.timeout:
                        process.kill()
                        process.wait(timeout=5)
                        raise RuntimeError(f"转换超过 {self.timeout} 秒，已停止；请减少模型规模或动画长度")
                    progress_path = folder / "progress.json"
                    if progress_path.is_file():
                        try:
                            progress = json.loads(progress_path.read_text(encoding="utf-8"))
                            job.update(stage=progress["stage"],stage_label=progress["stage_label"],progress={"step":progress.get("step"),"total":progress.get("total")})
                        except (OSError, json.JSONDecodeError):
                            pass  # Atomic replace may briefly be busy on Windows.
                    time.sleep(0.1)
                process.wait(timeout=5)
            if job["cancel_requested"] or self.stopped:
                job.update(status="cancelled",stage="cancelled",stage_label="已取消")
                return
            result_path = folder / "result.json"
            result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.is_file() else {}
            if process.returncode or not result.get("ok"):
                detail = result.get("error") or (folder / "blender.log").read_text(encoding="utf-8", errors="replace")[-1800:]
                raise RuntimeError("Blender 转换失败：" + detail)
            asset_folder = self.root / "assets" / job_id
            shutil.copytree(output.parent, asset_folder)
            files = []
            for path in asset_folder.rglob("*"):
                if path.is_file():
                    relative = path.relative_to(asset_folder).as_posix()
                    files.append({"name":relative,"url":f"/api/previs/assets/{job_id}/{relative}","size_bytes":path.stat().st_size})
            primary_url = f"/api/previs/assets/{job_id}/{output.name}"
            download_url = primary_url
            if output.suffix in {".gltf", ".obj"} or len(files) > 1:
                archive_path = asset_folder / "model-package.zip"
                with zipfile.ZipFile(archive_path,"w",zipfile.ZIP_DEFLATED) as archive:
                    for file in files:
                        archive.write(asset_folder / file["name"], file["name"])
                download_url = f"/api/previs/assets/{job_id}/{archive_path.name}"
            job.update(status="done",stage="complete",stage_label="转换完成",warnings=result.get("warnings",[]),
                       result={"url":primary_url,"file":output.name,"download_url":download_url,"asset_id":job_id,"sourceFormat":job["source_format"],"format":job["format"],"files":files,"statistics":result.get("statistics",{}),"blender_version":result.get("blender_version")})
        except Exception as error:
            job.update(status="failed",stage="failed",stage_label="转换失败",error=str(error))
        finally:
            job["finished_at"] = time.time()
            job["process"] = None
            self._persist(job)

    def shutdown(self):
        self.stopped = True
        with self.lock:
            for job in self.jobs.values():
                if job["status"] in {"queued", "running"}:
                    job["cancel_requested"] = True
                    process = job["process"]
                    if process and process.poll() is None:
                        process.terminate()
        self.pool.shutdown(wait=True, cancel_futures=False)


def manager_for(root):
    key = str(Path(root).resolve())
    with _MANAGERS_LOCK:
        if key not in _MANAGERS or _MANAGERS[key].stopped:
            _MANAGERS[key] = BridgeManager(key)
        return _MANAGERS[key]


def shutdown_jobs():
    with _MANAGERS_LOCK:
        managers = list(_MANAGERS.values())
    for manager in managers:
        manager.shutdown()


def create_blueprint(root_provider):
    blueprint = Blueprint("previs", __name__, url_prefix="/api/previs")
    def store():
        return PrevisStore(current_app.config.get("PREVIS_ROOT") or root_provider())
    def manager():
        return manager_for(store().root)
    @blueprint.get("/capabilities")
    def capabilities():
        executable = blender_path()
        return jsonify(ok=True,blender_available=bool(executable),blender_path=str(executable) if executable else None,
                       formats=sorted(FORMATS),max_upload_bytes=MAX_ASSET_BYTES,max_pending_jobs=4,workers=1,
                       alembic="verified Blender 4.5.1 supports sampling; runtime build checked on conversion",max_scene_json_bytes=32*1024*1024,
                       limitations={"obj":"仅静态网格，无动画/骨骼/父子层级", "abc":"几何/变换缓存；材质不完整，稳定拓扑采样为形态键，变化拓扑明确警告并保留首帧", "fbx":"烘焙动画；专用材质/约束不能无损映射"})
    @blueprint.get("/documents")
    def list_documents():
        return jsonify(ok=True,documents=store().list(request.args.get("kind")))
    @blueprint.get("/recent")
    def recent():
        return jsonify(ok=True,documents=store().list(recent=True))
    @blueprint.post("/documents")
    def save_document():
        data = request.get_json()
        if not isinstance(data,dict):
            raise ValueError("须提交文件 JSON")
        return jsonify(ok=True,document=store().save(data))
    @blueprint.get("/documents/<document_id>")
    def open_document(document_id):
        return jsonify(ok=True,document=store().open(document_id))
    @blueprint.delete("/documents/<document_id>")
    def delete_document(document_id):
        store().delete(document_id)
        return jsonify(ok=True)
    @blueprint.get("/documents/<document_id>/package")
    def package(document_id):
        return send_file(store().package(document_id),mimetype="application/zip",as_attachment=True,download_name="lumen-previs-"+validate_id(document_id)[:8]+".zip")
    @blueprint.post("/documents/import")
    def import_document():
        if "file" not in request.files:
            raise ValueError("请选择场景文件包")
        try:
            # Python 3.10's multipart SpooledTemporaryFile lacks seekable(), which
            # ZipFile's member reader needs. Copy to a real seekable temp file.
            with tempfile.TemporaryFile() as package:
                request.files["file"].save(package)
                package.seek(0)
                document = store().import_package(package)
        except zipfile.BadZipFile as error:
            raise ValueError("场景文件包不是有效 ZIP") from error
        return jsonify(ok=True,document=document)
    @blueprint.get("/assets/<asset_id>/<path:relative>")
    def asset(asset_id,relative):
        path = store().asset_path(asset_id,relative)
        if not path.is_file():
            raise ValueError("本地资产不存在")
        return send_file(path,conditional=True,as_attachment=request.args.get("download")=="1")
    @blueprint.post("/import")
    @blueprint.post("/export")
    def convert():
        if "file" not in request.files:
            raise ValueError("请选择要转换的文件")
        direction = "export" if request.path.endswith("/export") else "import"
        try:
            job = manager().submit(request.files["file"],direction,request.form.get("format","glb") if direction=="export" else "glb",int(request.form.get("fps",24)),int(request.form.get("sample_frames",60)))
        except zipfile.BadZipFile as error:
            raise ValueError("模型文件包不是有效 ZIP") from error
        finally:
            request.files["file"].close()
        return jsonify(ok=True,job=job),202
    @blueprint.get("/jobs/<job_id>")
    def job_status(job_id):
        return jsonify(ok=True,job=manager().get(job_id))
    @blueprint.post("/jobs/<job_id>/cancel")
    def cancel_job(job_id):
        return jsonify(ok=True,job=manager().cancel(job_id))
    return blueprint
