"""Agent CLI lifecycle and output contracts; no actual desktop or engine jobs."""
from contextlib import redirect_stdout
from dataclasses import replace
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import lumen


class AgentCliTests(unittest.TestCase):
    ready = {"desktop": True, "comfyui_running": True, "progress_connected": True,
             "models": {"fl2va": {"available": True}}}

    def setUp(self):
        runtime = tempfile.TemporaryDirectory()
        self.addCleanup(runtime.cleanup)
        for name, filename in (("PYTHONW", "pythonw.exe"), ("DESKTOP", "desktop.py")):
            entry = Path(runtime.name) / filename
            entry.touch()
            patched = patch.object(lumen, name, entry)
            patched.start()
            self.addCleanup(patched.stop)
        self.output = io.StringIO()
        capture = redirect_stdout(self.output)
        capture.__enter__()
        self.addCleanup(capture.__exit__, None, None, None)
        self.addCleanup(setattr, lumen, "JSON_MODE", False)
        self.addCleanup(setattr, lumen, "API_URL", lumen.API_URL)
        self.addCleanup(setattr, lumen, "RESULT", None)
        self.now = 0

    def advance(self, seconds):
        self.now += seconds

    def test_ensure_waits_for_progress_and_launches_original_entry_only_once(self):
        waiting = {**self.ready, "progress_connected": False}
        with patch.object(lumen, "request_json", side_effect=[lumen.ConnectionUnavailable("off"), waiting, self.ready]), \
             patch.object(lumen.subprocess, "Popen") as spawn, \
             patch.object(lumen.time, "sleep", side_effect=self.advance), \
             patch.object(lumen.time, "monotonic", side_effect=lambda: self.now):
            state = lumen.ensure_service(timeout=10)
        self.assertTrue(state["progress_connected"])
        spawn.assert_called_once()
        self.assertEqual(spawn.call_args.args[0], [str(lumen.PYTHONW), str(lumen.DESKTOP)])
        self.assertEqual(spawn.call_args.kwargs["cwd"], str(lumen.ROOT))
        self.assertEqual(self.output.getvalue(), "")

    def test_already_ready_reuses_desktop_without_spawn(self):
        with patch.object(lumen, "request_json", return_value=self.ready), patch.object(lumen.subprocess, "Popen") as spawn:
            self.assertEqual(lumen.ensure_service(), self.ready)
        spawn.assert_not_called()

    def test_existing_desktop_with_stopped_engine_starts_it_through_owner_api(self):
        stopped = {**self.ready, "comfyui_running": False, "engine": {"owned": False, "error": None}}
        with patch.object(lumen, "request_json", side_effect=[stopped, {"ok": True}, self.ready]) as api, \
             patch.object(lumen.subprocess, "Popen") as spawn, patch.object(lumen.time, "sleep", side_effect=self.advance), \
             patch.object(lumen.time, "monotonic", side_effect=lambda: self.now):
            self.assertEqual(lumen.ensure_service(timeout=10), self.ready)
        spawn.assert_not_called()
        self.assertEqual([call.args for call in api.call_args_list], [
            ("/api/system",), ("/api/comfyui/start", "POST", {}), ("/api/system",)])

    def test_start_waits_through_desktop_boot_without_spawning_twice(self):
        args = lumen.parser().parse_args(["start", "--timeout", "10"])
        with patch.object(lumen, "request_json", side_effect=[lumen.ConnectionUnavailable("booting"), self.ready]), \
             patch.object(lumen.subprocess, "Popen") as spawn, patch.object(lumen.time, "sleep", side_effect=self.advance), \
             patch.object(lumen.time, "monotonic", side_effect=lambda: self.now):
            self.assertEqual(lumen.cmd_start(args), 0)
        spawn.assert_called_once()

    def test_timeout_never_claims_ready_or_submits(self):
        with patch.object(lumen, "request_json", return_value={**self.ready, "progress_connected": False}) as api, \
             patch.object(lumen.time, "sleep", side_effect=self.advance), \
             patch.object(lumen.time, "monotonic", side_effect=lambda: self.now):
            with self.assertRaises(lumen.ApiError) as error:
                lumen.ensure_service(timeout=.1, launch=False)
        self.assertEqual(error.exception.code, "RUNTIME_NOT_READY")
        self.assertFalse(error.exception.detail["submitted"])
        self.assertTrue(all(call.args[0] == "/api/system" for call in api.call_args_list))

    def test_no_takeover_of_other_server_or_model_download(self):
        states = [({"desktop": False}, "SERVICE_MISMATCH"),
                  ({**self.ready, "models": {"ref2va": {"available": False}}}, "MODEL_MISSING"),
                  ({**self.ready, "comfyui_running": False, "engine": {"error": "8188 is occupied"}}, "RUNTIME_NOT_READY"),
                  ({**self.ready, "engine": {"error": "8188 belongs to another engine"}}, "RUNTIME_NOT_READY")]
        for state, code in states:
            with self.subTest(code=code), patch.object(lumen, "request_json", return_value=state), \
                 patch.object(lumen.subprocess, "Popen") as spawn:
                with self.assertRaises(lumen.ApiError) as error:
                    lumen.ensure_service()
                self.assertEqual(error.exception.code, code)
                spawn.assert_not_called()
        lumen.API_URL = "http://127.0.0.1:12345"
        with patch.object(lumen, "request_json", side_effect=lumen.ConnectionUnavailable("off")), patch.object(lumen.subprocess, "Popen") as spawn:
            with self.assertRaises(lumen.ApiError):
                lumen.ensure_service()
            spawn.assert_not_called()

    def test_invalid_start_timeout_does_not_launch(self):
        for timeout in (0, -1, float("nan"), float("inf"), 901, True):
            with self.subTest(timeout=timeout), patch.object(lumen, "launch_desktop") as spawn:
                with self.assertRaises(lumen.ApiError):
                    lumen.cmd_start(type("Args", (), {"timeout": timeout})())
                spawn.assert_not_called()

    def test_chat_ensures_runtime_and_waits_for_existing_local_files(self):
        args = lumen.parser().parse_args(["chat", "--prompt", "海边灯塔，镜头推进", "--preset-id", "hero",
                                         "--seed", "0", "--request-id", "once", "--wait"])
        calls = []
        file = {"local_path": "C:/fixture/result.mp4", "url": "/videos/video/result.mp4", "mime_type": "video/mp4"}
        def api(path, method="GET", payload=None, **kwargs):
            calls.append((path, method, payload))
            if path == "/api/agent/generate":
                return {"record_id": "record", "prompt_id": "prompt", "status": "submitting"}
            if path == "/api/agent/jobs/record":
                return {"task": {"status": "done"}}
            if path == "/api/agent/jobs/record/result":
                return {"ready": True, "record_id": "record", "status": "done", "files": [file]}
            raise AssertionError(path)
        with patch.object(lumen, "ensure_service", return_value=self.ready) as ensure, patch.object(lumen, "request_json", side_effect=api):
            self.assertEqual(lumen.cmd_chat(args), 0)
        ensure.assert_called_once_with(timeout=180)
        self.assertEqual(calls[0][2]["request_id"], "once")
        self.assertEqual(calls[0][2]["params"], {"seed": 0})
        self.assertEqual(calls[0][2]["preset_ids"], ["hero"])
        self.assertEqual(lumen.RESULT["files"], [file])

    def test_chat_unknown_submission_keeps_request_id_without_retry(self):
        args = lumen.parser().parse_args(["chat", "--prompt", "海岸", "--request-id", "same-id"])
        with patch.object(lumen, "ensure_service", return_value=self.ready), \
             patch.object(lumen, "request_json", side_effect=lumen.ConnectionUnavailable("timeout")) as api:
            with self.assertRaises(lumen.ApiError) as error:
                lumen.cmd_chat(args)
        self.assertEqual(error.exception.code, "OUTCOME_UNKNOWN")
        self.assertEqual(error.exception.detail["request_id"], "same-id")
        api.assert_called_once()

    def test_current_board_requires_revision_before_start(self):
        args = lumen.parser().parse_args(["chat", "--current-board"])
        with patch.object(lumen, "ensure_service") as ensure, self.assertRaises(lumen.ApiError):
            lumen.cmd_chat(args)
        ensure.assert_not_called()

    def test_invalid_wait_timeout_rejects_before_start_or_submit(self):
        for timeout in ("-1", "nan", "inf"):
            args = lumen.parser().parse_args(["chat", "--prompt", "海岸", "--wait", "--timeout", timeout])
            with self.subTest(timeout=timeout), patch.object(lumen, "ensure_service") as ensure, \
                 patch.object(lumen, "request_json") as request, self.assertRaises(lumen.ApiError):
                lumen.cmd_chat(args)
            ensure.assert_not_called()
            request.assert_not_called()

    def test_job_wait_timeout_is_resumable_and_not_cancelled(self):
        with patch.object(lumen, "request_json", return_value={"task": {"status": "running"}}) as api, \
             patch.object(lumen.time, "sleep", side_effect=self.advance), patch.object(lumen.time, "monotonic", side_effect=lambda: self.now):
            self.assertEqual(lumen.wait_for_job("saved-job", timeout=.1), 2)
        self.assertFalse(lumen.RESULT["cancelled"])
        self.assertEqual(lumen.RESULT["record_id"], "saved-job")
        self.assertTrue(all(call.args[0] == "/api/agent/jobs/saved-job" for call in api.call_args_list))

    def test_done_without_verified_files_is_not_success(self):
        for status in ("done", "failed", "interrupted", "cancelled"):
            with self.subTest(status=status), patch.object(lumen, "request_json", side_effect=[
                    {"task": {"status": status}}, {"status": status, "ready": False, "files": []}]):
                self.assertEqual(lumen.wait_for_job("record"), 1)

    def test_doctor_is_read_only_and_reports_size_not_hash_verification(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "models").mkdir()
            (root / "models/weight").write_bytes(b"data")
            (root / "python.exe").touch()
            (root / "main.py").touch()
            (root / "desktop.py").touch()
            (root / "models-manifest.json").write_text(json.dumps({"models": [{"id": "model", "path": "weight", "size": 4}]}))
            config = replace(lumen.CONFIG, comfy_dir=root, engine_python=root / "python.exe")
            with patch.object(lumen, "ROOT", root), patch.object(lumen, "CONFIG", config), patch.object(lumen, "DESKTOP", root / "desktop.py"), \
                 patch.object(lumen, "request_json", side_effect=lumen.ConnectionUnavailable("off")), patch.object(lumen, "launch_desktop") as launch:
                lumen.cmd_doctor(None)
            launch.assert_not_called()
            self.assertTrue(lumen.RESULT["installation_ready"])
            self.assertFalse(lumen.RESULT["service"]["reachable"])
            self.assertEqual(lumen.RESULT["verification"], "file-size; full hashes not reread")


if __name__ == "__main__":
    unittest.main()
