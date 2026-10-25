"""Lumen CLI uses the desktop application's API and task lifecycle."""
import argparse
from contextlib import redirect_stdout
import json
import mimetypes
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from runtime_config import CONFIG

ROOT = Path(__file__).resolve().parent
PYTHONW = CONFIG.engine_python.with_name("pythonw.exe")
DESKTOP = ROOT / "desktop.py"
API_URL = "http://127.0.0.1:8088"
TERMINAL = {"done", "failed", "cancelled", "interrupted"}
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
JSON_MODE = False
RESULT = None


class ApiError(RuntimeError):
    def __init__(self, message, code="API_ERROR", status=None, detail=None):
        super().__init__(message)
        self.code, self.status, self.detail = code, status, detail


class ConnectionUnavailable(ApiError):
    def __init__(self, message):
        super().__init__(message, "CONNECTION_UNAVAILABLE")


def request_http(path, method="GET", payload=None, body=None, content_type=None, timeout=10, headers=None):
    if not isinstance(path, str) or not path.startswith(("/api/", "/input/", "/output/", "/videos/", "/library/")) or "\r" in path or "\n" in path:
        raise ApiError("请使用本地 /api/... 路径或已返回的媒体路径", "INVALID_INPUT")
    headers = dict(headers or {})
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        content_type = "application/json"
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(API_URL + path, data=body, headers=headers, method=method)
    try:
        with HTTP.open(request, timeout=timeout) as response:
            return response.read(), dict(response.headers), response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw)
        except ValueError:
            detail = {"error": raw[:1500]}
        message = detail.get("error", detail) if isinstance(detail, dict) else detail
        code = detail.get("code", "HTTP_ERROR") if isinstance(detail, dict) else "HTTP_ERROR"
        raise ApiError("Lumen 返回 %s：%s" % (exc.code, str(message)[:1500]), code, exc.code, detail) from exc
    except OSError as exc:
        raise ConnectionUnavailable("无法连接 Lumen 桌面应用；请先运行 lumen start。任务结果需恢复连接后核对。") from exc


def request_json(path, method="GET", payload=None, body=None, content_type=None, timeout=10, headers=None):
    raw, _, _ = request_http(path, method, payload, body, content_type, timeout, headers)
    try:
        result = json.loads(raw.decode("utf-8")) if raw else None
    except (ValueError, UnicodeError) as exc:
        raise ApiError("Lumen 返回了无法读取的状态，请查看 desktop.log。") from exc
    if isinstance(result, dict) and result.get("ok") is False:
        raise ApiError(result.get("error", "Lumen 未完成此操作"))
    return result


def output(value, text=None):
    global RESULT
    RESULT = value
    if not JSON_MODE:
        print(text if text is not None else json.dumps(value, ensure_ascii=False, indent=2))


def load_input(filename):
    try:
        text = sys.stdin.read() if filename == "-" else Path(filename).read_text(encoding="utf-8-sig")
        return json.loads(text.removeprefix("\ufeff"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError("不支持 " + value)))
    except (ValueError, OSError) as exc:
        raise ApiError("无法读取 JSON 输入：" + str(exc), "INVALID_INPUT") from exc


def require_desktop():
    state = request_json("/api/system")
    if not state.get("desktop"):
        raise ApiError("当前是独立网页服务。请先关闭旧版，再通过桌面 Lumen 图标或 lumen start 启动。")
    return state


def cmd_start(_):
    subprocess.Popen([str(PYTHONW), str(DESKTOP)], cwd=str(ROOT),
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=subprocess.CREATE_NO_WINDOW)
    print("正在打开 Lumen 桌面窗口…")
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            state = request_json("/api/system", timeout=2)
            if state.get("desktop"):
                ready = state.get("comfyui_running") and state.get("progress_connected")
                print("桌面应用已打开；引擎" + ("已就绪。" if ready else "正在准备，请稍后查看 lumen status。"))
                output(state, "") if JSON_MODE else None
                return 0
        except ApiError:
            pass
        time.sleep(1)
    raise ApiError("桌面应用尚未响应，请查看 " + str(CONFIG.log_dir / "desktop.log"))


def cmd_stop(_):
    subprocess.run([str(PYTHONW), str(DESKTOP), "--close"], cwd=str(ROOT),
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   creationflags=subprocess.CREATE_NO_WINDOW, timeout=10, check=True)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            state = request_json("/api/system", timeout=2)
        except ConnectionUnavailable:
            print("桌面关闭指令已完成，Lumen 本地界面服务已停止。")
            output({"stopped": True}, "") if JSON_MODE else None
            return 0
        if not state.get("desktop"):
            raise ApiError("检测到旧版网页服务，桌面关闭指令不会终止不属于它的进程。")
        time.sleep(1)
    raise ApiError("桌面仍在退出，请查看桌面窗口及 desktop.log。")


def cmd_status(_):
    state = request_json("/api/system")
    records = request_json("/api/tasks")
    if JSON_MODE:
        output({"system": state, "tasks": records})
        return
    print("桌面：", "运行中" if state.get("desktop") else "独立网页服务")
    print("引擎：", "运行中" if state.get("comfyui_running") else "准备中或已停止")
    print("任务进度连接：", "已连接" if state.get("progress_connected") else "重连中")
    print("模型：", state.get("model", "未知"))
    if state.get("gpu"):
        print("GPU：", state["gpu"].get("name", "未知"))
    for record in records:
        if record.get("status") not in TERMINAL:
            print("当前任务：", record["id"], record.get("stage_label", record["status"]))


def upload_file(filename, path="/api/upload", fields=None, timeout=120):
    source = Path(filename).expanduser().resolve(strict=True)
    name = source.name.replace('"', "_").replace("\r", "_").replace("\n", "_")
    boundary = "lumen-" + uuid.uuid4().hex
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    header = ('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\n'
              'Content-Type: %s\r\n\r\n' % (boundary, name, mime)).encode("utf-8")
    if source.stat().st_size > 500 * 1024 * 1024:
        raise ApiError("上传文件超过 500 MiB", "INVALID_INPUT")
    form = bytearray()
    for key, value in (fields or {}).items():
        if not key or any(char in key for char in '\r\n"'):
            raise ApiError("表单字段名无效", "INVALID_INPUT")
        form.extend(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, key, value)).encode("utf-8"))
    body = bytes(form) + header + source.read_bytes() + ("\r\n--%s--\r\n" % boundary).encode("ascii")
    return request_json(path, "POST", body=body,
                        content_type="multipart/form-data; boundary=" + boundary, timeout=timeout)


def upload_image(filename):
    return upload_file(filename)["name"]


def wait_for_task(prompt_id, record_id, timeout=0):
    deadline = time.monotonic() + timeout if timeout else None
    previous = None
    try:
        while True:
            task = request_json("/api/status/" + urllib.parse.quote(prompt_id, safe=""))
            status = task.get("status")
            if status in TERMINAL:
                if JSON_MODE:
                    output(task)
                if status == "done" and task.get("outputs"):
                    print("生成完成，结果已进入素材库：")
                    for media in task["outputs"]:
                        print("  " + os.path.join(str(CONFIG.output_dir), media.get("sub", ""), media["name"]))
                    return 0
                print("任务结束：%s；%s" % (status, task.get("error") or "未确认有可用输出"))
                return 1
            progress = task.get("progress") or {}
            summary = (status, task.get("stage_label"), progress.get("step"), progress.get("total"), task.get("warning"))
            if summary != previous:
                label = task.get("stage_label") or status or "等待任务状态"
                if progress:
                    label += " %s/%s 步" % (progress.get("step", 0), progress.get("total", "?"))
                if task.get("eta_seconds") is not None:
                    label += "，本阶段约剩 %s 秒（另需解码和保存）" % task["eta_seconds"]
                print(label)
                if task.get("warning"):
                    print("提示：" + task["warning"])
                previous = summary
            if deadline is not None and time.monotonic() >= deadline:
                if JSON_MODE:
                    globals()["RESULT"] = {"task": task, "record_id": record_id, "code": "WAIT_TIMEOUT", "cancelled": False}
                print("等待已超时，未自动取消任务；查看 lumen info %s 或运行 lumen cancel %s。" % (record_id, record_id))
                return 2
            time.sleep(2)
    except KeyboardInterrupt:
        if JSON_MODE:
            globals()["RESULT"] = {"record_id": record_id, "code": "INTERRUPTED", "cancelled": False}
        print("\n已退出等待，任务未取消；如需停止，运行 lumen cancel %s。" % record_id)
        return 130


def cmd_generate(args):
    require_desktop()
    if args.input:
        payload = load_input(args.input)
        if not isinstance(payload, dict):
            raise ApiError("生成输入须为画板 JSON 对象", "INVALID_INPUT")
        return submit_payload(args, payload)
    items = []
    if args.prompt:
        items.append(dict(kind="text", role="extra", content=args.prompt))
    for role in ("char", "scene", "camera", "audio", "style"):
        if getattr(args, role):
            items.append(dict(kind="text", role=role, content=getattr(args, role)))
    for filename, role in ((args.sketch, "first_frame"), (args.layout, "last_frame")):
        if filename:
            items.append(dict(kind="image", role=role, file=upload_image(filename)))
    if not items:
        raise ApiError("请提供提示词、文字描述、首帧或尾帧图片。")
    payload = dict(items=items, params=dict(resolution=args.resolution, duration=args.duration,
                                           steps=args.steps, seed=args.seed))
    return submit_payload(args, payload)


def submit_payload(args, payload):
    payload = dict(payload)
    payload.pop("confirm_expensive", None)
    budget = request_json("/api/estimate", "POST", payload)
    print("实际输出：%s 帧，约 %s 秒；%s" % (budget["frames"], budget["actual_duration"], budget["estimate_label"]))
    if budget.get("estimate_seconds") is not None:
        print("同配置历史参考：约 %s 秒" % budget["estimate_seconds"])
    for warning in budget.get("warnings", []):
        print("提示：" + warning)
    if budget.get("requires_confirmation"):
        if not args.confirm_expensive:
            raise ApiError("此配置需要确认高负载；确认后加 --confirm-expensive，或先使用默认试片参数。", "CONFIRMATION_REQUIRED", detail=budget)
        payload["confirm_expensive"] = True
    response = request_json("/api/generate", "POST", payload, timeout=35)
    print("任务已提交：%s；prompt_id：%s" % (response["record_id"], response["prompt_id"]))
    output({**response, "estimate": budget}, "") if JSON_MODE else None
    if args.wait:
        return wait_for_task(response["prompt_id"], response["record_id"], args.timeout)
    return 0


def cmd_list(args):
    query = urllib.parse.urlencode({key: value for key, value in {"q": args.q, "tag": args.tag}.items() if value})
    records = request_json("/api/library" + ("?" + query if query else ""))
    if JSON_MODE:
        output(records)
        return
    if not records:
        print("素材库为空")
    for r in records[:50]:
        output = r.get("outputs") or []
        print("%s  %-12s  %s  %s" % (r["id"], r["status"], r.get("created", ""), output[0]["name"] if output else "尚无输出"))


def cmd_info(args):
    record = next((r for r in request_json("/api/tasks") if r["id"] == args.id), None)
    if record is None:
        raise ApiError("记录不存在或已移出素材库：" + args.id)
    output(record)


def cmd_refill(args):
    output(request_json("/api/library/" + urllib.parse.quote(args.id, safe="") + "/refill"))


def cmd_open(args):
    output(request_json("/api/library/" + urllib.parse.quote(args.id, safe="") + "/open", "POST", {}), "已打开输出所在位置")


def cmd_cancel(args):
    result = request_json("/api/tasks/" + urllib.parse.quote(args.id, safe="") + "/cancel", "POST", {})
    output(result, result["task"].get("stage_label", result["task"]["status"]))


def cmd_presets(args):
    if args.action == "list":
        output(request_json("/api/presets"))
        return
    if not args.name or (args.action == "add" and not args.text):
        raise ApiError("请提供 --name；添加预设还需要 --text。")
    output(request_json("/api/presets", "POST" if args.action == "add" else "DELETE",
                        dict(category=args.category, name=args.name, text=args.text)), "预设已更新")


def cmd_api(args):
    headers = {}
    for name, value in (("If-Match", args.if_match), ("Idempotency-Key", args.request_id)):
        if value:
            headers[name] = value
    payload = load_input(args.input) if args.input else None
    if args.output:
        destination = Path(args.output).expanduser().resolve()
        if destination.exists() and not args.overwrite:
            raise ApiError("输出文件已存在；请更换路径或明确使用 --overwrite", "INVALID_INPUT")
        raw, response_headers, status = request_http(args.path, args.method, payload, timeout=args.http_timeout, headers=headers)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("wb" if args.overwrite else "xb") as stream:
            stream.write(raw)
        output({"path": str(destination), "bytes": len(raw), "http_status": status, "content_type": response_headers.get("Content-Type")})
    else:
        output(request_json(args.path, args.method, payload, timeout=args.http_timeout, headers=headers))


def cmd_upload(args):
    fields = {}
    for field in args.field:
        key, separator, value = field.partition("=")
        if not separator:
            raise ApiError("--field 使用 name=value 格式", "INVALID_INPUT")
        fields[key] = value
    output(upload_file(args.file, args.path, fields, args.http_timeout))


def cmd_discover(args):
    output(request_json("/api/agent/" + args.command))


def cmd_preview(args):
    if not args.input:
        raise ApiError("preview 需要 --input 文件路径或 -", "INVALID_INPUT")
    output(request_json("/api/agent/preview", "POST", load_input(args.input), timeout=args.http_timeout))


def cmd_board(args):
    if args.action == "get":
        output(request_json("/api/agent/board"))
        return
    if not args.input:
        raise ApiError("board 修改需要 --input 文件路径或 -", "INVALID_INPUT")
    path = "/api/agent/board" + ("/operations" if args.action == "apply" else "")
    output(request_json(path, "POST" if args.action == "apply" else "PUT", load_input(args.input), timeout=args.http_timeout))


class CliParser(argparse.ArgumentParser):
    def error(self, message):
        raise ApiError(message, "INVALID_INPUT")


def parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="stdout 仅输出一个 JSON 结果；进度写 stderr")
    common.add_argument("--input", default=argparse.SUPPRESS, help="JSON 文件；- 表示 UTF-8 stdin")
    common.add_argument("--url", default=argparse.SUPPRESS, help="本地应用 URL，默认 http://127.0.0.1:8088")
    common.add_argument("--http-timeout", type=float, default=argparse.SUPPRESS, help="单次 HTTP 超时秒数")
    ap = CliParser(prog="lumen", description="Lumen local agent CLI（统一任务 API）", parents=[common])
    ap.set_defaults(json=False, input=None, url=API_URL, http_timeout=120)
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("start", parents=[common], help="打开桌面应用及其引擎")
    sub.add_parser("stop", parents=[common], help="关闭桌面应用及其拥有的引擎")
    sub.add_parser("status", parents=[common], help="查看桌面和任务状态")
    g = sub.add_parser("generate", parents=[common], help="通过桌面应用提交任务；--input 支持完整画板")
    for name, help_text in (("prompt", "完整提示词"), ("char", "人物"), ("scene", "场景"),
                            ("camera", "镜头"), ("audio", "音频描述"), ("style", "风格"),
                            ("sketch", "首帧图片路径"), ("layout", "尾帧图片路径")):
        g.add_argument("--" + name, help=help_text)
    g.add_argument("--resolution", default="608,352", help="宽,高（默认608,352）")
    g.add_argument("--duration", type=float, default=2, help="输入时长2–12秒（默认2，按模型帧网格对齐）")
    g.add_argument("--steps", type=int, default=8, help="采样步数6–40（默认8，仅供试片）")
    g.add_argument("--seed", type=int, default=20260827)
    g.add_argument("--confirm-expensive", action="store_true", help="确认预检提示的高负载配置")
    g.add_argument("--wait", action="store_true", help="等待应用确认完成、失败或取消")
    g.add_argument("--timeout", type=float, default=0, help="最多等待秒数；0为不限，超时不取消任务")
    ls = sub.add_parser("list", parents=[common], help="列出素材库")
    ls.add_argument("--q")
    ls.add_argument("--tag")
    for name, help_text in (("info", "查看任务详情"), ("refill", "输出完整回填配置"),
                            ("open", "打开输出位置"), ("cancel", "取消指定任务")):
        sub.add_parser(name, parents=[common], help=help_text).add_argument("id", help="record_id")
    p = sub.add_parser("presets", parents=[common], help="文字预设管理")
    p.add_argument("action", choices=["list", "add", "remove"])
    p.add_argument("--category", default="camera")
    p.add_argument("--name")
    p.add_argument("--text")
    for command in ("discover", "schema", "catalog"):
        sub.add_parser(command, parents=[common], help="读取机器可用接口信息")
    sub.add_parser("preview", parents=[common], help="校验/编译/估算输入，不提交生成")
    board = sub.add_parser("board", parents=[common], help="读取或带版本校验地修改画板")
    board.add_argument("action", choices=["get", "put", "apply"])
    rpc = sub.add_parser("api", parents=[common], help="调用任意本地 API；二进制响应指定 --output")
    rpc.add_argument("method", choices=["GET", "POST", "PUT", "PATCH", "DELETE"])
    rpc.add_argument("path", help="例如 /api/previs/documents")
    rpc.add_argument("--if-match")
    rpc.add_argument("--request-id")
    rpc.add_argument("--output")
    rpc.add_argument("--overwrite", action="store_true")
    upload = sub.add_parser("upload", parents=[common], help="multipart 上传媒体、预设包或三维模型")
    upload.add_argument("file")
    upload.add_argument("--path", default="/api/upload")
    upload.add_argument("--field", action="append", default=[], help="额外表单字段，如 format=fbx、fps=24")
    return ap


def main(argv=None):
    global JSON_MODE, RESULT, API_URL
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8-sig", errors="strict")
    argv = sys.argv[1:] if argv is None else argv
    JSON_MODE, RESULT = "--json" in argv, None
    handlers = dict(start=cmd_start, stop=cmd_stop, status=cmd_status, generate=cmd_generate,
                    list=cmd_list, info=cmd_info, refill=cmd_refill, open=cmd_open,
                    cancel=cmd_cancel, presets=cmd_presets, api=cmd_api, upload=cmd_upload,
                    discover=cmd_discover, schema=cmd_discover, catalog=cmd_discover, preview=cmd_preview, board=cmd_board)
    try:
        args = parser().parse_args(argv)
        url = urllib.parse.urlsplit(args.url)
        if url.scheme != "http" or url.hostname not in {"127.0.0.1", "localhost", "::1"} or url.username or url.password or url.query or url.fragment or url.path not in {"", "/"}:
            raise ApiError("--url 必须是本机 loopback HTTP 地址", "INVALID_INPUT")
        if not 0 < args.http_timeout <= 3600:
            raise ApiError("--http-timeout 范围须为 0–3600 秒", "INVALID_INPUT")
        API_URL = args.url.rstrip("/")
        if JSON_MODE:
            with redirect_stdout(sys.stderr):
                status = handlers[args.command](args) or 0
            print(json.dumps({"ok": status == 0, "result": RESULT, "code": {0:"OK", 1:"TASK_FAILED", 2:"WAIT_TIMEOUT", 130:"INTERRUPTED"}.get(status, "COMMAND_FAILED")}, ensure_ascii=True))
        else:
            status = handlers[args.command](args) or 0
        return 7 if status == 2 else 6 if status == 1 else status
    except (ApiError, OSError, ValueError, subprocess.SubprocessError) as exc:
        code = exc.code if isinstance(exc, ApiError) else "LOCAL_ERROR"
        status = exc.status if isinstance(exc, ApiError) else None
        if JSON_MODE:
            print(json.dumps({"ok": False, "code": code, "error": str(exc), "http_status": status,
                              "detail": exc.detail if isinstance(exc, ApiError) else None}, ensure_ascii=True))
        else:
            print("错误：" + str(exc), file=sys.stderr)
        return 2 if code == "INVALID_INPUT" else 3 if code == "CONNECTION_UNAVAILABLE" else 5 if status in {409, 412, 428} or code == "CONFIRMATION_REQUIRED" else 4
    except KeyboardInterrupt:
        if JSON_MODE:
            print(json.dumps({"ok": False, "code": "INTERRUPTED", "error": "CLI interrupted; submitted tasks are not cancelled"}))
        print("\n已停止当前命令；桌面应用和已提交任务由 Lumen 管理。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
