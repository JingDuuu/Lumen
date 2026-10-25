"""Portable reference preset tests using generated media in temporary libraries."""
import copy
import hashlib
import io
import json
import struct
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

from flask import Flask, jsonify
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from asset_presets import AssetPresetStore, create_blueprint


class AssetPresetsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lumen-preset-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.inputs = self.root / "input"
        self.inputs.mkdir()
        Image.new("RGB", (32, 24), "steelblue").save(self.inputs / "fixture.png")
        self.store = AssetPresetStore(self.root / "presets", self.inputs, self.root / "previs")
        self.payload = dict(
            name="蓝色大飞鱼", category="character", description="保持蓝色鳞片与翅鳍",
            items=[
                dict(id="text", kind="text", role="char", content="蓝色大飞鱼", x=30, y=160, w=320, h=220, zone_id="characters"),
                dict(id="image", kind="image", role="reference", reference_role="character", character_view="side", notes="侧面参考", file="fixture.png", x=400, y=160, w=320, h=280, zone_id="characters", enabled=False),
            ], connections=[dict(id="link", **{"from":"image", "to":"text"}, label="character_consistency")],
            zones=[dict(id="characters", name="人物", purpose="character", slot=0, x=-1180, y=-1180, w=1180, h=1180)],
            params=dict(resolution="608,352", duration=2, steps=8, seed=112),
        )
        self.app = Flask(__name__)
        self.app.register_blueprint(create_blueprint(lambda:self.store.root, lambda:self.inputs, lambda:self.store.previs_root))
        self.app.register_error_handler(ValueError, lambda error:(jsonify(ok=False,error=str(error)),400))
        self.client = self.app.test_client()

    def save(self):
        response = self.client.post("/api/asset-presets", json=self.payload)
        self.assertEqual(response.status_code, 200, response.data)
        return response.json["preset"]

    def package_with(self, preset, mutate):
        source = self.store.package(preset["id"])
        with zipfile.ZipFile(source) as archive:
            files = {entry.filename:archive.read(entry.filename) for entry in archive.infolist()}
        manifest = json.loads(files["asset-preset.json"])
        mutate(manifest,files)
        files["asset-preset.json"] = json.dumps(manifest).encode()
        output = io.BytesIO()
        with zipfile.ZipFile(output,"w") as archive:
            for name,data in files.items():archive.writestr(name,data)
        output.seek(0)
        return output

    def test_save_exact_metadata_without_changing_source(self):
        original = copy.deepcopy(self.payload)
        saved = self.save()
        for key in ("items","connections","zones","params"):
            self.assertEqual(saved[key],original[key])
        self.assertEqual(self.payload,original)
        self.assertEqual(len(saved["assets"]),1)
        self.assertTrue(self.inputs.joinpath("fixture.png").exists())
        self.assertEqual(self.client.get("/api/asset-presets?q=翅鳍&category=character").json["presets"][0]["name"],original["name"])

    def test_instances_have_fresh_ids_links_and_recover_deleted_media(self):
        saved = self.save()
        first = self.store.instantiate(saved["id"])
        self.assertEqual(first["items"][1]["file"],"fixture.png")
        self.inputs.joinpath("fixture.png").unlink()
        second = self.store.instantiate(saved["id"])
        self.assertTrue(self.inputs.joinpath(second["items"][1]["file"]).is_file())
        self.assertFalse(set(item["id"] for item in first["items"]) & set(item["id"] for item in second["items"]))
        self.assertEqual(second["connections"][0]["from"],second["items"][1]["id"])
        self.assertEqual(second["connections"][0]["to"],second["items"][0]["id"])
        self.assertEqual(second["params"],self.payload["params"])
        self.assertEqual(second["items"][1]["character_view"],"side")
        self.assertFalse(second["items"][1]["enabled"])

    def test_metadata_edit_and_delete_do_not_touch_inputs(self):
        saved = self.save()
        path = "/api/asset-presets/"+saved["id"]
        changed = self.client.patch(path,json={"name":"飞鱼角色","category":"style"})
        self.assertEqual(changed.status_code,200)
        self.assertEqual(changed.json["preset"]["items"],saved["items"])
        self.assertEqual(self.client.delete(path).status_code,200)
        self.assertTrue((self.inputs/"fixture.png").exists())
        self.assertFalse(self.store.folder(saved["id"]).exists())

    def test_multipart_zip_roundtrip_collects_dependencies(self):
        saved = self.save()
        data = self.client.get("/api/asset-presets/"+saved["id"]+"/package").data
        response = self.client.post("/api/asset-presets/import",data={"file":(io.BytesIO(data),"fixture.zip")})
        self.assertEqual(response.status_code,200,response.data)
        imported = response.json["preset"]
        self.assertNotEqual(imported["id"],saved["id"])
        self.assertEqual(imported["items"],saved["items"])
        self.store.delete(saved["id"])
        self.inputs.joinpath("fixture.png").unlink()
        instance = self.store.instantiate(imported["id"])
        self.assertTrue(self.inputs.joinpath(instance["items"][1]["file"]).is_file())

    def test_managed_layout_asset_is_portable(self):
        asset_id = "a"*32
        folder = self.store.previs_root/"assets"/asset_id
        folder.mkdir(parents=True)
        (folder/"mesh.bin").write_bytes(b"generated local fixture")
        (folder/"model.gltf").write_text(json.dumps({"asset":{"version":"2.0"},"buffers":[{"uri":"mesh.bin","byteLength":23}]}))
        self.payload["items"][1]["layout"]={"version":3,"objects":[{"id":"mesh","asset":{"url":f"/api/previs/assets/{asset_id}/model.gltf"}}]}
        saved=self.save()
        other=AssetPresetStore(self.root/"other-presets",self.root/"other-input",self.root/"other-previs")
        imported=other.import_package(self.store.package(saved["id"]))
        instance=other.instantiate(imported["id"])
        url=instance["items"][1]["layout"]["objects"][0]["asset"]["url"]
        self.assertNotIn(asset_id,url)
        relative=url.split("/api/previs/assets/",1)[1]
        self.assertTrue((other.previs_root/"assets"/relative).is_file())
        self.assertEqual((other.previs_root/"assets"/relative).with_name("mesh.bin").read_bytes(),b"generated local fixture")

    def test_invalid_package_paths_hashes_types_and_external_gltf_are_rejected(self):
        saved=self.save()
        mutations=[
            lambda manifest,files:files.update({"../escape.png":b"bad"}),
            lambda manifest,files:manifest["assets"][0].update(sha256="0"*64),
            lambda manifest,files:manifest["assets"][0].update(type="previs"),
            lambda manifest,files:manifest["items"][1].update(file="https://example.com/image.png"),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                with self.assertRaises(ValueError):self.store.import_package(self.package_with(saved,mutation))
        def external_gltf(manifest,files):
            data=json.dumps({"asset":{"version":"2.0"},"buffers":[{"uri":"https://example.com/mesh.bin"}]}).encode()
            relative="previs/fixture/model.gltf"
            files[relative]=data
            manifest["assets"].append(dict(source="/api/previs/assets/"+"a"*32+"/model.gltf",type="previs",path=relative,sha256=hashlib.sha256(data).hexdigest()))
        with self.assertRaises(ValueError):self.store.import_package(self.package_with(saved,external_gltf))
        def external_glb(manifest,files):
            data=json.dumps({"asset":{"version":"2.0"},"images":[{"uri":"https://example.com/texture.png"}]}).encode()
            data += b' ' * ((-len(data)) % 4)
            binary=b'glTF'+struct.pack('<III',2,20+len(data),len(data))+b'JSON'+data
            relative='previs/fixture/model.glb';files[relative]=binary
            manifest['assets'].append(dict(source='/api/previs/assets/'+'a'*32+'/model.glb',type='previs',path=relative,sha256=hashlib.sha256(binary).hexdigest()))
        with self.assertRaises(ValueError):self.store.import_package(self.package_with(saved,external_glb))
        self.assertEqual(len(self.store.list()),1)
        self.assertFalse(list(self.store.root.glob(".*.tmp")))

    def test_missing_or_external_assets_fail_atomically(self):
        self.payload["items"][1]["file"]="missing.png"
        with self.assertRaises(ValueError):self.store.save(self.payload)
        self.payload["items"][1]["file"]="fixture.png"
        self.payload["items"][1]["layout"]={"objects":[{"asset":{"url":"https://example.com/mesh.glb"}}]}
        with self.assertRaises(ValueError):self.store.save(self.payload)
        self.assertEqual(self.store.list(),[])
        self.assertFalse(list(self.store.root.glob(".*.tmp")))


if __name__=="__main__":unittest.main()
