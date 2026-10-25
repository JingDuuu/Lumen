"""Atomic local Previs documents and collected, portable asset dependencies."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import threading
import time
import uuid
from urllib.parse import unquote, urlsplit
import zipfile

MAX_JSON_BYTES = 32 * 1024 * 1024
MAX_ASSET_BYTES = 200 * 1024 * 1024
MAX_PACKAGE_BYTES = 500 * 1024 * 1024
KINDS = {"scene", "template", "prefab"}
_LOCK = threading.RLock()
_ID = re.compile(r"^[a-f0-9]{32}$")


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def safe_relative(value):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value or "\x00" in value:
        raise ValueError("资产路径无效")
    path = PurePosixPath(unquote(value))
    if path.is_absolute() or any(part in {"..", "."} for part in path.parts):
        raise ValueError("资产路径不能离开当前文件包")
    return path


def contained_path(root, relative):
    target = Path(root).joinpath(*safe_relative(relative).parts).resolve()
    if not target.is_relative_to(Path(root).resolve()):
        raise ValueError("资产路径不能离开本地库")
    return target


def validate_id(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError("文件编号无效")
    return value


def scene_urls(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {"url", "uri", "src", "modelURI"} and isinstance(child, str) and child:
                yield child
            else:
                yield from scene_urls(child)
    elif isinstance(value, list):
        for child in value:
            yield from scene_urls(child)


def replace_urls(value, mapping):
    if isinstance(value, dict):
        return {key: mapping.get(child, child) if key in {"url", "uri", "src", "modelURI"} and isinstance(child, str)
                else replace_urls(child, mapping) for key, child in value.items()}
    if isinstance(value, list):
        return [replace_urls(child, mapping) for child in value]
    return value


class PrevisStore:
    def __init__(self, root):
        self.root = Path(root).resolve()

    def _document_path(self, document_id):
        return self.root / "documents" / (validate_id(document_id) + ".json")

    def asset_path(self, asset_id, relative):
        return contained_path(self.root / "assets" / validate_id(asset_id), relative)

    def resolve_asset(self, source):
        parts = urlsplit(source)
        if parts.scheme or parts.netloc or not parts.path.startswith("/api/previs/assets/"):
            raise ValueError("场景资产必须先导入本地 Previs 库；不能保存外链、任意文件路径或临时 blob URL")
        remainder = unquote(parts.path[len("/api/previs/assets/"):])
        asset_id, separator, relative = remainder.partition("/")
        if not separator:
            raise ValueError("资产 URL 缺少文件名")
        target = self.asset_path(asset_id, relative)
        if not target.is_file():
            raise ValueError("场景依赖的本地资产不存在：" + relative)
        return target

    def collect_assets(self, scene, document_id):
        collected = []
        folder = self.root / "assets" / document_id
        total_bytes = 0
        for source in dict.fromkeys(scene_urls(scene)):
            if source.startswith("data:"):
                if not re.match(r"^data:(image/[^;,]+|application/octet-stream);base64,", source):
                    raise ValueError("嵌入资产只支持 base64 图片或二进制数据")
                try:
                    data = base64.b64decode(source.split(",", 1)[1], validate=True)
                except (ValueError, base64.binascii.Error) as error:
                    raise ValueError("嵌入资产数据无效") from error
                if len(data) > MAX_ASSET_BYTES:
                    raise ValueError("单个资产超过 200 MB")
                continue  # Already portable, retained byte-for-byte in the JSON.
            target = self.resolve_asset(source)
            if target.stat().st_size > MAX_ASSET_BYTES:
                raise ValueError("单个资产超过 200 MB")
            files = [(target, target.name, source)]
            if target.suffix.lower() == ".gltf":
                gltf = json.loads(target.read_text(encoding="utf-8-sig"))
                for item in gltf.get("buffers", []) + gltf.get("images", []):
                    uri = item.get("uri")
                    if uri and not uri.startswith("data:"):
                        dependency = contained_path(target.parent, uri)
                        if not dependency.is_file():
                            raise ValueError("glTF 依赖缺失：" + uri)
                        files.append((dependency, safe_relative(uri).as_posix(), source.rsplit("/", 1)[0] + "/" + uri))
            files = list({entry[0]: entry for entry in files}.values())
            digests = []
            for file, relative, original in files:
                size = file.stat().st_size
                total_bytes += size
                if size > MAX_ASSET_BYTES or total_bytes > MAX_PACKAGE_BYTES or len(collected) + len(files) > 2048:
                    raise ValueError("场景依赖超过单文件 200 MB、合计 500 MB 或 2048 个文件的限制")
                with file.open("rb") as stream:
                    hasher = hashlib.sha256()
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        hasher.update(chunk)
                    digest = hasher.hexdigest()
                digests.append(digest)
            group = hashlib.sha256("".join(digests).encode()).hexdigest()[:24]
            for (file, relative, original), digest in zip(files, digests):
                name = group + "/" + relative
                destination = contained_path(folder, name)
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not destination.exists():
                    temporary = destination.with_suffix(destination.suffix + ".tmp")
                    shutil.copyfile(file, temporary)
                    os.replace(temporary, destination)
                collected.append({"source": original, "url": f"/api/previs/assets/{document_id}/{name}",
                                  "name": name, "sha256": digest, "size_bytes": file.stat().st_size})
        return collected

    def save(self, data):
        kind, name, scene = data.get("kind", "scene"), data.get("name", "未命名场景"), data.get("scene")
        if kind not in KINDS or not isinstance(name, str) or not name.strip() or len(name) > 160:
            raise ValueError("请输入有效文件类型和不超过 160 字的名称")
        if not isinstance(scene, dict) or scene.get("version") != 3 or not isinstance(scene.get("objects"), list):
            raise ValueError("须保存 version:3 且包含 objects 的场景 JSON")
        try:
            encoded = json.dumps(scene, ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (TypeError, ValueError) as error:
            raise ValueError("场景包含无效 JSON 数值") from error
        if len(encoded) > MAX_JSON_BYTES:
            raise ValueError("场景 JSON 超过 32 MB；请将模型作为本地资产导入")
        document_id = validate_id(data["id"]) if data.get("id") else uuid.uuid4().hex
        with _LOCK:
            path = self._document_path(document_id)
            previous = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            if data.get("id") and not previous:
                raise ValueError("原文件不存在；请另存为新文件")
            assets = self.collect_assets(scene, document_id)
            now = time.time()
            document = {"id": document_id, "name": name.strip(), "kind": kind, "scene": scene,
                        "assets": assets, "created_at": previous.get("created_at", now), "updated_at": now, "opened_at": now}
            atomic_json(path, document)
            return document

    def open(self, document_id, touch=True):
        with _LOCK:
            path = self._document_path(document_id)
            if not path.is_file():
                raise ValueError("场景文件不存在")
            document = json.loads(path.read_text(encoding="utf-8"))
            if touch:
                document["opened_at"] = time.time()
                atomic_json(path, document)
            # The exact v3 JSON stays in scene; resolved_scene is safe to render even
            # after the original import job assets have been moved outside this app.
            document["resolved_scene"] = replace_urls(document["scene"], {item["source"]: item["url"] for item in document.get("assets", [])})
            return document

    def list(self, kind=None, recent=False):
        if kind is not None and kind not in KINDS:
            raise ValueError("文件类型无效")
        rows = []
        with _LOCK:
            for path in (self.root / "documents").glob("*.json"):
                try:
                    document = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if kind and document.get("kind") != kind:
                    continue
                rows.append({key: document.get(key) for key in ("id", "name", "kind", "created_at", "updated_at", "opened_at")}
                            | {"object_count": len(document.get("scene", {}).get("objects", [])), "asset_count": len(document.get("assets", []))})
        rows.sort(key=lambda row: row.get("opened_at" if recent else "updated_at") or 0, reverse=True)
        return rows[:30 if recent else 1000]

    def delete(self, document_id):
        with _LOCK:
            path = self._document_path(document_id)
            if not path.exists():
                raise ValueError("文件不存在")
            path.unlink()  # Assets are content-addressed dependencies; other saved scenes may refer to them.

    def package(self, document_id):
        document = self.open(document_id, touch=False)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            mapping = {item["source"]: "assets/" + item["name"] for item in document["assets"]}
            portable = {key: document[key] for key in ("name", "kind", "scene")}
            portable["scene"] = replace_urls(document["scene"], mapping)
            archive.writestr("previs.json", json.dumps(portable, ensure_ascii=False, allow_nan=False))
            for asset in {item["name"]: item for item in document["assets"]}.values():
                archive.write(self.resolve_asset(asset["url"]), "assets/" + asset["name"])
        buffer.seek(0)
        return buffer

    def import_package(self, stream):
        asset_id = uuid.uuid4().hex
        with zipfile.ZipFile(stream) as archive:
            infos = archive.infolist()
            if len(infos) > 2048 or sum(info.file_size for info in infos) > MAX_PACKAGE_BYTES:
                raise ValueError("文件包超过 500 MB 或文件数量过多")
            for info in infos:
                safe_relative(info.filename.rstrip("/"))
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("文件包不能包含符号链接")
            if "previs.json" not in archive.namelist():
                raise ValueError("文件包缺少 previs.json")
            if archive.getinfo("previs.json").file_size > MAX_JSON_BYTES:
                raise ValueError("场景 JSON 超过 32 MB")
            data = json.loads(archive.read("previs.json"))
            if not isinstance(data, dict):
                raise ValueError("previs.json 须为场景文件对象")
            mapping = {}
            for info in infos:
                if info.is_dir() or not info.filename.startswith("assets/"):
                    continue
                destination = self.asset_path(asset_id, info.filename[len("assets/"):])
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as reader, destination.open("wb") as writer:
                    shutil.copyfileobj(reader, writer)
            for source in dict.fromkeys(scene_urls(data.get("scene", {}))):
                if source.startswith("data:"):
                    continue
                relative = safe_relative(source)
                if relative.parts[0] != "assets" or source not in archive.namelist():
                    raise ValueError("文件包资产缺失或引用了外部文件")
                name = "/".join(relative.parts[1:])
                mapping[source] = f"/api/previs/assets/{asset_id}/{name}"
            data["scene"] = replace_urls(data["scene"], mapping)
            data.pop("id", None)
            return self.save(data)
