"""Exercise exported agent entry points from a separate installation directory."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class AgentPortabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory(prefix="lumen-portable-agent-")
        cls.root = Path(cls.folder.name) / "Lumen Copy 中文 With Spaces"
        cls.unrelated = Path(cls.folder.name) / "other working directory"
        cls.unrelated.mkdir()
        cls.environ = {key: value for key, value in os.environ.items()
                       if not key.startswith("LUMEN_") and key != "PYTHONPATH"}
        source = Path(__file__).resolve().parents[1]
        subprocess.run([sys.executable, str(source / "scripts" / "export_source.py"),
                        "--destination", str(cls.root)], cwd=cls.unrelated, env=cls.environ,
                       capture_output=True, text=True, encoding="utf-8", check=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def test_exported_bootstrap_uses_new_installation_paths(self):
        program = """
import json
from pathlib import Path
import sys
sys.path.insert(0, sys.argv[1])
import app
import lumen_core as core
import runtime_config
core.comfyui_running = lambda: False
def forbidden(*args, **kwargs):
    raise AssertionError('No engine or desktop launch during portability validation')
app.start_services = forbidden
app.engine_runtime.start = forbidden
with app.app.test_client() as client:
    response = client.get('/api/agent/bootstrap', base_url='http://127.0.0.1:19345')
    assert response.status_code == 200, response.get_json()
    print(json.dumps({'bootstrap': response.get_json(),
                      'paths': runtime_config.CONFIG.as_dict(),
                      'module': app.__file__, 'library': core.LIB_DIR}))
"""
        process = subprocess.run([sys.executable, "-c", program, str(self.root)],
                                 cwd=self.unrelated, env=self.environ, capture_output=True,
                                 text=True, encoding="utf-8", timeout=30, check=True,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        value = json.loads(process.stdout)
        root = self.root.resolve()
        self.assertEqual(Path(value["module"]).resolve().parent, root)
        self.assertEqual(Path(value["paths"]["data_dir"]), root / "data")
        self.assertEqual(Path(value["library"]), root / "data" / "library")
        boot = value["bootstrap"]
        self.assertEqual(boot["api_url"], "http://127.0.0.1:19345")
        self.assertEqual(Path(boot["cli_path"]), root / "lumen.bat")
        self.assertEqual(Path(boot["output_directory"]), root / "data" / "output")
        server = boot["mcp_config"]["mcpServers"]["lumen"]
        self.assertEqual(Path(server["command"]), root / ".venv" / "Scripts" / "python.exe")
        self.assertEqual(Path(server["args"][-1]), root / "lumen_mcp.py")
        self.assertEqual(Path(server["cwd"]), root)
        self.assertIn(str(root / "lumen.bat"), boot["prompt"])
        self.assertIn(str(root / "data" / "output"), boot["prompt"])
        self.assertNotIn("{LUMEN_", boot["prompt"])
        self.assertFalse(boot["connection"]["engine_ready"])
        self.assertFalse(boot["connection"]["models_ready"])

    def test_exported_stdio_discovers_tools_without_original_installation(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-11-25", "capabilities": {},
                "clientInfo": {"name": "portable-check", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ]
        process = subprocess.run([sys.executable, str(self.root / "lumen_mcp.py")],
                                 input="\n".join(json.dumps(message) for message in messages) + "\n",
                                 cwd=self.unrelated, env=self.environ, capture_output=True,
                                 text=True, encoding="utf-8", timeout=15, check=True,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        responses = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual([reply["id"] for reply in responses], [1, 2])
        names = {tool["name"] for tool in responses[1]["result"]["tools"]}
        self.assertTrue({"lumen_connect", "lumen_generate", "lumen_result"} <= names)
        self.assertFalse((self.root / "data" / "library" / "records.json").exists())


if __name__ == "__main__":
    unittest.main()
