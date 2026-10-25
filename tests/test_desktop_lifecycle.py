"""Windows lifecycle tests use small Python sentinels, never the real engine."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from desktop import SingleInstance
from engine_runtime import ProcessJob


def wait_until(predicate, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class DesktopLifecycleTests(unittest.TestCase):
    def test_single_instance_mutex_is_released(self):
        name = "Local\\Lumen.Test." + uuid.uuid4().hex
        first = SingleInstance(name)
        second = SingleInstance(name)
        try:
            self.assertTrue(first.primary)
            self.assertFalse(second.primary)
        finally:
            second.close()
            first.close()
        third = SingleInstance(name)
        try:
            self.assertTrue(third.primary)
        finally:
            third.close()

    def test_job_closes_child_and_grandchild_only(self):
        with tempfile.TemporaryDirectory() as folder:
            pid_file = Path(folder) / "grandchild.txt"
            child_code = (
                "import subprocess,sys,time; from pathlib import Path; "
                "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']); "
                f"Path({str(pid_file)!r}).write_text(str(p.pid)); time.sleep(60)"
            )
            sentinel = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(60)"],
                                        creationflags=subprocess.CREATE_NO_WINDOW)
            job = ProcessJob()
            try:
                with open(Path(folder) / "output.log", "ab") as output:
                    child_pid = job.spawn([sys.executable, "-c", child_code], folder, output, output)
                self.assertTrue(wait_until(pid_file.exists))
                grandchild_pid = int(pid_file.read_text())
                self.assertTrue(psutil.pid_exists(child_pid))
                self.assertTrue(psutil.pid_exists(grandchild_pid))
                job.close()
                self.assertTrue(wait_until(lambda: not psutil.pid_exists(child_pid)))
                self.assertTrue(wait_until(lambda: not psutil.pid_exists(grandchild_pid)))
                self.assertIsNone(sentinel.poll(), "An unrelated process was terminated")
            finally:
                job.close()
                sentinel.terminate()
                sentinel.wait(timeout=5)

    def test_owner_crash_also_closes_job(self):
        with tempfile.TemporaryDirectory() as folder:
            evidence = Path(folder) / "pid.json"
            owner_code = (
                "from engine_runtime import ProcessJob; import sys,time,json; from pathlib import Path; "
                "j=ProcessJob(); f=open('child.log','ab'); "
                "pid=j.spawn([sys.executable,'-c','import time;time.sleep(60)'],'.',f,f); "
                f"Path({str(evidence)!r}).write_text(json.dumps({{'pid':pid}})); time.sleep(60)"
            )
            env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]))
            owner = subprocess.Popen([sys.executable, "-c", owner_code], cwd=folder, env=env,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                self.assertTrue(wait_until(evidence.exists))
                child_pid = json.loads(evidence.read_text())["pid"]
                self.assertTrue(psutil.pid_exists(child_pid))
                owner.terminate()
                owner.wait(timeout=5)
                self.assertTrue(wait_until(lambda: not psutil.pid_exists(child_pid)))
            finally:
                if owner.poll() is None:
                    owner.terminate()
                    owner.wait(timeout=5)

    def test_shutdown_blocks_late_engine_start(self):
        code = "import engine_runtime as e; e.shutdown(); e.start()"
        result = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1],
                                capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"RuntimeError", result.stderr)


if __name__ == "__main__":
    unittest.main()
