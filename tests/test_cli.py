"""CLI contract tests never start the desktop or access a live server."""
from contextlib import redirect_stdout
import copy
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lumen


class CliTests(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        self.capture = redirect_stdout(self.output)
        self.capture.__enter__()
        self.addCleanup(self.capture.__exit__, None, None, None)

    @staticmethod
    def budget(expensive=False):
        return dict(frames=56, actual_duration=2.33, estimate_label="No measured estimate",
                    warnings=[], requires_confirmation=expensive)

    def generate_api(self, expensive=False):
        calls = []
        def api(path, method="GET", payload=None, **kwargs):
            calls.append((path, method, copy.deepcopy(payload)))
            if path == "/api/system":
                return {"desktop": True}
            if path == "/api/estimate":
                return self.budget(expensive)
            if path == "/api/generate":
                return {"record_id": "record-a", "prompt_id": "prompt-a"}
            raise AssertionError(path)
        return api, calls

    def test_start_uses_absolute_windowless_desktop_entry(self):
        with patch.object(lumen.subprocess, "Popen") as spawn, patch.object(lumen, "request_json", return_value={
            "desktop": True, "comfyui_running": True, "progress_connected": True
        }):
            self.assertEqual(lumen.cmd_start(None), 0)
        self.assertEqual(spawn.call_args.args[0], [str(lumen.PYTHONW), str(lumen.DESKTOP)])
        self.assertTrue(lumen.PYTHONW.is_absolute())
        self.assertEqual(spawn.call_args.kwargs["stdout"], lumen.subprocess.DEVNULL)

    def test_stop_uses_desktop_close_not_global_engine_kill(self):
        with patch.object(lumen.subprocess, "run") as run, patch.object(lumen, "request_json", side_effect=lumen.ConnectionUnavailable("offline")):
            self.assertEqual(lumen.cmd_stop(None), 0)
        self.assertEqual(run.call_args.args[0], [str(lumen.PYTHONW), str(lumen.DESKTOP), "--close"])

    def test_preview_uses_preflight_and_preserves_seed_zero(self):
        api, calls = self.generate_api()
        args = lumen.parser().parse_args(["generate", "--prompt", "A lighthouse", "--seed", "0", "--confirm-expensive"])
        with patch.object(lumen, "request_json", side_effect=api):
            self.assertEqual(lumen.cmd_generate(args), 0)
        self.assertEqual([c[0] for c in calls], ["/api/system", "/api/estimate", "/api/generate"])
        payload = calls[-1][2]
        self.assertNotIn("confirm_expensive", payload)
        self.assertEqual(payload["params"]["seed"], 0)
        self.assertEqual(payload["params"]["resolution"], "608,352")

    def test_expensive_job_requires_explicit_cli_flag(self):
        api, calls = self.generate_api(expensive=True)
        args = lumen.parser().parse_args(["generate", "--prompt", "A lighthouse"])
        with patch.object(lumen, "request_json", side_effect=api), self.assertRaises(lumen.ApiError):
            lumen.cmd_generate(args)
        self.assertNotIn("/api/generate", [c[0] for c in calls])

    def test_expensive_flag_is_passed_when_required(self):
        api, calls = self.generate_api(expensive=True)
        args = lumen.parser().parse_args(["generate", "--prompt", "A lighthouse", "--confirm-expensive"])
        with patch.object(lumen, "request_json", side_effect=api):
            lumen.cmd_generate(args)
        self.assertTrue(calls[-1][2]["confirm_expensive"])

    def test_generate_rejects_standalone_web_service(self):
        args = lumen.parser().parse_args(["generate", "--prompt", "A lighthouse"])
        with patch.object(lumen, "request_json", return_value={"desktop": False}) as api, self.assertRaises(lumen.ApiError):
            lumen.cmd_generate(args)
        api.assert_called_once_with("/api/system")

    def test_upload_uses_api_multipart(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "first.png"
            source.write_bytes(b"fixture-image")
            with patch.object(lumen, "request_json", return_value={"name": "upload_a.png"}) as api:
                self.assertEqual(lumen.upload_image(source), "upload_a.png")
            self.assertEqual(api.call_args.args, ("/api/upload", "POST"))
            self.assertIn(b"fixture-image", api.call_args.kwargs["body"])
            self.assertIn('multipart/form-data; boundary=', api.call_args.kwargs["content_type"])

    def test_wait_requires_success_with_output(self):
        with patch.object(lumen, "request_json", side_effect=[
            {"status": "running", "progress": {"step": 8, "total": 8}},
            {"status": "done", "outputs": [{"sub": "video", "name": "result.mp4"}]},
        ]), patch.object(lumen.time, "sleep"):
            self.assertEqual(lumen.wait_for_task("prompt-a", "record-a"), 0)

    def test_done_boolean_does_not_turn_failure_into_success(self):
        for status in ("failed", "cancelled", "interrupted", "done"):
            with self.subTest(status=status), patch.object(lumen, "request_json", return_value={
                "done": True, "status": status, "outputs": [], "error": "No output"
            }):
                self.assertEqual(lumen.wait_for_task("prompt-a", "record-a"), 1)

    def test_wait_timeout_does_not_cancel_task(self):
        with patch.object(lumen, "request_json", return_value={"status": "running"}) as api, \
             patch.object(lumen.time, "monotonic", side_effect=[0, 2]):
            self.assertEqual(lumen.wait_for_task("prompt-a", "record-a", timeout=1), 2)
        self.assertEqual([c.args[0] for c in api.call_args_list], ["/api/status/prompt-a"])


if __name__ == "__main__":
    unittest.main()
