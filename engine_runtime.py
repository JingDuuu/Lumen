"""Lumen owns only the engine process tree that it starts."""
import _winapi
import ctypes
from ctypes import wintypes
import msvcrt
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from runtime_config import CONFIG


COMFY_DIR = CONFIG.comfy_dir
PYTHON = CONFIG.engine_python
_kernel = ctypes.WinDLL("kernel32", use_last_error=True)
_kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
_kernel.CreateJobObjectW.restype = wintypes.HANDLE
_kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
_kernel.SetInformationJobObject.restype = wintypes.BOOL
_kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
_kernel.AssignProcessToJobObject.restype = wintypes.BOOL
_kernel.ResumeThread.argtypes = [wintypes.HANDLE]
_kernel.ResumeThread.restype = wintypes.DWORD
_kernel.CloseHandle.argtypes = [wintypes.HANDLE]
_kernel.CloseHandle.restype = wintypes.BOOL


class _BasicLimit(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD)]


class _IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                 "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _ExtendedLimit(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", _BasicLimit), ("IoInfo", _IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


class ProcessJob:
    """A Windows kill-on-close job, with race-free child assignment."""

    def __init__(self):
        self.process = None
        self.pid = None
        self.handle = _kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = _ExtendedLimit()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not _kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def spawn(self, args, cwd, stdout, stderr):
        startup = subprocess.STARTUPINFO()
        startup.dwFlags = subprocess.STARTF_USESTDHANDLES | subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        with open(os.devnull, "rb") as stdin:
            handles = [msvcrt.get_osfhandle(stream.fileno()) for stream in (stdin, stdout, stderr)]
            startup.hStdInput, startup.hStdOutput, startup.hStdError = handles
            startup.lpAttributeList = {"handle_list": list(set(handles))}
            for handle in handles:
                os.set_handle_inheritable(handle, True)
            try:
                process, thread, pid, _ = _winapi.CreateProcess(
                    str(args[0]), subprocess.list2cmdline([str(arg) for arg in args]),
                    None, None, True, 0x4 | subprocess.CREATE_NO_WINDOW, None, str(cwd), startup)
            finally:
                for handle in handles:
                    os.set_handle_inheritable(handle, False)
        try:
            if not _kernel.AssignProcessToJobObject(self.handle, process):
                raise ctypes.WinError(ctypes.get_last_error())
            if _kernel.ResumeThread(thread) == 0xFFFFFFFF:
                raise ctypes.WinError(ctypes.get_last_error())
        except OSError:
            _winapi.TerminateProcess(process, 1)
            _winapi.CloseHandle(process)
            raise
        finally:
            _winapi.CloseHandle(thread)
        self.process, self.pid = process, pid
        return pid

    def alive(self):
        return self.process is not None and _winapi.WaitForSingleObject(self.process, 0) == 258

    def close(self):
        if self.handle:
            _kernel.CloseHandle(self.handle)
            self.handle = None
        if self.process is not None:
            _winapi.WaitForSingleObject(self.process, 5000)
            _winapi.CloseHandle(self.process)
            self.process = None


_job = None
_lock = threading.RLock()
_started_at = None
_last_error = None
_shutting_down = False


def state():
    with _lock:
        owned = bool(_job and _job.alive())
        error = _last_error
        if _job and not owned and not error:
            code = _winapi.GetExitCodeProcess(_job.process)
            error = f"生成引擎已退出（代码 {code}）。请重新启动；详细原因见 comfyui_err.log。"
        return {"owned": owned, "pid": _job.pid if owned else None,
                "started_at": _started_at if owned else None, "error": error}


def start():
    global _job, _started_at, _last_error
    with _lock:
        if _shutting_down:
            raise RuntimeError("Lumen 正在关闭，无法再次启动引擎。")
        if _job and _job.alive():
            return True
        if _job:
            _job.close()
            _job = None
        if not PYTHON.is_file() or not (COMFY_DIR / "main.py").is_file():
            _last_error = "生成引擎尚未安装。请运行 Setup-Lumen.cmd，或在 lumen.local.json 配置已有 ComfyUI 与 Python。"
            raise RuntimeError(_last_error)
        with socket.socket() as probe:
            probe.settimeout(0.5)
            if probe.connect_ex(("127.0.0.1", 8188)) == 0:
                _last_error = "8188 端口由另一个引擎占用。请先关闭独立启动的 ComfyUI，再在 Lumen 中启动。"
                raise RuntimeError(_last_error)
        job = ProcessJob()
        try:
            CONFIG.engine_log_dir.mkdir(parents=True, exist_ok=True)
            CONFIG.input_dir.mkdir(parents=True, exist_ok=True)
            CONFIG.output_dir.mkdir(parents=True, exist_ok=True)
            with open(CONFIG.engine_log_dir / "comfyui.log", "ab") as output, open(CONFIG.engine_log_dir / "comfyui_err.log", "ab") as errors:
                job.spawn([PYTHON, "-u", str(COMFY_DIR / "main.py"), "--listen", "127.0.0.1", "--port", "8188",
                           "--input-directory", str(CONFIG.input_dir), "--output-directory", str(CONFIG.output_dir)],
                          COMFY_DIR, output, errors)
        except OSError as error:
            job.close()
            _last_error = str(error)
            raise
        _job = job
        _started_at = time.time()
        _last_error = None
        return True


def stop():
    global _job, _started_at
    with _lock:
        if _job:
            _job.close()
            _job = None
        _started_at = None
        return True


def shutdown():
    global _shutting_down
    with _lock:
        _shutting_down = True
        return stop()
