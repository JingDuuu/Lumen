"""Real compilation and workflow checks, no model or personal library writes."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lumen_core as core
import reference_inputs as refs
import tasks


class DirectorPromptTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        Image.new("RGB", (64, 64), "steelblue").save(self.root / "ref.png")
        for key, value in {"INPUT_DIR": directory.name, "RECORDS_FILE": str(self.root / "records.json"),
                           "MEMORY_FILE": str(self.root / "memory.json")}.items():
            p = patch.object(core, key, value)
            p.start()
            self.addCleanup(p.stop)
        self.params = tasks.validate_params(dict(duration=5, steps=6, seed=0, resolution="608,352"))

    def image(self, id, **fields):
        return dict(id=id, kind="image", role="reference", file="ref.png", reference_role="character", **fields)

    def compile(self, items, zones=None, edges=None, **params):
        return core.compile_inputs(items, {**self.params, **params}, edges or [], zones or [])

    def test_shared_character_area_never_merges_unrelated_people(self):
        c = self.compile([self.image("man", zone_id="people"), self.image("woman", zone_id="people")],
                         [dict(id="people", purpose="character", name="人物")])
        self.assertEqual(len(c["subjects"]), 2)
        self.assertEqual(c["subjects"][0]["references"], ["<Picture 1>"])
        self.assertEqual(c["subjects"][1]["references"], ["<Picture 2>"])
        self.assertNotIn("同一人物身份组", c["compiled_prompt"])
        self.assertNotIn("分区", c["compiled_prompt"])

    def test_explicit_identity_combines_views_but_not_other_characters(self):
        c = self.compile([self.image("a", character_id="hero"),
                          self.image("b", character_id="hero", character_view="side"),
                          self.image("c", character_id="guest")])
        self.assertEqual(len(c["subjects"]), 2)
        self.assertEqual(c["subjects"][0]["item_ids"], ["a", "b"])
        self.assertEqual(len(c["subjects"][0]["references"]), 2)

    def test_legacy_preset_identity_and_duplicate_notes_preserve_words(self):
        note = "橙粉短发、贝雷帽、记者服。"
        action = '怒视屏幕，右手指着屏幕怒吼：\n“You\'re Fired!!!!!”'
        c = self.compile([
            self.image("hero", preset_id="reporter", description=note, notes=note),
            dict(id="identity", kind="text", role="char", preset_id="reporter", content=note),
            dict(id="full", kind="text", role="extra", content="蓝色西装壮汉" + action),
            dict(id="action", kind="text", role="action", content=action)])
        prompt = c["compiled_prompt"]
        self.assertEqual(len(c["subjects"]), 1)
        self.assertEqual(prompt.count(note), 1)
        self.assertEqual(prompt.count("You're Fired!!!!!"), 1)
        self.assertIn("蓝色西装壮汉", prompt)
        self.assertNotIn("[文字", prompt)
        self.assertNotIn("→", prompt)

    def test_picture_numbers_stay_aligned_with_sockets_when_excluded(self):
        c = self.compile([self.image("disabled", enabled=False), self.image("active")])
        wf = core.build_workflow(c["compiled_prompt"], 608, 352, 5, 6, 0, compiled=c)
        self.assertNotIn("<Picture 2>", c["compiled_prompt"])
        self.assertEqual(refs.input_packet(c)["images"][0]["socket"], "ref_images.ref_image_0")
        self.assertEqual(wf["5"]["inputs"]["ref_images.ref_image_0"], ["100", 0])

    def test_dialogue_speaker_sfx_music_and_silent_output(self):
        items = [self.image("hero", character_id="hero", character_name="记者"),
                 dict(id="line", kind="text", role="audio", audio_type="dialogue", speaker_id="hero", content="You're Fired!!!!!"),
                 dict(id="sound", kind="text", role="audio", audio_type="sfx", content="手拍桌面的闷响"),
                 dict(id="music", kind="text", role="audio", audio_type="music", content="低沉弦乐")]
        c = self.compile(items)
        self.assertIn("<Subject 1>（记者）说：<d>[English] You're Fired!!!!!</d>", c["compiled_prompt"])
        self.assertIn("音效：手拍桌面的闷响", c["compiled_prompt"])
        self.assertIn("配乐：\n低沉弦乐", c["compiled_prompt"])
        silent = self.compile(items, audio_mode="silent")
        wf = core.build_workflow(silent["compiled_prompt"], 608, 352, 5, 6, 0, compiled=silent)
        self.assertNotIn("audio", wf["13"]["inputs"])
        self.assertNotIn("12", wf)
        self.assertNotIn("You're Fired", silent["compiled_prompt"])
        self.assertNotIn("低沉弦乐", silent["compiled_prompt"])
        record = core.create_record("silent", {**self.params, "audio_mode": "silent"}, silent["fields"], silent["compiled_prompt"], {}, items, wf, compiled=silent)
        self.assertEqual(core.refill_payload(record["id"])["params"]["audio_mode"], "silent")

    def test_disabled_speaker_cannot_silently_change_to_another_person(self):
        with self.assertRaisesRegex(ValueError, "说话人"):
            self.compile([self.image("hero", character_id="hero", enabled=False),
                          dict(id="line", kind="text", role="audio", audio_type="dialogue", speaker_id="hero", content="你好")])

    def test_layout_identity_is_bound_without_sending_scene_json(self):
        c = self.compile([self.image("hero", character_id="hero", character_name="蓝飞鱼"),
                          dict(id="layout", kind="image", file="ref.png", role="reference", reference_role="layout",
                               layout={"objects": [{"id": "proxy", "character_id": "hero"}, {"id": "plane", "character_id": "hero"}]})])
        self.assertIn("<Picture 2> 中的角色布局对应 <Subject 1>（蓝飞鱼）", c["compiled_prompt"])
        self.assertFalse(refs.input_packet(c)["layout_metadata_sent"])

    def test_high_reference_count_still_submits_without_confirmation(self):
        items = [self.image(str(i), character_id="hero") for i in range(4)]
        manager = tasks.TaskManager()
        manager.ready.set()
        available = {"fl2va": {"available": True}, "ref2va": {"available": True}}
        with patch.object(core, "model_status", return_value=available), patch.object(core, "comfyui_running", return_value=True), \
                patch.object(core, "comfy_post", side_effect=lambda path, payload, **kwargs: {"prompt_id": payload["prompt_id"]}):
            estimate = tasks.estimate(items, self.params)
            self.assertFalse(estimate["requires_confirmation"])
            self.assertEqual(estimate["resource_tier"], "extended")
            record = manager.submit(items, self.params)
        self.assertEqual(record["status"], "submitting")

    def test_reject_invalid_audio_and_identity_metadata(self):
        for change in ({"audio_type": "banana"}, {"character_id": []}, {"speaker_id": {}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                refs.validate_metadata(change)
        with self.assertRaises(ValueError):
            tasks.validate_params({"audio_mode": "unknown"})

    def test_timing_history_ignores_dormant_library_assets(self):
        active = self.image("hero")
        compiled = self.compile([active])
        record = core.create_record("timing", self.params, compiled["fields"], compiled["compiled_prompt"], {},
                                    [active], compiled=compiled)
        core.update_record(record["id"], status="done", elapsed_seconds=60)
        result = tasks.estimate([active, self.image("dormant", enabled=False)], self.params)
        self.assertEqual(result["estimate_seconds"], 60)
        silent = tasks.estimate([active], {**self.params, "audio_mode": "silent"})
        self.assertIsNone(silent["estimate_seconds"])

    def test_asset_toggle_keeps_member_exclusions_and_exact_identity(self):
        active = self.image("portrait", character_id="hero", asset_enabled=False)
        note = dict(id="provenance", kind="text", role="extra", character_id="hero", enabled=False,
                    content="资料与来源（不参与生成）：https://example.invalid/source")
        off = self.compile([active, note])
        self.assertFalse(any(e["included"] for e in off["input_manifest"]))
        on = self.compile([{**active, "asset_enabled": True}, {**note, "asset_enabled": True}])
        self.assertEqual(len(on["subjects"]), 1)
        self.assertNotIn("example.invalid", on["compiled_prompt"])
        self.assertFalse(on["input_manifest"][1]["included"])

    def test_legacy_reference_link_keeps_shot_action_out_of_identity_and_dedupes(self):
        action = '怒视屏幕，右手指着屏幕怒吼：“You\'re Fired!!!!!”'
        items = [self.image("person", character_id="hero"),
                 dict(id="instruction", kind="text", role="extra", character_id="hero", content="蓝色西装壮汉" + action),
                 dict(id="action", kind="text", role="action", content=action)]
        c = self.compile(items, edges=[dict(id="ref", **{"from": "person", "to": "instruction"}, label="reference")])
        self.assertEqual(c["compiled_prompt"].count("You're Fired!!!!!"), 1)
        self.assertNotIn("怒吼", c["prompt_sections"][0]["text"])
        self.assertIn("以 <Subject 1> 为参考表现：蓝色西装壮汉", c["compiled_prompt"])

    def test_area_notes_and_audio_identity_links_keep_their_meaning(self):
        items = [self.image("hero", character_id="hero", zone_id="scene"),
                 dict(id="line", kind="text", role="audio", audio_type="dialogue", content="听，雨停了。")]
        zones = [dict(id="scene", purpose="scene", notes="红色灯笼全部熄灭。")]
        edges = [dict(id="speaker", **{"from": "hero", "to": "line"}, label="character_consistency")]
        c = self.compile(items, zones, edges)
        self.assertIn("红色灯笼全部熄灭", c["compiled_prompt"])
        self.assertIn("<Subject 1>说：<d>[Chinese] 听，雨停了。</d>", c["compiled_prompt"])
        self.assertNotIn("雨停了", c["prompt_sections"][0]["text"])
        silent = self.compile(items, zones, edges, audio_mode="silent")
        self.assertNotIn("雨停了", silent["compiled_prompt"])

    def test_shared_asset_speaker_requires_unambiguous_character_id(self):
        people = [self.image("a", character_id="actor-a", asset_id="twins"),
                  self.image("b", character_id="actor-b", asset_id="twins")]
        line = dict(id="line", kind="text", role="audio", audio_type="dialogue", speaker_id="twins", content="Hello")
        with self.assertRaisesRegex(ValueError, "多个人物"):
            self.compile(people + [line])
        c = self.compile(people + [{**line, "speaker_id": "actor-a"}])
        self.assertIn("<Subject 1>说：", c["compiled_prompt"])
        self.assertNotIn("<Subject 2>说：", c["compiled_prompt"])

    def test_unknown_layout_metadata_does_not_crash_prompt_compilation(self):
        for objects in (None, "external metadata", [None, 1, {}]):
            with self.subTest(objects=objects):
                self.compile([dict(id="layout", kind="image", file="ref.png", role="reference", reference_role="layout", layout={"objects": objects})])


if __name__ == "__main__":
    unittest.main()
