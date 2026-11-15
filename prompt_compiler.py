"""Deterministic director notes, separate from the editor's audit manifest.

This preserves the user's wording. It does not caption images, translate text,
or pretend to perform the model's separate Context-IR language-model rewrite.
"""
import re


ROLE_HINTS = {
    "scene": "参考场景、空间与环境", "action": "参考动作与运动节奏",
    "camera": "参考机位、景别与运镜", "style": "参考视觉风格、光线和色彩",
    "layout": "参考构图、人物站位、空间比例与镜头关系",
    "storyboard": "参考分镜构图和镜头顺序，成片不出现分镜边框、文字标注或拼贴",
    "audio": "参考声音与节奏", "general": "参考画面内容",
}
VIEW_HINTS = {"front": "正面", "side": "侧面", "back": "背面",
              "three_view": "同一人物的正侧背三视图", "detail": "局部细节"}


def normalized(text):
    return re.sub(r"\s+", "", text).strip("。；; ")


def unique_text(values, contained=False):
    """Remove exact repeated notes without paraphrasing or inventing details."""
    result, seen = [], set()
    for value in values:
        for part in re.split(r"\n\s*\n", value or ""):
            part = part.strip()
            key = normalized(part)
            if key and key not in seen:
                seen.add(key)
                result.append(part)
    if contained:
        result = [value for value in result if not any(
            len(normalized(value)) >= 12 and normalized(value) != normalized(other)
            and normalized(value) in normalized(other) for other in result)]
    return result


def effective_role(entry, zone_map):
    if entry["kind"] == "text" and entry.get("role") not in {"extra", None}:
        return "character" if entry["role"] == "char" else entry["role"]
    explicit = entry.get("reference_role", "general")
    role = explicit if explicit != "general" else zone_map.get(entry.get("zone_id"), {}).get("purpose", "general")
    return "character" if entry["kind"] != "text" and role == "general" and entry.get("character_id") else role


def compose(manifest, items, zones, connections, audio_mode="generated"):
    active = [e for e in manifest if e["included"]]
    zone_map = {z["id"]: z for z in zones}
    source = {i.get("id"): i for i in items}
    by_id = {e["item_id"]: e for e in active}
    roles = {e["item_id"]: effective_role(e, zone_map) for e in active}
    groups, group_for = {}, {}
    # A board area is a category, never an identity. Only explicit asset identity
    # or an explicit identity link may combine references to the same character.
    character_assets = {e.get("character_id") or e.get("asset_id") or e.get("preset_id")
                        for e in active if roles[e["item_id"]] == "character"}
    character_assets.discard(None)
    for e in active:
        identity = e.get("character_id") or e.get("asset_id") or e.get("preset_id")
        if roles[e["item_id"]] != "character" and (identity not in character_assets or roles[e["item_id"]] in {"audio", "action", "camera"}
                                                   or (e["kind"] == "text" and not e.get("preset_id"))):
            continue
        key = identity or e["item_id"]
        groups.setdefault(key, []).append(e)
        group_for[e["item_id"]] = key
    for edge in connections:
        if edge.get("label") != "character_consistency" or edge["from"] not in by_id or edge["to"] not in by_id:
            continue
        a, b = edge["from"], edge["to"]
        if any(by_id[k]["kind"] == "text" and roles[k] not in {"character", "general"} for k in (a, b)):
            continue
        if a not in group_for and b not in group_for:
            continue
        key = group_for.get(a, group_for.get(b))
        for item_id in (a, b):
            old = group_for.get(item_id)
            members = groups.pop(old) if old and old != key else [by_id[item_id]] if not old else []
            for member in members:
                groups[key].append(member)
                group_for[member["item_id"]] = key

    subjects, subject_by_item, subject_by_character, asset_aliases, identities = [], {}, {}, {}, []
    for index, (identity, members) in enumerate(groups.items(), 1):
        tag = f"<Subject {index}>"
        name = next((e.get("character_name") or e.get("asset_name") for e in members
                     if e.get("character_name") or e.get("asset_name")), "")
        title = f"{tag}（{name}）" if name else tag
        refs = [e["tag"] + (f"（{VIEW_HINTS[e['character_view']]}）" if e.get("character_view") in VIEW_HINTS else "")
                for e in members if e["kind"] != "text" and e.get("tag", "").startswith("<")]
        detail = unique_text([e.get(field, "") for e in members for field in ("content", "description", "notes")], contained=True)
        heading = title + ("，外观依据 " + "、".join(refs) if refs else "")
        subjects.append(heading + ("。" + "\n".join(detail) if detail else "。保持其脸部、发型、服装和体型一致。"))
        for e in members:
            subject_by_item[e["item_id"]] = title
            if e.get("character_id"):
                subject_by_character[e["character_id"]] = title
            for field in ("asset_id", "preset_id"):
                if e.get(field):
                    asset_aliases.setdefault(e[field], set()).add(title)
        identities.append(dict(subject=tag, name=name, asset_id=identity,
                               item_ids=[e["item_id"] for e in members], references=refs))
    if len(subjects) > 1:
        subjects.append("以上是不同人物，分别保持身份，不互换脸部、服装或身体特征。")

    def resolve_subject(identifier):
        if not identifier:
            return None
        exact = subject_by_character.get(identifier) or subject_by_item.get(identifier)
        if exact:
            return exact
        candidates = asset_aliases.get(identifier, set())
        if len(candidates) > 1:
            raise ValueError("同一资产对应多个人物，请用明确的 character_id 或卡片 ID 指定说话人/布局角色")
        return next(iter(candidates), None)

    visuals, references, sounds, music = [], [], [], []
    rendered = {}
    labels = {"scene": "场景", "action": "动作", "camera": "镜头", "style": "风格", "layout": "构图", "storyboard": "分镜"}
    for e in active:
        role = roles[e["item_id"]]
        if e["item_id"] in subject_by_item:
            rendered[e["item_id"]] = subject_by_item[e["item_id"]]
            continue
        notes = unique_text([e.get(field, "") for field in ("content", "description", "notes")], contained=True)
        text = "\n".join(notes)
        if e["kind"] == "text":
            rendered[e["item_id"]] = text
            if role == "audio":
                if audio_mode == "silent":
                    continue
                kind = e.get("audio_type", "ambience")
                if kind == "dialogue":
                    speaker_id = e.get("speaker_id")
                    speaker = resolve_subject(speaker_id)
                    if not speaker_id:
                        linked = set()
                        for edge in connections:
                            if edge.get("label") == "character_consistency" and e["item_id"] in {edge["from"], edge["to"]}:
                                peer = edge["to"] if edge["from"] == e["item_id"] else edge["from"]
                                if peer in subject_by_item:
                                    linked.add(subject_by_item[peer])
                        if len(linked) > 1:
                            raise ValueError("这句台词关联了多个人物，请明确选择说话人")
                        speaker = next(iter(linked), None)
                    if speaker_id and not speaker:
                        raise ValueError("台词的说话人未参与当前镜头，请启用该角色或重新选择说话人")
                    language = "Chinese" if re.search(r"[\u4e00-\u9fff]", text) else "English"
                    line = text if "<d>" in text else f"<d>[{language}] {text}</d>"
                    sounds.append((speaker + "说：" if speaker else "台词：") + line)
                elif kind == "music":
                    music.append(text)
                else:
                    sounds.append(({"sfx": "音效", "ambience": "环境声"}.get(kind, "声音")) + "：" + text)
            elif text:
                if role == "storyboard" and e.get("shot_order"):
                    text = f"镜头 {e['shot_order']}：{text}"
                visuals.append((role, text))
        else:
            tag = e.get("tag")
            if tag and tag.startswith("<"):
                heading = tag + "：" + ROLE_HINTS.get(role, ROLE_HINTS["general"])
                if role == "storyboard" and e.get("shot_order"):
                    heading += f"，镜头顺序 {e['shot_order']}"
                references.append(heading + ("。" + text if text else "。"))
                rendered[e["item_id"]] = tag
            else:
                # FL2VA pictures already enter the model at exact frame indices;
                # invented text identifiers do not bind them more accurately.
                rendered[e["item_id"]] = f"第 {e['frame_index']/24:.2f} 秒的关键帧"
                if text:
                    references.append(f"{rendered[e['item_id']]}：{text}")
            layout = source.get(e["item_id"], {}).get("layout", {})
            cast = []
            objects = layout.get("objects")
            for obj in objects if isinstance(objects, list) else []:
                if not isinstance(obj, dict):
                    continue
                who = resolve_subject(obj.get("character_id")) or resolve_subject(obj.get("asset_id"))
                if who:
                    cast.append(who)
            if cast:
                references.append(f"{tag} 中的角色布局对应 " + "、".join(dict.fromkeys(cast)) + "，造型以各自的人物参考为准。")

    if audio_mode != "silent":
        sounds.extend(f"参考 {e['audio_tag']}（{e['tag']} 的同期声音）。" for e in active if e.get("audio_tag"))

    for zone in zones:
        if any(e.get("zone_id") == zone["id"] for e in active):
            for note in unique_text([zone.get("notes", ""), zone.get("description", "")]):
                visuals.append((zone.get("purpose", "general"), note))

    # Drop exact/contained repeated action notes, preserving the longest wording
    # and all original dialogue punctuation. No semantic rewriting is guessed.
    kept = set(unique_text([text for _, text in visuals], contained=True))
    visual_lines, seen = [], set()
    for role, value in visuals:
        for text in unique_text([value]):
            if text in kept and text not in seen:
                visual_lines.append((labels[role] + "：" if role in labels else "") + text)
                seen.add(text)
    relations = []
    verbs = {"reference": "以 {a} 为参考表现：{b}", "character_consistency": "{b} 与 {a} 保持人物身份一致",
             "style_inherit": "{b} 的视觉风格参考 {a}", "action_reference": "{b} 的动作参考 {a}",
             "camera": "{b} 的机位与运镜参考 {a}", "continuation": "{b} 延续 {a} 的动作与时空关系",
             "association": "在同一镜头中关联 {a} 与 {b}"}
    for edge in connections:
        a, b = edge["from"], edge["to"]
        if a not in by_id or b not in by_id:
            continue
        if audio_mode == "silent" and (roles[a] == "audio" or roles[b] == "audio"):
            continue
        if edge.get("label") == "character_consistency" and (roles[a] == "audio" or roles[b] == "audio"):
            continue  # Already bound as a speaker above; never turn dialogue into identity prose.
        if subject_by_item.get(a) and subject_by_item.get(a) == subject_by_item.get(b):
            continue
        left, right = rendered.get(a), rendered.get(b)
        if not left or not right:
            continue
        # Replaces an unbound action paragraph rather than repeating it below.
        if by_id[b]["kind"] == "text" and roles[b] != "audio" and b not in subject_by_item:
            visual_lines = [line for line in visual_lines if not line.endswith(right)]
        template = verbs.get(edge.get("label"))
        relations.append(template.format(a=left, b=right) if template else f"{left} 与 {right}：{edge.get('label', '')}")
    sections = []
    for title, lines in (("人物", subjects), ("画面", visual_lines + relations), ("视觉参考", references),
                         ("声音", ["无声视频，不输出音轨。"] if audio_mode == "silent" else sounds), ("配乐", music)):
        content = "\n".join(unique_text(lines))
        if content:
            sections.append(dict(title=title, text=content))
    return dict(compiled_prompt="\n\n".join(s["title"] + "：\n" + s["text"] for s in sections),
                prompt_sections=sections, subjects=identities, audio_mode=audio_mode,
                prompt_format="lumen-director-v2")
