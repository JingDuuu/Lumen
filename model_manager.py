"""Explicit, resumable installation of pinned H3 artifacts. No startup network calls."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import threading
import time
from contextlib import contextmanager

if os.name == "nt":
    import msvcrt
else:
    import fcntl

import requests
from flask import Blueprint, jsonify, request

from runtime_config import CONFIG, APP_ROOT

MANIFEST = json.loads((APP_ROOT / "models-manifest.json").read_text(encoding="utf-8"))
MODELS = {model["id"]: model for model in MANIFEST["models"]}
COMMON = ["text_encoder", "video_vae", "audio_vae"]


class Cancelled(Exception):
    pass


@contextmanager
def installation_lock(models_dir):
    """OS releases the lock after a crash; CLI and desktop cannot append together."""
    models_dir.mkdir(parents=True, exist_ok=True)
    with (models_dir / ".lumen-install.lock").open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError("另一个 Lumen/命令行安装器正在使用此模型目录，请先暂停它。") from error
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


class ModelInstaller:
    def __init__(self, models_dir=CONFIG.models_dir, data_dir=CONFIG.data_dir, manifest=MANIFEST):
        self.models_dir = Path(models_dir).resolve()
        self.data_dir = Path(data_dir).resolve()
        self.manifest = manifest
        self.models = {model["id"]: model for model in manifest["models"]}
        self.lock = threading.RLock()
        self.cancel_event = threading.Event()
        self.worker = None
        self.job = {"stage": "idle", "active": False}

    def destination(self, model):
        path = (self.models_dir / model["path"]).resolve()
        if not path.is_relative_to(self.models_dir):
            raise ValueError("模型路径超出 models 目录")
        return path

    def inventory(self):
        entries = []
        for model in self.models.values():
            destination = self.destination(model)
            partial = destination.with_suffix(destination.suffix + ".part")
            size = destination.stat().st_size if destination.is_file() else 0
            entries.append(dict(model, present=size == model["size"], existing_bytes=size,
                                partial_bytes=partial.stat().st_size if partial.is_file() else 0))
        ancestor = self.models_dir
        while not ancestor.exists():
            ancestor = ancestor.parent
        with self.lock:
            job = dict(self.job)
        return {"models": entries, "job": job, "models_dir": str(self.models_dir),
                "free_bytes": shutil.disk_usage(ancestor).free,
                "repository": self.manifest["repository"], "revision": self.manifest["revision"],
                "license_name": self.manifest["license_name"], "license_url": self.manifest["license_url"],
                "engine_installed": (CONFIG.comfy_dir / "main.py").is_file() and CONFIG.engine_python.is_file(),
                "paths": CONFIG.as_dict()}

    def update(self, **values):
        with self.lock:
            self.job.update(values, updated_at=time.time())

    def check_cancelled(self):
        if self.cancel_event.is_set():
            raise Cancelled("已暂停，下载片段保留；再次安装会续传。")

    def start(self, ids):
        if not isinstance(ids, list) or not ids or any(not isinstance(value, str) or value not in self.models for value in ids):
            raise ValueError("请选择有效的模型文件")
        ids = list(dict.fromkeys(ids))
        with self.lock:
            if self.worker and self.worker.is_alive():
                raise RuntimeError("已有模型安装在进行")
            missing = 0
            for model_id in ids:
                model = self.models[model_id]
                destination = self.destination(model)
                partial = destination.with_suffix(destination.suffix + ".part")
                if not destination.exists():
                    missing += max(0, model["size"] - (partial.stat().st_size if partial.is_file() else 0))
            if self.inventory()["free_bytes"] < missing + 1024 ** 3:
                raise ValueError(f"磁盘空间不足：还需约 {missing / 1024**3:.1f} GiB，另预留 1 GiB。")
            self.cancel_event.clear()
            self.job = {"active": True, "stage": "starting", "models": ids, "completed": 0,
                        "total": len(ids), "error": None, "updated_at": time.time()}
            self.worker = threading.Thread(target=self.run, args=(ids,), name="lumen-model-install", daemon=True)
            self.worker.start()
        return self.inventory()

    def cancel(self):
        self.cancel_event.set()
        self.update(stage="cancelling" if self.job.get("active") else self.job["stage"])
        return self.inventory()

    def verify(self, path, model):
        digest = hashlib.sha256()
        count = 0
        self.update(stage="verifying", downloaded_bytes=model["size"], verified_bytes=0, bytes_per_second=0, eta_seconds=None)
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                self.check_cancelled()
                digest.update(chunk)
                count += len(chunk)
                self.update(verified_bytes=count)
        if count != model["size"] or digest.hexdigest() != model["sha256"]:
            raise ValueError(f"{path.name} 的大小或 SHA-256 不匹配，文件已保留，未覆盖已有模型。")

    def download(self, model):
        destination = self.destination(model)
        destination.parent.mkdir(parents=True, exist_ok=True)
        self.update(model_id=model["id"], label=model["label"], expected_bytes=model["size"], downloaded_bytes=0)
        if destination.exists():
            self.verify(destination, model)
            return
        partial = destination.with_suffix(destination.suffix + ".part")
        if partial.exists() and partial.stat().st_size > model["size"]:
            raise ValueError("续传文件超出官方大小，已保留，请先检查该 .part 文件")
        url = f"https://huggingface.co/{self.manifest['repository']}/resolve/{self.manifest['revision']}/{model['path']}"
        # Sequential ranges retain one partial file: no second 20 GB merge copy.
        for attempt in range(4):
            self.check_cancelled()
            offset = partial.stat().st_size if partial.exists() else 0
            if offset == model["size"]:
                break
            self.update(stage="downloading", downloaded_bytes=offset, eta_seconds=None)
            started, received = time.monotonic(), offset
            try:
                with requests.get(url, headers={"Range": f"bytes={offset}-", "Accept-Encoding": "identity"}, stream=True, timeout=(15, 15)) as response:
                    response.raise_for_status()
                    if response.status_code == 206:
                        expected = f"bytes {offset}-{model['size']-1}/{model['size']}"
                        if response.headers.get("Content-Range") != expected:
                            raise ValueError("下载服务器返回的范围与固定模型大小不符")
                    elif response.status_code != 200 or offset:
                        raise ValueError("下载服务器不支持本次续传，已有片段已保留")
                    with partial.open("ab") as stream:
                        for chunk in response.iter_content(1024 * 1024):
                            self.check_cancelled()
                            if received + len(chunk) > model["size"]:
                                raise ValueError("下载响应超出固定模型大小")
                            stream.write(chunk)
                            received += len(chunk)
                            speed = (received - offset) / max(.01, time.monotonic() - started)
                            self.update(downloaded_bytes=received, bytes_per_second=round(speed),
                                        eta_seconds=round((model["size"]-received)/speed) if speed else None)
                if received != model["size"]:
                    raise requests.ConnectionError("下载提前中断")
                break
            except requests.RequestException:
                if attempt == 3:
                    raise RuntimeError("下载连接中断；已有片段保留，请稍后继续安装。")
                self.update(stage="retrying")
                if self.cancel_event.wait(min(8, attempt + 2)):
                    self.check_cancelled()
        self.verify(partial, model)
        self.check_cancelled()
        if destination.exists():
            raise RuntimeError("目标文件在下载期间已出现，未覆盖，请重新校验。")
        os.replace(partial, destination)

    def run(self, ids):
        try:
            with installation_lock(self.models_dir):
                for index, model_id in enumerate(ids):
                    self.check_cancelled()
                    self.download(self.models[model_id])
                    self.update(completed=index + 1)
            self.update(stage="ready", active=False, error=None)
        except Cancelled as error:
            self.update(stage="cancelled", active=False, error=str(error))
        except (OSError, ValueError, RuntimeError) as error:
            self.update(stage="failed", active=False, error=str(error))


installer = ModelInstaller()


def create_blueprint(manager=installer):
    blueprint = Blueprint("models", __name__, url_prefix="/api/models")

    @blueprint.get("")
    def inventory():
        return jsonify(manager.inventory())

    @blueprint.post("/install")
    def install():
        data = request.get_json()
        if not isinstance(data, dict) or data.get("accept_license") is not True:
            raise ValueError("请先阅读并确认模型许可，再主动开始下载")
        return jsonify(manager.start(data.get("models")))

    @blueprint.post("/cancel")
    def cancel():
        return jsonify(manager.cancel())

    return blueprint


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["list", "install"])
    parser.add_argument("pack", choices=["fl2va", "ref2va", "all"], nargs="?", default="all")
    parser.add_argument("--accept-license", action="store_true")
    args = parser.parse_args()
    if args.action == "list":
        print(json.dumps(installer.inventory(), ensure_ascii=False, indent=2))
        return
    if not args.accept_license:
        parser.error("阅读 " + MANIFEST["license_url"] + " 后，使用 --accept-license 主动授权下载")
    ids = list(MODELS) if args.pack == "all" else [args.pack] + COMMON
    installer.start(ids)
    try:
        while installer.worker.is_alive():
            print(json.dumps(installer.inventory()["job"], ensure_ascii=False), flush=True)
            installer.worker.join(2)
    except KeyboardInterrupt:
        installer.cancel()
        installer.worker.join(20)
    if installer.job["stage"] != "ready":
        raise SystemExit(installer.job.get("error") or "安装未完成；已保存续传片段")


if __name__ == "__main__":
    main()
