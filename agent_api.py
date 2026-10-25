"""Local agent discovery and version-checked edits, sharing the UI's owner locks."""
import copy
import hashlib
import json
from pathlib import Path
import re
import time

from flask import Blueprint, current_app, jsonify, request

import lumen_core as core
import tasks
import previs_store


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def public_board(board):
    return {key: value for key, value in board.items() if not key.startswith("_agent_")}


def board_revision(board):
    return digest(public_board(board))


def document_revision(document):
    return digest({key: value for key, value in document.items() if key not in {"opened_at", "resolved_scene"}})


class AgentError(ValueError):
    def __init__(self, code, message, status=400, **details):
        super().__init__(message)
        self.code, self.status, self.details = code, status, details


def json_object():
    data = request.get_json()
    if not isinstance(data, dict):
        raise AgentError("INVALID_INPUT", "请求须为 JSON 对象")
    return data


def require_revision(data, revision):
    expected = request.headers.get("If-Match", data.get("expected_revision", "")).strip('"')
    if not expected:
        raise AgentError("PRECONDITION_REQUIRED", "先读取当前 revision，再提交 expected_revision 或 If-Match", 428,
                         current_revision=revision)
    if expected != revision:
        raise AgentError("REVISION_CONFLICT", "内容已被其他操作更新；请重新读取并合并，不能直接覆盖", 409,
                         current_revision=revision)


def request_id(data, required=False):
    value = request.headers.get("Idempotency-Key", data.get("request_id"))
    if value is None and not required:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", value):
        raise AgentError("INVALID_REQUEST_ID", "request_id 须为 1–160 位字母、数字、下划线、点、冒号或横线")
    return value


def validate_board(board):
    if not isinstance(board, dict) or "items" not in board or "params" not in board:
        raise AgentError("INVALID_INPUT", "画板须包含 items 和 params")
    # Fail on NaN/infinity before persistence, including positions and extension metadata.
    digest(board)
    if isinstance(board["items"], list):
        for item in board["items"]:
            if not isinstance(item, dict):
                raise AgentError("INVALID_INPUT", "卡片须为对象")
            for key in ("kind", "role", "reference_role", "character_view", "file", "content"):
                if key in item and not isinstance(item[key], str):
                    raise AgentError("INVALID_INPUT", "卡片 " + key + " 须为文本")
            for key in ("x", "y", "w", "h"):
                if key in item and (isinstance(item[key], bool) or not isinstance(item[key], (int, float)) or key in {"w", "h"} and item[key] <= 0):
                    raise AgentError("INVALID_INPUT", "卡片位置和尺寸须为有效数值")
    if isinstance(board["params"], dict):
        for key in ("steps", "seed"):
            if key in board["params"] and (isinstance(board["params"][key], bool) or not isinstance(board["params"][key], int)):
                raise AgentError("INVALID_INPUT", key + " 须为整数")
        if "model_mode" in board["params"] and not isinstance(board["params"]["model_mode"], str):
            raise AgentError("INVALID_INPUT", "model_mode 须为文本")
    tasks.validate_items(board["items"])
    tasks.validate_params(board["params"])
    ids = [item.get("id") for item in board["items"]]
    if any(not isinstance(item_id, str) or not 1 <= len(item_id) <= 200 for item_id in ids) or len(set(ids)) != len(ids):
        raise AgentError("INVALID_INPUT", "Agent 画板卡片必须有唯一的非空 id（最多 200 字）")
    if isinstance(board.get("zones"), list):
        for zone in board["zones"]:
            if isinstance(zone, dict) and "purpose" in zone and not isinstance(zone["purpose"], str):
                raise AgentError("INVALID_INPUT", "分区 purpose 须为文本")
    board["zones"] = core.reference_inputs.normalize_zones(board.get("zones"))
    zone_ids = {zone["id"] for zone in board["zones"]}
    if any(item.get("zone_id") is not None and item["zone_id"] not in zone_ids for item in board["items"]):
        raise AgentError("INVALID_INPUT", "卡片引用了不存在的分区")
    connections = board.get("connections", [])
    if isinstance(connections, list):
        for edge in connections:
            if not isinstance(edge, dict) or any(not isinstance(edge.get(key), str) for key in ("id", "from", "to")):
                raise AgentError("INVALID_INPUT", "连线 id/from/to 须为文本")
    normalized = core.normalize_connections(board["items"], connections)
    if not isinstance(connections, list) or len(normalized) != len(connections):
        raise AgentError("INVALID_INPUT", "连线含不存在的端点、自连线或重复 id")
    board["connections"] = normalized
    return board


def apply_operations(board, operations):
    if not isinstance(operations, list) or not 1 <= len(operations) <= 500:
        raise AgentError("INVALID_INPUT", "operations 须包含 1–500 个操作")
    board = copy.deepcopy(public_board(board))
    for operation in operations:
        if not isinstance(operation, dict):
            raise AgentError("INVALID_INPUT", "操作须为 JSON 对象")
        action = operation.get("op")
        if action == "set_params":
            if not isinstance(operation.get("value"), dict):
                raise AgentError("INVALID_INPUT", "set_params.value 须为对象")
            board["params"] = {**board.get("params", {}), **operation["value"]}
            continue
        if action == "set_viewport":
            if not isinstance(operation.get("value"), dict):
                raise AgentError("INVALID_INPUT", "set_viewport.value 须为对象")
            board["viewport"] = {**board.get("viewport", {}), **operation["value"]}
            continue
        match = re.fullmatch(r"(add|update|remove)_(item|zone|connection)", str(action))
        if not match:
            raise AgentError("INVALID_INPUT", "不支持的画板操作：" + str(action))
        verb, kind = match.groups()
        collection = {"item": "items", "zone": "zones", "connection": "connections"}[kind]
        rows = board.setdefault(collection, [])
        value = operation.get("value", {})
        identifier = operation.get("id") if verb != "add" else value.get("id") if isinstance(value, dict) else None
        if not isinstance(identifier, str) or not identifier:
            raise AgentError("INVALID_INPUT", "操作须指定非空 id")
        previous = next((row for row in rows if row.get("id") == identifier), None)
        if verb == "add":
            if previous is not None:
                raise AgentError("ID_CONFLICT", "id 已存在：" + identifier, 409)
            rows.append(copy.deepcopy(value))
        elif previous is None:
            raise AgentError("NOT_FOUND", "操作目标不存在：" + identifier, 404)
        elif verb == "update":
            if not isinstance(value, dict) or value.get("id", identifier) != identifier:
                raise AgentError("INVALID_INPUT", "update.value 须为对象且不能更改 id")
            previous.update(copy.deepcopy(value))
        else:
            rows.remove(previous)
            if kind == "item":
                board["connections"] = [edge for edge in board.get("connections", [])
                                        if identifier not in (edge.get("from"), edge.get("to"))]
            if kind == "zone":
                for item in board.get("items", []):
                    if item.get("zone_id") == identifier:
                        item["zone_id"] = None
    return validate_board(board)


def validate_scene(scene):
    """Reject unrenderable agent documents before collecting/persisting assets."""
    if not isinstance(scene, dict) or scene.get("version") != 3 or not isinstance(scene.get("objects"), list):
        raise AgentError("INVALID_INPUT", "场景须为 version:3 且包含 objects")
    digest(scene)
    objects = scene["objects"]
    catalog = json.loads((Path(__file__).parent / "agent-catalog.json").read_text(encoding="utf-8"))
    known = {asset["id"] for asset in catalog["assets"]} | {"group", "imported", "camera", "point_light", "spot_light", "directional_light"}
    if len(objects) > 200 or any(not isinstance(item, dict) for item in objects):
        raise AgentError("INVALID_INPUT", "场景最多 200 个对象")
    identifiers = [item.get("id") for item in objects]
    if any(not isinstance(value, str) or not value or value in {"camera", "scene", "environment"} for value in identifiers) or len(set(identifiers)) != len(identifiers):
        raise AgentError("INVALID_INPUT", "场景对象 id 必须唯一且不能占用 camera/scene/environment")
    for item in objects:
        if not isinstance(item.get("type"), str) or item["type"] not in known:
            raise AgentError("INVALID_INPUT", "未知对象类型：" + str(item.get("type")))
        for key in ("position", "rotation", "scale"):
            if key in item and (not isinstance(item[key], list) or len(item[key]) != 3 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or (key == "scale" and v <= 0) for v in item[key])):
                raise AgentError("INVALID_INPUT", key + " 须为三个有效数值；缩放必须为正")
    parents = {item["id"]: item.get("parentId") for item in objects}
    def hierarchy(mapping):
        for identifier in mapping:
            seen = {identifier}
            parent = mapping[identifier]
            while parent:
                if not isinstance(parent, str) or parent not in mapping or parent in seen:
                    raise AgentError("INVALID_INPUT", "场景父级不存在或形成循环")
                seen.add(parent)
                parent = mapping[parent]
    hierarchy(parents)
    sequence = scene.get("sequence", {})
    if not isinstance(sequence, dict):
        raise AgentError("INVALID_INPUT", "sequence 须为对象")
    duration, fps, tracks = sequence.get("duration", 5), sequence.get("fps", 24), sequence.get("tracks", [])
    if not isinstance(duration, (int, float)) or not 1 <= duration <= 300 or not isinstance(fps, (int, float)) or not 1 <= fps <= 60 or not isinstance(tracks, list):
        raise AgentError("INVALID_INPUT", "时间线 duration 为 1–300 秒，fps 为 1–60，tracks 为列表")
    count, parent_tracks, times = 0, [], {0}
    for track in tracks:
        if not isinstance(track, dict) or not isinstance(track.get("targetId"), str) or track["targetId"] not in set(identifiers) | {"camera", "environment", "scene"}:
            raise AgentError("INVALID_INPUT", "轨道目标不存在")
        path = track.get("property", "")
        if not isinstance(path, str) or path.split(".")[0] not in catalog["timeline_properties"] or any(not re.fullmatch(r"[\w-]+", part) or part in {"__proto__", "prototype", "constructor"} for part in path.split(".")):
            raise AgentError("INVALID_INPUT", "不支持的时间线属性")
        keys = track.get("keys", [])
        if not isinstance(keys, list):
            raise AgentError("INVALID_INPUT", "轨道 keys 须为列表")
        count += len(keys)
        for key in keys:
            if not isinstance(key, dict) or "value" not in key or not isinstance(key.get("time"), (int, float)) or not 0 <= key["time"] <= duration:
                raise AgentError("INVALID_INPUT", "关键帧须包含 value 和范围内 time")
            if path == "parentId" and (key["value"] is not None and (not isinstance(key["value"], str) or key["value"] not in parents)):
                raise AgentError("INVALID_INPUT", "动态父级不存在")
        if path == "parentId" and keys and not track.get("muted"):
            if track["targetId"] not in parents:
                raise AgentError("INVALID_INPUT", "系统相机与环境不能设置父级轨道")
            parent_tracks.append(track)
            times.update(key["time"] for key in keys)
    if count > 10000:
        raise AgentError("INVALID_INPUT", "最多 10000 个关键帧")
    for moment in times:
        active = dict(parents)
        for track in parent_tracks:
            keys = sorted(track["keys"], key=lambda key: key["time"])
            active[track["targetId"]] = next((key["value"] for key in reversed(keys) if key["time"] <= moment), keys[0]["value"])
        hierarchy(active)
    return scene


def create_blueprint(board_path, board_lock):
    blueprint = Blueprint("agent", __name__, url_prefix="/api/agent")

    @blueprint.errorhandler(AgentError)
    def agent_error(error):
        return jsonify(ok=False, error=str(error), code=error.code, **error.details), error.status

    def read_board():
        return core._load_json(str(board_path()), {"items": [], "params": {}, "viewport": {}, "connections": [], "zones": []})

    def board_response(board, **extra):
        response = jsonify(ok=True, revision=board_revision(board), board=public_board(board), **extra)
        response.set_etag(board_revision(board))
        return response

    @blueprint.get("/board")
    def get_board():
        with board_lock:
            return board_response(read_board())

    def edit_board(operations=False):
        data = json_object()
        identifier = request_id(data)
        fingerprint = digest({"mode": "operations" if operations else "replace", "payload": data})
        with board_lock:
            old = read_board()
            receipts = old.get("_agent_receipts", [])
            receipt = next((r for r in receipts if r["id"] == identifier), None) if identifier else None
            if receipt:
                if receipt["fingerprint"] != fingerprint:
                    raise AgentError("IDEMPOTENCY_CONFLICT", "同一个 request_id 不能用于不同请求", 409)
                return board_response(old, replayed=True, applied_revision=receipt["revision"])
            require_revision(data, board_revision(old))
            board = apply_operations(old, data.get("operations")) if operations else validate_board(copy.deepcopy(data.get("board")))
            board = public_board(board)
            board["saved_at"] = time.time()
            revision = board_revision(board)
            if identifier:
                receipts = [*receipts, {"id": identifier, "fingerprint": fingerprint, "revision": revision}][-128:]
            if receipts:
                board["_agent_receipts"] = receipts
            Path(board_path()).parent.mkdir(parents=True, exist_ok=True)
            core._save_json(str(board_path()), board)
            return board_response(board, replayed=False, applied_revision=revision)

    @blueprint.put("/board")
    def replace_board():
        return edit_board()

    @blueprint.post("/board/operations")
    def operate_board():
        return edit_board(True)

    @blueprint.post("/preview")
    def preview():
        data = json_object()
        if "operations" in data:
            with board_lock:
                board = read_board()
                require_revision(data, board_revision(board))
                board = apply_operations(board, data["operations"])
        else:
            board = validate_board(copy.deepcopy(data.get("board", data)))
        estimate = tasks.estimate(board["items"], board["params"], board.get("connections"), board.get("zones"))
        return jsonify(ok=True, board=public_board(board), estimate=estimate, writes_board=False, submits_generation=False)

    def store():
        return previs_store.PrevisStore(current_app.config.get("PREVIS_ROOT") or Path(core.LIB_DIR) / "previs")

    def document_response(document, **extra):
        response = jsonify(ok=True, document=document, revision=document_revision(document), **extra)
        response.set_etag(document_revision(document))
        return response

    @blueprint.get("/documents/<document_id>")
    def get_document(document_id):
        return document_response(store().open(document_id, touch=False))

    def edit_document(document_id=None, delete=False):
        data = json_object()
        identifier = request_id(data, required=True)
        fingerprint = digest({"id": document_id, "delete": delete, "payload": data})
        document_store = store()
        # Share the document owner's lock with normal UI saves. Pending receipts
        # survive a crash; an ambiguous operation is never automatically repeated.
        with previs_store._LOCK:
            receipt_path = document_store.root / "agent-requests" / (digest(identifier) + ".json")
            receipt = core._load_json(str(receipt_path), None)
            if receipt:
                if receipt["fingerprint"] != fingerprint:
                    raise AgentError("IDEMPOTENCY_CONFLICT", "同一个 request_id 不能用于不同请求", 409)
                if receipt["state"] != "done":
                    raise AgentError("OUTCOME_UNKNOWN", "上次请求在写入后未完成确认；请读取文档列表核对，勿更换 request_id 自动重试", 409)
                return jsonify(ok=True, replayed=True, **receipt["result"])
            if document_id:
                old = document_store.open(document_id, touch=False)
                require_revision(data, document_revision(old))
            payload = copy.deepcopy(data.get("document", {}))
            if not delete and not isinstance(payload, dict):
                raise AgentError("INVALID_INPUT", "document 须为对象")
            if document_id:
                payload["id"] = document_id
            elif payload.get("id"):
                raise AgentError("INVALID_INPUT", "新建文档不能指定 id；更新请使用 PUT /documents/<id>")
            if not delete:
                validate_scene(payload.get("scene"))
            previs_store.atomic_json(receipt_path, {"state": "pending", "fingerprint": fingerprint})
            try:
                if delete:
                    document_store.delete(document_id)
                    result = {"id": document_id, "deleted": True}
                else:
                    document = document_store.save(payload)
                    result = {"id": document["id"], "revision": document_revision(document)}
            except ValueError:
                receipt_path.unlink(missing_ok=True)
                raise
            previs_store.atomic_json(receipt_path, {"state": "done", "fingerprint": fingerprint, "result": result})
            return jsonify(ok=True, replayed=False, **result)

    @blueprint.post("/documents")
    def create_document():
        return edit_document()

    @blueprint.put("/documents/<document_id>")
    def replace_document(document_id):
        return edit_document(document_id)

    @blueprint.delete("/documents/<document_id>")
    def remove_document(document_id):
        return edit_document(document_id, delete=True)

    @blueprint.get("/schema")
    def schema():
        return jsonify(json.loads((Path(__file__).parent / "agent-schema.json").read_text(encoding="utf-8")))

    @blueprint.get("/catalog")
    def catalog():
        return jsonify(json.loads((Path(__file__).parent / "agent-catalog.json").read_text(encoding="utf-8")))

    @blueprint.get("/guide")
    def guide():
        return jsonify(ok=True, format="markdown", text=(Path(__file__).parent / "docs/AGENT_GUIDE.md").read_text(encoding="utf-8"))

    @blueprint.get("/examples/<name>")
    def example(name):
        if name not in {"board", "board-operations", "animated-prefab"}:
            raise AgentError("NOT_FOUND", "示例不存在", 404)
        return jsonify(json.loads((Path(__file__).parent / "examples/agent" / (name + ".json")).read_text(encoding="utf-8")))

    @blueprint.get("/discover")
    def discover():
        endpoints = [{"path": rule.rule, "methods": sorted(rule.methods - {"OPTIONS", "HEAD"})}
                     for rule in current_app.url_map.iter_rules() if rule.rule.startswith("/api/")]
        return jsonify(ok=True, api_version="1.0", application="Lumen", transport="loopback HTTP JSON + multipart",
                       schema="/api/agent/schema", catalog="/api/agent/catalog", guide="/api/agent/guide",
                       examples={name:"/api/agent/examples/" + name for name in ("board", "board-operations", "animated-prefab")},
                       endpoints=sorted(endpoints, key=lambda e: e["path"]),
                       contracts={"POST /api/agent/preview":{"request":"Board or BoardOperations","response":"{board,estimate,writes_board:false,submits_generation:false}"},
                                  "PUT /api/agent/board":{"request":"BoardWrite","response":"{board,revision,replayed,applied_revision}"},
                                  "POST /api/agent/board/operations":{"request":"BoardOperations","response":"{board,revision,replayed,applied_revision}"},
                                  "POST /api/agent/documents":{"request":"DocumentWrite","response":"{id,revision,replayed}"},
                                  "PUT /api/agent/documents/<document_id>":{"request":"DocumentWrite + expected_revision","response":"{id,revision,replayed}"},
                                  "POST /api/asset-presets":{"request":"AssetPreset","response":"{preset}"},
                                  "POST /api/generate":{"request":"Board + confirm_expensive?","response":"{record_id,prompt_id,input_manifest,compiled_prompt}"},
                                  "POST /api/previs/import|export":{"request":"multipart file, format? fps? sample_frames?","response":"202 {job}; poll GET /api/previs/jobs/<id>"}},
                       workflow=["discover", "upload local assets", "preview/estimate", "review manifest and cost", "explicit generate", "poll status"],
                       safe_edits={"board":"/api/agent/board", "operations":"/api/agent/board/operations",
                                   "documents":"/api/agent/documents", "revision":"SHA-256; use expected_revision or If-Match",
                                   "idempotency":"request_id or Idempotency-Key; board retains last 128 receipts; document receipts persist",
                                   "unknown_outcome":"OUTCOME_UNKNOWN requires inspection; never blindly retry with a new ID"},
                       notes=["Direct legacy API writes do not provide agent optimistic concurrency guarantees.",
                              "Preset instantiate returns new IDs and restores media; it does not modify the board.",
                              "Preview can probe/cache local media but never saves the board or submits a GPU job.",
                              "Save a v3 scene/template/prefab document to inject 3D content; HTTP does not manipulate an already-open editor tab.",
                              "Conversion jobs use local Blender; GPU generation uses the owned desktop engine."])

    return blueprint
