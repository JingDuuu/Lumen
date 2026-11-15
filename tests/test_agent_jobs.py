"""Agent generation uses a fake engine, real records, and temporary files."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import app as backend
import agent_api
import lumen_core as core
import tasks
from PIL import Image


class AgentJobsTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        for key, value in {"LIB_DIR": folder.name, "INPUT_DIR": folder.name,
                           "OUTPUT_DIR": str(self.root / "output"), "RECORDS_FILE": str(self.root / "records.json"),
                           "MEMORY_FILE": str(self.root / "memory.json")}.items():
            p = patch.object(core, key, value);p.start();self.addCleanup(p.stop)
        self.board_path = self.root / "board.json"
        self.board = dict(items=[dict(id="scene", kind="text", role="scene", content="原有镜头")],
                          params=dict(resolution="608,352", duration=2, steps=8, seed=0), connections=[], zones=[])
        core._save_json(str(self.board_path), self.board)
        self.manager = tasks.TaskManager();self.manager.ready.set()
        for target, name, value in [(backend, "BOARD_FILE", str(self.board_path)),
                                    (tasks, "manager", self.manager)]:
            p = patch.object(target, name, value);p.start();self.addCleanup(p.stop)
        for target, name, kwargs in [
                (backend, "start_services", dict(return_value=None)),
                (backend.engine_runtime, "state", dict(return_value={"owned": True})),
                (core, "comfyui_running", dict(return_value=True)),
                (core, "model_status", dict(return_value={"fl2va": {"available": True}, "ref2va": {"available": True}})),
                (core, "comfy_post", dict(side_effect=lambda path, payload, **kw: {"prompt_id": payload["prompt_id"]}))]:
            p = patch.object(target, name, **kwargs);m=p.start();self.addCleanup(p.stop)
            if name == "comfy_post":self.post=m
        self.client = backend.app.test_client()

    def generate(self, **changes):
        return self.client.post("/api/agent/generate", json={"request_id": "shot-1", "prompt": "夜晚，镜头缓缓推近。", "client_name": "Test Agent", **changes})

    def test_submit_saves_origin_before_engine_and_does_not_overwrite_board(self):
        def submit(path, payload, **kwargs):
            saved = core.load_records()[0]
            self.assertEqual(saved["source"]["request_id"], "shot-1")
            return {"prompt_id": payload["prompt_id"]}
        self.post.side_effect = submit
        response = self.generate(title="Agent 镜头")
        self.assertEqual(response.status_code, 200, response.get_json())
        result=response.get_json();record=core.get_record(result["record_id"])
        self.assertEqual(record["title"], "Agent 镜头")
        self.assertEqual(record["duration"], 5)
        self.assertEqual(record["source"]["client_name"], "Test Agent")
        self.assertEqual(core._load_json(str(self.board_path), {}), self.board)
        self.assertIn("/result", result["result_url"])

    def test_same_request_replays_after_unknown_engine_response_and_conflicts_on_changes(self):
        self.post.side_effect = OSError("socket timed out after accepting request")
        first = self.generate().get_json()
        replay = self.generate().get_json()
        self.assertEqual(replay["record_id"], first["record_id"])
        self.assertTrue(replay["replayed"])
        self.assertEqual(self.post.call_count, 1)
        self.assertEqual(len(core.load_records()), 1)
        conflict=self.generate(prompt="另一条镜头")
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.get_json()["code"], "IDEMPOTENCY_CONFLICT")

    def test_current_board_checks_revision_without_mutation(self):
        base=dict(request_id="current-1",use_current_board=True,expected_revision="stale")
        response=self.client.post("/api/agent/generate",json=base)
        self.assertEqual(response.status_code,409)
        base["expected_revision"]=agent_api.board_revision(self.board)
        response=self.client.post("/api/agent/generate",json=base)
        self.assertEqual(response.status_code,200,response.get_json())
        self.assertIn("原有镜头",response.get_json()["compiled_prompt"])
        self.assertEqual(core._load_json(str(self.board_path), {}),self.board)

    def test_invalid_inputs_and_engine_not_ready_never_submit(self):
        for data in ({}, {"request_id":"bad", "prompt":[]}, {"request_id":"bad", "prompt":"x", "board":self.board},
                     {"request_id":"bad", "use_current_board":True,"expected_revision":[]},
                     {"request_id":"bad", "prompt":"x", "preset_ids":["a","a"]}):
            with self.subTest(data=data):
                response=self.client.post("/api/agent/generate",json=data)
                self.assertIn(response.status_code,(400,428))
        with patch.object(backend.engine_runtime,"state",return_value={"owned":False}):
            response=self.generate();self.assertEqual(response.status_code,503)
        self.post.assert_not_called()

    def test_result_only_succeeds_when_finished_files_exist(self):
        record_id=self.generate().get_json()["record_id"]
        endpoint=f"/api/agent/jobs/{record_id}/result"
        self.assertFalse(self.client.get(endpoint).get_json()["ready"])
        core.update_record(record_id,status="done",outputs=[dict(sub="video",name="shot.mp4")])
        missing=self.client.get(endpoint).get_json()
        self.assertFalse(missing["ready"]);self.assertEqual(missing["error_code"],"OUTPUT_MISSING")
        file=Path(core.OUTPUT_DIR)/"video"/"shot.mp4";file.parent.mkdir(parents=True);file.write_bytes(b"fixture-video")
        ready=self.client.get(endpoint).get_json()
        self.assertTrue(ready["ready"]);self.assertEqual(ready["files"][0]["local_path"],str(file.resolve()))
        self.assertEqual(ready["files"][0]["mime_type"],"video/mp4")
        with self.client.get(f"/api/agent/jobs/{record_id}/files/0") as response:
            self.assertEqual(response.data,b"fixture-video")
            self.assertIn("attachment",response.headers["Content-Disposition"])
        self.assertTrue(self.client.get(f"/api/agent/results/{record_id}").get_json()["ready"])
        core.update_record(record_id,outputs=[dict(sub="..",name="records.json")])
        self.assertFalse(self.client.get(endpoint).get_json()["ready"])
        self.assertEqual(self.client.get(f"/api/agent/jobs/{record_id}/files/0").status_code,404)

    def test_bootstrap_is_local_dynamic_and_does_not_start_engine(self):
        response=self.client.get("/api/agent/bootstrap",base_url="http://127.0.0.1:19345")
        self.assertEqual(response.status_code,200)
        payload=response.get_json()
        self.assertEqual(payload["api_url"],"http://127.0.0.1:19345")
        self.assertTrue(Path(payload["cli_path"]).is_absolute())
        self.assertIn("mcpServers",payload["mcp_config"])
        self.assertIn("lumen",payload["mcp_config"]["mcpServers"])
        self.post.assert_not_called()
        backend.start_services.assert_not_called()

    def test_concurrent_retry_creates_one_job(self):
        def submit(_):
            with backend.app.test_client() as client:
                response=client.post("/api/agent/generate",json={"request_id":"parallel", "prompt":"A blue cube"})
                self.assertEqual(response.status_code,200,response.get_json())
                return response.get_json()["record_id"]
        with ThreadPoolExecutor(max_workers=3) as pool:
            identifiers=list(pool.map(submit,range(3)))
        self.assertEqual(len(set(identifiers)),1)
        self.assertEqual(self.post.call_count,1)

    def test_preset_references_keep_member_masks_and_shot_params(self):
        Image.new("RGB",(64,64),"steelblue").save(self.root/"person.png")
        preset=dict(name="蓝色角色",category="character",items=[
            dict(id="image",kind="image",role="reference",file="person.png",reference_role="character"),
            dict(id="identity",kind="text",role="char",content="蓝衣角色，短发。"),
            dict(id="source",kind="text",role="extra",content="来源与许可，不参与生成",enabled=False)],
            connections=[],zones=[],params=dict(duration=12,steps=40))
        response=self.client.post("/api/asset-presets",json=preset)
        self.assertEqual(response.status_code,200,response.get_json())
        identifier=response.get_json()["preset"]["id"]
        generated=self.generate(preset_ids=[identifier]).get_json()
        self.assertIn("蓝衣角色",generated["compiled_prompt"])
        self.assertIn("<Picture 1>",generated["compiled_prompt"])
        self.assertNotIn("来源与许可",generated["compiled_prompt"])
        record=core.get_record(generated["record_id"])
        self.assertEqual(record["duration"],5)
        self.assertEqual(record["steps"],8)
        self.assertFalse(record["input_manifest"][-1]["included"])


if __name__ == "__main__":
    unittest.main()
