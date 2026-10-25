"""HTTP contracts use isolated user data and never start a service or GPU job."""
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as backend
import lumen_core as core
import tasks


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        for directory in ("library/thumbs", "input", "output/video"):
            (self.root / directory).mkdir(parents=True)
        for name, path in {
            "LIB_DIR": "library", "THUMB_DIR": "library/thumbs", "RECORDS_FILE": "library/records.json",
            "MEMORY_FILE": "memory.json", "PRESETS_FILE": "presets.json", "INPUT_DIR": "input", "OUTPUT_DIR": "output",
        }.items():
            self.patch(core, name, str(self.root / path))
        self.board_file = self.root / "library" / "board-default.json"
        self.patch(backend, "BOARD_FILE", str(self.board_file))
        self.manager = tasks.TaskManager()
        self.patch(tasks, "manager", self.manager)
        self.patch(self.manager, "start", return_value=None)
        self.engine_get = self.patch(core, "comfy_get", side_effect=AssertionError("Unexpected engine GET"))
        self.engine_post = self.patch(core, "comfy_post", side_effect=AssertionError("Unexpected engine POST"))
        self.engine_start = self.patch(core, "start_comfyui", side_effect=AssertionError("Engine must not start"))
        self.engine_running = self.patch(core, "comfyui_running", side_effect=AssertionError("Unexpected engine probe"))
        self.patch(core, "extract_thumb", side_effect=AssertionError("No media subprocesses in API tests"))
        self.patch(backend.subprocess, "Popen", side_effect=AssertionError("No process creation in API tests"))
        config = patch.dict(backend.app.config, TESTING=True)
        config.start()
        self.addCleanup(config.stop)
        self.client = backend.app.test_client()
        self.params = dict(resolution="608,352", duration=2, steps=8, seed=0)
        self.items = [dict(id="text-a", kind="text", role="scene", content="雨夜街道", x=-125.5, y=241, w=320, h=160)]

    def patch(self, target, name, *args, **kwargs):
        p = patch.object(target, name, *args, **kwargs)
        self.addCleanup(p.stop)
        return p.start()

    def record(self, status="done", **changes):
        rec = core.create_record("prompt-" + status, tasks.validate_params(self.params), {}, "雨夜街道", {}, self.items,
                                 {"private": "workflow-is-not-needed-in-polling"})
        return core.update_record(rec["id"], status=status, **changes)

    def test_svg_response_uses_browser_supported_mime(self):
        for path in ("/favicon.svg", "/static/favicon.svg", "/static/lumen-mark.svg"):
            response = self.client.get(path)
            self.addCleanup(response.close)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, "image/svg+xml")

    def test_local_three_modules_use_javascript_mime(self):
        for path in ("three.module.js", "three.core.js", "examples/jsm/controls/OrbitControls.js", "examples/jsm/controls/TransformControls.js"):
            response = self.client.get("/static/vendor/three/" + path)
            self.addCleanup(response.close)
            self.assertEqual(response.status_code, 200)
            self.assertIn(response.mimetype, ("text/javascript", "application/javascript"))

    def test_board_roundtrip_preserves_positions_viewport_and_seed_zero(self):
        (self.root / "input" / "first.png").write_bytes(b"local-image-fixture")
        items = self.items + [dict(id="image-a", kind="image", role="first_frame", file="first.png",
                                  x=512, y=-70, w=400, h=225)]
        payload = dict(items=items, params=self.params, viewport=dict(zoom=0.75, panX=-210, panY=40))
        saved = self.client.put("/api/boards/default", json=payload)
        self.assertEqual(saved.status_code, 200)
        loaded = self.client.get("/api/boards/default").get_json()
        self.assertEqual(loaded["items"], items)
        self.assertEqual(loaded["params"]["seed"], 0)
        self.assertEqual(loaded["viewport"], payload["viewport"])
        self.assertGreater(loaded["saved_at"], 0)
        self.assertEqual(json.loads(self.board_file.read_text(encoding="utf-8")), loaded)

    def test_invalid_board_params_do_not_replace_saved_draft(self):
        self.client.put("/api/boards/default", json=dict(items=self.items, params=self.params))
        original = self.board_file.read_bytes()
        for invalid in ({"steps": 0}, {"resolution": "607,352"}, {"duration": 13}, {"seed": -1}, None, "invalid"):
            with self.subTest(params=invalid):
                response = self.client.put("/api/boards/default", json=dict(items=self.items, params=invalid))
                self.assertEqual(response.status_code, 400)
                self.assertFalse(response.get_json()["ok"])
                self.assertEqual(self.board_file.read_bytes(), original)

    def test_invalid_generation_is_rejected_before_record_or_engine_changes(self):
        self.record()
        original = Path(core.RECORDS_FILE).read_bytes()
        for changes in ({"steps": 41}, {"resolution": "999,352"}, {"duration": 0}, {"seed": -5}):
            with self.subTest(changes=changes):
                response = self.client.post("/api/generate", json=dict(items=self.items, params={**self.params, **changes}))
                self.assertEqual(response.status_code, 400)
                self.assertEqual(Path(core.RECORDS_FILE).read_bytes(), original)
        self.engine_running.assert_not_called()
        self.engine_start.assert_not_called()
        self.engine_post.assert_not_called()

    def test_non_object_json_is_400_and_does_not_erase_saved_data(self):
        rec = self.record()
        self.client.put("/api/boards/default", json=dict(items=self.items, params=self.params))
        before_board = self.board_file.read_bytes()
        before_records = Path(core.RECORDS_FILE).read_bytes()
        routes = [("PUT", "/api/boards/default"), ("POST", "/api/generate"), ("POST", "/api/estimate"),
                  ("POST", "/api/presets"), ("DELETE", "/api/presets"),
                  ("POST", f"/api/library/{rec['id']}/star"), ("POST", f"/api/library/{rec['id']}/tags")]
        for method, path in routes:
            for payload in (None, [], ["bad"], "bad", 12, True):
                with self.subTest(path=path, payload=payload):
                    response = self.client.open(path, method=method, data=json.dumps(payload), content_type="application/json")
                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(self.board_file.read_bytes(), before_board)
                    self.assertEqual(Path(core.RECORDS_FILE).read_bytes(), before_records)

    def test_incomplete_board_and_invalid_cards_preserve_the_draft(self):
        self.client.put("/api/boards/default", json=dict(items=self.items, params=self.params))
        original = self.board_file.read_bytes()
        invalid = ({}, {"items": []}, {"params": self.params}, {"items": [None], "params": self.params},
                   {"items": "not-a-list", "params": self.params},
                   {"items": [{"kind": "text", "role": "scene", "content": 12}], "params": self.params})
        for payload in invalid:
            with self.subTest(payload=payload):
                response = self.client.put("/api/boards/default", json=payload)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.board_file.read_bytes(), original)
        for items in ([None], "not-a-list", [{"kind": "text", "role": "scene", "content": 12}]):
            with self.subTest(generate_items=items):
                response = self.client.post("/api/generate", json=dict(items=items, params=self.params))
                self.assertEqual(response.status_code, 400)
        self.assertFalse(Path(core.RECORDS_FILE).exists())
        self.engine_running.assert_not_called()

    def test_generation_rejects_non_object_params_before_engine_access(self):
        for params in (None, [], "", False, 12):
            with self.subTest(params=params):
                response = self.client.post("/api/generate", json=dict(items=self.items, params=params))
                self.assertEqual(response.status_code, 400)
                self.assertFalse(Path(core.RECORDS_FILE).exists())
        self.engine_running.assert_not_called()
        self.engine_start.assert_not_called()

    def test_invalid_preset_fields_are_400_without_changing_presets(self):
        core.save_presets({"camera": [{"name": "existing", "text": "preserve-existing-preset"}]})
        original = Path(core.PRESETS_FILE).read_bytes()
        for changes in ({"name": 12}, {"text": ["bad"]}, {"category": ["bad"]}, {"category": {"bad": True}}):
            with self.subTest(changes=changes):
                payload = {"name": "new", "text": "new-text", "category": "camera", **changes}
                response = self.client.post("/api/presets", json=payload)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(Path(core.PRESETS_FILE).read_bytes(), original)

    def test_preflight_is_read_only_and_does_not_invent_eta(self):
        response = self.client.post("/api/estimate", json=dict(items=self.items, params=self.params))
        self.assertEqual(response.status_code, 200)
        estimate = response.get_json()
        self.assertEqual(estimate["frames"], 56)
        self.assertEqual(estimate["actual_duration"], 2.33)
        self.assertIsNone(estimate["estimate_seconds"])
        self.assertFalse(Path(core.RECORDS_FILE).exists())
        self.assertFalse(Path(core.MEMORY_FILE).exists())
        self.engine_get.assert_not_called()

    def test_output_routes_block_traversal_but_serve_media(self):
        secret = b"outside-output-do-not-serve"
        (self.root / "private.txt").write_bytes(secret)
        media = self.root / "output" / "video" / "clip.mp4"
        media.write_bytes(b"local-media-fixture")
        for valid in ("/output/video/clip.mp4", "/videos/video/clip.mp4"):
            with self.subTest(valid=valid):
                response = self.client.get(valid)
                try:
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.data, media.read_bytes())
                finally:
                    response.close()
        for path in ("/output/../private.txt", "/output/%2e%2e%2fprivate.txt", "/output/..%5cprivate.txt",
                     "/videos/video/../../private.txt", "/videos/../private.txt"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertIn(response.status_code, (403, 404))
                self.assertNotIn(secret, response.data)

    def test_cross_origin_mutations_cannot_change_saved_data(self):
        rec = self.record()
        self.client.put("/api/boards/default", json=dict(items=self.items, params=self.params))
        before_records = Path(core.RECORDS_FILE).read_bytes()
        before_board = self.board_file.read_bytes()
        for method, path, payload in (
            ("PUT", "/api/boards/default", {"items": [], "params": {}}),
            ("POST", f"/api/library/{rec['id']}/star", {"star": True}),
            ("DELETE", f"/api/library/{rec['id']}", None),
        ):
            with self.subTest(method=method):
                response = self.client.open(path, method=method, json=payload, headers={"Origin": "https://other.example"})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(Path(core.RECORDS_FILE).read_bytes(), before_records)
                self.assertEqual(self.board_file.read_bytes(), before_board)
        same_origin = self.client.post(f"/api/library/{rec['id']}/star", json={"star": True}, headers={"Origin": "http://localhost"})
        self.assertEqual(same_origin.status_code, 200)
        self.assertTrue(core.get_record(rec["id"])["star"])

    def test_task_status_exposes_done_output_and_failed_error_as_terminal(self):
        for status, changes in (
            ("done", dict(outputs=[{"sub": "video", "name": "clip.mp4"}], elapsed_seconds=120)),
            ("failed", dict(error="SamplerCustomAdvanced: CUDA out of memory", elapsed_seconds=50)),
            ("queued", {}),
        ):
            with self.subTest(status=status):
                rec = self.record(status, **changes)
                response = self.client.get("/api/status/" + rec["prompt_id"])
                self.assertEqual(response.status_code, 200)
                result = response.get_json()
                self.assertEqual(result["status"], status)
                self.assertEqual(result["done"], status in {"done", "failed"})
                self.assertEqual(result["queued"], status == "queued")
                self.assertEqual(result["record_id"], rec["id"])
                self.assertNotIn("workflow", result)
                if status == "done":
                    self.assertEqual(result["outputs"], changes["outputs"])
                if status == "failed":
                    self.assertEqual(result["error"], changes["error"])
        self.assertEqual(self.client.get("/api/status/missing").status_code, 404)
        self.engine_get.assert_not_called()

    def test_library_archive_restore_preserves_media_and_refill(self):
        media = self.root / "output" / "video" / "clip.mp4"
        media.write_bytes(b"preserve-this-video")
        rec = self.record(outputs=[{"sub": "video", "name": "clip.mp4"}], viewport={"zoom": 0.8, "panX": 23})
        thumb = self.root / "library" / "thumbs" / (rec["id"] + ".jpg")
        thumb.write_bytes(b"preserve-this-thumbnail")
        core.update_record(rec["id"], thumb="thumbs/" + thumb.name)
        archived = self.client.delete("/api/library/" + rec["id"])
        self.assertEqual(archived.status_code, 200)
        self.assertTrue(archived.get_json()["ok"])
        self.assertEqual(self.client.get("/api/library").get_json(), [])
        self.assertEqual(self.client.get("/api/tasks").get_json(), [])
        self.assertTrue(core.get_record(rec["id"])["archived"])
        self.assertEqual(media.read_bytes(), b"preserve-this-video")
        self.assertEqual(thumb.read_bytes(), b"preserve-this-thumbnail")
        restored = self.client.post(f"/api/library/{rec['id']}/restore")
        self.assertTrue(restored.get_json()["ok"])
        self.assertEqual(self.client.get("/api/library").get_json()[0]["id"], rec["id"])
        refill = self.client.get(f"/api/library/{rec['id']}/refill").get_json()
        self.assertEqual(refill["items"], self.items)
        self.assertEqual(refill["params"]["seed"], 0)
        self.assertEqual(refill["viewport"], rec["viewport"])
        self.assertEqual(media.read_bytes(), b"preserve-this-video")

    def test_active_task_cannot_be_archived(self):
        rec = self.record("running")
        response = self.client.delete("/api/library/" + rec["id"])
        self.assertEqual(response.status_code, 400)
        self.assertFalse(core.get_record(rec["id"]).get("archived", False))
        self.assertEqual(self.client.get("/api/library").get_json()[0]["id"], rec["id"])

    def test_upload_and_input_are_confined_to_temporary_input_directory(self):
        response = self.client.post("/api/upload", data={"file": (io.BytesIO(b"uploaded-image-fixture"), "reference.png")})
        self.assertEqual(response.status_code, 200)
        name = response.get_json()["name"]
        self.assertTrue(name.startswith("upload_"))
        self.assertEqual((self.root / "input" / name).read_bytes(), b"uploaded-image-fixture")
        served = self.client.get("/input/" + name)
        try:
            self.assertEqual(served.status_code, 200)
            self.assertEqual(served.data, b"uploaded-image-fixture")
        finally:
            served.close()
        (self.root / "private.png").write_bytes(b"private-image-fixture")
        self.assertEqual(self.client.get("/input/../private.png").status_code, 403)

    def test_invalid_upload_is_400_and_does_not_create_a_file(self):
        response = self.client.post("/api/upload", data={"file": (io.BytesIO(b"invalid-type"), "notes.txt")})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()["ok"])
        self.assertEqual(list((self.root / "input").iterdir()), [])

    def test_board_connections_roundtrip_and_deleted_endpoints_are_filtered(self):
        items = self.items + [dict(id="text-b", kind="text", role="camera", content="拉远"),
                              dict(id="text-c", kind="text", role="extra", content="转场")]
        edges = [dict(id="edge-a", **{"from": "text-a", "to": "text-b"}, label="  镜头关系\n保留原文  "),
                 dict(id="edge-b", **{"from": "text-b", "to": "text-c"}, label="接下个镜头")]
        payload = dict(items=items, params=self.params, connections=edges)
        response = self.client.put("/api/boards/default", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/boards/default").get_json()["connections"], edges)
        # An older caller that omits the new field must not erase valid links.
        response = self.client.put("/api/boards/default", json=dict(items=items[:2], params=self.params))
        self.assertEqual(response.get_json()["connections"], edges[:1])
        self.assertEqual(response.get_json()["items"], items[:2])
        response = self.client.put("/api/boards/default", json=dict(items=items[:2], params=self.params, connections=[]))
        self.assertEqual(response.get_json()["connections"], [])

    def test_invalid_connections_preserve_saved_board_and_never_access_engine(self):
        items = self.items + [dict(id="text-b", kind="text", role="camera", content="拉远")]
        valid = dict(id="edge-a", **{"from": "text-a", "to": "text-b"}, label="镜头关系")
        self.client.put("/api/boards/default", json=dict(items=items, params=self.params, connections=[valid]))
        original = self.board_file.read_bytes()
        for connections in ({"invalid": True}, [dict(valid, label={"invalid": True})], [valid] * 1001):
            with self.subTest(connections_type=type(connections).__name__):
                payload = dict(items=items, params=self.params, connections=connections)
                self.assertEqual(self.client.put("/api/boards/default", json=payload).status_code, 400)
                self.assertEqual(self.board_file.read_bytes(), original)
                self.assertEqual(self.client.post("/api/generate", json=payload).status_code, 400)
        self.engine_running.assert_not_called()
        self.engine_start.assert_not_called()
        self.engine_post.assert_not_called()

    def test_legacy_board_and_record_return_empty_connections_without_rewrite(self):
        legacy_board = dict(items=self.items, params=self.params)
        self.board_file.write_text(json.dumps(legacy_board), encoding="utf-8")
        original = self.board_file.read_bytes()
        self.assertEqual(self.client.get("/api/boards/default").get_json()["connections"], [])
        self.assertEqual(self.board_file.read_bytes(), original)
        rec = self.record()
        records = core.load_records()
        records[0].pop("connections")
        core.save_records(records)
        before_records = Path(core.RECORDS_FILE).read_bytes()
        refill = self.client.get(f"/api/library/{rec['id']}/refill").get_json()
        self.assertEqual(refill["connections"], [])
        self.assertEqual(refill["items"], self.items)
        self.assertEqual(Path(core.RECORDS_FILE).read_bytes(), before_records)

    def test_generation_and_refill_preserve_links_and_apply_middle_keyframes(self):
        models = self.patch(core, "model_status", return_value={
            "fl2va": {"available": True}, "ref2va": {"available": False},
        })
        images = []
        for index, role in enumerate(("first_frame", "middle_frame_1", "middle_frame_2", "middle_frame_3", "future_role", "last_frame")):
            name = f"image-{index}.png"
            (self.root / "input" / name).write_bytes(b"local-image-fixture")
            images.append(dict(id=f"image-{index}", kind="image", role=role, file=name, x=index * 300, y=200))
        images[4]["enabled"] = False
        items = self.items + images
        edges = [dict(id="first-to-middle", **{"from": "image-0", "to": "image-1"}, label="先转身，再看镜头"),
                 dict(id="middle-to-last", **{"from": "image-3", "to": "image-5"}, label="收尾")]
        self.patch(backend.engine_runtime, "state", return_value={"owned": True})
        self.engine_running.side_effect = None
        self.engine_running.return_value = True
        self.manager.ready.set()
        self.engine_post.side_effect = lambda path, payload, **kwargs: {"prompt_id": payload["prompt_id"]}
        response = self.client.post("/api/generate", json=dict(items=items, params=self.params, connections=edges,
                                                              viewport={"zoom": 0.7, "panX": 24, "panY": -12}))
        self.assertEqual(response.status_code, 200, response.get_json())
        models.assert_called_once_with()
        rec = core.get_record(response.get_json()["record_id"])
        self.assertEqual(rec["connections"], edges)
        self.assertEqual(rec["items"], items)
        workflow = self.engine_post.call_args.args[1]["prompt"]
        loaded_images = [node["inputs"]["image"] for node in workflow.values() if node["class_type"] == "LoadImage"]
        self.assertEqual(loaded_images, ["image-0.png", "image-5.png", "image-1.png", "image-2.png", "image-3.png"])
        self.assertIn("先转身", rec["prompt"])
        self.assertEqual(rec["images"]["reference"], [])
        self.assertEqual(sum(n["class_type"] == "MiniMaxH3AddGuide" for n in workflow.values()), 3)
        self.assertFalse(next(entry for entry in rec["input_manifest"] if entry["item_id"] == "image-4")["included"])
        refill = self.client.get(f"/api/library/{rec['id']}/refill").get_json()
        self.assertEqual(refill["connections"], edges)
        self.assertEqual(refill["items"], items)
        self.assertEqual(refill["params"]["seed"], 0)
        self.assertEqual(refill["viewport"]["zoom"], 0.7)
        polled = self.client.get("/api/status/" + rec["prompt_id"]).get_json()
        self.assertNotIn("connections", polled)
        self.assertNotIn("workflow", polled)

    def test_ambiguous_dangling_self_and_duplicate_edges_do_not_damage_cards(self):
        items = self.items + [dict(id="text-b", kind="text", role="camera", content="拉远")]
        valid = dict(id="edge-a", **{"from": "text-a", "to": "text-b"}, label="保留")
        edges = [None, valid, dict(valid, label="重复ID"),
                 dict(id="self", **{"from": "text-a", "to": "text-a"}),
                 dict(id="dangling", **{"from": "text-a", "to": "deleted"}),
                 dict(id="invalid", **{"from": ["text-a"], "to": "text-b"})]
        response = self.client.put("/api/boards/default", json=dict(items=items, params=self.params, connections=edges))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["connections"], [valid])
        self.assertEqual(response.get_json()["items"], items)
        ambiguous_items = items + [dict(items[1], content="独立卡片但ID重复")]
        self.assertEqual(core.normalize_connections(ambiguous_items, [valid]), [])


if __name__ == "__main__":
    unittest.main()
