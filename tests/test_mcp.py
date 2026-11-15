"""MCP transport and real local HTTP, always isolated from the user's app/GPU."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lumen
import lumen_mcp as mcp


def request(method, params=None, identifier=1, modern=True):
    params = copy.deepcopy(params or {})
    if modern:
        params["_meta"] = {"io.modelcontextprotocol/protocolVersion": mcp.MODERN,
                           "io.modelcontextprotocol/clientCapabilities": {}}
    return {"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}


class McpTests(unittest.TestCase):
    def setUp(self):
        self.server = mcp.Server()
        old_url, old_http = lumen.API_URL, lumen.HTTP
        self.addCleanup(setattr, lumen, "API_URL", old_url)
        self.addCleanup(setattr, lumen, "HTTP", old_http)

    def call(self, name, arguments=None, modern=True):
        return self.server.handle(request("tools/call", {"name": name, "arguments": arguments or {}}, modern=modern))

    def initialize(self, version="2025-11-25"):
        response = self.server.handle(request("initialize", {"protocolVersion": version, "capabilities": {},
                                      "clientInfo": {"name": "fixture", "version": "1"}}, modern=False))
        self.server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return response

    def test_modern_discovery_and_tools_are_side_effect_free(self):
        with patch.object(lumen, "ensure_service", side_effect=AssertionError("No launch")), \
                patch.object(lumen, "request_json", side_effect=AssertionError("No HTTP")):
            result = self.server.handle(request("server/discover"))["result"]
            self.assertIn("2026-07-28", result["supportedVersions"])
            self.assertEqual(result["resultType"], "complete")
            listed = self.server.handle(request("tools/list"))["result"]
            names = [tool["name"] for tool in listed["tools"]]
            self.assertEqual(len(names), len(set(names)))
            self.assertIn("lumen_generate", names)
            self.assertIn("lumen_result", names)
            self.assertEqual(listed["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "lumen-local")

    def test_legacy_handshakes_negotiate_without_modern_metadata(self):
        for version in mcp.LEGACY:
            self.server = mcp.Server()
            self.assertEqual(self.initialize(version)["result"]["protocolVersion"], version)
            self.assertIn("tools", self.server.handle(request("tools/list", modern=False))["result"])
        self.server = mcp.Server()
        self.assertEqual(self.initialize("unknown")["result"]["protocolVersion"], mcp.LEGACY[0])

    def test_version_mismatch_missing_capabilities_and_uninitialized_calls_are_errors(self):
        message = request("server/discover")
        message["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] = "2099-01-01"
        response = self.server.handle(message)
        self.assertEqual(response["error"]["code"], -32022)
        self.assertIn(mcp.MODERN, response["error"]["data"]["supported"])
        message = request("tools/list")
        del message["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"]
        self.assertEqual(self.server.handle(message)["error"]["code"], -32602)
        self.assertEqual(self.server.handle(request("tools/list", modern=False))["error"]["code"], -32002)

    def test_invalid_messages_tools_and_argument_types_do_not_reach_http(self):
        with patch.object(lumen, "request_json", side_effect=AssertionError("No HTTP")):
            for message in ([1], {"jsonrpc": "1.0", "method": "tools/list", "id": 1}, request("tools/list", identifier=True)):
                self.assertEqual(self.server.handle(message)["error"]["code"], -32600)
            for name, arguments in (("missing", {}), ("lumen_job", {"record_id": []}),
                                    ("lumen_generate", {"prompt": "Hello"}),
                                    ("lumen_connect", {"timeout": True}),
                                    ("lumen_connect", {"timeout": 181}),
                                    ("lumen_assets", {"category": "unknown"}),
                                    ("lumen_board_apply", {"expected_revision": "r", "operations": []}),
                                    ("lumen_generate", {"request_id": "once", "prompt": "Hello", "board": {}}),
                                    ("lumen_generate", {"request_id": "once", "use_current_board": False, "expected_revision": "r"}),
                                    ("lumen_preview", {"operations": []})):
                with self.subTest(name=name, arguments=arguments):
                    self.assertEqual(self.call(name, arguments)["error"]["code"], -32602)

    def test_board_revision_and_generation_request_id_are_forwarded_exactly_once(self):
        body = {"expected_revision": "original-revision", "request_id": "edit-once", "operations": [{"op": "set_params", "value": {"seed": 0}}]}
        with patch.object(lumen, "request_json", return_value={"ok": True}) as api:
            self.call("lumen_board_apply", body)
            self.assertEqual(api.call_args.args, ("/api/agent/board/operations", "POST", body))
            generation = {"request_id": "stable-generation-id", "use_current_board": True, "expected_revision": "original-revision"}
            self.call("lumen_generate", generation)
            self.assertEqual(api.call_args.args, ("/api/agent/generate", "POST", generation))
            self.assertEqual(api.call_count, 2)

    def test_runtime_connect_only_launches_when_the_named_tool_is_called(self):
        with patch.object(lumen, "ensure_service", return_value={"desktop": True, "comfyui_running": True}) as ensure:
            self.server.handle(request("tools/list"))
            ensure.assert_not_called()
            value = self.call("lumen_connect", {"timeout": 30})["result"]["structuredContent"]
        ensure.assert_called_once_with(timeout=30, launch=True)
        self.assertTrue(value["system"]["comfyui_running"])

    def test_http_errors_preserve_conflicts_and_uncertain_outcome_instead_of_retrying(self):
        error = lumen.ApiError("changed", "REVISION_CONFLICT", 409, {"current_revision": "new"})
        with patch.object(lumen, "request_json", side_effect=error) as api:
            value = self.call("lumen_job", {"record_id": "abc"})["result"]
        self.assertTrue(value["isError"])
        self.assertEqual(value["structuredContent"]["code"], "REVISION_CONFLICT")
        self.assertEqual(value["structuredContent"]["detail"]["current_revision"], "new")
        self.assertEqual(api.call_count, 1)

    def test_verified_result_returns_video_link_without_inlining_binary_data(self):
        with tempfile.TemporaryDirectory() as folder:
            video = Path(folder) / "虚构镜头.mp4"
            video.write_bytes(b"isolated-file")
            output = {"ready": True, "files": [{"local_path": str(video), "name": video.name,
                      "size_bytes": video.stat().st_size, "mime_type": "video/mp4", "url": "http://127.0.0.1:8088/videos/synthetic.mp4"}]}
            with patch.object(lumen, "request_json", return_value=output):
                result = self.call("lumen_result", {"record_id": "abc"})["result"]
                self.assertEqual(result["content"][1]["type"], "resource_link")
                self.assertEqual(result["content"][1]["uri"], video.as_uri())
                self.assertEqual(result["content"][1]["mimeType"], "video/mp4")
                self.assertEqual(result["content"][1]["size"], 13)
                self.assertNotIn("data", result["content"][1])
                self.initialize("2024-11-05")
                old = self.call("lumen_result", {"record_id": "abc"}, modern=False)["result"]
                self.assertEqual(len(old["content"]), 1)
                self.assertNotIn("structuredContent", old)
            with patch.object(lumen, "request_json", return_value={"ready": False, "files": []}):
                self.assertEqual(len(self.call("lumen_result", {"record_id": "abc"})["result"]["content"]), 1)

    def test_loopback_configuration_rejects_external_or_ambiguous_urls(self):
        for url in ("https://127.0.0.1:8088", "http://example.com", "http://127.0.0.1:8088/a", "http://u:p@localhost:8088", "http://localhost:0", "http://localhost:99999", "http://localhost/?key=x"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                mcp.configure_url(url)
        mcp.configure_url("http://127.0.0.1:12345")
        self.assertEqual(lumen.API_URL, "http://127.0.0.1:12345")

    def test_parse_errors_notifications_and_ping_use_only_protocol_stdout(self):
        output = io.StringIO()
        messages = b'not-json\n' + json.dumps(request("ping", modern=False)).encode() + b'\n' + b'{"jsonrpc":"2.0","method":"notifications/cancelled","params":[]}' + b'\n'
        mcp.serve(io.BytesIO(messages), output)
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["error"]["code"], -32700)
        self.assertEqual(lines[1]["result"], {})

    @unittest.skipUnless(os.name == "nt", "Windows batch launcher")
    def test_batch_launcher_is_cwd_independent_and_emits_only_protocol_json(self):
        message = request("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                          "clientInfo": {"name": "fixture", "version": "1"}}, modern=False)
        with tempfile.TemporaryDirectory() as folder:
            completed = subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"), "/d", "/c",
                                        str(Path(mcp.__file__).with_name("Lumen-MCP.cmd"))],
                                       input=json.dumps(message) + "\n", cwd=folder, capture_output=True,
                                       text=True, encoding="utf-8", timeout=30,
                                       env={**os.environ, "LUMEN_ENGINE_PYTHON": sys.executable})
        self.assertEqual(completed.returncode, 0, completed.stderr)
        lines = completed.stdout.splitlines()
        self.assertEqual(len(lines), 1, completed.stdout)
        self.assertEqual(json.loads(lines[0])["result"]["serverInfo"]["name"], "lumen-local")

    def test_real_flask_generation_idempotency_and_file_return_over_stdio(self):
        import app as backend
        import lumen_core as core
        import tasks
        from contextlib import ExitStack
        from urllib.request import urlopen
        from werkzeug.serving import make_server, WSGIRequestHandler

        class QuietHandler(WSGIRequestHandler):
            def log(self, *args, **kwargs):
                pass

        with tempfile.TemporaryDirectory() as folder, ExitStack() as stack:
            root = Path(folder)
            board_file = root / "board.json"
            board = {"items": [{"id": "existing", "kind": "text", "role": "scene", "content": "保留原镜头"}],
                     "params": {"resolution": "608,352", "duration": 2, "steps": 8, "seed": 0}, "zones": [], "connections": []}
            board_file.write_text(json.dumps(board), encoding="utf-8")
            for name, value in {"LIB_DIR": folder, "INPUT_DIR": folder, "OUTPUT_DIR": str(root / "output"),
                                "RECORDS_FILE": str(root / "records.json"), "MEMORY_FILE": str(root / "memory.json")}.items():
                stack.enter_context(patch.object(core, name, value))
            manager = tasks.TaskManager()
            manager.ready.set()
            stack.enter_context(patch.object(tasks, "manager", manager))
            stack.enter_context(patch.object(backend, "BOARD_FILE", str(board_file)))
            stack.enter_context(patch.object(backend, "start_services", return_value=None))
            stack.enter_context(patch.object(backend.engine_runtime, "state", return_value={"owned": True}))
            stack.enter_context(patch.object(core, "comfyui_running", return_value=True))
            stack.enter_context(patch.object(core, "model_status", return_value={"fl2va": {"available": True}, "ref2va": {"available": True}}))
            submit = stack.enter_context(patch.object(core, "comfy_post", side_effect=lambda path, payload, **kw: {"prompt_id": payload["prompt_id"]}))
            http = make_server("127.0.0.1", 0, backend.app, threaded=True, request_handler=QuietHandler)
            threading.Thread(target=http.serve_forever, daemon=True).start()
            stack.callback(http.server_close)
            stack.callback(http.shutdown)
            url = "http://127.0.0.1:" + str(http.server_port)
            process = subprocess.Popen([sys.executable, "-u", str(Path(mcp.__file__)), "--url", url],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, encoding="utf-8")
            responses = queue.Queue()

            def read():
                for line in process.stdout:
                    responses.put(json.loads(line))

            threading.Thread(target=read, daemon=True).start()
            number = 0

            def call(name, arguments):
                nonlocal number
                number += 1
                process.stdin.write(json.dumps(request("tools/call", {"name": name, "arguments": arguments}, number)) + "\n")
                process.stdin.flush()
                result = responses.get(timeout=10)
                self.assertEqual(result["id"], number)
                self.assertNotIn("error", result)
                return result["result"]

            try:
                payload = {"request_id": "mcp-real-http-once", "prompt": "虚构海面，镜头缓缓推进。", "params": {"seed": 0}}
                first = call("lumen_generate", payload)["structuredContent"]
                second = call("lumen_generate", payload)["structuredContent"]
                self.assertEqual(first["record_id"], second["record_id"])
                self.assertTrue(second["replayed"])
                self.assertEqual(submit.call_count, 1)
                self.assertEqual(json.loads(board_file.read_text(encoding="utf-8")), board)
                waiting = call("lumen_result", {"record_id": first["record_id"]})
                self.assertFalse(waiting["structuredContent"]["ready"])
                self.assertEqual(len(waiting["content"]), 1)
                video = root / "output" / "video" / "isolated.mp4"
                video.parent.mkdir(parents=True)
                video.write_bytes(b"synthetic output, not a generated or decoded video")
                core.update_record(first["record_id"], status="done", outputs=[{"sub": "video", "name": video.name}])
                result = call("lumen_result", {"record_id": first["record_id"]})
                self.assertTrue(result["structuredContent"]["ready"])
                self.assertEqual(result["content"][1]["uri"], video.as_uri())
                file = result["structuredContent"]["files"][0]
                with urlopen(file["download_url"], timeout=3) as response:
                    self.assertEqual(response.read(), video.read_bytes())
                core.update_record(first["record_id"], outputs=[{"sub": "video", "name": "missing.mp4"}])
                self.assertFalse(call("lumen_result", {"record_id": first["record_id"]})["structuredContent"]["ready"])
            finally:
                process.stdin.close()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
                for stream in (process.stdout, process.stderr):
                    stream.close()


class StdioHttpTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.video = self.root / "synthetic.mp4"
        self.video.write_bytes(b"synthetic-local-result")
        self.requests = []
        self.slow_entered, self.slow_release = threading.Event(), threading.Event()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def handle_request(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                owner.requests.append((self.command, self.path, body))
                status = 200
                if self.path == "/api/agent/board":
                    value = {"ok": True, "revision": "fixture-revision", "board": {"items": [], "params": {"seed": 0}}}
                elif self.path == "/api/asset-presets?q=%E6%B5%B7%E8%BE%B9&category=scene":
                    value = {"ok": True, "presets": [{"id": "coast", "name": "海边"}]}
                elif self.path == "/api/agent/board/operations":
                    value = {"ok": False, "code": "REVISION_CONFLICT", "error": "changed", "current_revision": "new"}
                    status = 409
                elif self.path == "/api/upload":
                    value = {"ok": True, "name": "server-owned.png"}
                elif self.path == "/api/agent/jobs/synthetic/result":
                    value = {"ok": True, "ready": True, "files": [{"local_path": str(owner.video), "name": owner.video.name, "mime_type": "video/mp4", "size_bytes": owner.video.stat().st_size}]}
                elif self.path == "/api/agent/jobs/slow":
                    owner.slow_entered.set()
                    owner.slow_release.wait(10)
                    value = {"ok": True, "status": "running"}
                elif self.path == "/api/agent/generate":
                    value = {"ok": True, "record_id": "synthetic", "prompt_id": "prompt-synthetic", "status": "queued"}
                else:
                    value = {"ok": True, "status": "running"}
                encoded = json.dumps(value, ensure_ascii=False).encode("utf-8")
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                except (OSError, BrokenPipeError):
                    pass

            do_GET = handle_request
            do_POST = handle_request

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=self.http.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        self.url = "http://127.0.0.1:" + str(self.http.server_port)
        self.process = subprocess.Popen([sys.executable, "-u", str(Path(mcp.__file__)), "--url", self.url],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        self.addCleanup(self.close_process)
        self.responses = queue.Queue()
        threading.Thread(target=self.read_responses, daemon=True).start()

    def read_responses(self):
        for line in self.process.stdout:
            self.responses.put(json.loads(line))

    def close_process(self):
        self.slow_release.set()
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        for stream in (self.process.stdout, self.process.stderr):
            stream.close()

    def send(self, message):
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def rpc(self, method, params=None, identifier=1):
        self.send(request(method, params, identifier))
        value = self.responses.get(timeout=8)
        self.assertEqual(value["id"], identifier)
        return value

    def tool(self, name, arguments=None, identifier=1):
        return self.rpc("tools/call", {"name": name, "arguments": arguments or {}}, identifier)

    def test_real_stdio_http_board_upload_generate_and_result(self):
        self.assertIn(mcp.MODERN, self.rpc("server/discover")["result"]["supportedVersions"])
        board = self.tool("lumen_board_get")["result"]["structuredContent"]
        self.assertEqual(board["revision"], "fixture-revision")
        presets = self.tool("lumen_assets", {"query": "海边", "category": "scene"})["result"]["structuredContent"]
        self.assertEqual(presets["presets"][0]["name"], "海边")
        file = self.root / "中文图.png"
        file.write_bytes(b"synthetic-image")
        self.assertEqual(self.tool("lumen_upload", {"local_path": str(file)})["result"]["structuredContent"]["name"], "server-owned.png")
        self.assertIn(b"synthetic-image", self.requests[-1][2])
        payload = {"request_id": "do-not-change-id", "prompt": "虚构海边", "params": {"seed": 0}}
        job = self.tool("lumen_generate", payload)["result"]["structuredContent"]
        self.assertEqual(job["record_id"], "synthetic")
        self.assertEqual(json.loads(self.requests[-1][2]), payload)
        files = self.tool("lumen_result", {"record_id": "synthetic"})["result"]
        self.assertEqual(files["content"][1]["uri"], self.video.as_uri())
        conflict = self.tool("lumen_board_apply", {"expected_revision": "old", "request_id": "once", "operations": []})["result"]
        self.assertTrue(conflict["isError"])
        self.assertEqual(conflict["structuredContent"]["code"], "REVISION_CONFLICT")
        self.assertEqual(self.process.poll(), None)

    def test_cancelled_request_suppresses_response_and_keeps_server_responsive(self):
        self.send(request("tools/call", {"name": "lumen_job", "arguments": {"record_id": "slow"}}, identifier=7))
        self.assertTrue(self.slow_entered.wait(5))
        self.send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 7}})
        self.assertEqual(self.rpc("ping", identifier=8)["result"]["resultType"], "complete")
        self.slow_release.set()
        with self.assertRaises(queue.Empty):
            self.responses.get(timeout=.3)
        self.assertFalse(any("cancel" in path for _, path, _ in self.requests))


if __name__ == "__main__":
    unittest.main()
