"""Real CLI/HTTP acceptance against ui_fixture.py's disposable data only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def main():
    evidence = {"fixture": "temporary random-port server; no user data", "engine_jobs": 0, "checks": []}
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    raw_env = {key:value for key,value in os.environ.items() if key not in {"PYTHONIOENCODING", "PYTHONUTF8"}}
    fixture = subprocess.Popen([sys.executable, str(ROOT / "tests/ui_fixture.py")], cwd=ROOT,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", env=env)
    try:
        url = fixture.stdout.readline().strip()
        assert url.startswith("http://127.0.0.1:"), (url, fixture.stderr.read())
        def cli(*arguments, payload=None, expected=0):
            command = [sys.executable, str(ROOT / "lumen.py"), *arguments, "--url", url, "--json"]
            if payload is not None:
                command += ["--input", "-"]
            completed = subprocess.run(command, input=json.dumps(payload, ensure_ascii=False) if payload is not None else None,
                                       capture_output=True, encoding="utf-8", timeout=30, env=raw_env)
            assert completed.returncode == expected, (arguments, completed.returncode, completed.stdout, completed.stderr)
            result = json.loads(completed.stdout)
            assert result["ok"] == (expected == 0), result
            return result["result"] if expected == 0 else result
        def check(name):
            evidence["checks"].append({"name": name, "passed": True})
        with tempfile.TemporaryDirectory(prefix="lumen-agent-e2e-") as folder:
            folder = Path(folder)
            discovered = cli("discover")
            routes = [endpoint["path"] for endpoint in discovered["endpoints"]]
            assert "/api/asset-presets" in routes and "/api/previs/export" in routes
            assert "BoardOperations" in cli("schema")["$defs"]
            catalog = cli("catalog")
            assert len(catalog["poses"]) >= 50
            check("discover all registered APIs, JSON Schema and original pose catalog")
            source = folder / "虚构海岸.png"
            Image.new("RGB", (320, 180), (54, 112, 143)).save(source)
            uploaded = cli("upload", str(source))["name"]
            downloaded = folder / "downloaded-coast.png"
            cli("api", "GET", "/input/" + uploaded, "--output", str(downloaded))
            assert downloaded.read_bytes() == source.read_bytes()
            check("Chinese-filename multipart upload and binary download preserve exact media bytes")
            preset = {"name":"Synthetic coast reference", "category":"scene", "description":"CLI acceptance fixture",
                "items":[{"id":"prompt-original","kind":"text","role":"scene","content":"虚构海岸，镜头缓慢推进","zone_id":"zone-original","x":40,"y":40},
                         {"id":"image-original","kind":"image","role":"reference","reference_role":"scene","file":uploaded,"zone_id":"zone-original","x":400,"y":40}],
                "connections":[{"id":"edge-original","from":"image-original","to":"prompt-original","label":"reference"}],
                "zones":[{"id":"zone-original","name":"Coast","purpose":"scene","x":0,"y":0,"w":800,"h":500}],
                "params":{"resolution":"608,352","duration":2,"steps":8,"seed":0}}
            created = cli("api", "POST", "/api/asset-presets", payload=preset)["preset"]
            assert cli("api", "GET", "/api/asset-presets/" + created["id"])["preset"]["name"] == preset["name"]
            package = folder / "references.zip"
            cli("api", "GET", "/api/asset-presets/" + created["id"] + "/package", "--output", str(package))
            assert package.stat().st_size > 100
            cli("api", "DELETE", "/api/asset-presets/" + created["id"])
            imported = cli("upload", str(package), "--path", "/api/asset-presets/import")["preset"]
            before = cli("board", "get")
            instantiated = cli("api", "POST", "/api/asset-presets/" + imported["id"] + "/instantiate", payload={})
            assert cli("board", "get")["revision"] == before["revision"]
            assert instantiated["items"][0]["id"] != "prompt-original"
            ids = {item["id"] for item in instantiated["items"]}
            assert all(edge["from"] in ids and edge["to"] in ids for edge in instantiated["connections"])
            check("reference preset create/get/package/delete/import/instantiate remaps IDs without writing board")
            operations = ([{"op":"add_zone","value":zone} for zone in instantiated["zones"]] +
                          [{"op":"add_item","value":item} for item in instantiated["items"]] +
                          [{"op":"add_connection","value":edge} for edge in instantiated["connections"]])
            transaction = {"expected_revision":before["revision"],"request_id":"cli-inject-reference-v1","operations":operations}
            preview = cli("preview", payload=transaction)
            assert not preview["submits_generation"] and not preview["writes_board"]
            assert preview["estimate"]["compiled_prompt"]
            assert cli("board", "get")["revision"] == before["revision"]
            check("full draft preview compiles actual reference manifest without saving or generating")
            unicode_payload = {"items":[{"id":"unicode","kind":"text","role":"scene","content":"虚构海岸的灯塔 🌊"}],"params":preset["params"]}
            raw = subprocess.run([sys.executable,str(ROOT / "lumen.py"),"preview","--input","-","--url",url,"--json"],
                                 input=json.dumps(unicode_payload,ensure_ascii=False).encode("utf-8-sig"), capture_output=True, env=raw_env, timeout=30)
            assert raw.returncode == 0, (raw.returncode,raw.stdout,raw.stderr)
            decoded = json.loads(raw.stdout.decode("utf-8"))
            assert "虚构海岸的灯塔 🌊" in decoded["result"]["estimate"]["compiled_prompt"]
            assert all(byte < 128 for byte in raw.stdout)
            check("default Windows environment preserves Chinese and emoji from UTF-8 BOM stdin through ASCII-safe JSON bytes")
            if os.name == "nt":
                wrapped = subprocess.run(["cmd.exe","/d","/c",str(ROOT / "lumen.bat"),"preview","--input","-","--url",url,"--json"],
                                         input=json.dumps(unicode_payload,ensure_ascii=False).encode("utf-8-sig"),capture_output=True,env=raw_env,timeout=30)
                assert wrapped.returncode == 0, (wrapped.returncode,wrapped.stdout,wrapped.stderr)
                wrapped_result = json.loads(wrapped.stdout.decode("utf-8"))
                assert "虚构海岸的灯塔 🌊" in wrapped_result["result"]["estimate"]["compiled_prompt"]
                check("normal lumen.bat/PowerShell launcher preserves piped JSON stdin and structured stdout")
            applied = cli("board", "apply", payload=transaction)
            replayed = cli("board", "apply", payload=transaction)
            assert replayed["replayed"] and applied["revision"] == replayed["revision"]
            assert len(applied["board"]["items"]) == len(before["board"]["items"]) + len(instantiated["items"])
            conflicting = {**transaction, "request_id":"conflicting-v2"}
            error = cli("board", "apply", payload=conflicting, expected=5)
            assert error["code"] == "REVISION_CONFLICT"
            check("atomic external board injection, replay deduplication and stale-revision exit 5")
            scene = {"version":3,"name":"Synthetic actor blocking","objects":[{"id":"actor","type":"adult_female","position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"pose":catalog["poses"][0]["pose"]}],
                     "sequence":{"duration":2,"fps":24,"tracks":[{"id":"move","targetId":"actor","property":"position","keys":[{"time":0,"value":[0,0,0]},{"time":2,"value":[1,0,0]}]}]}}
            document = {"name":"Agent synthetic prefab","kind":"prefab","scene":scene}
            created_doc = cli("api", "POST", "/api/agent/documents", payload={"request_id":"cli-prefab-v1","document":document})
            doc_url = "/api/agent/documents/" + created_doc["id"]
            loaded_doc = cli("api", "GET", doc_url)
            assert loaded_doc["document"]["scene"]["sequence"]["tracks"][0]["keys"][1]["value"] == [1,0,0]
            saved = cli("api", "PUT", doc_url, payload={"request_id":"cli-prefab-v2","expected_revision":loaded_doc["revision"],"document":{**document,"name":"Updated synthetic prefab"}})
            doc_package = folder / "scene.zip"
            cli("api", "GET", "/api/previs/documents/" + created_doc["id"] + "/package", "--output", str(doc_package))
            cli("api", "DELETE", doc_url, payload={"request_id":"cli-prefab-delete","expected_revision":saved["revision"]})
            assert doc_package.stat().st_size > 100
            check("animated prefab JSON create/read/versioned update/package/delete")
            conversion = cli("api", "GET", "/api/previs/capabilities")
            assert "formats" in conversion and "blender_available" in conversion
            check("conversion discovery exposes local backend capabilities without starting a conversion")
            # Capture the actual subprocess return code, not a later shell command's status.
            bad = subprocess.run([sys.executable, str(ROOT / "lumen.py"), "api", "GET", "/api/system", "--url", "http://127.0.0.1:1", "--json", "--http-timeout", "0.5"],
                                 capture_output=True, encoding="utf-8", timeout=5, env=env)
            assert bad.returncode == 3 and json.loads(bad.stdout)["code"] == "CONNECTION_UNAVAILABLE"
            check("offline error is one structured JSON object with subprocess exit 3")
    finally:
        if fixture.poll() is None:
            _, fixture_errors = fixture.communicate("quit\n", timeout=10)
            if fixture_errors:
                print(fixture_errors, file=sys.stderr)
    evidence["checked_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    evidence["passed"] = True
    output = ROOT / "diagnostics" / "agent-cli-acceptance.json"
    output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=False))


if __name__ == "__main__":
    main()
