"""Local Lumen MCP tools over UTF-8 newline-delimited stdio; no SDK required.

Supports the 2026-07-28 per-request protocol and initialization-based revisions.
Starting this adapter neither opens Lumen nor submits a video. Use lumen_connect
to open the ordinary desktop app. Closing the adapter never cancels a model job.
"""
import argparse
import json
from pathlib import Path
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request

import lumen

MODERN = "2026-07-28"
LEGACY = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
VERSIONS = (MODERN, *LEGACY)
SERVER = {"name": "lumen-local", "title": "Lumen · 本机视频工作室", "version": "1.0.0"}
CAPABILITIES = {"tools": {"listChanged": False}}
INSTRUCTIONS = (
    "Lumen controls this computer's MiniMax H3 through its existing desktop app. "
    "Call lumen_connect, inspect assets/board, preview, then generate only when the user requests a video. "
    "Keep the same request_id when recovering an uncertain submission. Poll lumen_job; report success only "
    "when lumen_result.ready is true. Return the verified local file and local playback URL; attach the "
    "video if the chat host supports local attachments. A cloud-only chat cannot reach this stdio server "
    "without a local MCP host. Never send local references or results to a third party automatically."
)


def schema(properties=None, required=()):
    return {"type": "object", "properties": properties or {}, "required": list(required), "additionalProperties": False}


STRING = {"type": "string", "minLength": 1}
ID = {"type": "string", "minLength": 1, "maxLength": 200}
REQUEST_ID = {"type": "string", "minLength": 1, "maxLength": 160}
OBJECT = {"type": "object"}
GENERATION = schema({
    "request_id": REQUEST_ID, "prompt": {"type": "string", "minLength": 1, "maxLength": 20000},
    "preset_ids": {"type": "array", "items": ID, "maxItems": 20}, "params": OBJECT,
    "board": OBJECT, "use_current_board": {"type": "boolean"}, "expected_revision": STRING,
    "client_name": {"type": "string", "maxLength": 120}, "title": {"type": "string", "maxLength": 160},
}, ("request_id",))
GENERATION["oneOf"] = [
    {"required": ["prompt"], "not": {"anyOf": [{"required": ["board"]}, {"required": ["use_current_board"]}]}},
    {"required": ["board"], "not": {"anyOf": [{"required": ["prompt"]}, {"required": ["use_current_board"]}]}},
    {"required": ["use_current_board", "expected_revision"], "properties": {"use_current_board": {"const": True}},
     "not": {"anyOf": [{"required": ["prompt"]}, {"required": ["board"]}]}},
]


def tool(name, description, input_schema, read_only=True):
    return {"name": name, "description": description, "inputSchema": input_schema,
            "annotations": {"readOnlyHint": read_only, "destructiveHint": False, "openWorldHint": False}}


TOOLS = [
    tool("lumen_connect", "Open/reuse the normal local Lumen desktop app and wait for H3 readiness. No generation or downloads. A cloud-only host needs a local connection.",
         schema({"timeout": {"type": "integer", "minimum": 1, "maximum": 180}}), False),
    tool("lumen_discover", "Read available routes, schemas and capabilities from the running local installation.", schema()),
    tool("lumen_status", "Read model/engine readiness and existing generation jobs; never opens the app or starts a job.", schema()),
    tool("lumen_board_get", "Read the human's current board and opaque revision before editing it.", schema()),
    tool("lumen_board_apply", "Atomically apply board operations with the exact revision read earlier. On conflict reread and merge; do not blindly retry stale changes.",
         schema({"expected_revision": STRING, "request_id": REQUEST_ID, "operations": {"type": "array", "items": OBJECT, "maxItems": 1000}},
                ("expected_revision", "request_id", "operations")), False),
    tool("lumen_assets", "Search reusable local character/scene/action/style presets. Use returned IDs, not guessed names, when generating.",
         schema({"query": {"type": "string", "maxLength": 500}, "category": {"enum": ["character", "scene", "action", "camera", "style", "general"]}})),
    tool("lumen_asset_instantiate", "Copy a preset's references into current input storage and return fresh items/zones/connections. Does NOT change the board. To display it, append returned data with lumen_board_apply. Generation accepts preset_ids directly.",
         schema({"preset_id": ID}, ("preset_id",)), False),
    tool("lumen_upload", "Import one user-requested local image/video file into Lumen. The returned server filename can be used in a board; not an external upload.",
         schema({"local_path": STRING}, ("local_path",)), False),
    tool("lumen_preview", "Compile a complete board or versioned operation batch without saving or generating. Inspect actual H3 text, references, model mode and limits.",
         schema({"board": OBJECT, "operations": {"type": "array", "items": OBJECT}, "expected_revision": STRING})),
    tool("lumen_generate", "Generate only after the user requests a video. Choose one: prompt with optional preset_ids/params, a complete board, or use_current_board:true with expected_revision. Keep request_id stable on uncertain retries. Returns immediately with a job; never regenerate just because a wait timed out.",
         GENERATION, False),
    tool("lumen_job", "Read a job's actual stage, sampling progress and remaining-time estimate by record ID. Poll until terminal; reading does not cancel or regenerate.",
         schema({"record_id": ID}, ("record_id",))),
    tool("lumen_result", "Return verified output files, absolute local paths and local playback/download URLs. Only ready:true confirms actual completed output. Attach that file in chat if supported; otherwise return the path and local URL.",
         schema({"record_id": ID}, ("record_id",))),
    tool("lumen_cancel", "Cancel one generation only when the user asks to stop it. Cancels the selected Lumen job, not unrelated processes.",
         schema({"record_id": ID}, ("record_id",)), False),
]
BY_NAME = {entry["name"]: entry for entry in TOOLS}


class RpcError(Exception):
    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code, self.data = code, data


def validate(value, spec, path="arguments"):
    """Validate the small, explicit JSON Schema subset used by these tools."""
    types = {"object": dict, "array": list, "string": str, "boolean": bool, "integer": int, "number": (int, float)}
    kind = spec.get("type")
    if kind and (not isinstance(value, types[kind]) or kind in {"integer", "number"} and isinstance(value, bool)):
        raise RpcError(-32602, path + " must be " + kind)
    if "enum" in spec and value not in spec["enum"] or "const" in spec and value != spec["const"]:
        raise RpcError(-32602, path + " has an unsupported value")
    if isinstance(value, str) and (len(value) < spec.get("minLength", 0) or len(value) > spec.get("maxLength", 2**31)):
        raise RpcError(-32602, path + " has an invalid length")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and not spec.get("minimum", -float("inf")) <= value <= spec.get("maximum", float("inf")):
        raise RpcError(-32602, path + " is out of range")
    if isinstance(value, dict):
        for key in spec.get("required", []):
            if key not in value:
                raise RpcError(-32602, path + "." + key + " is required")
        for key, child in value.items():
            if key in spec.get("properties", {}):
                validate(child, spec["properties"][key], path + "." + key)
            elif spec.get("additionalProperties") is False:
                raise RpcError(-32602, "Unknown " + path + "." + key)
    if isinstance(value, list):
        if len(value) > spec.get("maxItems", 2**31):
            raise RpcError(-32602, path + " has too many items")
        for child in value:
            validate(child, spec.get("items", {}), path + "[]")


def configure_url(url):
    parsed = urllib.parse.urlsplit(url)
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("Lumen URL requires a valid local port") from error
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.path not in {"", "/"} or parsed.query or parsed.fragment or parsed.username or parsed.password or port == 0:
        raise ValueError("Lumen MCP only connects to http://127.0.0.1:PORT (or localhost/::1)")
    lumen.API_URL = url.rstrip("/")
    # A local API must not redirect local references or credentials elsewhere.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    lumen.HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def quoted(identifier):
    return urllib.parse.quote(identifier, safe="")


def call_tool(name, arguments):
    validate(arguments, BY_NAME[name]["inputSchema"])
    if name == "lumen_connect":
        return {"ok": True, "system": lumen.ensure_service(timeout=arguments.get("timeout", 120), launch=True)}
    if name == "lumen_discover":
        return lumen.request_json("/api/agent/discover")
    if name == "lumen_status":
        return {"system": lumen.request_json("/api/system"), "tasks": lumen.request_json("/api/tasks")}
    if name == "lumen_board_get":
        return lumen.request_json("/api/agent/board")
    if name == "lumen_board_apply":
        return lumen.request_json("/api/agent/board/operations", "POST", arguments)
    if name == "lumen_assets":
        query = urllib.parse.urlencode({k: v for k, v in {"q": arguments.get("query", ""), "category": arguments.get("category")}.items() if v is not None})
        return lumen.request_json("/api/asset-presets?" + query)
    if name == "lumen_asset_instantiate":
        return lumen.request_json("/api/asset-presets/" + quoted(arguments["preset_id"]) + "/instantiate", "POST", {})
    if name == "lumen_upload":
        return lumen.upload_file(arguments["local_path"])
    if name == "lumen_preview":
        if ("board" in arguments) == ("operations" in arguments) or "operations" in arguments and not arguments.get("expected_revision"):
            raise RpcError(-32602, "Preview requires one board OR operations with expected_revision")
        return lumen.request_json("/api/agent/preview", "POST", arguments, timeout=30)
    if name == "lumen_generate":
        sources = sum(key in arguments for key in ("prompt", "board", "use_current_board"))
        if sources != 1 or "use_current_board" in arguments and (arguments["use_current_board"] is not True or not arguments.get("expected_revision")):
            raise RpcError(-32602, "Generation requires one prompt, board, or use_current_board:true with expected_revision")
        return lumen.request_json("/api/agent/generate", "POST", arguments, timeout=150)
    if name in {"lumen_job", "lumen_result"}:
        return lumen.request_json("/api/agent/jobs/" + quoted(arguments["record_id"]) + ("/result" if name == "lumen_result" else ""))
    if name == "lumen_cancel":
        return lumen.request_json("/api/tasks/" + quoted(arguments["record_id"]) + "/cancel", "POST", {})
    raise RpcError(-32602, "Unknown tool: " + name)


def tool_result(value):
    content = [{"type": "text", "text": json.dumps(value, ensure_ascii=False, allow_nan=False)}]
    if isinstance(value, dict) and value.get("ready") is True:
        for file in value.get("files", []):
            local = file.get("local_path")
            if local:
                link = {"type": "resource_link", "uri": Path(local).as_uri(),
                                "name": file.get("name") or Path(local).name,
                                "mimeType": file.get("mime_type", "video/mp4"),
                                "description": "Verified local Lumen output; use the chat host's attachment capability to show this video."}
                if isinstance(file.get("size_bytes"), int):
                    link["size"] = file["size_bytes"]
                content.append(link)
    return {"content": content, "structuredContent": value if isinstance(value, dict) else {"result": value}, "isError": False}


class Server:
    def __init__(self):
        self.version = None
        self.initialized = False

    def handle(self, message):
        identifier = message.get("id") if isinstance(message, dict) else None
        try:
            if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
                raise RpcError(-32600, "Expected a JSON-RPC 2.0 request")
            if "id" in message and (not isinstance(identifier, (str, int)) or isinstance(identifier, bool)):
                raise RpcError(-32600, "Request id must be a string or integer")
            method, params = message["method"], message.get("params", {})
            if not isinstance(params, dict):
                raise RpcError(-32602, "params must be an object")
            if "id" not in message:
                if method == "notifications/initialized" and self.version:
                    self.initialized = True
                return None
            meta = params.get("_meta", {})
            if not isinstance(meta, dict):
                raise RpcError(-32602, "_meta must be an object")
            modern = "io.modelcontextprotocol/protocolVersion" in meta
            if modern:
                requested = meta["io.modelcontextprotocol/protocolVersion"]
                if requested != MODERN:
                    raise RpcError(-32022, "Unsupported protocol version", {"supported": list(VERSIONS), "requested": requested})
                if not isinstance(meta.get("io.modelcontextprotocol/clientCapabilities"), dict):
                    raise RpcError(-32602, "Per-request clientCapabilities is required")
            elif method == "initialize":
                requested = params.get("protocolVersion")
                if not isinstance(requested, str) or not isinstance(params.get("capabilities"), dict) or not isinstance(params.get("clientInfo"), dict):
                    raise RpcError(-32602, "Initialize requires protocolVersion, capabilities and clientInfo")
                self.version = requested if requested in LEGACY else LEGACY[0]
                self.initialized = False
                return {"jsonrpc": "2.0", "id": identifier, "result": {"protocolVersion": self.version, "capabilities": CAPABILITIES, "serverInfo": SERVER, "instructions": INSTRUCTIONS}}
            elif method != "ping" and not self.initialized:
                raise RpcError(-32002, "Initialize the MCP connection first, or use per-request protocol metadata")
            if method == "server/discover" and modern:
                result = {"supportedVersions": list(VERSIONS), "capabilities": CAPABILITIES,
                          "instructions": INSTRUCTIONS, "ttlMs": 60000, "cacheScope": "private"}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                if params.get("cursor"):
                    raise RpcError(-32602, "This tool list has no pagination cursor")
                result = {"tools": TOOLS}
            elif method == "tools/call":
                name = params.get("name")
                if not isinstance(name, str) or name not in BY_NAME:
                    raise RpcError(-32602, "Unknown tool: " + str(name))
                arguments = params.get("arguments", {})
                try:
                    result = tool_result(call_tool(name, arguments))
                except lumen.ApiError as error:
                    result = {"content": [{"type": "text", "text": str(error)}], "isError": True,
                              "structuredContent": {"ok": False, "code": error.code, "error": str(error), "http_status": error.status,
                                                    "detail": error.detail, "next_step": "If submission outcome is uncertain, retry the same request_id or inspect existing jobs; do not create a fresh request_id."}}
                except (OSError, ValueError) as error:
                    result = {"content": [{"type": "text", "text": str(error)}], "isError": True,
                              "structuredContent": {"ok": False, "code": "LOCAL_INPUT_ERROR", "error": str(error)}}
                if not modern and self.version in {"2024-11-05", "2025-03-26"}:
                    result["content"] = [item for item in result["content"] if item["type"] == "text"]
                    result.pop("structuredContent", None)
            else:
                raise RpcError(-32601, "Unknown method: " + method)
            if modern:
                result = {**result, "resultType": "complete", "_meta": {"io.modelcontextprotocol/serverInfo": SERVER}}
            return {"jsonrpc": "2.0", "id": identifier, "result": result}
        except RpcError as error:
            body = {"code": error.code, "message": str(error)}
            if error.data is not None:
                body["data"] = error.data
            return {"jsonrpc": "2.0", "id": identifier, "error": body}


def serve(input_stream=None, output_stream=None):
    incoming, outgoing = input_stream or sys.stdin.buffer, output_stream or sys.stdout
    server, output_lock, pending_lock = Server(), threading.Lock(), threading.Lock()
    pending, slots = {}, threading.BoundedSemaphore(4)

    def emit(value):
        if value is not None:
            with output_lock:
                outgoing.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
                outgoing.flush()

    def execute(message, cancelled):
        try:
            response = server.handle(message)
            if not cancelled.is_set():
                emit(response)
        except Exception as error:
            print("Lumen MCP request failed: " + str(error), file=sys.stderr)
            if not cancelled.is_set():
                emit({"jsonrpc": "2.0", "id": message.get("id"), "error": {"code": -32603, "message": "Local tool request failed; inspect Lumen status before retrying"}})
        finally:
            with pending_lock:
                pending.pop(message.get("id"), None)
            slots.release()

    try:
        while True:
            line = incoming.readline(32 * 1024 * 1024 + 1)
            if not line:
                return
            try:
                if len(line) > 32 * 1024 * 1024:
                    emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "MCP message exceeds 32 MiB"}})
                    return
                message = json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
            except (ValueError, UnicodeError):
                emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid UTF-8 JSON"}})
                continue
            if isinstance(message, dict) and message.get("method") == "notifications/cancelled" and "id" not in message:
                params = message.get("params")
                identifier = params.get("requestId") if isinstance(params, dict) else None
                with pending_lock:
                    if isinstance(identifier, (str, int)) and identifier in pending:
                        pending[identifier].set()
                continue
            if isinstance(message, dict) and message.get("method") == "tools/call" and isinstance(message.get("id"), (str, int)) and not isinstance(message["id"], bool):
                with pending_lock:
                    if message["id"] in pending:
                        emit({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32600, "message": "Request id already in flight"}})
                        continue
                    if not slots.acquire(False):
                        emit({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": "Too many in-flight calls; poll or retry later"}})
                        continue
                    cancelled = threading.Event()
                    pending[message["id"]] = cancelled
                threading.Thread(target=execute, args=(message, cancelled), daemon=True).start()
            else:
                emit(server.handle(message))
    finally:
        with pending_lock:
            for cancelled in pending.values():
                cancelled.set()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8088", help="Existing local Lumen service URL")
    args = parser.parse_args()
    configure_url(args.url)
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        serve()
    except (BrokenPipeError, KeyboardInterrupt):
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
