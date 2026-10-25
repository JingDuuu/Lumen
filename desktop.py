"""The single-window Windows entry point for Lumen."""
import ctypes
from ctypes import wintypes
import logging
import os
from pathlib import Path
import sys
import threading
import traceback

from werkzeug.serving import make_server

import engine_runtime
from runtime_config import CONFIG


ROOT = Path(__file__).resolve().parent
TITLE = "Lumen · 流光"
MUTEX_NAME = r"Local\Lumen.Desktop.2026"
_kernel = ctypes.WinDLL("kernel32", use_last_error=True)
_user = ctypes.WinDLL("user32", use_last_error=True)
_kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
_kernel.CreateMutexW.restype = wintypes.HANDLE
_kernel.CloseHandle.argtypes = [wintypes.HANDLE]
_kernel.CloseHandle.restype = wintypes.BOOL
_user.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
_user.FindWindowW.restype = wintypes.HWND
_user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
_user.SetForegroundWindow.argtypes = [wintypes.HWND]
_user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]


class SingleInstance:
    def __init__(self, name=MUTEX_NAME):
        self.handle = _kernel.CreateMutexW(None, False, name)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        self.primary = ctypes.get_last_error() != 183

    def close(self):
        if self.handle:
            _kernel.CloseHandle(self.handle)
            self.handle = None


def activate_existing():
    handle = _user.FindWindowW(None, TITLE)
    if handle:
        _user.ShowWindow(handle, 9)
        _user.SetForegroundWindow(handle)


def close_existing():
    handle = _user.FindWindowW(None, TITLE)
    if handle:
        _user.PostMessageW(handle, 0x0010, 0, 0)  # WM_CLOSE uses the same lifecycle as X.


def run():
    # These imports belong to the desktop bootstrap, not module import or tests.
    import webview
    import app as backend

    # Model/scene exports use the native Save As dialog in WebView2.
    webview.settings["ALLOW_DOWNLOADS"] = True

    server = make_server("127.0.0.1", 8088, backend.app, threaded=True)
    server_thread = threading.Thread(target=server.serve_forever, name="lumen-http", daemon=True)
    server_thread.start()
    stopped = threading.Event()
    shutdown_lock = threading.Lock()

    def shutdown():
        with shutdown_lock:
            if stopped.is_set():
                return
            try:
                backend.stop_services()
            finally:
                engine_runtime.shutdown()
                server.shutdown()
                server.server_close()
                stopped.set()

    try:
        backend.start_services()
        def start_engine():
            try:
                engine_runtime.start()
            except (OSError, RuntimeError):
                logging.exception("Lumen engine could not start")

        threading.Thread(target=start_engine, name="lumen-engine-start", daemon=True).start()
        window = webview.create_window(TITLE, "http://127.0.0.1:8088", width=1440, height=960,
                                      min_size=(1040, 720), background_color="#0d1420",
                                      confirm_close=False)
        backend.app.config["DESKTOP_CLOSE"] = window.destroy
        window.events.closed += shutdown
        webview.start(gui="edgechromium", private_mode=False,
                      storage_path=str(CONFIG.data_dir / "desktop-data"), icon=str(ROOT / "static" / "lumen-v3.ico"))
    finally:
        shutdown()


def main():
    os.chdir(ROOT)
    if "--close" in sys.argv:
        close_existing()
        return
    instance = SingleInstance()
    if not instance.primary:
        activate_existing()
        instance.close()
        return
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Lumen.Desktop")
    CONFIG.log_dir.mkdir(parents=True, exist_ok=True)
    log_path = CONFIG.log_dir / "desktop.log"
    log = open(log_path, "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = log
    logging.basicConfig(stream=log, level=logging.WARNING)
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    try:
        run()
    except (Exception, SystemExit):
        traceback.print_exc(file=log)
        _user.MessageBoxW(None, f"Lumen 启动失败。请查看 {log_path}。\n如果旧版 Lumen 仍在运行，请先关闭旧版。", TITLE, 0x10)
    finally:
        engine_runtime.shutdown()
        instance.close()


if __name__ == "__main__":
    main()
