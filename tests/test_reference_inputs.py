"""Real CPU media preprocessing and isolated H3 compilation; never submit to a GPU."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import av
from PIL import Image
from imageio_ffmpeg import get_ffmpeg_exe

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as backend
import lumen_core as core
import reference_inputs as refs
import tasks


class ReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.root = Path(cls.folder.name)
        Image.new("RGB", (640, 384), "steelblue").save(cls.root / "face.png")
        subprocess.run([get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
                        "-f", "lavfi", "-i", "testsrc2=size=640x384:rate=30:duration=3",
                        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
                        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
                        str(cls.root / "motion.mp4")], check=True, capture_output=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def setUp(self):
        self.library = tempfile.TemporaryDirectory()
        self.addCleanup(self.library.cleanup)
        for key, value in {"INPUT_DIR": str(self.root), "RECORDS_FILE": str(Path(self.library.name)/"records.json"),
                           "MEMORY_FILE": str(Path(self.library.name)/"memory.json")}.items():
            patcher = patch.object(core, key, value)
            patcher.start(); self.addCleanup(patcher.stop)
        self.params = tasks.validate_params(dict(resolution="608,352", duration=2, steps=8, seed=0))
        self.text = dict(id="story", kind="text", role="scene", content="人物在海边步行。")
        self.picture = dict(id="person", kind="image", file="face.png", role="reference", reference_role="character",
                            character_view="three_view", zone_id="hero", notes="同一角色，黑色短发。", layout={"camera": {"fov": 50}})
        self.video = dict(id="motion", kind="video", file="motion.mp4", role="reference", reference_role="action",
                          video_start=.5, video_duration=2, include_audio=True)
        self.zones = [dict(id="hero", name="主角", purpose="character", x=0, y=0, w=1000, h=700)]
        self.connections = [dict(id="rel", **{"from": "motion", "to": "person"}, label="action_reference")]

    def compiled(self, items=None, params=None, connections=None, zones=None):
        return core.compile_inputs(items or [self.text, self.picture, self.video], params or self.params,
                                   self.connections if connections is None else connections,
                                   self.zones if zones is None else zones)

    def workflow(self, compiled):
        return core.build_workflow(compiled["compiled_prompt"], 608, 352, 2, 8, 0, compiled=compiled)

    def test_reference_prompt_tags_grouping_connections_and_metadata(self):
        compiled = self.compiled()
        self.assertEqual(compiled["model_mode"], "ref2va")
        prompt = compiled["compiled_prompt"]
        for fragment in ("<Picture 1>", "<Video 1>", "<Audio 1>", "正侧背三视图", "同一人物身份组", "后者参考前者的动作", "黑色短发"):
            self.assertIn(fragment, prompt)
        self.assertEqual(compiled["input_manifest"][1]["item_id"], "person")
        self.assertEqual(compiled["connection_manifest"][0]["from_tag"], "<Video 1>")

    def test_changing_character_reference_to_style_keeps_view_metadata_out_of_prompt(self):
        picture = dict(self.picture, reference_role="style", character_view="three_view", zone_id=None)
        compiled = self.compiled([self.text, picture], connections=[], zones=[])
        self.assertEqual(compiled["input_manifest"][1]["character_view"], "three_view")
        self.assertIn("参考视觉风格", compiled["compiled_prompt"])
        self.assertNotIn("人物视角", compiled["compiled_prompt"])
        self.assertNotIn("正侧背三视图", compiled["compiled_prompt"])

    def test_real_video_is_bounded_resampled_cached_and_connected_with_audio(self):
        compiled = self.compiled()
        video = compiled["input_manifest"][2]["video"]
        self.assertEqual(video["frames"], 39)
        self.assertEqual(video["fps"], 24)
        self.assertEqual(video["effective_duration"], 39 / 24)
        self.assertEqual(video["start_seconds"], .5)
        self.assertLessEqual(video["width"] * video["height"], 608 * 352)
        workflow = self.workflow(compiled)
        self.assertEqual(workflow["1"]["inputs"]["unet_name"], core.MODEL_REF)
        inputs = workflow["5"]["inputs"]
        self.assertEqual(inputs["ref_images.ref_image_0"], ["100", 0])
        self.assertEqual(inputs["ref_videos.ref_video_0"], ["121", 0])
        self.assertEqual(inputs["ref_video_audios.ref_video_audio_0"], ["121", 1])
        prepared = self.root / compiled["input_manifest"][2]["prepared_file"]
        self.assertTrue(prepared.resolve().is_relative_to(self.root.resolve()))
        with av.open(str(prepared)) as container:
            self.assertEqual(float(container.streams.video[0].average_rate), 24)
            self.assertTrue(container.streams.audio)
            self.assertEqual(sum(1 for _ in container.decode(video=0)), 39)
        mtime = prepared.stat().st_mtime_ns
        self.workflow(self.compiled())
        self.assertEqual(prepared.stat().st_mtime_ns, mtime)

    def test_middle_guides_are_real_conditions_at_quarter_positions(self):
        images = [dict(id=f"m{i}", kind="image", role=f"middle_frame_{i}", file="face.png") for i in (1, 2, 3)]
        compiled = self.compiled([self.text] + images, connections=[], zones=[])
        self.assertEqual(compiled["model_mode"], "fl2va")
        workflow = self.workflow(compiled)
        guides = [n for n in workflow.values() if n["class_type"] == "MiniMaxH3AddGuide"]
        self.assertEqual([n["inputs"]["frame_idx"] for n in guides], [14, 28, 41])
        self.assertEqual(workflow["7"]["inputs"]["conditioning"], ["145", 0])
        self.assertTrue(all(n["inputs"]["latent"] == ["5", 1] for n in guides))

    def test_mixed_or_unknown_or_extra_auto_inputs_are_rejected(self):
        for items in ([self.picture, dict(id="key", kind="image", role="first_frame", file="face.png")],
                      [dict(id="bad", kind="image", role="unsupported", file="face.png")],
                      [dict(id=str(i), kind="image", role="auto", file="face.png") for i in range(3)]):
            with self.subTest(items=items), self.assertRaises(ValueError):
                self.compiled(items, connections=[])
        with self.assertRaises(ValueError):
            self.compiled(params={**self.params, "model_mode": "fl2va"})

    def test_disabled_inputs_are_explicitly_excluded_with_their_links(self):
        disabled = [dict(self.picture, id=f"stored-{i}", enabled=False) for i in range(12)]
        compiled = self.compiled([self.text, dict(self.picture, enabled=False), dict(self.video, enabled=False)] + disabled)
        self.assertEqual(compiled["model_mode"], "fl2va")
        self.assertNotIn("<Picture", compiled["compiled_prompt"])
        self.assertFalse(compiled["connection_manifest"][0]["included"])
        self.assertEqual(sum(entry["included"] for entry in compiled["input_manifest"]), 1)
        self.assertTrue(all(entry.get("reason") == "已停用" for entry in compiled["input_manifest"][1:]))
        self.assertFalse(any(node["class_type"] == "LoadImage" for node in self.workflow(compiled).values()))

    def test_reference_limits_and_video_ranges_are_actionable(self):
        for count in (10, 11):
            with self.assertRaisesRegex(ValueError, "9张"):
                self.compiled([dict(self.picture, id=f"p{i}") for i in range(count)], connections=[])
        for change in ({"video_start": 4}, {"video_duration": 16}, {"video_duration": float("nan")}, {"video_start": 2.99}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.compiled([dict(self.video, **change)], connections=[])
        short = self.compiled([dict(self.video, video_start=2.5, video_duration=2)], connections=[])
        self.assertEqual(short["input_manifest"][0]["video"]["frames"], 5)

    def test_mute_omits_audio_socket_and_tag(self):
        compiled = self.compiled([dict(self.video, include_audio=False)], connections=[])
        workflow = self.workflow(compiled)
        self.assertNotIn("<Audio", compiled["compiled_prompt"])
        self.assertFalse(any("ref_video_audio" in key for key in workflow["5"]["inputs"]))

    def test_record_refill_and_board_preserve_semantic_workspace(self):
        compiled = self.compiled()
        items = [self.text, self.picture, self.video]
        record = core.create_record("isolated", self.params, compiled["fields"], compiled["compiled_prompt"], {},
                                    items, self.workflow(compiled), self.connections, self.zones, compiled)
        payload = core.refill_payload(record["id"])
        self.assertEqual(payload["items"], items)
        self.assertEqual(payload["zones"], self.zones)
        self.assertEqual(payload["connections"], self.connections)
        self.assertEqual(payload["params"]["model_mode"], "auto")
        self.assertEqual(record["model_mode"], "ref2va")
        self.assertEqual(payload["compiled_prompt"], compiled["compiled_prompt"])
        with patch.object(backend, "BOARD_FILE", str(Path(self.library.name) / "board.json")):
            client = backend.app.test_client()
            saved = client.put("/api/boards/default", json=payload)
            self.assertEqual(saved.status_code, 200)
            self.assertEqual(client.get("/api/boards/default").get_json()["zones"], self.zones)

    def test_estimate_uses_connections_and_never_uses_gpu_or_prepares_media(self):
        with patch.object(core, "comfy_get", side_effect=AssertionError("GPU")), patch.object(refs, "prepare_video", side_effect=AssertionError("Unexpected transcode")):
            result = tasks.estimate([self.text, self.picture, self.video], self.params, self.connections, self.zones)
        self.assertEqual(result["model_mode"], "ref2va")
        self.assertIn("后者参考前者的动作", result["compiled_prompt"])
        self.assertEqual(result["input_manifest"][2]["video"]["frame_count"], 39)
        self.assertIsNone(result["estimate_seconds"])

    def test_submit_saves_exact_compilation_and_prepared_video(self):
        manager = tasks.TaskManager()
        manager.ready.set()
        available = {"fl2va": {"available": True}, "ref2va": {"available": True}}
        with patch.object(core, "model_status", return_value=available), patch.object(core, "comfyui_running", return_value=True), \
             patch.object(core, "comfy_post", side_effect=lambda path, payload, **kw: {"prompt_id": payload["prompt_id"]}) as post:
            record = manager.submit([self.text, self.picture, self.video], self.params, connections=self.connections, zones=self.zones)
        self.assertEqual(record["model"], core.MODEL_REF)
        self.assertEqual(record["status"], "submitting")
        submitted = post.call_args.args[1]["prompt"]
        self.assertEqual(submitted["5"]["inputs"]["prompt"], record["compiled_prompt"])
        self.assertEqual(submitted["120"]["inputs"]["file"], record["input_manifest"][2]["prepared_file"])
        self.assertEqual(record["zones"], self.zones)
        self.assertEqual(record["connection_manifest"][0]["to_tag"], "<Picture 1>")

    def test_missing_model_blocks_submission_before_engine_access(self):
        available = {"fl2va": {"available": True}, "ref2va": {"available": False}}
        with patch.object(core, "model_status", return_value=available), patch.object(core, "comfyui_running", side_effect=AssertionError("Do not touch engine")):
            with self.assertRaisesRegex(ValueError, "尚未安装"):
                tasks.TaskManager().submit([self.text, self.picture, self.video], self.params, connections=self.connections, zones=self.zones)
        self.assertFalse(Path(core.RECORDS_FILE).exists())

    def test_empty_text_with_notes_is_truthfully_included(self):
        compiled = self.compiled([dict(self.text, content="", notes="摄影机缓慢向左平移")], connections=[], zones=[])
        self.assertTrue(compiled["input_manifest"][0]["included"])
        self.assertIn("摄影机缓慢向左平移", compiled["compiled_prompt"])

    def test_storyboard_order_is_explicit_without_reassigning_image_tags(self):
        second = dict(self.picture, id="second", reference_role="storyboard", shot_order=2, zone_id="boards")
        first = dict(second, id="first", shot_order=1)
        text = dict(self.text, role="storyboard", content="从大全景推到人物近景", shot_order=3)
        compiled = self.compiled([second, first, text], connections=[], zones=[dict(id="boards", name="分镜", purpose="storyboard", slot=3)])
        self.assertIn("分镜参考顺序：<Picture 2> → <Picture 1> → [文字1]", compiled["compiled_prompt"])
        self.assertIn("不生成拼贴或分镜边框", compiled["compiled_prompt"])
        self.assertEqual(compiled["input_manifest"][0]["item_id"], "second")
        for value in (0, 101, True, 1.5, "2"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "分镜序号"):
                self.compiled([dict(first, shot_order=value)], connections=[], zones=self.zones)

    def test_input_packet_matches_workflow_and_excludes_editor_geometry(self):
        compiled = self.compiled([self.text, self.picture, self.video, dict(self.picture, id="off", enabled=False)])
        packet = refs.input_packet(compiled)
        workflow = self.workflow(compiled)
        self.assertEqual(packet["text"], workflow["5"]["inputs"]["prompt"])
        self.assertEqual(len(packet["images"]), 1)
        self.assertEqual(packet["images"][0]["socket"], "ref_images.ref_image_0")
        self.assertEqual(packet["videos"][0]["video"]["frames"], 39)
        self.assertEqual(packet["audio"][0]["socket"], "ref_video_audios.ref_video_audio_0")
        self.assertIn(packet["audio"][0]["socket"], workflow["5"]["inputs"])
        self.assertFalse(packet["layout_metadata_sent"])
        self.assertNotIn("fov", json.dumps(packet))
        estimate = tasks.estimate([self.text, self.picture, self.video], self.params, self.connections, self.zones)
        self.assertEqual(estimate["input_packet"], packet)

    def test_streaming_webm_without_duration_is_real_video_reference(self):
        # Pipe output has no seekable duration header, like browser MediaRecorder.
        result = subprocess.run([get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error",
                                 "-f", "lavfi", "-i", "testsrc2=size=320x192:rate=24:duration=2.5",
                                 "-c:v", "libvpx", "-deadline", "realtime", "-an", "-f", "webm", "pipe:1"],
                                capture_output=True, check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        source = self.root / "layout-capture.webm"
        source.write_bytes(result.stdout)
        with av.open(str(source)) as container:
            self.assertIsNone(container.duration)
        info = refs.probe_video(source)
        self.assertAlmostEqual(info["duration"], 2.5, delta=.05)
        video = dict(self.video, file=source.name, reference_role="layout", video_start=0, include_audio=False)
        compiled = self.compiled([self.text, video], connections=[], zones=[])
        workflow = self.workflow(compiled)
        self.assertIn("ref_videos.ref_video_0", workflow["5"]["inputs"])
        prepared = self.root / compiled["input_manifest"][1]["prepared_file"]
        with av.open(str(prepared)) as container:
            self.assertEqual(sum(1 for _ in container.decode(video=0)), 39)

    def test_rig_and_sequence_metadata_survive_record_refill(self):
        scene = dict(version=2, objects=[dict(id="human", type="male", pose={"leftElbow":[0,0,45]},
                      hands={"left":"point","right":"fist"}, ik={"leftHandPole":[0,1,2]}, body={"height":1.8})],
                     sequence={"duration":5,"keys":[{"id":"k1","time":0,"camera":{"position":[0,1,3]}}]},
                     retained="x" * 110000)
        item = dict(self.picture, layout=scene, reference_role="layout")
        compiled = self.compiled([self.text, item], connections=[])
        record = core.create_record("rig", self.params, compiled["fields"], compiled["compiled_prompt"], {},
                                    [self.text,item], self.workflow(compiled), [], self.zones, compiled)
        restored = core.refill_payload(record["id"])
        self.assertEqual(restored["items"][1]["layout"], scene)
        self.assertEqual(record["input_packet"]["images"][0]["reference_role"], "layout")


if __name__ == "__main__":
    unittest.main()
