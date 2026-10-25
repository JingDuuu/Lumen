"""Task recovery tests use a temporary library and mocked engine I/O only."""
import copy
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lumen_core as core
import tasks


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        for name, value in {
            "RECORDS_FILE": str(Path(self.folder.name) / "records.json"),
            "MEMORY_FILE": str(Path(self.folder.name) / "memory.json"),
            "INPUT_DIR": self.folder.name,
        }.items():
            p = patch.object(core, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.get = self._mock("comfy_get", side_effect=AssertionError("Unexpected engine GET"))
        self.post = self._mock("comfy_post", side_effect=AssertionError("Unexpected engine POST"))
        self._mock("extract_thumb", return_value=None)
        self.manager = tasks.TaskManager()

    def _mock(self, name, **kwargs):
        p = patch.object(core, name, **kwargs)
        self.addCleanup(p.stop)
        return p.start()

    def record(self, pid="prompt-a", status="running", **changes):
        r = core.create_record(pid, dict(resolution=[608, 352], duration=2, steps=8, seed=0),
                               {}, "A lighthouse at dusk", {}, [], {})
        return core.update_record(r["id"], status=status, created_at=time.time() - 60, **changes)

    @staticmethod
    def history(filename="Lumen_00001_.mp4"):
        # SaveVideo returns ui.PreviewVideo, whose current wire key is images.
        return {"status": {"status_str": "success", "completed": True, "messages": []},
                "outputs": {"14": {"images": [{"filename": filename, "subfolder": "video", "type": "output"}]}}}

    def engine(self, running=(), pending=(), history=None):
        q = {"queue_running": [[0, p] for p in running], "queue_pending": [[1, p] for p in pending]}
        h = history or {}
        def read(path, **kwargs):
            if path == "/queue":
                return copy.deepcopy(q)
            if path == "/history":
                return copy.deepcopy(h)
            if path.startswith("/history/"):
                pid = path.rsplit("/", 1)[1]
                return {pid: copy.deepcopy(h[pid])} if pid in h else {}
            raise AssertionError(path)
        self.get.side_effect = read
        return q, h

    def test_structured_execution_error_becomes_failed(self):
        r = self.record()
        self.manager.apply_history(r, {"status": {"status_str": "error", "messages": [
            ["execution_error", {"node_type": "SamplerCustomAdvanced", "exception_message": "CUDA out of memory"}]
        ]}})
        saved = core.get_record(r["id"])
        self.assertEqual(saved["status"], "failed")
        self.assertIn("CUDA out of memory", saved["error"])

    def test_savevideo_history_collects_output_once(self):
        r = self.record()
        entry = self.history()
        entry["outputs"]["14"]["videos"] = copy.deepcopy(entry["outputs"]["14"]["images"])
        entry["outputs"]["preview"] = {"images": [{"filename": "preview.png", "type": "temp"}]}
        self.manager.apply_history(r, entry)
        saved = core.get_record(r["id"])
        self.assertEqual(saved["status"], "done")
        self.assertEqual(saved["outputs"], [{"sub": "video", "name": "Lumen_00001_.mp4"}])

    def test_success_without_output_is_actionable_failure(self):
        r = self.record()
        self.manager.apply_history(r, {"status": {"completed": True}, "outputs": {}})
        self.assertEqual(core.get_record(r["id"])["status"], "failed")

    def test_missing_job_converges_after_three_confirmed_checks(self):
        r = self.record()
        self.engine()
        for _ in range(3):
            self.manager.reconcile()
        self.assertEqual(core.get_record(r["id"])["status"], "interrupted")

    def test_connection_outage_can_recover_completed_output(self):
        r = self.record()
        self.get.side_effect = OSError("temporarily unavailable")
        for _ in range(7):
            self.manager.reconcile()
        self.engine(history={r["prompt_id"]: self.history()})
        self.manager.reconcile()
        self.assertEqual(core.get_record(r["id"])["status"], "done")

    def test_pending_cancel_does_not_interrupt_unrelated_running_job(self):
        r = self.record(status="queued")
        q, _ = self.engine(running=["unrelated"], pending=[r["prompt_id"]])
        def post(path, payload, **kwargs):
            self.assertEqual(path, "/queue")
            self.assertEqual(payload, {"delete": [r["prompt_id"]]})
            q["queue_pending"] = []
            return {}
        self.post.side_effect = post
        self.manager.cancel(r["id"])
        self.assertEqual(core.get_record(r["id"])["status"], "cancelled")
        self.assertFalse(any(c.args[0] == "/interrupt" for c in self.post.call_args_list))

    def test_pending_to_running_race_uses_targeted_interrupt(self):
        r = self.record(status="queued")
        q, _ = self.engine(pending=[r["prompt_id"]])
        def post(path, payload, **kwargs):
            if path == "/queue":
                # The worker started this job just before queue deletion.
                q["queue_pending"] = []
                q["queue_running"] = [[0, r["prompt_id"]]]
            elif path != "/interrupt":
                raise AssertionError(path)
            return {}
        self.post.side_effect = post
        self.manager.cancel(r["id"])
        self.assertEqual(core.get_record(r["id"])["status"], "cancelling")
        interrupts = [c for c in self.post.call_args_list if c.args[0] == "/interrupt"]
        self.assertEqual(len(interrupts), 1)
        self.assertEqual(interrupts[0].args[1], {"prompt_id": r["prompt_id"]})

    def test_cancel_after_engine_completed_preserves_result(self):
        r = self.record()
        self.engine(history={r["prompt_id"]: self.history()})
        self.manager.cancel(r["id"])
        self.assertEqual(core.get_record(r["id"])["status"], "done")
        self.post.assert_not_called()

    def test_cancel_during_submission_cannot_leave_untracked_generation(self):
        models = self._mock("model_status", return_value={
            "fl2va": {"available": True}, "ref2va": {"available": False},
        })
        q, _ = self.engine()
        submitting = threading.Event()
        release_submit = threading.Event()
        failures = []
        self.manager.ready.set()
        self._mock("comfyui_running", return_value=True)
        def post(path, payload, **kwargs):
            if path == "/prompt":
                submitting.set()
                if not release_submit.wait(3):
                    raise AssertionError("Test submission was not released")
                q["queue_running"] = [[0, payload["prompt_id"]]]
                return {"prompt_id": payload["prompt_id"]}
            if path == "/interrupt":
                self.assertEqual(payload, {"prompt_id": q["queue_running"][0][1]})
                return {}
            raise AssertionError(path)
        self.post.side_effect = post
        def run(fn):
            try:
                fn()
            except BaseException as exc:
                failures.append(exc)
        submitter = threading.Thread(target=run, args=(lambda: self.manager.submit(
            [{"kind": "text", "role": "scene", "content": "A lighthouse"}], {}),))
        submitter.start()
        try:
            self.assertTrue(submitting.wait(3), failures)
            rid = core.load_records()[0]["id"]
            canceller = threading.Thread(target=run, args=(lambda: self.manager.cancel(rid),))
            canceller.start()
            # Let cancellation attempt the state lock while submission is in flight.
            time.sleep(0.05)
            release_submit.set()
            submitter.join(3)
            canceller.join(3)
            self.assertFalse(submitter.is_alive() or canceller.is_alive())
            self.assertEqual(failures, [])
            self.assertEqual(core.get_record(rid)["status"], "cancelling")
            self.assertTrue(any(c.args[0] == "/interrupt" for c in self.post.call_args_list))
            models.assert_called_once_with()
        finally:
            release_submit.set()
            submitter.join(3)

    def test_cancel_interruption_event_is_terminal(self):
        r = self.record(status="cancelling")
        self.manager.handle_event({"type": "execution_interrupted", "data": {"prompt_id": r["prompt_id"]}})
        self.assertEqual(core.get_record(r["id"])["status"], "cancelled")

    def test_progress_is_bound_to_prompt_and_ignores_terminal_jobs(self):
        first = self.record("first", "done")
        second = self.record("second")
        for pid in ("first", "unknown"):
            self.manager.handle_event({"type": "progress", "data": {"prompt_id": pid, "node": "10", "value": 7, "max": 8}})
        self.assertNotIn("progress", core.get_record(second["id"]))
        self.assertEqual(core.get_record(first["id"])["status"], "done")
        self.manager.handle_event({"type": "progress_state", "data": {"prompt_id": "second", "nodes": {
            "10": {"state": "running", "value": 2, "max": 8}
        }}})
        self.assertEqual(core.get_record(second["id"])["progress"]["step"], 2)
        self.assertNotIn("progress", core.get_record(first["id"]))

    def test_eta_uses_measured_steps_and_clears_for_decoding(self):
        r = self.record()
        with patch.object(tasks.time, "time") as now:
            for step, at in ((1, 1001), (2, 1011), (3, 1031)):
                now.return_value = at
                self.manager.handle_event({"type": "progress", "data": {
                    "prompt_id": r["prompt_id"], "node": "10", "value": step, "max": 8}})
            saved = core.get_record(r["id"])
            self.assertEqual(saved["eta_seconds"], 75)
            self.assertEqual(saved["step_times"], [10, 20])
            now.return_value = 1041
            self.manager.handle_event({"type": "executing", "data": {"prompt_id": r["prompt_id"], "node": "11"}})
        saved = core.get_record(r["id"])
        self.assertEqual(saved["stage"], "decoding")
        self.assertIsNone(saved["eta_seconds"])

    def test_seed_zero_and_canvas_survive_refill(self):
        r = self.record()
        items = [{"kind": "text", "role": "scene", "content": "A lighthouse", "x": 123, "y": 456}]
        core.update_record(r["id"], items=items)
        refill = core.refill_payload(r["id"])
        self.assertEqual(refill["params"]["seed"], 0)
        self.assertEqual(refill["items"], items)
        self.assertEqual(core.build_workflow("test", 608, 352, 2, 8, 0)["6"]["inputs"]["noise_seed"], 0)

    def test_invalid_parameter_boundaries_are_rejected(self):
        invalid = [{"resolution": "607,352"}, {"resolution": "1344,1344"}, {"duration": float("nan")},
                   {"duration": 13}, {"duration": 1}, {"steps": 5}, {"steps": 41}, {"seed": -1}, {"seed": 2**64}]
        for params in invalid:
            with self.subTest(params=params), self.assertRaises(ValueError):
                tasks.validate_params(params)
        self.assertEqual(tasks.validate_params({"seed": 0})["seed"], 0)

    def test_preflight_exposes_actual_frame_count_and_reference_limit(self):
        (Path(self.folder.name) / "reference.png").touch()
        budget = tasks.estimate([{"kind": "image", "role": "reference", "file": "reference.png"}], {})
        self.assertEqual(budget["frames"], 56)
        self.assertEqual(budget["actual_duration"], 2.33)
        self.assertTrue(budget["capabilities"]["reference_images"])
        self.assertEqual(budget["model_mode"], "ref2va")
        self.assertEqual(budget["input_manifest"][0]["tag"], "<Picture 1>")

    def test_only_explicit_auto_images_can_fill_missing_first_and_last_frames(self):
        references = [dict(kind="image", role=role, file=f"reference-{index}.png")
                      for index, role in enumerate(("middle_frame_1", "middle_frame_2", "middle_frame_3", "future_role", "reference", ""))]
        references.append(dict(kind="image", file="missing-role.png"))
        _, first, last, fields = core.assemble_prompt(references)
        self.assertIsNone(first)
        self.assertIsNone(last)
        self.assertEqual(fields["_images_reference"], [item["file"] for item in references])
        autos = [dict(kind="image", role="auto", file="auto-first.png"),
                 dict(kind="image", role="auto", file="auto-last.png")]
        _, first, last, fields = core.assemble_prompt(references + autos)
        self.assertEqual((first, last), ("auto-first.png", "auto-last.png"))
        self.assertEqual(fields["_images_reference"], [item["file"] for item in references])

    def test_middle_only_board_compiles_a_real_guide(self):
        (Path(self.folder.name) / "middle.png").touch()
        items = [dict(id="middle", kind="image", role="middle_frame_2", file="middle.png")]
        budget = tasks.estimate(items, {})
        self.assertTrue(budget["capabilities"]["middle_frames"])
        self.assertTrue(budget["capabilities"]["connections_affect_generation"])
        self.assertTrue(any("中间帧" in warning for warning in budget["warnings"]))
        compiled = core.compile_inputs(items, budget["params"])
        workflow = core.build_workflow(compiled["compiled_prompt"], 608, 352, 2, 8, 0, compiled=compiled)
        guides = [node for node in workflow.values() if node["class_type"] == "MiniMaxH3AddGuide"]
        self.assertEqual(guides[0]["inputs"]["frame_idx"], 28)


if __name__ == "__main__":
    unittest.main()
