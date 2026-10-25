"""Isolated local UI acceptance server; never starts the generation engine."""
import json
from pathlib import Path
import sys
import tempfile
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as backend
import lumen_core as core
from werkzeug.serving import make_server, WSGIRequestHandler
from PIL import Image


class QuietHandler(WSGIRequestHandler):
    def log(self, *args, **kwargs):
        pass


def main():
    with tempfile.TemporaryDirectory(prefix="lumen-ui-") as folder:
        root = Path(folder)
        for directory in ("library/thumbs", "input", "output/video"):
            (root / directory).mkdir(parents=True)
        for name, relative in {
            "LIB_DIR": "library", "THUMB_DIR": "library/thumbs",
            "RECORDS_FILE": "library/records.json", "MEMORY_FILE": "memory.json",
            "PRESETS_FILE": "presets.json", "INPUT_DIR": "input", "OUTPUT_DIR": "output",
        }.items():
            setattr(core, name, str(root / relative))
        backend.BOARD_FILE = str(root / "library/board-default.json")
        backend.app.config["PREVIS_ROOT"] = str(root / "library/previs")
        core.comfyui_running = lambda: False
        core.model_status = lambda: {
            "fl2va": {"name": core.MODEL_UNET, "available": True},
            "ref2va": {"name": core.MODEL_REF, "available": True},
        }
        backend.gpu_usage = lambda: None
        def forbid_engine(*args, **kwargs):
            raise AssertionError("UI acceptance must not start or submit to the model")
        core.start_comfyui = forbid_engine
        core.comfy_post = forbid_engine
        backend.start_services = forbid_engine
        # Board/Previs tests represent a configured editor regardless of the host's
        # actual model files. The dedicated onboarding test supplies missing models.
        manifest = backend.model_manager.MANIFEST
        backend.model_manager.installer.inventory = lambda: {
            **manifest, "models": [dict(model, present=True, partial_bytes=0)
                                   for model in manifest["models"]],
            "models_dir": str(root / "models"), "free_bytes": 200 * 1024**3,
            "engine_installed": True, "paths": {}, "job": {"stage": "idle", "active": False},
        }
        backend.model_manager.installer.start = forbid_engine
        Image.new("RGB", (320, 180), (56, 75, 85)).save(root / "input/fixture.png")
        board = {
            "items": [
                dict(id="scene-a", kind="text", role="scene", content="海边灯塔，夕阳映在海面", x=40, y=40, w=320, h=220),
                dict(id="camera-b", kind="text", role="camera", content="镜头缓慢推进", x=440, y=40, w=320, h=220),
                dict(id="image-c", kind="image", role="reference", file="fixture.png", x=440, y=350, w=320, h=260),
            ],
            "connections": [], "viewport": dict(zoom=0.9, panX=12, panY=12),
            "params": dict(resolution="608,352", duration=2, steps=8, seed=0),
        }
        Path(backend.BOARD_FILE).write_text(json.dumps(board, ensure_ascii=False), encoding="utf-8")
        server = make_server("127.0.0.1", 0, backend.app, threaded=True, request_handler=QuietHandler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        print(f"http://127.0.0.1:{server.server_port}", flush=True)
        try:
            sys.stdin.readline()
        finally:
            backend.format_bridge.shutdown_jobs()
            server.shutdown()
            server.server_close()
            worker.join(timeout=3)


if __name__ == "__main__":
    main()
