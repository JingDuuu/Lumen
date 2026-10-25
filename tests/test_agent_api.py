"""Agent contracts use temporary stores; no live service, engine or user board."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from flask import Flask, jsonify

import agent_api
import lumen_core as core
import previs_store


class AgentApiTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.board_path = self.root / "library" / "board.json"
        self.app = Flask(__name__)
        self.app.config.update(TESTING=True, PREVIS_ROOT=str(self.root / "previs"))
        self.app.register_blueprint(agent_api.create_blueprint(lambda: self.board_path, threading.Lock()))
        self.app.register_error_handler(ValueError, lambda error: (jsonify(ok=False, error=str(error)), 400))
        self.client = self.app.test_client()
        self.board = {"items": [{"id": "scene-text", "kind": "text", "role": "scene", "content": "A lighthouse", "x": 10}],
                      "params": {"resolution": "608,352", "duration": 2, "steps": 8, "seed": 0}, "zones": [], "connections": []}
        self.gpu = patch.object(core, "comfy_post", side_effect=AssertionError("No engine work"))
        self.gpu.start()
        self.addCleanup(self.gpu.stop)

    def current(self):
        return self.client.get("/api/agent/board").get_json()

    def save(self, board=None, **extra):
        return self.client.put("/api/agent/board", json={"board": board or self.board,
                                                       "expected_revision": self.current()["revision"], **extra})

    def test_discovery_schema_and_pose_catalog_are_machine_readable(self):
        discovered = self.client.get("/api/agent/discover").get_json()
        self.assertIn("/api/agent/board/operations", [entry["path"] for entry in discovered["endpoints"]])
        schema = self.client.get(discovered["schema"]).get_json()
        self.assertIn("Scene", schema["$defs"])
        catalog = self.client.get(discovered["catalog"]).get_json()
        self.assertGreaterEqual(len(catalog["poses"]), 50)
        self.assertTrue(catalog["poses"][0]["pose"])
        self.assertEqual(self.client.get(discovered["guide"]).get_json()["format"], "markdown")
        self.assertIn("items", self.client.get(discovered["examples"]["board"]).get_json())

    def test_optimistic_write_and_idempotent_retry_preserve_newer_edits(self):
        first = {"board": self.board, "expected_revision": self.current()["revision"], "request_id": "first-write"}
        saved = self.client.put("/api/agent/board", json=first)
        self.assertEqual(saved.status_code, 200)
        self.assertIn(saved.get_json()["revision"], saved.headers["ETag"])
        next_board = copy.deepcopy(self.board)
        next_board["items"][0]["content"] = "Updated by another agent"
        self.save(next_board)
        replay = self.client.put("/api/agent/board", json=first).get_json()
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["board"]["items"][0]["content"], "Updated by another agent")
        self.assertNotEqual(replay["applied_revision"], replay["revision"])

    def test_request_id_reuse_with_different_body_rejected(self):
        self.save(request_id="single")
        response = self.save({**self.board, "viewport": {"zoom": 2}}, request_id="single")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "IDEMPOTENCY_CONFLICT")

    def test_missing_or_stale_precondition_never_overwrites(self):
        old_revision = self.current()["revision"]
        self.save()
        original = self.board_path.read_bytes()
        for data, status in (({"board": self.board}, 428), ({"board": self.board, "expected_revision": old_revision}, 409)):
            self.assertEqual(self.client.put("/api/agent/board", json=data).status_code, status)
            self.assertEqual(self.board_path.read_bytes(), original)

    def test_two_simultaneous_clients_only_one_can_apply_same_revision(self):
        self.save()
        revision = self.current()["revision"]
        barrier, statuses = threading.Barrier(2), []
        def edit(seed):
            barrier.wait()
            with self.app.test_client() as client:
                response = client.post("/api/agent/board/operations", json={"expected_revision": revision,
                    "operations": [{"op": "set_params", "value": {"seed": seed}}]})
                statuses.append(response.status_code)
        threads = [threading.Thread(target=edit, args=(seed,)) for seed in (17, 31)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(statuses), [200, 409])

    def test_operation_batch_rolls_back_on_late_invalid_step(self):
        self.save()
        original = self.board_path.read_bytes()
        response = self.client.post("/api/agent/board/operations", json={"expected_revision": self.current()["revision"],
            "operations": [{"op": "set_params", "value": {"seed": 99}}, {"op": "remove_item", "id": "missing"}]})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.board_path.read_bytes(), original)

    def test_remove_endpoint_and_zone_cleanup_is_atomic(self):
        board = copy.deepcopy(self.board)
        board["zones"] = [{"id": "group", "purpose": "character"}]
        board["items"].append({"id": "actor", "kind": "text", "role": "char", "content": "A fictional sailor", "zone_id": "group"})
        board["connections"] = [{"id": "edge", "from": "actor", "to": "scene-text", "label": "association"}]
        self.save(board)
        result = self.client.post("/api/agent/board/operations", json={"expected_revision": self.current()["revision"],
            "operations": [{"op": "remove_zone", "id": "group"}, {"op": "remove_item", "id": "scene-text"}]}).get_json()
        self.assertEqual(result["board"]["connections"], [])
        self.assertIsNone(result["board"]["items"][0]["zone_id"])

    def test_duplicate_card_or_dangling_edge_rejected_without_silent_drop(self):
        duplicate = copy.deepcopy(self.board)
        duplicate["items"].append(copy.deepcopy(duplicate["items"][0]))
        self.assertEqual(self.save(duplicate).status_code, 400)
        dangling = {**self.board, "connections": [{"id": "bad", "from": "scene-text", "to": "missing"}]}
        self.assertEqual(self.save(dangling).status_code, 400)
        self.assertFalse(self.board_path.exists())

    def test_malformed_agent_fields_return_validation_errors_not_server_errors(self):
        for key, value in (("kind", []), ("reference_role", {}), ("x", "invalid"), ("w", -5)):
            board = copy.deepcopy(self.board)
            board["items"][0][key] = value
            self.assertEqual(self.save(board).status_code, 400)
        for changes in ({"zones":[{"id":"zone","purpose":[]}]},
                        {"connections":[{"id":"edge","from":[],"to":"scene-text"}]},
                        {"params":{"seed":0.7}}, {"params":{"model_mode":[]}}):
            self.assertEqual(self.save({**self.board, **changes}).status_code, 400)
        self.assertFalse(self.board_path.exists())

    def test_preview_compiles_operations_but_does_not_save_or_submit(self):
        self.save()
        original = self.board_path.read_bytes()
        with patch.object(agent_api.tasks, "estimate", return_value={"compiled_prompt": "preview"}) as estimate:
            response = self.client.post("/api/agent/preview", json={"expected_revision": self.current()["revision"],
                "operations": [{"op": "set_params", "value": {"seed": 123}}]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(estimate.call_args.args[1]["seed"], 123)
        self.assertFalse(response.get_json()["submits_generation"])
        self.assertEqual(self.board_path.read_bytes(), original)

    def document(self):
        return {"name": "Synthetic blocking", "kind": "scene", "scene": {"version": 3, "objects": []}}

    def test_document_create_retry_update_conflict_and_read_without_touch(self):
        payload = {"request_id": "create-scene", "document": self.document()}
        first = self.client.post("/api/agent/documents", json=payload).get_json()
        self.assertTrue(first["ok"])
        replay = self.client.post("/api/agent/documents", json=payload).get_json()
        self.assertTrue(replay["replayed"])
        self.assertEqual(first["id"], replay["id"])
        url = "/api/agent/documents/" + first["id"]
        path = self.root / "previs" / "documents" / (first["id"] + ".json")
        before = path.read_bytes()
        self.assertEqual(self.client.get(url).get_json()["revision"], first["revision"])
        self.assertEqual(path.read_bytes(), before)
        update = {"request_id": "edit-scene", "expected_revision": first["revision"], "document": {**self.document(), "name": "Revised"}}
        updated = self.client.put(url, json=update)
        self.assertEqual(updated.status_code, 200)
        update["request_id"] = "different-edit"
        self.assertEqual(self.client.put(url, json=update).status_code, 409)
        self.assertEqual(len(list(path.parent.glob("*.json"))), 1)

    def test_ambiguous_document_write_is_not_automatically_repeated(self):
        payload = {"request_id": "interrupted", "document": self.document()}
        with patch.object(previs_store.PrevisStore, "save", side_effect=OSError("simulated power loss")):
            with self.assertRaises(OSError):
                self.client.post("/api/agent/documents", json=payload)
        retry = self.client.post("/api/agent/documents", json=payload)
        self.assertEqual(retry.status_code, 409)
        self.assertEqual(retry.get_json()["code"], "OUTCOME_UNKNOWN")

    def test_document_delete_retry_is_idempotent(self):
        created = self.client.post("/api/agent/documents", json={"request_id":"new", "document":self.document()}).get_json()
        url = "/api/agent/documents/" + created["id"]
        payload = {"request_id":"delete", "expected_revision":created["revision"]}
        self.assertTrue(self.client.delete(url, json=payload).get_json()["deleted"])
        self.assertTrue(self.client.delete(url, json=payload).get_json()["replayed"])

    def test_invalid_scene_hierarchy_tracks_and_types_do_not_persist(self):
        actor = {"id":"actor", "type":"adult_female"}
        scenes = [
            {"version":3,"objects":[actor,actor]},
            {"version":3,"objects":[{**actor,"parentId":"missing"}]},
            {"version":3,"objects":[{**actor,"type":[]}]},
            {"version":3,"objects":[{**actor,"scale":[1,0,1]}]},
            {"version":3,"objects":[actor],"sequence":{"duration":2,"tracks":[{"targetId":"actor","property":"position.__proto__","keys":[]}]}},
            {"version":3,"objects":[actor],"sequence":{"duration":2,"tracks":[{"targetId":"missing","property":"position","keys":[]}]}},
            {"version":3,"objects":[actor,{"id":"child","type":"box","parentId":"actor"}],"sequence":{"duration":2,"tracks":[{"targetId":"actor","property":"parentId","keys":[{"time":1,"value":"child"}]}]}}
        ]
        for index, scene in enumerate(scenes):
            with self.subTest(index=index):
                response = self.client.post("/api/agent/documents", json={"request_id":"bad-"+str(index),"document":{**self.document(),"scene":scene}})
                self.assertEqual(response.status_code, 400)
        self.assertFalse((self.root / "previs" / "documents").exists())


if __name__ == "__main__":
    unittest.main()
