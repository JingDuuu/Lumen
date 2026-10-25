"""Deterministic local PNG-frame encoding for Previs reference videos."""
from fractions import Fraction
import io
import os
from pathlib import Path
import re
import threading
import uuid

import av
from PIL import Image, UnidentifiedImageError
from flask import Blueprint, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

MAX_FRAMES = 360
MAX_FRAME_BYTES = 3 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
MAX_REQUEST_BYTES = MAX_TOTAL_BYTES + 1024 * 1024
_FRAME_NAME = re.compile(r"^frame(\d{1,6})\.png$", re.IGNORECASE)
_ENCODING = threading.BoundedSemaphore(1)


def ordered_frames(files):
    if not files or len(files) > MAX_FRAMES:
        raise ValueError("须提供 1–360 张 PNG 帧")
    ordered = []
    for file in files:
        match = _FRAME_NAME.fullmatch(file.filename or "")
        if not match:
            raise ValueError("帧文件名须为 frame000000.png 起的连续编号")
        ordered.append((int(match.group(1)), file))
    ordered.sort(key=lambda entry: entry[0])
    if [index for index, _ in ordered] != list(range(len(ordered))):
        raise ValueError("帧编号须从 0 连续递增，不能缺失或重复")
    return [file for _, file in ordered]


def encode_frames(files, fps, input_dir):
    if not isinstance(fps, int) or not 1 <= fps <= 30:
        raise ValueError("视频帧率须为 1–30 的整数")
    ordered = ordered_frames(files)
    if len(ordered) > fps * 15:
        raise ValueError("预演视频最长 15 秒，请缩短片段")
    if not _ENCODING.acquire(blocking=False):
        raise RuntimeError("另一个预演视频正在编码，请稍后再试")
    folder = Path(input_dir).resolve()
    token = uuid.uuid4().hex
    temporary = folder / (".previs-" + token + ".mp4.part")
    destination = folder / ("layout_previs_" + token + ".mp4")
    width = height = None
    total_bytes = 0
    try:
        folder.mkdir(parents=True, exist_ok=True)
        with av.open(str(temporary), "w", format="mp4", options={"movflags":"+faststart"}) as output:
            stream = None
            for index, file in enumerate(ordered):
                raw = file.stream.read(MAX_FRAME_BYTES + 1)
                total_bytes += len(raw)
                if len(raw) > MAX_FRAME_BYTES or total_bytes > MAX_TOTAL_BYTES:
                    raise RequestEntityTooLarge("每帧最多 3 MiB、全部 PNG 最多 128 MiB")
                try:
                    with Image.open(io.BytesIO(raw)) as image:
                        if image.format != "PNG":
                            raise ValueError("所有帧必须是真实 PNG，不能只改文件扩展名")
                        w, h = image.size
                        if w < 2 or h < 2 or w > 960 or h > 540 or w * h > 960 * 540 or w % 2 or h % 2:
                            raise ValueError("帧尺寸须为相同的偶数宽高，最大 960×540")
                        if width is None:
                            width, height = w, h
                            stream = output.add_stream("libx264", rate=fps)
                            stream.width, stream.height = width, height
                            stream.pix_fmt = "yuv420p"
                            stream.time_base = Fraction(1, fps)
                            stream.codec_context.time_base = Fraction(1, fps)
                            stream.codec_context.max_b_frames = 0
                            stream.codec_context.thread_count = 2
                            stream.options = {"crf":"18", "preset":"fast"}
                        elif (w, h) != (width, height):
                            raise ValueError("所有帧的宽高必须一致")
                        image.load()
                        rgb = image.convert("RGB")
                        frame = av.VideoFrame.from_image(rgb)
                        frame.pts = index
                        frame.time_base = Fraction(1, fps)
                        for packet in stream.encode(frame):
                            output.mux(packet)
                except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as error:
                    raise ValueError("PNG 帧损坏或无法解码：第 " + str(index + 1) + " 帧") from error
            for packet in stream.encode():
                output.mux(packet)
        os.replace(temporary, destination)
        return {"ok":True,"name":destination.name,"frames":len(ordered),"duration":len(ordered)/fps,"fps":fps,"width":width,"height":height}
    except av.FFmpegError as error:
        raise RuntimeError("本地 MP4 编码失败：" + str(error)) from error
    finally:
        try:
            temporary.unlink(missing_ok=True)
        finally:
            _ENCODING.release()


def create_blueprint(input_dir_provider):
    blueprint = Blueprint("previs_render", __name__, url_prefix="/api/previs")

    @blueprint.post("/render-video")
    def render_video():
        request.max_content_length = MAX_REQUEST_BYTES
        files = []
        try:
            files = request.files.getlist("frames")
            raw_fps = request.form.get("fps", "24")
            if not re.fullmatch(r"\d{1,2}", raw_fps):
                raise ValueError("视频帧率须为 1–30 的整数")
            return jsonify(encode_frames(files, int(raw_fps), input_dir_provider()))
        finally:
            for file in files:
                file.close()

    @blueprint.errorhandler(RequestEntityTooLarge)
    def too_large(error):
        return jsonify(ok=False,error="PNG 序列超过 128 MiB 或单帧超过 3 MiB，请降低分辨率或缩短片段"),413

    return blueprint
