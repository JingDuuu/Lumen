# -*- coding: utf-8 -*-
"""
Lumen · 流光 —— 核心业务模块
================================
本模块是 Lumen 的"业务层"，被两个入口共用：
  - app.py    （Web 控制台，Flask）
  - lumen.py  （命令行 CLI，供 Codex / 脚本 / 自动化接管）

包含：
  1) ComfyUI 交互：启停引擎、提交工作流、查询状态与进度
  2) 工作流构建：把画板/表单信息组装成 MiniMax H3 的 API 工作流
  3) 素材库：每次生成的完整元数据（提示词/参数/输出文件/缩略图/星标/标签）
  4) 预设：运镜 / 风格 / 音频 / 提示词模板
  5) 关键词记忆：按角色记录最近用过的关键词，供一键回填

数据文件（全部为 UTF-8 JSON，可手工编辑）：
  studio/library/records.json  素材库索引
  studio/library/thumbs/       视频缩略图 (jpg)
  studio/presets.json          预设
  studio/memory.json           关键词记忆
"""
import json
import os
import subprocess
import threading
import time
import uuid
import urllib.request
import shutil
import copy
import engine_runtime
import reference_inputs
from runtime_config import CONFIG

# ---------------------------------------------------------------- 路径常量
COMFY_DIR = str(CONFIG.comfy_dir)
PY = str(CONFIG.engine_python)
COMFY_URL = "http://127.0.0.1:8188"
INPUT_DIR = str(CONFIG.input_dir)
OUTPUT_DIR = str(CONFIG.output_dir)

CORE_DIR = os.path.dirname(os.path.abspath(__file__))
LIB_DIR = str(CONFIG.data_dir / "library")
THUMB_DIR = os.path.join(LIB_DIR, "thumbs")
RECORDS_FILE = os.path.join(LIB_DIR, "records.json")
PRESETS_FILE = str(CONFIG.data_dir / "presets.json")
MEMORY_FILE = str(CONFIG.data_dir / "memory.json")

# ---------------------------------------------------------------- 全局配置
DURATION_MIN = 2.0
DURATION_MAX = 12.0          # H3 官方上限约 15s，这里保守放开到 12s
MODEL_UNET = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
MODEL_REF = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
MODEL_REF_SIZE = 20970379616
MODEL_CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
MODEL_VAE_VIDEO = "minimax_h3_video_vae_fp16.safetensors"
MODEL_VAE_AUDIO = "minimax_h3_audio_vae_fp32.safetensors"
TEXT_ROLES = ["char", "scene", "action", "camera", "audio", "style", "layout", "storyboard", "extra"]
IMAGE_ROLES = ["auto", "first_frame", "last_frame", "middle_frame_1", "middle_frame_2", "middle_frame_3", "reference"]

os.makedirs(INPUT_DIR, exist_ok=True)
os.makedirs(LIB_DIR, exist_ok=True)
os.makedirs(THUMB_DIR, exist_ok=True)

_LIB_LOCK = threading.RLock()


# ================================================================ ComfyUI 交互
def comfyui_running():
    try:
        urllib.request.urlopen(COMFY_URL + "/system_stats", timeout=3)
        return True
    except Exception:
        return False


def start_comfyui():
    return engine_runtime.start()


def stop_comfyui():
    return engine_runtime.stop()


def comfy_get(path, timeout=10):
    req = urllib.request.Request(COMFY_URL + path)
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8"))


def comfy_post(path, payload, timeout=120):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(COMFY_URL + path, data=body,
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8"))


# ================================================================ 工作流构建
def calc_length(duration):
    """秒 -> 帧数（对齐模型 17k+5 的帧网格，24fps）。"""
    frames = max(5, round(float(duration) * 24))
    return int(frames + (5 - (frames % 17)) % 17)


def build_workflow(prompt, width, height, duration, steps, seed,
                   first_frame=None, last_frame=None, prefix="video/Lumen", compiled=None):
    length = calc_length(duration)
    if compiled:
        first_frame = next((e["file"] for e in compiled["input_manifest"] if e["included"] and e["kind"] == "image" and e["role"] == "first_frame"), None)
        last_frame = next((e["file"] for e in compiled["input_manifest"] if e["included"] and e["kind"] == "image" and e["role"] == "last_frame"), None)
    wf = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": MODEL_UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": MODEL_CLIP, "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": MODEL_VAE_VIDEO}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": MODEL_VAE_AUDIO}},
        "5": {"class_type": "MiniMaxH3ImageToVideo",
              "inputs": {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt,
                         "width": width, "height": height, "length": length}},
        "6": {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)}},
        "7": {"class_type": "BasicGuider", "inputs": {"model": ["1", 0], "conditioning": ["5", 0]}},
        "8": {"class_type": "BasicScheduler",
              "inputs": {"model": ["1", 0], "scheduler": "simple", "steps": int(steps), "denoise": 1.0}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "10": {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["6", 0], "guider": ["7", 0], "sampler": ["9", 0],
                          "sigmas": ["8", 0], "latent_image": ["5", 1]}},
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["3", 0]}},
        "12": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["10", 0], "vae": ["4", 0]}},
        "13": {"class_type": "CreateVideo", "inputs": {"images": ["11", 0], "audio": ["12", 0], "fps": 24, "bit_depth": 8}},
        "14": {"class_type": "SaveVideo", "inputs": {"video": ["13", 0], "filename_prefix": prefix,
                                                     "format": "auto", "codec": "auto"}},
    }
    if first_frame:
        wf["20"] = {"class_type": "LoadImage", "inputs": {"image": first_frame}}
        wf["5"]["inputs"]["first_frame"] = ["20", 0]
    if last_frame:
        wf["21"] = {"class_type": "LoadImage", "inputs": {"image": last_frame}}
        wf["5"]["inputs"]["last_frame"] = ["21", 0]
    if compiled:
        manifest = [entry for entry in compiled["input_manifest"] if entry["included"]]
        if compiled["model_mode"] == "ref2va":
            wf["1"]["inputs"]["unet_name"] = MODEL_REF
            wf["5"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
                "clip": ["2", 0], "vae": ["3", 0], "audio_vae": ["4", 0], "prompt": prompt,
                "width": width, "height": height, "length": length, "ref_image_size": "match"}}
            for index, entry in enumerate(e for e in manifest if e["kind"] == "image"):
                nid = str(100 + index)
                wf[nid] = {"class_type": "LoadImage", "inputs": {"image": entry["file"]}}
                wf["5"]["inputs"][f"ref_images.ref_image_{index}"] = [nid, 0]
            for index, entry in enumerate(e for e in manifest if e["kind"] == "video"):
                filename = reference_inputs.prepare_video(INPUT_DIR, entry["file"], entry["video"])
                entry["prepared_file"] = filename
                nid, components = str(120 + index * 2), str(121 + index * 2)
                wf[nid] = {"class_type": "LoadVideo", "inputs": {"file": filename}}
                wf[components] = {"class_type": "GetVideoComponents", "inputs": {"video": [nid, 0]}}
                wf["5"]["inputs"][f"ref_videos.ref_video_{index}"] = [components, 0]
                if entry["video"]["include_audio"]:
                    wf["5"]["inputs"][f"ref_video_audios.ref_video_audio_{index}"] = [components, 1]
        else:
            positive = ["5", 0]
            for index, entry in enumerate(e for e in manifest if e["kind"] == "image"):
                role = entry["role"]
                if role in {"first_frame", "last_frame"}:
                    continue
                image_id, guide_id = str(140 + index * 2), str(141 + index * 2)
                wf[image_id] = {"class_type": "LoadImage", "inputs": {"image": entry["file"]}}
                wf[guide_id] = {"class_type": "MiniMaxH3AddGuide", "inputs": {
                    "positive": positive, "latent": ["5", 1], "vae": ["3", 0],
                    "image": [image_id, 0], "frame_idx": entry["frame_index"]}}
                positive = [guide_id, 0]
            wf["7"]["inputs"]["conditioning"] = positive
    return wf


ROLE_LABEL = {"char": "人设", "scene": "场景", "action": "动作", "camera": "镜头", "audio": "音频", "style": "风格", "layout": "构图", "storyboard": "分镜", "extra": "备注"}


def model_status():
    result = {}
    for mode, name in (("fl2va", MODEL_UNET), ("ref2va", MODEL_REF)):
        path = os.path.join(COMFY_DIR, "models", "diffusion_models", name)
        size = os.path.getsize(path) if os.path.isfile(path) else 0
        result[mode] = dict(name=name, available=size == MODEL_REF_SIZE, size_bytes=size, expected_bytes=MODEL_REF_SIZE)
    return result


def compile_inputs(items, params, connections=None, zones=None):
    connections = normalize_connections(items, connections)
    return reference_inputs.compile_board(items, params, zones, connections, INPUT_DIR,
                                          calc_length(params["duration"]), ROLE_LABEL)


def assemble_prompt(items):
    """把画板条目自动整理成最终提示词 + 图片角色分配。
    返回 (prompt, first_frame, last_frame, fields)
    规则：
      - 文字卡片按角色分节拼接（场景/人设/镜头/音频/风格/备注）
      - 图片：显式首帧/尾帧优先；只有 auto 角色可自动补充首尾帧
      - 中间帧、参考及未知角色仅保留为画板资料，不进入模型输入
      - 视频：仅作为参考素材记录，不进入模型输入
    """
    fields = {r: [] for r in TEXT_ROLES}
    images = {"first_frame": [], "last_frame": [], "reference": [], "auto": []}
    videos = []
    for it in items or []:
        kind = it.get("kind")
        role = it.get("role") or ""
        if kind == "text":
            content = (it.get("content") or "").strip()
            if content and role in fields:
                fields[role].append(content)
        elif kind == "image":
            f = (it.get("file") or "").strip()
            if f:
                images[role if role in images else "reference"].append(f)
        elif kind == "video":
            f = (it.get("file") or "").strip()
            if f:
                videos.append(f)

    # 图片自动分配
    first = (images["first_frame"] or [None])[0]
    last = (images["last_frame"] or [None])[0]
    auto = images["auto"]
    if first is None and auto:
        first = auto.pop(0)
    if last is None and auto:
        last = auto.pop(0)

    sections = []
    for r in ("scene", "char", "action", "camera", "audio", "style", "layout", "storyboard"):
        if fields[r]:
            sections.append(ROLE_LABEL[r] + "：" + "\n".join(fields[r]))
    if fields["extra"]:
        sections.append("\n".join(fields["extra"]))
    prompt = "\n\n".join(sections)

    out_fields = {r: "\n".join(fields[r]) for r in TEXT_ROLES}
    out_fields["_videos"] = videos
    out_fields["_images_reference"] = images["reference"] + auto
    return prompt, first, last, out_fields


def normalize_connections(items, connections=None):
    """Keep board links attached to existing, unambiguous card IDs."""
    if connections is None:
        return []
    if not isinstance(connections, list) or len(connections) > 1000:
        raise ValueError("画板连线须为列表，最多1000条")
    counts = {}
    for item in items or []:
        card_id = item.get("id")
        if isinstance(card_id, str) and card_id:
            counts[card_id] = counts.get(card_id, 0) + 1
    card_ids = {card_id for card_id, count in counts.items() if count == 1}
    result, used_ids = [], set()
    for edge in connections:
        if not isinstance(edge, dict):
            continue
        edge_id, source, target = edge.get("id"), edge.get("from"), edge.get("to")
        if not all(isinstance(value, str) and 0 < len(value) <= 200 for value in (edge_id, source, target)):
            continue
        if edge_id in used_ids or source == target or source not in card_ids or target not in card_ids:
            continue
        label = edge.get("label", "")
        if not isinstance(label, str) or len(label) > 2000:
            raise ValueError("连线标签须为文本，最多2000字")
        result.append({"id": edge_id, "from": source, "to": target, "label": label})
        used_ids.add(edge_id)
    return result


# ================================================================ 上传
ALLOWED_IMG = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
ALLOWED_VID = {".mp4", ".webm", ".mov", ".mkv"}


def save_upload(fileobj, filename):
    """把上传文件保存到 ComfyUI 的 input 目录，返回新文件名。"""
    ext = os.path.splitext(filename or "")[1].lower()
    if ext not in ALLOWED_IMG and ext not in ALLOWED_VID:
        raise ValueError("请选择 PNG、JPG、WebP 图片或 MP4、WebM、MOV 视频")
    name = "upload_" + uuid.uuid4().hex[:10] + ext
    path = os.path.join(INPUT_DIR, name)
    if hasattr(fileobj, "save"):
        fileobj.save(path)
    else:
        with open(path, "wb") as dst:
            shutil.copyfileobj(fileobj, dst)
    return name


def serve_input(name):
    """安全地在 input 目录内解析文件名（防目录穿越）。"""
    base = os.path.abspath(INPUT_DIR)
    p = os.path.abspath(os.path.join(INPUT_DIR, name))
    if os.path.commonpath([base, p]) != base:
        raise ValueError("非法文件名")
    return p


# ================================================================ 素材库
def _load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def _save_json(path, data):
    tmp = path + "." + uuid.uuid4().hex + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_records():
    return _load_json(RECORDS_FILE, [])


def save_records(records):
    with _LIB_LOCK:
        _save_json(RECORDS_FILE, records)


def new_record_id():
    return uuid.uuid4().hex[:10]


def create_record(prompt_id, params, fields, prompt, images, items=None, workflow=None, connections=None, zones=None, compiled=None):
    rec = {
        "id": new_record_id(),
        "prompt_id": prompt_id,
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        "duration": params.get("duration"),
        "resolution": params.get("resolution"),
        "steps": params.get("steps"),
        "seed": params.get("seed"),
        "fields": {k: v for k, v in (fields or {}).items() if not k.startswith("_")},
        "refs": {"videos": (fields or {}).get("_videos", []),
                 "images": (fields or {}).get("_images_reference", [])},
        "images": images,
        "prompt": prompt,
        "outputs": [],
        "status": "queued",
        "created_at": time.time(),
        "items": copy.deepcopy(items),
        "connections": normalize_connections(items, connections),
        "zones": reference_inputs.normalize_zones(zones),
        "workflow": workflow,
        "frames": calc_length(params.get("duration", 2)),
        "model": MODEL_UNET,
        "model_mode": params.get("model_mode", "auto"),
        "requested_model_mode": params.get("model_mode", "auto"),
        "error": None,
        "star": False,
        "tags": [],
        "thumb": None,
    }
    if compiled:
        rec.update(model=MODEL_REF if compiled["model_mode"] == "ref2va" else MODEL_UNET,
                   model_mode=compiled["model_mode"], input_manifest=copy.deepcopy(compiled["input_manifest"]),
                   compiled_prompt=compiled["compiled_prompt"], connection_manifest=copy.deepcopy(compiled["connection_manifest"]),
                   input_packet=reference_inputs.input_packet(compiled))
    with _LIB_LOCK:
        records = load_records()
        records.insert(0, rec)
        save_records(records)
    return rec


def update_record(rec_id, **changes):
    with _LIB_LOCK:
        records = load_records()
        for r in records:
            if r["id"] == rec_id:
                r.update(changes)
                save_records(records)
                return r
    return None


def get_record(rec_id):
    for r in load_records():
        if r["id"] == rec_id:
            return r
    return None


def find_record_by_prompt_id(prompt_id):
    for r in load_records():
        if r["prompt_id"] == prompt_id:
            return r
    return None


def list_records(q=None, tag=None):
    out = load_records()
    if tag:
        out = [r for r in out if tag in r.get("tags", [])]
    if q:
        q = q.lower()
        out = [r for r in out
               if q in (r.get("prompt", "") + " " + json.dumps(r.get("fields", {}), ensure_ascii=False)).lower()]
    return out


def set_star(rec_id, star):
    return update_record(rec_id, star=bool(star)) is not None


def set_tags(rec_id, tags):
    return update_record(rec_id, tags=list(tags or [])) is not None


def delete_record(rec_id):
    # 素材移出列表时保留视频、配置和缩略图，可恢复。
    return update_record(rec_id, archived=True) is not None


def refill_payload(rec_id):
    """一键回填：把某次生成还原成画板条目 + 参数。"""
    r = get_record(rec_id)
    if not r:
        return None
    items = []
    for role, label in ROLE_LABEL.items():
        content = (r.get("fields") or {}).get(role)
        if content:
            items.append({"kind": "text", "role": role, "content": content})
    imgs = r.get("images") or {}
    for role in ("first_frame", "last_frame"):
        f = imgs.get(role)
        if f:
            items.append({"kind": "image", "role": role, "file": f})
    for f in (imgs.get("reference") or []):
        items.append({"kind": "image", "role": "reference", "file": f})
    for f in (r.get("refs") or {}).get("videos", []):
        items.append({"kind": "video", "role": "reference", "file": f})
    res = r.get("resolution") or [864, 480]
    params = {
        "resolution": "%d,%d" % (res[0], res[1]) if isinstance(res, list) else str(res),
        "duration": r.get("duration") or 5,
        "steps": r.get("steps") or 20,
        "seed": r.get("seed", 20260827),
        "model_mode": r.get("requested_model_mode", r.get("model_mode", "auto")),
    }
    items = copy.deepcopy(r.get("items") if r.get("items") is not None else items)
    return {"items": items, "connections": normalize_connections(items, r.get("connections")),
            "zones": reference_inputs.normalize_zones(r.get("zones")),
            "params": params, "viewport": r.get("viewport"),
            "input_manifest": copy.deepcopy(r.get("input_manifest", [])), "compiled_prompt": r.get("compiled_prompt", r.get("prompt", ""))}


def extract_thumb(rec_id, video_rel):
    """为记录提取视频中段一帧作为缩略图。返回相对路径或 None。"""
    from imageio_ffmpeg import get_ffmpeg_exe
    ffmpeg = get_ffmpeg_exe()
    video_abs = os.path.join(OUTPUT_DIR, video_rel.replace("/", os.sep))
    if not os.path.isfile(video_abs):
        return None
    thumb_name = rec_id + ".jpg"
    thumb_abs = os.path.join(THUMB_DIR, thumb_name)
    # 取视频中点附近的一帧
    try:
        import subprocess as sp
        sp.run([ffmpeg, "-y", "-i", video_abs, "-vf", "thumbnail=40", "-frames:v", "1", thumb_abs],
               capture_output=True, timeout=60)
    except Exception:
        try:
            subprocess.run([ffmpeg, "-y", "-i", video_abs, "-frames:v", "1", thumb_abs],
                           capture_output=True, timeout=60)
        except Exception:
            pass
    if os.path.isfile(thumb_abs):
        return "thumbs/" + thumb_name
    return None


# ================================================================ 预设
DEFAULT_PRESETS = {
    "camera": [
        {"name": "手持微晃", "text": "手持微晃的纪实感，焦点轻轻游移（微微移焦）"},
        {"name": "缓慢推近", "text": "缓慢推近（dolly in），景别从全景逐渐收紧到特写"},
        {"name": "缓慢拉远", "text": "缓慢拉远（dolly out），从特写逐渐展开到全景"},
        {"name": "横向摇移", "text": "横向摇移镜头，平稳匀速，展现环境全貌"},
        {"name": "环绕运镜", "text": "环绕主体缓慢旋转运镜，保持主体居中"},
        {"name": "固定机位", "text": "固定机位，画面静止，仅主体运动"},
        {"name": "希区柯克变焦", "text": "希区柯克式推拉变焦，背景压迫感增强"},
        {"name": "一镜到底", "text": "一镜到底的长镜头，机位连续运动不断切"},
    ],
    "style": [
        {"name": "咒术回战OP", "text": "咒术回战OP质感，赛璐璐动画，高饱和冷暖对比，电影级构图"},
        {"name": "吉卜力手绘", "text": "吉卜力风格手绘动画，柔和水彩质感，温暖自然光"},
        {"name": "新海诚唯美", "text": "新海诚式唯美画面，通透天空与光斑，细腻色彩"},
        {"name": "赛博朋克", "text": "赛博朋克风格，霓虹灯光，雨夜都市，高对比冷色调"},
        {"name": "胶片实拍", "text": "电影胶片实拍质感，浅景深，轻微颗粒，自然调色"},
        {"name": "水墨国风", "text": "水墨国风，留白构图，笔触晕染，东方意境"},
    ],
    "audio": [
        {"name": "安静氛围", "text": "安静压抑的氛围底噪，远处环境音，虫鸣与树叶沙沙"},
        {"name": "史诗管弦", "text": "史诗感管弦配乐，渐强的鼓点与铜管"},
        {"name": "轻快电子", "text": "轻快的电子配乐，节奏明快，清新氛围"},
        {"name": "自然白噪", "text": "自然白噪音，风声水声，宁静平和"},
    ],
    "prompt": [
        {"name": "产品展示模板", "text": "产品展示：{产品}放在干净的展示台上，光线柔和，镜头缓慢环绕，突出材质与细节；音频：轻柔背景音乐"},
        {"name": "人物出场模板", "text": "人物出场：{人物}从远处走向镜头，逆光剪影逐渐清晰，微风拂动衣角；音频：脚步声与氛围音乐渐强"},
    ],
}


def load_presets():
    data = _load_json(PRESETS_FILE, None)
    if data is None:
        data = DEFAULT_PRESETS
        _save_json(PRESETS_FILE, data)
    # 合并内置项（不覆盖用户已有）
    for k, v in DEFAULT_PRESETS.items():
        if k not in data:
            data[k] = v
    _save_json(PRESETS_FILE, data)
    return data


def save_presets(data):
    _save_json(PRESETS_FILE, data)


# ================================================================ 关键词记忆
def load_memory():
    return _load_json(MEMORY_FILE, {r: [] for r in TEXT_ROLES})


def remember(fields):
    """把一次生成的各字段关键词写入记忆（每角色保留最近 8 条不重复）。"""
    mem = load_memory()
    for r in TEXT_ROLES:
        v = (fields or {}).get(r, "").strip()
        if not v:
            continue
        lst = mem.setdefault(r, [])
        if v in lst:
            lst.remove(v)
        lst.insert(0, v)
        mem[r] = lst[:8]
    _save_json(MEMORY_FILE, mem)


def memory_items():
    return load_memory()
