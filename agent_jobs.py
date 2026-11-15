"""Chat-agent jobs share Lumen's model queue, records, and local output files."""
import copy
import json
import mimetypes
from pathlib import Path
import threading
from urllib.parse import quote
import uuid

from flask import Blueprint, current_app, jsonify, request, send_file

import agent_api
import asset_presets
import engine_runtime
import lumen_core as core
import model_manager
import tasks
from runtime_config import CONFIG, APP_ROOT

_SUBMIT_LOCK = threading.Lock()


def local_url(path):
    return request.url_root.rstrip("/") + path


def result_payload(record):
    task = tasks.public_record(record)
    root = Path(core.OUTPUT_DIR).resolve()
    files, missing = [], []
    for index, output in enumerate(record.get("outputs") or []):
        name, sub = output.get("name", ""), output.get("sub", "")
        if not isinstance(name, str) or not name or not isinstance(sub, str):
            missing.append({"index": index, "reason": "invalid_output"})
            continue
        file = (root / sub / name).resolve()
        if not file.is_relative_to(root) or not file.is_file() or file.stat().st_size == 0:
            missing.append({"index": index, "name": name, "reason": "missing_or_outside_output"})
            continue
        relative = file.relative_to(root).as_posix()
        files.append(dict(index=index, name=file.name, local_path=str(file),
                          url=local_url("/output/" + quote(relative, safe="/")),
                          download_url=local_url(f"/api/agent/jobs/{record['id']}/files/{index}"),
                          mime_type=mimetypes.guess_type(file.name)[0] or "application/octet-stream",
                          size_bytes=file.stat().st_size))
    ready = task["status"] == "done" and bool(files) and not missing
    payload = dict(ok=True, ready=ready, record_id=record["id"], prompt_id=record["prompt_id"],
                   status=task["status"], task=task, files=files, missing_outputs=missing,
                   output_directory=str(root))
    if task["status"] == "done" and not ready:
        payload["error_code"] = "OUTPUT_MISSING"
    return payload


def source_text(data, name, limit):
    value = data.get(name)
    if value is not None and (not isinstance(value, str) or len(value) > limit):
        raise agent_api.AgentError("INVALID_INPUT", name + " 格式无效")
    return value


def build_draft(data, board_path, board_lock):
    choices = sum(("board" in data, "prompt" in data, data.get("use_current_board") is True))
    if choices != 1:
        raise agent_api.AgentError("INVALID_INPUT", "请选择 board、prompt 或 use_current_board 中的一种生成输入")
    if "board" in data:
        return agent_api.validate_board(copy.deepcopy(data["board"]))
    if data.get("use_current_board") is True:
        with board_lock:
            board = core._load_json(str(board_path()), {"items": [], "params": {}})
            agent_api.require_revision(data, agent_api.board_revision(board))
            return agent_api.validate_board(copy.deepcopy(agent_api.public_board(board)))
    prompt = source_text(data, "prompt", 20000)
    if not prompt or not prompt.strip():
        raise agent_api.AgentError("INVALID_INPUT", "请输入这一镜的画面、动作或声音描述")
    ids = data.get("preset_ids", [])
    if not isinstance(ids, list) or len(ids) > 20 or any(not isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
        raise agent_api.AgentError("INVALID_INPUT", "preset_ids 须为不重复的素材库 ID 列表，最多20个")
    params = data.get("params", {})
    if not isinstance(params, dict):
        raise agent_api.AgentError("INVALID_INPUT", "params 须为对象")
    draft = dict(items=[dict(id="shot-" + uuid.uuid4().hex, kind="text", role="scene", content=prompt.strip())],
                 params={"resolution": "608,352", "duration": 5, "steps": 8, "seed": uuid.uuid4().int % 2**63,
                         "model_mode": "auto", "audio_mode": "generated", **params}, zones=[], connections=[])
    store = asset_presets.AssetPresetStore(Path(core.LIB_DIR) / "asset-presets", core.INPUT_DIR,
                                         current_app.config.get("PREVIS_ROOT") or Path(core.LIB_DIR) / "previs")
    # Instantiation restores only local media. Preset params and dormant reference
    # masks never override this shot's explicit choices.
    for identifier in ids:
        preset = store.instantiate(identifier)
        for key in ("items", "zones", "connections"):
            draft[key].extend(preset[key])
    return agent_api.validate_board(draft)


def bootstrap_payload():
    api_url = request.url_root.rstrip("/")
    cli = str(APP_ROOT / "lumen.bat")
    config = {"mcpServers": {"lumen": {"command": str(CONFIG.engine_python),
                                    "args": [str(APP_ROOT / "lumen_mcp.py")], "cwd": str(APP_ROOT)}}}
    template = APP_ROOT / "docs" / "AGENT_BOOTSTRAP.txt"
    prompt = template.read_text(encoding="utf-8") if template.is_file() else "请通过本机 Lumen CLI 操作视频模型：{LUMEN_CLI} discover --json"
    for key, value in {"LUMEN_CLI": cli, "LUMEN_API": api_url, "LUMEN_OUTPUT": str(Path(core.OUTPUT_DIR).resolve()),
                       "LUMEN_MCP_CONFIG": json.dumps(config, ensure_ascii=False, indent=2),
                       "LUMEN_ROOT": str(APP_ROOT), "LUMEN_PYTHON": str(CONFIG.engine_python)}.items():
        prompt = prompt.replace("{" + key + "}", value)
    models = core.model_status()
    return dict(ok=True, prompt=prompt, mcp_config=config, api_url=api_url,
                guide_url="/api/agent/guide", cli_path=cli, output_directory=str(Path(core.OUTPUT_DIR).resolve()),
                connection=dict(service="ready", engine_ready=core.comfyui_running(),
                                progress_connected=tasks.manager.ready.is_set(),
                                models_ready=all(m["available"] for m in models.values())
                                and all(m["present"] for m in model_manager.installer.inventory()["models"])),
                boundary="Agent 需要本机命令工具或连接本机 MCP。纯云端聊天框无法仅凭提示词访问此电脑；结果由聊天宿主附件能力展示。")


def create_blueprint(board_path, board_lock, start_services):
    blueprint = Blueprint("agent_jobs", __name__, url_prefix="/api/agent")

    @blueprint.errorhandler(agent_api.AgentError)
    def agent_error(error):
        return jsonify(ok=False, code=error.code, error=str(error), **error.details), error.status

    def find_record(identifier):
        record = core.get_record(identifier)
        if record is None:
            raise agent_api.AgentError("NOT_FOUND", "生成任务不存在", 404)
        return record

    def submission(record, replayed):
        return jsonify(ok=True, record_id=record["id"], prompt_id=record["prompt_id"], status=record["status"],
                       task=tasks.public_record(record), compiled_prompt=record.get("compiled_prompt", ""),
                       model_mode=record.get("model_mode"), replayed=replayed,
                       result_url=f"/api/agent/jobs/{record['id']}/result")

    @blueprint.get("/bootstrap")
    def bootstrap():
        return jsonify(bootstrap_payload())

    @blueprint.post("/generate")
    def generate():
        data = agent_api.json_object()
        identifier = agent_api.request_id(data, required=True)
        fingerprint = agent_api.digest({k: v for k, v in data.items() if k != "request_id"})
        client = source_text(data, "client_name", 120) or "Local Agent"
        title = source_text(data, "title", 160)
        with _SUBMIT_LOCK:
            previous = next((r for r in core.load_records() if r.get("source", {}).get("kind") == "agent"
                             and r["source"].get("request_id") == identifier), None)
            if previous:
                if previous["source"].get("fingerprint") != fingerprint:
                    raise agent_api.AgentError("IDEMPOTENCY_CONFLICT", "相同 request_id 已用于不同镜头；请读取原任务或使用新的 ID", 409,
                                               record_id=previous["id"])
                return submission(previous, True)
            if not engine_runtime.state()["owned"]:
                raise agent_api.AgentError("ENGINE_NOT_READY", "请用 Lumen ensure 启动并等待本机引擎就绪", 503)
            draft = build_draft(data, board_path, board_lock)
            start_services()
            if not core.comfyui_running() or not tasks.manager.ready.is_set():
                raise agent_api.AgentError("ENGINE_NOT_READY", "引擎或进度连接尚未就绪，请稍后使用同一 request_id 重试", 503)
            record = tasks.manager.submit(draft["items"], draft["params"], viewport=draft.get("viewport"),
                                          connections=draft.get("connections"), zones=draft.get("zones"),
                                          source=dict(kind="agent", client_name=client, request_id=identifier, fingerprint=fingerprint), title=title)
            return submission(record, False)

    @blueprint.get("/jobs/<identifier>")
    def job(identifier):
        record = find_record(identifier)
        return jsonify(ok=True, record_id=record["id"], prompt_id=record["prompt_id"], status=record["status"],
                       task=tasks.public_record(record), result_url=f"/api/agent/jobs/{record['id']}/result")

    @blueprint.get("/results/<identifier>")
    @blueprint.get("/jobs/<identifier>/result")
    def result(identifier):
        return jsonify(result_payload(find_record(identifier)))

    @blueprint.get("/jobs/<identifier>/files/<int:index>")
    def download(identifier, index):
        result = result_payload(find_record(identifier))
        file = next((f for f in result["files"] if f["index"] == index), None) if result["ready"] else None
        if file is None:
            raise agent_api.AgentError("OUTPUT_NOT_READY", "成片文件尚未就绪或已不在原位置", 404)
        return send_file(file["local_path"], as_attachment=True, download_name=file["name"], conditional=True)

    return blueprint
