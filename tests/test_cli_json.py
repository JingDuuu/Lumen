"""Machine CLI output contracts; all HTTP calls are mocked."""
from contextlib import redirect_stdout, redirect_stderr
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import lumen


class CliJsonTests(unittest.TestCase):
    def setUp(self):
        self.old_url = lumen.API_URL
        self.addCleanup(setattr, lumen, "API_URL", self.old_url)
        self.addCleanup(setattr, lumen, "JSON_MODE", False)

    def run_cli(self, arguments, stdin=""):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr), patch.object(lumen.sys, "stdin", io.StringIO(stdin)):
            code = lumen.main(arguments)
        return code, json.loads(stdout.getvalue()), stderr.getvalue()

    def test_global_or_suffix_json_option_emits_one_object(self):
        for arguments in (["--json", "discover"], ["discover", "--json"]):
            with patch.object(lumen, "request_json", return_value={"endpoints": []}):
                code, result, _ = self.run_cli(arguments)
            self.assertEqual(code, 0)
            self.assertEqual(result["result"], {"endpoints": []})

    def test_rpc_reads_unicode_stdin_and_forwards_precondition_headers(self):
        with patch.object(lumen, "request_json", return_value={"ok": True}) as request:
            code, result, _ = self.run_cli(["api", "PUT", "/api/agent/board", "--input", "-", "--if-match", "revision", "--request-id", "once", "--json"], '\ufeff{"name":"虚构灯塔"}')
        self.assertEqual(code, 0)
        self.assertEqual(request.call_args.args[2], {"name":"虚构灯塔"})
        self.assertEqual(request.call_args.kwargs["headers"], {"If-Match":"revision", "Idempotency-Key":"once"})

    def test_parse_error_and_nonfinite_json_are_structured_invalid_input(self):
        for arguments, stdin in ((["unknown", "--json"], ""), (["preview", "--input", "-", "--json"], '{"value":NaN}')):
            code, result, _ = self.run_cli(arguments, stdin)
            self.assertEqual(code, 2)
            self.assertEqual(result["code"], "INVALID_INPUT")

    def test_remote_urls_are_rejected_before_http(self):
        with patch.object(lumen, "request_json") as request:
            code, result, _ = self.run_cli(["status", "--url", "https://example.com", "--json"])
        self.assertEqual(code, 2)
        request.assert_not_called()

    def test_offline_and_revision_conflict_keep_machine_codes(self):
        for error, expected in ((lumen.ConnectionUnavailable("offline"), 3),
                                (lumen.ApiError("changed", "REVISION_CONFLICT", 409, {"current_revision":"new"}), 5)):
            with patch.object(lumen, "request_json", side_effect=error):
                code, result, _ = self.run_cli(["board", "get", "--json"])
            self.assertEqual(code, expected)
            self.assertEqual(result["code"], error.code)

    def test_json_generate_preflights_and_waits_for_outputs(self):
        calls = []
        def api(path, method="GET", payload=None, **kwargs):
            calls.append((path, payload))
            if path == "/api/system":
                return {"desktop": True}
            if path == "/api/estimate":
                return {"frames":56,"actual_duration":2.333,"estimate_label":"fixture","warnings":[],"requires_confirmation":False}
            if path == "/api/generate":
                return {"record_id":"record-fixture","prompt_id":"prompt-fixture"}
            return {"status":"done","outputs":[{"name":"fixture.mp4","sub":"video"}]}
        payload = {"items":[{"id":"text","kind":"text","role":"scene","content":"Synthetic coast"}],"params":{"seed":0},"confirm_expensive":True}
        with patch.object(lumen, "request_json", side_effect=api):
            code, result, stderr = self.run_cli(["generate","--input","-","--wait","--json"], json.dumps(payload))
        self.assertEqual(code, 0)
        self.assertEqual(result["result"]["status"], "done")
        self.assertEqual([call[0] for call in calls], ["/api/system","/api/estimate","/api/generate","/api/status/prompt-fixture"])
        self.assertNotIn("confirm_expensive", calls[2][1])
        self.assertEqual(calls[2][1]["params"]["seed"], 0)
        self.assertTrue(stderr)

    def test_binary_download_requires_explicit_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / "package.zip"
            with patch.object(lumen, "request_http", return_value=(b"synthetic zip", {"Content-Type":"application/zip"}, 200)) as http:
                arguments = ["api","GET","/api/previs/documents/id/package","--output",str(destination),"--json"]
                code, result, _ = self.run_cli(arguments)
                self.assertEqual(code, 0)
                self.assertEqual(destination.read_bytes(), b"synthetic zip")
                code, result, _ = self.run_cli(arguments)
                self.assertEqual(code, 2)
                self.assertEqual(http.call_count, 1)

    def test_interrupt_returns_json_and_never_claims_task_cancelled(self):
        with patch.object(lumen, "request_json", side_effect=KeyboardInterrupt):
            code, result, _ = self.run_cli(["status", "--json"])
        self.assertEqual(code, 130)
        self.assertEqual(result["code"], "INTERRUPTED")


if __name__ == "__main__":
    unittest.main()
