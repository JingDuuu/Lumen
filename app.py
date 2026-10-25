# -*- coding: utf-8 -*-
"""
Lumen · 流光 —— Web 控制台后端 (Flask)
=====================================
路由全部调用 lumen_core 的业务函数；本文件只做 HTTP 层。
开发/维护请先阅读同目录 README.md。
"""
import json
import mimetypes
import os
import subprocess
import shutil
import uuid
import threading
import time
from urllib.parse import urlparse

from flask import Flask, request, jsonify, send_from_directory, render_template, abort

import lumen_core as core
import tasks
import engine_runtime
import format_bridge
import previs_render
import asset_presets
import agent_api
import model_manager

mimetypes.add_type("image/svg+xml", ".svg")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024
app.register_blueprint(format_bridge.create_blueprint(lambda: os.path.join(core.LIB_DIR, "previs")))
app.register_blueprint(previs_render.create_blueprint(lambda: core.INPUT_DIR))
BOARD_FILE = os.path.join(core.LIB_DIR, "board-default.json")
_BOARD_LOCK = threading.Lock()
app.register_blueprint(asset_presets.create_blueprint(
    lambda: os.path.join(core.LIB_DIR, "asset-presets"), lambda: core.INPUT_DIR,
    lambda: os.path.join(core.LIB_DIR, "previs")))
app.register_blueprint(agent_api.create_blueprint(board_path=lambda: BOARD_FILE, board_lock=_BOARD_LOCK))
app.register_blueprint(model_manager.create_blueprint())
_GPU_CACHE = {"at": 0, "value": None}


def gpu_usage():
    if time.time() - _GPU_CACHE["at"] < 5:
        return _GPU_CACHE["value"]
    try:
        executable = shutil.which("nvidia-smi") or os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe")
        result = subprocess.run([executable,
                                 "--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
                                capture_output=True, text=True, timeout=3, creationflags=subprocess.CREATE_NO_WINDOW, check=True)
        name, used, total, utilization = result.stdout.splitlines()[0].split(",")
        value = dict(name=name.strip(), vram_used_gb=round(float(used)/1024, 2), vram_total_gb=round(float(total)/1024, 1), utilization=int(utilization), source="nvidia-smi")
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        value = None
    _GPU_CACHE.update(at=time.time(), value=value)
    return value


def start_services():
    tasks.manager.start()


def stop_services():
    model_manager.installer.cancel()
    format_bridge.shutdown_jobs()
    tasks.manager.stop()
    tasks.manager.interrupt_records()


def json_object():
    data = request.get_json()
    if not isinstance(data, dict):
        raise ValueError("请求内容须为JSON对象")
    return data


@app.before_request
def local_requests_only():
    if request.host.split(":")[0] not in {"127.0.0.1", "localhost"}:
        abort(403)
    if request.method in {"POST", "PUT", "DELETE", "PATCH"}:
        origin = request.headers.get("Origin")
        if origin and urlparse(origin).netloc != request.host:
            abort(403)


@app.errorhandler(ValueError)
def bad_value(error):
    return jsonify(ok=False, error=str(error)), 400


@app.errorhandler(RuntimeError)
def runtime_error(error):
    return jsonify(ok=False, error=str(error)), 409


@app.errorhandler(OSError)
def io_error(error):
    return jsonify(ok=False, error="本地服务或文件暂不可用：" + str(error)), 503


# ================================================================ 页面
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/favicon.svg")
def favicon():
    return send_from_directory(os.path.join(core.CORE_DIR, "static"), "favicon.svg")


# ================================================================ 系统与引擎
@app.route("/api/system")
def api_system():
    running = core.comfyui_running()
    info = {"comfyui_running": running, "version": "4.1.0", "desktop": bool(app.config.get("DESKTOP_CLOSE")),
            "model": "MiniMax H3 · FL2VA / Ref2VA INT8", "capabilities": tasks.CAPABILITIES, "models": core.model_status(),
            "progress_connected": tasks.manager.ready.is_set(), "engine": engine_runtime.state()}
    if running:
        try:
            s = core.comfy_get("/system_stats", timeout=5)
            dev = s.get("devices", [{}])[0]
            info["gpu"] = {
                "name": dev.get("name", ""),
                "vram_used_gb": round((dev.get("vram_total", 0) - dev.get("vram_free", 0)) / 1024**3, 2),
                "vram_total_gb": round(dev.get("vram_total", 0) / 1024**3, 1),
            }
        except Exception:
            pass
    physical_gpu = gpu_usage()
    if physical_gpu:
        info["gpu"] = physical_gpu
    return jsonify(info)


@app.route("/api/comfyui/start", methods=["POST"])
def api_start():
    core.start_comfyui()
    return jsonify({"ok": True})


@app.route("/api/comfyui/stop", methods=["POST"])
def api_stop():
    core.stop_comfyui()
    tasks.manager.interrupt_records()
    return jsonify({"ok": True})


# ================================================================ 上传
@app.route("/api/upload", methods=["POST"])
def api_upload():
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "缺少文件"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"ok": False, "error": "空文件名"}), 400
    try:
        name = core.save_upload(f, f.filename)
    except ValueError:
        raise
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "name": name})


@app.route("/input/<path:name>")
def serve_input(name):
    try:
        core.serve_input(name)
    except ValueError:
        abort(403)
    return send_from_directory(core.INPUT_DIR, name)


# ================================================================ 生成
def _parse_generate_payload():
    """兼容两种提交方式：
    1) 画板模式：JSON {items:[...], params:{...}}
    2) 传统表单：multipart form 字段 + sketch/layout 文件
    返回 (items, params, prompt, first_frame, last_frame, fields)
    """
    if request.is_json:
        data = json_object()
        items = data.get("items", [])
        params = data.get("params", {})
        tasks.validate_items(items)
        tasks.validate_params(params)
        prompt, first, last, fields = core.assemble_prompt(items)
        return items, params, prompt, first, last, fields

    # 传统表单（向后兼容，也方便脚本）
    form = request.form
    items = []
    for r in ("char", "scene", "camera", "audio", "style"):
        v = (form.get(r) or "").strip()
        if v:
            items.append({"kind": "text", "role": r, "content": v})
    extra = (form.get("extra") or "").strip()
    if extra:
        items.append({"kind": "text", "role": "extra", "content": extra})
    first = last = None
    if "sketch" in request.files and request.files["sketch"].filename:
        first = core.save_upload(request.files["sketch"], request.files["sketch"].filename)
        items.append({"kind": "image", "role": "first_frame", "file": first})
    if "layout" in request.files and request.files["layout"].filename:
        last = core.save_upload(request.files["layout"], request.files["layout"].filename)
        items.append({"kind": "image", "role": "last_frame", "file": last})
    prompt, first2, last2, fields = core.assemble_prompt(items)
    params = {
        "resolution": form.get("resolution", "864,480"),
        "duration": form.get("duration", 5),
        "steps": form.get("steps", 20),
        "seed": form.get("seed", 20260827),
    }
    return items, params, prompt, first2 or first, last2 or last, fields


@app.route("/api/generate", methods=["POST"])
def api_generate():
    items, params, *_ = _parse_generate_payload()
    data = json_object() if request.is_json else {}
    connections = core.normalize_connections(items, data.get("connections"))
    zones = core.reference_inputs.normalize_zones(data.get("zones"))
    core.compile_inputs(items, tasks.validate_params(params), connections, zones)
    if not engine_runtime.state()["owned"] and core.comfyui_running():
        raise RuntimeError("当前生成引擎由其他程序启动。请先关闭独立的ComfyUI，再重新打开Lumen。")
    start_services()
    rec = tasks.manager.submit(items, params, data.get("confirm_expensive") is True, data.get("viewport"), connections=connections, zones=zones)
    return jsonify(ok=True, prompt_id=rec["prompt_id"], record_id=rec["id"], model_mode=rec.get("model_mode"),
                   input_manifest=rec.get("input_manifest", []), compiled_prompt=rec.get("compiled_prompt", ""))


@app.route("/api/status/<pid>")
def api_status(pid):
    rec = core.find_record_by_prompt_id(pid)
    if not rec:
        abort(404)
    r = tasks.public_record(rec)
    return jsonify(**r, done=r["status"] in tasks.TERMINAL, queued=r["status"] == "queued", record_id=r["id"])


@app.route("/api/estimate", methods=["POST"])
def api_estimate():
    data = json_object()
    return jsonify(tasks.estimate(data.get("items", []), data.get("params", {}), data.get("connections"), data.get("zones")))


@app.route("/api/tasks")
def api_tasks():
    return jsonify([tasks.public_record(r) for r in core.load_records() if not r.get("archived")])


@app.route("/api/tasks/<rid>/cancel", methods=["POST"])
def api_cancel(rid):
    return jsonify(ok=True, task=tasks.public_record(tasks.manager.cancel(rid)))


@app.route("/api/boards/default", methods=["GET", "PUT"])
def api_board():
    with _BOARD_LOCK:
        if request.method == "PUT":
            data = json_object()
            previous = core._load_json(BOARD_FILE, {})
            if "items" not in data or "params" not in data:
                raise ValueError("保存画板必须包含卡片和生成参数")
            tasks.validate_items(data.get("items", []))
            tasks.validate_params(data.get("params", {}))
            connections = data.get("connections") if "connections" in data else core._load_json(BOARD_FILE, {}).get("connections")
            data["connections"] = core.normalize_connections(data["items"], connections)
            zones = data.get("zones") if "zones" in data else core._load_json(BOARD_FILE, {}).get("zones")
            data["zones"] = core.reference_inputs.normalize_zones(zones)
            data["saved_at"] = time.time()
            if "_agent_receipts" in previous:
                data["_agent_receipts"] = previous["_agent_receipts"]
            core._save_json(BOARD_FILE, data)
        board = core._load_json(BOARD_FILE, {"items": [], "params": {}, "viewport": {}, "connections": []})
        board["connections"] = core.normalize_connections(board.get("items", []), board.get("connections"))
        board["zones"] = core.reference_inputs.normalize_zones(board.get("zones"))
        return jsonify(board)


# ================================================================ 素材库
@app.route("/api/library")
def api_library():
    q = request.args.get("q")
    tag = request.args.get("tag")
    return jsonify([tasks.public_record(r) for r in core.list_records(q=q, tag=tag) if not r.get("archived")])


@app.route("/api/library/<rid>/star", methods=["POST"])
def api_star(rid):
    star = json_object().get("star", True)
    return jsonify({"ok": core.set_star(rid, star)})


@app.route("/api/library/<rid>/tags", methods=["POST"])
def api_tags(rid):
    tags = json_object().get("tags", [])
    if not isinstance(tags, list) or len(tags) > 30 or any(not isinstance(t, str) or len(t) > 80 for t in tags):
        raise ValueError("标签须为文本列表，最多30个，每个最多80字")
    return jsonify({"ok": core.set_tags(rid, tags)})


@app.route("/api/library/<rid>", methods=["DELETE"])
def api_delete(rid):
    r = core.get_record(rid)
    if r and r.get("status") in tasks.ACTIVE:
        raise ValueError("请先取消任务，再移出素材库")
    return jsonify({"ok": core.delete_record(rid)})


@app.route("/api/library/<rid>/restore", methods=["POST"])
def api_restore(rid):
    return jsonify(ok=core.update_record(rid, archived=False) is not None)


@app.route("/api/library/<rid>/refill")
def api_refill(rid):
    payload = core.refill_payload(rid)
    if payload is None:
        return jsonify({"ok": False, "error": "记录不存在"}), 404
    payload["ok"] = True
    return jsonify(payload)


@app.route("/api/library/<rid>/open", methods=["POST"])
def api_open(rid):
    r = core.get_record(rid)
    if not r:
        return jsonify({"ok": False}), 404
    target = core.OUTPUT_DIR
    if r.get("outputs"):
        rel = (r["outputs"][0].get("sub") or "") + os.sep + r["outputs"][0]["name"]
        p = os.path.join(core.OUTPUT_DIR, rel.replace("/", os.sep))
        if os.path.isfile(p):
            target = p
    subprocess.Popen(["explorer", "/select,", target])
    return jsonify({"ok": True})


@app.route("/library/<path:name>")
def serve_library_file(name):
    return send_from_directory(core.LIB_DIR, name)


# ================================================================ 预设与记忆
@app.route("/api/presets")
def api_presets():
    return jsonify(core.load_presets())


@app.route("/api/presets", methods=["POST"])
def api_preset_add():
    data = json_object()
    cat = data.get("category", "camera")
    if not isinstance(cat, str) or cat not in core.TEXT_ROLES + ["prompt"]:
        raise ValueError("请选择有效的预设类别")
    name, text = data.get("name", ""), data.get("text", "")
    if not isinstance(name, str) or not isinstance(text, str):
        raise ValueError("预设名称和内容须为文本")
    name, text = name.strip(), text.strip()
    if not name or not text:
        return jsonify({"ok": False, "error": "name/text 不能为空"}), 400
    presets = core.load_presets()
    presets.setdefault(cat, []).append({"name": name, "text": text})
    core.save_presets(presets)
    return jsonify({"ok": True})


@app.route("/api/presets", methods=["DELETE"])
def api_preset_remove():
    data = json_object()
    cat = data.get("category", "camera")
    name = data.get("name")
    if not isinstance(cat, str) or cat not in core.TEXT_ROLES + ["prompt"] or not isinstance(name, str):
        raise ValueError("请选择有效的预设类别和名称")
    presets = core.load_presets()
    presets[cat] = [p for p in presets.get(cat, []) if p.get("name") != name]
    core.save_presets(presets)
    return jsonify({"ok": True})


@app.route("/api/memory")
def api_memory():
    return jsonify(core.memory_items())


# ================================================================ 视频文件
@app.route("/videos/<path:sub>/<path:name>")
def serve_video(sub, name):
    base = os.path.abspath(core.OUTPUT_DIR)
    path = os.path.abspath(os.path.join(base, sub, name))
    if os.path.commonpath([base, path]) != base:
        abort(403)
    return send_from_directory(base, os.path.relpath(path, base).replace(os.sep, "/"))


@app.route("/output/<path:name>")
def serve_output(name):
    return send_from_directory(core.OUTPUT_DIR, name, conditional=True)


@app.route("/api/videos")
def api_videos():
    items = []
    for sub in ("video", ""):
        d = os.path.join(core.OUTPUT_DIR, sub) if sub else core.OUTPUT_DIR
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if fn.lower().endswith((".mp4", ".webm", ".webp")):
                p = os.path.join(d, fn)
                try:
                    items.append({"name": fn, "sub": sub, "size": os.path.getsize(p), "time": os.path.getmtime(p)})
                except OSError:
                    pass
    items.sort(key=lambda x: -x["time"])
    return jsonify(items[:60])


# ================================================================ 关闭
@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    close = app.config.get("DESKTOP_CLOSE")
    if not close:
        raise RuntimeError("请关闭Lumen桌面窗口来退出")
    threading.Timer(0.1, close).start()
    return jsonify(ok=True)


if __name__ == "__main__":
    os.makedirs(core.INPUT_DIR, exist_ok=True)
    start_services()
    app.run(host="127.0.0.1", port=8088, threaded=True)
