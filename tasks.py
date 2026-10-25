"""Persistent Lumen jobs. Progress belongs to a prompt id, never to a log tail."""
import asyncio
import json
import logging
import math
import os
import statistics
import threading
import time
import uuid
import urllib.error
from functools import wraps

import aiohttp

import lumen_core as core

ACTIVE = {"queued", "running", "stalled", "cancelling", "submitting"}
TERMINAL = {"done", "failed", "cancelled", "interrupted"}
CAPABILITIES = dict(text_to_video=True, first_frame=True, last_frame=True,
                    reference_images=True, reference_video=True, reference_video_audio=True, middle_frames=True, audio_generation=True,
                    board_connections=True, connections_affect_generation=True, zones=True,
                    model_modes=["auto", "fl2va", "ref2va"], max_reference_images=9, max_reference_videos=3,
                    reference_audio=False, mixed_reference_keyframes=False)
STAGES = {
    "1": ("loading", "加载视频模型"), "2": ("loading", "加载文字编码器"),
    "3": ("loading", "加载视频解码器"), "4": ("loading", "加载音频解码器"),
    "5": ("encoding", "编码文字、图像与视频条件"), "8": ("loading", "准备采样"),
    "10": ("sampling", "生成画面与声音"), "11": ("decoding", "解码视频帧"),
    "12": ("decoding", "解码音频"), "13": ("saving", "合成视频与声音"),
    "14": ("saving", "保存视频文件"), "20": ("encoding", "读取首帧"),
    "21": ("encoding", "读取尾帧"),
}


def synchronized(method):
    @wraps(method)
    def locked(self, *args, **kwargs):
        with self.state_lock:
            return method(self, *args, **kwargs)
    return locked


def validate_params(params):
    if not isinstance(params, dict):
        raise ValueError("生成参数格式不正确")
    try:
        res = params.get("resolution", "608,352")
        w, h = map(int, res.split(",") if isinstance(res, str) else res)
        duration = float(params.get("duration", 2))
        steps = int(params.get("steps", 8))
        seed = int(params.get("seed", 20260827))
    except (ValueError, TypeError, OverflowError):
        raise ValueError("请填写有效的分辨率、时长、步数和种子")
    if not (256 <= w <= 1344 and 256 <= h <= 1344 and w % 32 == 0 and h % 32 == 0 and w * h <= 1344 * 768):
        raise ValueError("宽高须为32的倍数，范围256–1344，总像素不超过1344×768")
    if not math.isfinite(duration) or not 2 <= duration <= 12:
        raise ValueError("时长范围为2–12秒")
    if not 6 <= steps <= 40 or not 0 <= seed <= 2**64 - 1:
        raise ValueError("采样步数范围6–40；种子须为非负64位整数")
    mode = params.get("model_mode", "auto")
    if mode not in {"auto", "fl2va", "ref2va"}:
        raise ValueError("模型模式须为auto、fl2va或ref2va")
    return dict(resolution=[w, h], duration=duration, steps=steps, seed=seed, model_mode=mode)


def validate_items(items):
    if not isinstance(items, list) or len(items) > 100:
        raise ValueError("画板最多支持100张卡片")
    for item in items:
        if not isinstance(item, dict) or item.get("kind") not in {"text", "image", "video"}:
            raise ValueError("不支持的画板卡片")
        core.reference_inputs.validate_metadata(item)
        if item["kind"] == "text":
            if item.get("role") not in core.TEXT_ROLES or not isinstance(item.get("content", ""), str):
                raise ValueError("文字卡片格式不正确")
            if len(item.get("content", "")) > 20000:
                raise ValueError("单张文字卡片最多20000字")
        else:
            if item.get("role") is not None and not isinstance(item["role"], str):
                raise ValueError("素材卡片角色须为文本")
            name = item.get("file", "")
            if not isinstance(name, str) or not name or (item.get("enabled", True) and not os.path.isfile(core.serve_input(name))):
                raise ValueError("画板素材不存在，请重新上传")
    for role in ("first_frame", "last_frame", "middle_frame_1", "middle_frame_2", "middle_frame_3"):
        if sum(i.get("enabled", True) and i.get("kind") == "image" and i.get("role") == role for i in items) > 1:
            raise ValueError("每个首帧、尾帧或中间帧位置只能指定一张图片")


def estimate(items, params, connections=None, zones=None):
    validate_items(items)
    p = validate_params(params)
    compiled = core.compile_inputs(items, p, connections, zones)
    manifest = compiled["input_manifest"]
    first = next((entry["file"] for entry in manifest if entry["included"] and entry.get("role") == "first_frame" and entry["kind"] == "image"), None)
    last = next((entry["file"] for entry in manifest if entry["included"] and entry.get("role") == "last_frame" and entry["kind"] == "image"), None)
    w, h = p["resolution"]
    frames = core.calc_length(p["duration"])
    warnings = []
    expensive = w * h > 864 * 480 or frames > 124 or p["steps"] > 20
    references = [entry for entry in manifest if entry["included"] and entry["kind"] in {"image", "video"}]
    if compiled["model_mode"] == "ref2va":
        expensive = expensive or len(references) > 3 or any(entry.get("video", {}).get("frames", 0) > 56 for entry in references)
        warnings.append("Ref2VA在每个采样步读取参考，素材越多耗时越长；本机先用1张图和1段短视频试片。")
    if expensive:
        warnings.append("此配置显著高于试片负载；本机10GB显存，高清长视频可能需要数小时。建议先生成2秒试片。")
    if p["duration"] < 5:
        warnings.append("2–4秒用于验证构图和工作流；低于模型训练时长范围，不代表最终成片质量。")
    for entry in references:
        if entry.get("video"):
            video = entry["video"]
            warnings.append(f"{entry['tag']} 实际截取 {video['start_seconds']:.2f}–{video['start_seconds']+video['effective_duration']:.2f} 秒，{video['frames']}帧，24fps，{video['width']}×{video['height']}；" + ("含同期声音。" if video["include_audio"] else "不含声音。"))
    if any(entry.get("role", "").startswith("middle_frame_") for entry in manifest if isinstance(entry.get("role"), str)):
        warnings.append("中间帧1/2/3分别约束25%、50%、75%的位置；这是模型条件，不保证逐像素复现。")
    warnings.append("视频时长和画幅以右侧参数为准；提示词中的秒数或分辨率不会修改参数。")
    samples = [r["elapsed_seconds"] for r in core.load_records()
               if r.get("status") == "done" and r.get("elapsed_seconds", 0) > 0
               and r.get("resolution") == p["resolution"] and r.get("frames") == frames
               and r.get("steps") == p["steps"] and bool((r.get("images") or {}).get("first_frame")) == bool(first)
               and bool((r.get("images") or {}).get("last_frame")) == bool(last)
               and r.get("model") == (core.MODEL_REF if compiled["model_mode"] == "ref2va" else core.MODEL_UNET)
               and [(e.get("kind"), e.get("role"), e.get("video", {}).get("frames")) for e in r.get("input_manifest", []) if e.get("kind") != "text"] ==
                   [(e.get("kind"), e.get("role"), e.get("video", {}).get("frames")) for e in manifest if e.get("kind") != "text"]]
    seconds = round(statistics.median(samples[:5])) if samples else None
    return dict(ok=True, frames=frames, actual_duration=round(frames / 24, 2), params=p,
                estimate_seconds=seconds,
                estimate_label="暂无同配置实测，不能可靠估时" if seconds is None else "同配置实测参考；冷启动和显存占用会影响耗时",
                warnings=warnings, requires_confirmation=expensive, capabilities=CAPABILITIES,
                model_mode=compiled["model_mode"], model_available=core.model_status()[compiled["model_mode"]]["available"],
                compiled_prompt=compiled["compiled_prompt"], input_manifest=manifest, connection_manifest=compiled["connection_manifest"],
                input_packet=core.reference_inputs.input_packet(compiled))


def timestamp(record):
    if record.get("created_at"):
        return record["created_at"]
    try:
        return time.mktime(time.strptime(record["created"], "%Y-%m-%d %H:%M:%S"))
    except (KeyError, ValueError):
        return time.time()


def public_record(record):
    r = dict(record)
    if r.get("status") in ACTIVE:
        r["elapsed_seconds"] = max(0, round(time.time() - timestamp(r)))
        if r.get("eta_at"):
            r["eta_seconds"] = max(0, round(r["eta_at"] - time.time()))
        silence = time.time() - r.get("last_activity_at", timestamp(r))
        if silence > 600 and r.get("status") != "queued":
            r["warning"] = "超过10分钟未收到新的阶段或步数。引擎可能仍在计算；可取消任务并降低分辨率和时长。"
        if r.get("eta_seconds") == 0:
            r["eta_seconds"] = None
    r.pop("workflow", None)
    r.pop("connections", None)
    r.pop("zones", None)
    return r


class TaskManager:
    def __init__(self):
        self.client_id = "lumen-desktop-v2"
        self.stop_event = threading.Event()
        self.ready = threading.Event()
        self.started = False
        self.submit_lock = threading.Lock()
        self.state_lock = threading.RLock()
        self.missing = {}
        self.failures = 0
        self.threads = []

    def start(self):
        if self.started:
            return
        self.started = True
        self.stop_event.clear()
        self.threads = [threading.Thread(target=self._poll, daemon=True, name="lumen-jobs"),
                        threading.Thread(target=lambda: asyncio.run(self._events()), daemon=True, name="lumen-progress")]
        for thread in self.threads:
            thread.start()

    def stop(self):
        self.stop_event.set()
        self.started = False

    def interrupt_records(self):
        for r in core.load_records():
            if r.get("status") in ACTIVE:
                self.finish(r, "interrupted", "应用已关闭，任务已停止。原始画板和参数已保留，可回填后重新生成。")

    @synchronized
    def finish(self, r, status, error=None, outputs=None):
        r = core.get_record(r["id"])
        if not r or r.get("status") in TERMINAL:
            return
        changes = dict(status=status, stage=status, stage_label={"done": "生成完成", "failed": "生成失败", "cancelled": "已取消", "interrupted": "已中断"}[status],
                       error=error, finished_at=time.time(), elapsed_seconds=max(0, round(time.time() - timestamp(r))),
                       eta_seconds=None, eta_at=None, warning=None)
        if outputs is not None:
            changes["outputs"] = outputs
        core.update_record(r["id"], **changes)
        if outputs and not r.get("thumb"):
            rel = os.path.join(outputs[0].get("sub", ""), outputs[0]["name"])
            thumb = core.extract_thumb(r["id"], rel)
            if thumb:
                core.update_record(r["id"], thumb=thumb)

    def apply_history(self, r, entry):
        status = entry.get("status", {})
        for message in status.get("messages", []):
            if not isinstance(message, (list, tuple)) or len(message) != 2:
                continue
            kind, data = message
            if kind == "execution_error":
                self.finish(r, "failed", "%s：%s" % (data.get("node_type", "模型执行"), data.get("exception_message", "执行失败")))
                return
            if kind == "execution_interrupted":
                self.finish(r, "cancelled" if r.get("status") == "cancelling" else "interrupted", "生成已停止，画板与参数已保留")
                return
        outputs = []
        for node in entry.get("outputs", {}).values():
            for key in ("images", "gifs", "videos"):
                for item in node.get(key, []) or []:
                    if item.get("filename") and item.get("type", "output") == "output":
                        out = dict(sub=item.get("subfolder", ""), name=item["filename"])
                        if out not in outputs:
                            outputs.append(out)
        if status.get("status_str") == "error":
            self.finish(r, "failed", "引擎报告执行失败，请查看诊断日志")
        elif status.get("completed") or status.get("status_str") == "success":
            if outputs:
                self.finish(r, "done", outputs=outputs)
            else:
                self.finish(r, "failed", "引擎结束但没有返回输出文件；请检查模型与保存节点")

    @synchronized
    def reconcile(self):
        active = [r for r in core.load_records() if r.get("status") in ACTIVE]
        if not active:
            return
        try:
            queue = core.comfy_get("/queue", timeout=3)
            history = core.comfy_get("/history", timeout=3)
        except (OSError, ValueError):
            self.failures += 1
            for r in active:
                core.update_record(r["id"], status="stalled" if self.failures >= 6 else r["status"],
                                   warning="引擎连接中断，无法确认结果；正在重连，请勿重复提交", eta_seconds=None, eta_at=None)
            return
        self.failures = 0
        running = {row[1] for row in queue.get("queue_running", [])}
        pending = {row[1] for row in queue.get("queue_pending", [])}
        for old in active:
            r = core.get_record(old["id"])
            if r.get("status") not in ACTIVE:
                continue
            pid = r["prompt_id"]
            if pid in history:
                self.apply_history(r, history[pid])
            elif pid in running:
                self.missing.pop(pid, None)
                if r.get("status") in {"queued", "submitting", "stalled"}:
                    core.update_record(r["id"], status="running", stage="loading", stage_label="引擎正在执行", started_at=time.time())
            elif pid in pending:
                self.missing.pop(pid, None)
                if r.get("status") == "submitting":
                    core.update_record(r["id"], status="queued", stage="queued", stage_label="等待生成")
            elif time.time() - timestamp(r) > 15:
                self.missing[pid] = self.missing.get(pid, 0) + 1
                if self.missing[pid] >= 3:
                    self.finish(r, "cancelled" if r.get("status") == "cancelling" else "interrupted", "任务已不在引擎队列中，也没有完成记录；已保留配置供重新生成")

    @synchronized
    def handle_event(self, message):
        kind, data = message.get("type"), message.get("data", {})
        pid = data.get("prompt_id")
        if not pid:
            return
        r = core.find_record_by_prompt_id(pid)
        if not r or r.get("status") not in ACTIVE:
            return
        now = time.time()
        if kind == "execution_error":
            self.finish(r, "failed", "%s：%s" % (data.get("node_type", "模型"), data.get("exception_message", "执行失败")))
            return
        if kind == "execution_interrupted":
            self.finish(r, "cancelled" if r.get("status") == "cancelling" else "interrupted", "生成已停止，配置已保留")
            return
        if r.get("status") == "cancelling":
            return
        node = str(data.get("node", ""))
        progress = None
        if kind == "progress_state":
            active = [(n, v) for n, v in data.get("nodes", {}).items() if v.get("state") == "running"]
            if not active:
                return
            node, state = active[-1]
            if str(node) == "10" and state.get("max", 0) > 1:
                progress = dict(step=state["value"], total=state["max"])
        elif kind == "progress" and node == "10":
            progress = dict(step=data.get("value", 0), total=data.get("max", 1))
        elif kind not in {"executing", "execution_start"}:
            return
        stage, label = STAGES.get(str(node), (r.get("stage", "loading"), r.get("stage_label", "准备生成")))
        node_type = (r.get("workflow", {}).get(str(node), {}) or {}).get("class_type")
        if str(node) not in STAGES and node_type in {"LoadImage", "LoadVideo", "GetVideoComponents", "MiniMaxH3AddGuide"}:
            stage, label = "encoding", {"LoadImage": "读取参考图片", "LoadVideo": "读取参考视频片段",
                                        "GetVideoComponents": "提取参考画面与声音", "MiniMaxH3AddGuide": "编码中间帧约束"}[node_type]
        changes = dict(status="running", stage=stage, stage_label=label, last_activity_at=now, warning=None)
        if stage != r.get("stage"):
            changes.update(eta_seconds=None, eta_at=None)
            changes["timeline"] = (r.get("timeline", []) + [dict(stage=stage, label=label, at=now)])[-30:]
        if progress:
            progress["percent"] = round(100 * progress["step"] / max(1, progress["total"]))
            changes["progress"] = progress
            previous = r.get("progress") or {}
            if progress["step"] > previous.get("step", 0):
                times = r.get("step_times", [])
                if r.get("step_at") and previous.get("step", 0) > 0:
                    times = (times + [(now - r["step_at"]) / (progress["step"] - previous["step"])])[-5:]
                changes.update(step_at=now, step_times=times)
                if len(times) >= 2 and progress["step"] < progress["total"]:
                    remaining = round(statistics.median(times) * (progress["total"] - progress["step"]))
                    changes.update(eta_seconds=remaining, eta_at=now + remaining,
                                   eta_label="按最近采样步速估算，另需解码和保存时间")
        core.update_record(r["id"], **changes)

    async def _events(self):
        while not self.stop_event.is_set():
            try:
                async with aiohttp.ClientSession(trust_env=False) as session:
                    url = core.COMFY_URL.replace("http:", "ws:") + "/ws?clientId=" + self.client_id
                    async with session.ws_connect(url, heartbeat=15, timeout=3) as ws:
                        self.ready.set()
                        while not self.stop_event.is_set():
                            try:
                                msg = await ws.receive(timeout=2)
                            except asyncio.TimeoutError:
                                continue
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                self.handle_event(json.loads(msg.data))
                            elif msg.type in {aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR}:
                                break
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError, ValueError):
                pass
            self.ready.clear()
            await asyncio.sleep(2)

    def _poll(self):
        while not self.stop_event.is_set():
            try:
                self.reconcile()
            except Exception:
                logging.exception("Could not reconcile Lumen jobs")
            self.stop_event.wait(3)

    def submit(self, items, params, confirm=False, viewport=None, connections=None, zones=None):
        budget = estimate(items, params, connections, zones)
        connections = core.normalize_connections(items, connections)
        if budget["requires_confirmation"] and not confirm:
            raise ValueError("请先阅读高负载提示并确认，或选择2秒试片")
        compiled = core.compile_inputs(items, budget["params"], connections, zones)
        prompt, fields = compiled["compiled_prompt"], compiled["fields"]
        manifest = compiled["input_manifest"]
        first = next((e["file"] for e in manifest if e["included"] and e["kind"] == "image" and e.get("role") == "first_frame"), None)
        last = next((e["file"] for e in manifest if e["included"] and e["kind"] == "image" and e.get("role") == "last_frame"), None)
        if not any(entry["included"] for entry in manifest):
            raise ValueError("请先添加镜头描述或图像/视频参考")
        if not budget["model_available"]:
            raise ValueError("所需" + compiled["model_mode"].upper() + "模型尚未安装完成，请查看模型下载状态")
        if not core.comfyui_running():
            core.start_comfyui()
            raise ValueError("正在启动生成引擎，请等右上角就绪后再次生成")
        if not self.ready.wait(4):
            raise ValueError("进度连接尚未就绪，请稍后再试")
        p = budget["params"]
        with self.submit_lock, self.state_lock:
            if any(r.get("status") in ACTIVE for r in core.load_records()):
                raise ValueError("已有任务正在执行，请等待完成或先取消；本机逐个生成更稳定")
            workflow = core.build_workflow(prompt, *p["resolution"], p["duration"], p["steps"], p["seed"], first, last, compiled=compiled)
            fields["_images_reference"] = [entry["file"] for entry in manifest if entry["included"] and entry["kind"] == "image" and compiled["model_mode"] == "ref2va"]
            fields["_videos"] = [entry["file"] for entry in manifest if entry["included"] and entry["kind"] == "video"]
            pid = str(uuid.uuid4())
            rec = core.create_record(pid, p, fields, prompt, dict(first_frame=first, last_frame=last, reference=fields["_images_reference"]),
                                     items, workflow, connections=connections, zones=zones, compiled=compiled)
            core.update_record(rec["id"], status="submitting", stage="queued", stage_label="提交生成任务", viewport=viewport,
                               last_activity_at=time.time(), timeline=[dict(stage="queued", label="提交生成任务", at=time.time())])
            try:
                response = core.comfy_post("/prompt", dict(prompt=workflow, prompt_id=pid, client_id=self.client_id), timeout=20)
                if response.get("node_errors") or response.get("error"):
                    raise ValueError(json.dumps(response, ensure_ascii=False))
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")[:4000]
                self.finish(rec, "failed", "引擎拒绝工作流：" + detail)
                raise ValueError("引擎拒绝工作流，详情已记录到任务") from exc
            except ValueError as exc:
                self.finish(rec, "failed", str(exc))
                raise
            except OSError:
                core.update_record(rec["id"], warning="提交回应超时，正在向引擎核对；请勿重复提交")
            core.remember(fields)
            return core.get_record(rec["id"])

    @synchronized
    def cancel(self, rid):
        rec = core.get_record(rid)
        if not rec:
            raise ValueError("任务不存在")
        if rec.get("status") not in ACTIVE:
            return rec
        queue = core.comfy_get("/queue", timeout=5)
        pid = rec["prompt_id"]
        if any(row[1] == pid for row in queue.get("queue_pending", [])):
            core.comfy_post("/queue", {"delete": [pid]}, timeout=5)
            queue = core.comfy_get("/queue", timeout=5)
        if any(row[1] == pid for row in queue.get("queue_running", [])):
            core.update_record(rid, status="cancelling", stage_label="正在取消，等待当前计算结束", eta_seconds=None, eta_at=None)
            core.comfy_post("/interrupt", {"prompt_id": pid}, timeout=5)
        else:
            history = core.comfy_get("/history/" + pid, timeout=5)
            if pid in history:
                self.apply_history(rec, history[pid])
            else:
                self.finish(rec, "cancelled", "已取消任务，配置已保留")
        return core.get_record(rid)


manager = TaskManager()
