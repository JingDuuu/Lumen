"""Compile a board into explicit H3 conditioning and bounded local media inputs."""
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import threading

import av
from imageio_ffmpeg import get_ffmpeg_exe

REFERENCE_ROLES = {"character", "scene", "action", "camera", "style", "layout", "storyboard", "audio", "general"}
CHARACTER_VIEWS = {"general", "front", "side", "back", "three_view", "detail"}
KEYFRAME_ROLES = {"first_frame", "last_frame", "middle_frame_1", "middle_frame_2", "middle_frame_3"}
ROLE_TEXT = {"character": "保持人物身份、脸部特征、发型和服装一致", "scene": "参考场景、空间与环境",
             "action": "参考动作、姿态与运动节奏", "camera": "参考机位、景别与运镜",
             "style": "参考视觉风格、光线和色彩", "layout": "遵循构图、人物站位、空间比例与镜头关系",
             "storyboard": "参考分镜的构图、景别、人物走位和镜头节奏，成片不要出现分镜边框、标注文字或拼贴",
             "audio": "参考声音、音色与节奏", "general": "依据画面内容与下述说明使用此参考"}
VIEW_TEXT = {"front": "正面", "side": "侧面", "back": "背面", "three_view": "同一人物的正侧背三视图",
             "detail": "人物局部细节", "general": "人物参考"}
EDGE_TEXT = {"reference": "使用前者作为后者的参考", "character_consistency": "保持前后两者人物身份一致",
             "style_inherit": "后者继承前者的视觉风格", "action_reference": "后者参考前者的动作与运动",
             "camera": "后者参考前者的机位与运镜", "continuation": "后者延续前者的动作与时空关系",
             "association": "将两者作为同一镜头中相互关联的内容"}
_MEDIA_LOCK = threading.Lock()


def normalize_zones(zones=None):
    if zones is None:
        return []
    if not isinstance(zones, list) or len(zones) > 100:
        raise ValueError("分区须为列表，最多100个")
    result, ids = [], set()
    for zone in zones:
        if not isinstance(zone, dict) or not isinstance(zone.get("id"), str) or not 1 <= len(zone["id"]) <= 200 or zone["id"] in ids:
            raise ValueError("分区ID须为唯一非空文本")
        normal = dict(zone)
        normal["purpose"] = "general" if zone.get("purpose", "general") == "free" else zone.get("purpose", "general")
        if normal["purpose"] not in REFERENCE_ROLES:
            raise ValueError("不支持的分区用途")
        for key in ("name", "notes"):
            if key in zone and (not isinstance(zone[key], str) or len(zone[key]) > 2000):
                raise ValueError("分区名称与说明须为文本，最多2000字")
        for key in ("x", "y", "w", "h"):
            if key in zone and (not isinstance(zone[key], (int, float)) or not math.isfinite(zone[key]) or (key in {"w", "h"} and zone[key] <= 0)):
                raise ValueError("分区位置与尺寸格式不正确")
        ids.add(zone["id"])
        result.append(normal)
    return result


def validate_metadata(item):
    for key in ("description", "notes"):
        if key in item and (not isinstance(item[key], str) or len(item[key]) > 20000):
            raise ValueError("素材说明须为文本，最多20000字")
    if item.get("reference_role", "general") not in REFERENCE_ROLES:
        raise ValueError("不支持的参考用途")
    if item.get("character_view", "general") not in CHARACTER_VIEWS:
        raise ValueError("不支持的人物视角")
    if item.get("zone_id") is not None and (not isinstance(item["zone_id"], str) or len(item["zone_id"]) > 200):
        raise ValueError("卡片分区ID格式不正确")
    if "layout" in item and (not isinstance(item["layout"], dict) or len(json.dumps(item["layout"]).encode("utf-8")) > 20 * 1024 * 1024):
        raise ValueError("构图元数据须为JSON对象且不超过20MB")
    if item.get("shot_order") is not None and (isinstance(item["shot_order"], bool) or not isinstance(item["shot_order"], int) or not 1 <= item["shot_order"] <= 100):
        raise ValueError("分镜序号须为1–100的整数")
    if "include_audio" in item and not isinstance(item["include_audio"], bool):
        raise ValueError("视频声音开关须为布尔值")
    if "enabled" in item and not isinstance(item["enabled"], bool):
        raise ValueError("卡片参与开关须为布尔值")


def probe_video(path):
    try:
        with av.open(str(path)) as container:
            if not container.streams.video:
                raise ValueError("参考视频没有可读取的视频轨")
            stream = container.streams.video[0]
            duration = float(stream.duration * stream.time_base) if stream.duration is not None else float(container.duration or 0) / av.time_base
            if duration <= 0 or not math.isfinite(duration):
                # MediaRecorder WebM has no final duration header. Demux timestamps
                # without decoding frames so local layout captures stay inexpensive.
                rate = float(stream.average_rate or 24)
                duration = 0.0
                for count, packet in enumerate(container.demux(stream)):
                    if count >= 100000:
                        raise ValueError("此视频缺少时长信息且过长，请转为普通MP4后重新上传")
                    if packet.pts is not None:
                        start = float(packet.pts * packet.time_base)
                        length = float(packet.duration * packet.time_base) if packet.duration else 1 / rate
                        duration = max(duration, start + length)
                if duration <= 0 or not math.isfinite(duration):
                    raise ValueError("无法确定参考视频时长，请转为普通MP4后重新上传")
            return dict(duration=duration, width=stream.width, height=stream.height, has_audio=bool(container.streams.audio))
    except av.error.FFmpegError as error:
        raise ValueError("无法读取参考视频，请上传有效的MP4、WebM或MOV") from error


def video_plan(path, item, width, height, output_frames):
    info = probe_video(path)
    try:
        start = float(item.get("video_start", 0))
        requested = float(item.get("video_duration", 2))
    except (TypeError, ValueError, OverflowError):
        raise ValueError("视频参考起点与时长须为数字")
    if not math.isfinite(start) or not math.isfinite(requested) or start < 0 or not 0.21 <= requested <= 15 or start >= info["duration"]:
        raise ValueError("视频参考起点须在素材内，截取时长范围0.21–15秒")
    available = min(requested, info["duration"] - start, output_frames / 24)
    frames = math.floor(available * 24 + 1e-6)
    frames -= (frames - 5) % 17
    if frames < 5:
        raise ValueError("参考视频有效片段不足5帧，请调整截取起点")
    area = min(width * height, 608 * 352)
    scale = min(1.0, math.sqrt(area / (info["width"] * info["height"])))
    vw = max(32, math.floor(info["width"] * scale / 32) * 32)
    vh = max(32, math.floor(info["height"] * scale / 32) * 32)
    return dict(start_seconds=start, requested_duration=requested, effective_duration=frames / 24,
                frames=frames, frame_count=frames, fps=24, width=vw, height=vh, source_duration=info["duration"],
                has_audio=info["has_audio"], include_audio=item.get("include_audio", True) and info["has_audio"])


def prepare_video(input_dir, filename, plan):
    root = Path(input_dir).resolve()
    source = (root / filename).resolve()
    if not source.is_relative_to(root) or not source.is_file():
        raise ValueError("视频素材路径无效")
    stat = source.stat()
    cache_key = hashlib.sha256(json.dumps([str(source), stat.st_size, stat.st_mtime_ns, plan], sort_keys=True).encode()).hexdigest()[:28]
    cache = root / "_lumen_refs"
    destination = cache / (cache_key + ".mp4")
    with _MEDIA_LOCK:
        if destination.is_file():
            return destination.relative_to(root).as_posix()
        cache.mkdir(exist_ok=True)
        temporary = cache / (cache_key + ".pending.mp4")
        cmd = [get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-ss", str(plan["start_seconds"]),
               "-i", str(source), "-t", str(plan["effective_duration"]), "-map", "0:v:0",
               "-vf", f"fps=24,scale={plan['width']}:{plan['height']}:flags=lanczos,setsar=1", "-frames:v", str(plan["frames"]),
               "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"]
        if plan["include_audio"]:
            cmd += ["-map", "0:a:0", "-c:a", "aac", "-ar", "48000", "-ac", "2"]
        else:
            cmd += ["-an"]
        cmd += ["-movflags", "+faststart", str(temporary)]
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=180,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if result.returncode:
                raise ValueError("参考视频预处理失败：" + result.stderr.decode("utf-8", errors="replace")[-1500:])
            with av.open(str(temporary)) as output:
                frames = sum(1 for _ in output.decode(video=0))
            if frames != plan["frames"]:
                raise ValueError(f"参考视频解码为{frames}帧，与预期{plan['frames']}帧不符，请更换片段")
            os.replace(temporary, destination)
        finally:
            if temporary.exists():
                temporary.unlink()
    return destination.relative_to(root).as_posix()


def compile_board(items, params, zones, connections, input_dir, output_frames, text_labels):
    zones = normalize_zones(zones)
    zone_map = {zone["id"]: zone for zone in zones}
    media = [item for item in items if item["kind"] in {"image", "video"} and item.get("enabled", True)]
    for item in items:
        validate_metadata(item)
        if item.get("zone_id") and item["zone_id"] not in zone_map:
            raise ValueError("卡片所属分区不存在，请重新选择分区")
    for item in media:
        if item.get("role", "reference") not in KEYFRAME_ROLES | {"reference", "auto", None, ""}:
            raise ValueError("素材包含未知生成角色，请明确选择参考、首尾帧或中间帧")
        if item["kind"] == "video" and item.get("role", "reference") not in {"reference", "auto", None, ""}:
            raise ValueError("视频当前通过Ref2VA作为动态参考；精确帧约束请使用图片")
    has_refs = any(item["kind"] == "video" or item.get("role", "reference") in {"reference", None, ""} for item in media)
    has_keys = any(item["kind"] == "image" and item.get("role") in KEYFRAME_ROLES | {"auto"} for item in media)
    mode = params.get("model_mode", "auto")
    if mode == "auto":
        mode = "ref2va" if has_refs else "fl2va"
    if has_refs and has_keys:
        raise ValueError("真实参考与精确首尾/中间帧不能混用：请将帧约束改为参考图，或移除参考素材后使用FL2VA")
    if mode == "fl2va" and has_refs:
        raise ValueError("FL2VA不能读取参考图或视频，请改用自动或Ref2VA模式")
    if mode == "ref2va" and has_keys:
        raise ValueError("Ref2VA不接收精确帧约束，请将首尾/中间帧图片改为参考图")
    pictures = [item for item in media if item["kind"] == "image"]
    videos = [item for item in media if item["kind"] == "video"]
    if mode == "ref2va" and (len(pictures) > 9 or len(videos) > 3):
        raise ValueError("Ref2VA最多读取9张参考图和3段参考视频，请减少素材")
    manifest, descriptions, fields, labels = [], [], {key: [] for key in text_labels}, {}
    text_number = picture_number = video_number = audio_number = 0
    occupied = {item.get("role") for item in pictures if item.get("role") in {"first_frame", "last_frame"}}
    missing = [role for role in ("first_frame", "last_frame") if role not in occupied]
    for item in items:
        entry = dict(item_id=item.get("id"), kind=item["kind"], role=item.get("role"), included=True,
                     reference_role=item.get("reference_role", "general"), zone_id=item.get("zone_id"),
                     description=item.get("description", ""), notes=item.get("notes", ""),
                     character_view=item.get("character_view", "general"), shot_order=item.get("shot_order"))
        if not item.get("enabled", True):
            entry.update(included=False, reason="已停用", file=item.get("file"), tag=None)
            manifest.append(entry)
            continue
        if item["kind"] == "text":
            text_number += 1
            entry["tag"] = f"[文字{text_number}]"
            entry["content"] = item.get("content", "").strip()
            if not entry["content"]:
                if not entry["description"].strip() and not entry["notes"].strip():
                    entry.update(included=False, reason="空白文字")
            else:
                fields[item["role"]].append(entry["content"])
                descriptions.append(f"{entry['tag']} {text_labels[item['role']]}：{entry['content']}")
        else:
            entry["file"] = item["file"]
            if mode == "ref2va":
                if item["kind"] == "image":
                    picture_number += 1
                    entry["tag"] = f"<Picture {picture_number}>"
                else:
                    video_number += 1
                    entry["tag"] = f"<Video {video_number}>"
                    entry["video"] = video_plan(Path(input_dir) / item["file"], item, *params["resolution"], output_frames)
                    if entry["video"]["include_audio"]:
                        audio_number += 1
                        entry["audio_tag"] = f"<Audio {audio_number}>"
                descriptions.append(f"{entry['tag']}：{ROLE_TEXT[entry['reference_role']]}。")
                if entry.get("audio_tag"):
                    descriptions.append(f"{entry['audio_tag']} 是 {entry['tag']} 的同期声音，可参考声音、音色与节奏。")
            else:
                role = item.get("role")
                if role == "auto":
                    if not missing:
                        raise ValueError("自动帧图片超过可用首尾帧位置，请明确角色；不会忽略多余图片")
                    role = missing.pop(0)
                frame = 0 if role == "first_frame" else output_frames - 1 if role == "last_frame" else round((output_frames - 1) * int(role[-1]) / 4)
                entry.update(role=role, frame_index=frame, tag=f"[第{frame}帧图片]")
                descriptions.append(f"{entry['tag']}：在视频第{frame/24:.2f}秒处遵循此图像约束。")
            if entry["reference_role"] == "character":
                descriptions.append(f"{entry['tag']} 人物视角：{VIEW_TEXT[entry['character_view']]}。")
        for key in ("description", "notes"):
            if entry[key].strip():
                descriptions.append(f"{entry['tag']} 说明：{entry[key].strip()}")
        manifest.append(entry)
        if item.get("id"):
            labels[item["id"]] = entry["tag"]
    for zone in zones:
        members = [entry["tag"] for entry in manifest if entry["zone_id"] == zone["id"] and entry["included"]]
        if members:
            purpose = "同一人物身份组；不同视角表现同一个人物" if zone["purpose"] == "character" else ROLE_TEXT[zone["purpose"]]
            descriptions.append(f"分区「{zone.get('name', zone['id'])}」：{'、'.join(members)}。{purpose}。{zone.get('notes', '')}")
    storyboard = [entry for entry in manifest if entry["included"] and (entry["reference_role"] == "storyboard" or entry["role"] == "storyboard")]
    storyboard.sort(key=lambda entry: entry["shot_order"] if entry["shot_order"] is not None else 101)
    if storyboard:
        descriptions.append("分镜参考顺序：" + " → ".join(entry["tag"] for entry in storyboard) + "。按此顺序理解镜头设计与动作衔接，不生成拼贴或分镜边框。")
    included_ids = {entry["item_id"] for entry in manifest if entry["included"]}
    connection_manifest = []
    for edge in connections:
        if edge["from"] not in included_ids or edge["to"] not in included_ids:
            connection_manifest.append(dict(id=edge["id"], included=False, reason="端点卡片已停用或为空"))
            continue
        label = edge.get("label", "association")
        descriptions.append(f"关系：{labels[edge['from']]} → {labels[edge['to']]}；{EDGE_TEXT.get(label, label or EDGE_TEXT['association'])}。")
        connection_manifest.append(dict(id=edge["id"], included=True, from_tag=labels[edge["from"]], to_tag=labels[edge["to"]], instruction=EDGE_TEXT.get(label, label)))
    return dict(model_mode=mode, compiled_prompt="\n\n".join(descriptions), input_manifest=manifest,
                fields={key: "\n".join(values) for key, values in fields.items()}, zones=zones,
                connections=connections, connection_manifest=connection_manifest)


def input_packet(compiled):
    """Describe the conditioning lanes used by the workflow, without editor state."""
    images, videos, audio = [], [], []
    for entry in compiled["input_manifest"]:
        if not entry["included"] or entry["kind"] == "text":
            continue
        media = {key: entry[key] for key in ("item_id", "tag", "file", "reference_role", "role", "frame_index", "video", "shot_order") if key in entry}
        if entry["kind"] == "image":
            media["socket"] = f"ref_images.ref_image_{len(images)}" if compiled["model_mode"] == "ref2va" else entry["role"]
            images.append(media)
        else:
            media["socket"] = f"ref_videos.ref_video_{len(videos)}"
            if entry.get("audio_tag"):
                audio.append(dict(tag=entry["audio_tag"], video_tag=entry["tag"], socket=f"ref_video_audios.ref_video_audio_{len(videos)}"))
            videos.append(media)
    return dict(model_mode=compiled["model_mode"], text=compiled["compiled_prompt"], images=images, videos=videos, audio=audio,
                relationships=[entry for entry in compiled["connection_manifest"] if entry["included"]],
                layout_metadata_sent=False,
                explanation="H3接收下面的文字、图像像素和视频帧；3D场景、骨架和时间线JSON只用于继续编辑，导出图片或预演视频后才作为视觉参考。")
