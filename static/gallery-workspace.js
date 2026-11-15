/* Shot gallery: the persisted board remains the source of truth. */
(() => {
  const board = window.LumenBoard;
  const make = (tag, cls = "", text = "") =>
    Object.assign(document.createElement(tag), {
      className: cls,
      textContent: text,
    });
  const button = (text, handler, cls = "btn") => {
    const el = make("button", cls, text);
    el.type = "button";
    el.onclick = handler;
    return el;
  };
  const labels = {
    all: "全部参考",
    character: "角色",
    scene: "场景",
    action: "动作与镜头",
    layout: "构图与预演",
    general: "其他参考",
  };
  const purposes = {
    character: "角色",
    scene: "场景",
    action: "动作",
    camera: "镜头",
    style: "风格",
    layout: "构图与预演",
    storyboard: "分镜",
    general: "其他参考",
    audio: "声音",
  };
  let filter = "all",
    scheduled = false,
    dragged = null,
    soundExpanded = false;
  const host = make("section", "shot-workspace");
  host.id = "shot-workspace";
  host.tabIndex = -1;
  host.setAttribute("aria-label", "当前镜头图版");
  const toolbar = make("div", "shot-toolbar");
  for (const id of [
    "open-reference-presets",
    "add-image",
    "add-video",
    "layout-open",
  ]) {
    const control = document.getElementById(id);
    if (control) toolbar.append(control);
  }
  toolbar.querySelector("#open-reference-presets").lastChild.textContent =
    " 角色 / 场景库";
  const save = button("存为预设", () =>
    window.LumenPresetLibrary.saveSelection(),
  );
  save.title = "将选中图版项保存到角色与场景库";
  save.id = "gallery-save-preset";
  toolbar.append(save);
  const picture = make("section", "shot-picture-panel");
  picture.id = "shot-picture-panel";
  const bar = make("div", "gallery-filterbar"),
    tabs = make("div", "gallery-tabs"),
    count = make("span", "gallery-summary");
  count.id = "gallery-summary";
  for (const [key, label] of Object.entries(labels)) {
    const tab = button(
      label,
      () => {
        filter = key;
        render();
      },
      "gallery-tab",
    );
    tab.dataset.filter = key;
    tabs.append(tab);
  }
  bar.append(tabs, count);
  const grid = make("div", "shot-gallery");
  grid.id = "shot-gallery";
  const hint = make(
    "p",
    "gallery-hint",
    "双击图版项可移除，撤销可恢复。原文件和角色库会保留。拖动卡片把手调整显示顺序。",
  );
  host.append(toolbar, picture, bar, grid, hint);
  document.querySelector(".canvas-stage").before(host);
  const sound = make("section", "inspector-block shot-sound-panel");
  sound.id = "shot-sound-panel";
  document.querySelector(".inspector-content").prepend(sound);
  const editDialog = make("dialog", "gallery-editor-dialog");
  editDialog.id = "gallery-editor";
  document.body.append(editDialog);
  function field(label, input) {
    const row = make("label", "gallery-field", label);
    row.append(input);
    return row;
  }
  function select(values, value, label) {
    const input = make("select");
    input.setAttribute("aria-label", label);
    for (const [key, text] of Object.entries(values)) {
      const option = make("option", "", text);
      option.value = key;
      input.append(option);
    }
    input.value = value;
    return input;
  }
  function editInput(input, item, key) {
    input.value = item[key] || "";
    let first = true;
    input.addEventListener("focus", () => (first = true));
    input.addEventListener("input", () => {
      board.updateItems([item.id], { [key]: input.value }, first);
      first = false;
    });
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (
        document.activeElement?.matches(
          "#shot-workspace textarea,#shot-workspace input,#shot-sound-panel textarea,#gallery-editor textarea,#gallery-editor input",
        )
      )
        return;
      render();
    });
  }
  function showEditor(group) {
    editDialog.replaceChildren();
    const top = make("div", "gallery-editor-top");
    top.append(
      make("h2", "", "编辑 " + group.name),
      button("完成", () => {
        editDialog.close();
        render();
      }),
    );
    editDialog.append(top);
    const naming = make("input");
    naming.value = group.name;
    naming.maxLength = 160;
    naming.setAttribute("aria-label", "图版项名称");
    let firstName = true;
    naming.oninput = () => {
      board.updateItems(
        group.items.map((item) => item.id),
        {
          preset_name: naming.value,
          asset_name: naming.value,
          ...(group.character_id ? { character_name: naming.value } : {}),
        },
        firstName,
      );
      firstName = false;
    };
    editDialog.append(field("名称", naming));
    const purpose = select(purposes, group.purpose, "图版项用途");
    purpose.onchange = () => {
      board.setAssetPurpose(
        group.items.map((item) => item.id),
        purpose.value,
      );
    };
    editDialog.append(field("用途", purpose));
    editDialog.append(
      make(
        "p",
        "field-help",
        "逐项选择用于生成的参考和说明。未勾选的备选图、来源资料会保留，不会因为整组加入镜头而自动启用。",
      ),
    );
    for (const item of group.items) {
      const panel = make("div", "gallery-item-editor");
      panel.dataset.itemId = item.id;
      const memberToggle = make("input");
      memberToggle.type = "checkbox";
      memberToggle.checked = item.enabled !== false;
      memberToggle.setAttribute("aria-label", "此素材参与生成");
      memberToggle.onchange = () =>
        board.updateItems([item.id], { enabled: memberToggle.checked });
      const memberLabel = make("label", "gallery-member-toggle");
      memberLabel.append(
        memberToggle,
        document.createTextNode("此素材参与生成"),
      );
      panel.append(memberLabel);
      if (item.kind === "text") {
        const content = make("textarea");
        content.rows = 4;
        content.maxLength = 20000;
        content.setAttribute("aria-label", "素材说明");
        editInput(content, item, "content");
        panel.append(field("说明", content));
      } else {
        const media = make(
          item.kind === "image" ? "img" : "video",
          "gallery-editor-media",
        );
        media.src =
          "/input/" + item.file.split("/").map(encodeURIComponent).join("/");
        if (item.kind === "video") media.controls = true;
        panel.append(media);
        const caption = make("textarea");
        caption.rows = 2;
        caption.maxLength = 20000;
        caption.setAttribute("aria-label", "参考图说明");
        editInput(caption, item, "notes");
        panel.append(field("这份参考的说明", caption));
        if (item.kind === "image") {
          const usage = select(
            {
              reference: "参考图",
              first_frame: "首帧",
              last_frame: "尾帧",
              middle_frame_1: "中间帧 25%",
              middle_frame_2: "中间帧 50%",
              middle_frame_3: "中间帧 75%",
            },
            item.role === "auto" ? "reference" : item.role,
            "图片生成用法",
          );
          usage.onchange = () => board.setImageUsage(item.id, usage.value);
          panel.append(field("生成用法", usage));
          if (group.character_id) {
            const view = select(
              {
                general: "整体参考",
                front: "正面",
                side: "侧面",
                back: "背面",
                three_view: "三视图",
                detail: "局部",
              },
              item.character_view || "general",
              "人物视角",
            );
            view.onchange = () =>
              board.updateItems([item.id], { character_view: view.value });
            panel.append(field("人物视角", view));
          }
        } else {
          for (const [key, label, min, max] of [
            ["video_start", "开始秒数", 0, 86400],
            ["video_duration", "选用秒数", 0.21, 15],
          ]) {
            const input = make("input");
            input.type = "number";
            input.min = min;
            input.max = max;
            input.step = ".01";
            input.value = item[key] ?? (key === "video_start" ? 0 : 2);
            input.onchange = () => {
              if (input.reportValidity())
                board.updateItems([item.id], { [key]: Number(input.value) });
            };
            panel.append(field(label, input));
          }
          const audio = select(
            { yes: "使用原片声音", no: "不使用原片声音" },
            item.include_audio === true ? "yes" : "no",
            "参考视频声音",
          );
          audio.onchange = () =>
            board.updateItems([item.id], {
              include_audio: audio.value === "yes",
            });
          panel.append(audio);
        }
        panel.append(
          button("放大查看", () => board.previewItem(item.id), "btn quiet"),
        );
      }
      panel.append(
        button(
          "移除此素材",
          () => {
            board.removeItems([item.id]);
            editDialog.close();
            render();
          },
          "text-btn danger",
        ),
      );
      editDialog.append(panel);
    }
    editDialog.append(
      button("追加图片 / 视频", () => {
        const input = make("input");
        input.type = "file";
        input.accept = "image/*,video/*";
        input.multiple = true;
        input.onchange = async () => {
          const added = await board.uploadFiles(input.files);
          if (added?.length) {
            board.updateItems(
              added.map((item) => item.id),
              {
                asset_id: group.asset_id,
                ...(group.character_id
                  ? { character_id: group.character_id }
                  : {}),
                reference_role: group.purpose,
                preset_name: group.name,
              },
            );
            editDialog.close();
            render();
          }
        };
        input.click();
      }),
    );
    editDialog.showModal();
  }
  function renderPicture(snapshot) {
    picture.replaceChildren();
    const heading = make("div", "gallery-section-heading");
    heading.append(
      make("h2", "", "这一镜，发生什么？"),
      button(
        "添加一段画面",
        () => {
          board.addText("scene", "");
          render();
        },
        "text-btn",
      ),
    );
    picture.append(heading);
    const scenes = snapshot.items.filter(
      (item) =>
        item.kind === "text" &&
        item.role === "scene" &&
        !item.preset_id &&
        !item.character_id,
    );
    if (!scenes.length) {
      const input = make("textarea");
      input.id = "shot-description";
      input.rows = 3;
      input.placeholder =
        "画面、动作与镜头。例如：蓝色大飞鱼游进教室，镜头缓缓跟随，窗外是下午的阳光。";
      input.setAttribute("aria-label", "画面描述");
      let item = null;
      input.oninput = () => {
        if (!item) item = board.addText("scene", input.value);
        else board.updateItems([item.id], { content: input.value }, false);
      };
      picture.append(input);
    } else
      for (const [index, item] of scenes.entries()) {
        const area = make("div", "shot-description-row"),
          input = make("textarea");
        input.rows = index === 0 ? 3 : 2;
        input.maxLength = 20000;
        input.setAttribute(
          "aria-label",
          index ? "补充画面 " + (index + 1) : "画面描述",
        );
        if (index === 0) input.id = "shot-description";
        editInput(input, item, "content");
        area.append(input);
        if (index > 0)
          area.append(
            button("移除", () => board.removeItems([item.id]), "text-btn"),
          );
        picture.append(area);
      }
  }
  function renderSound(snapshot, characters) {
    sound.replaceChildren();
    const heading = make("div", "gallery-section-heading");
    heading.append(
      make("h2", "", "声音"),
      button(
        "添加声音",
        () => {
          soundExpanded = true;
          const item = board.addText("audio", "");
          board.updateItems([item.id], { audio_type: "ambience" }, false);
          render();
        },
        "text-btn",
      ),
    );
    sound.append(heading);
    const mode = select(
      { generated: "生成声音", silent: "无声成片" },
      snapshot.params.audio_mode || "generated",
      "成片声音模式",
    );
    mode.id = "shot-audio-mode";
    mode.onchange = () => {
      soundExpanded = mode.value === "generated";
      board.updateParameters({ audio_mode: mode.value });
    };
    sound.append(mode);
    if (mode.value === "silent") {
      sound.append(
        make(
          "p",
          "field-help",
          "成片不包含音轨。已填写的声音说明会保留，切回生成声音即可继续使用。",
        ),
      );
      return;
    }
    const entries = snapshot.items.filter(
      (item) => item.kind === "text" && item.role === "audio",
    );
    if (entries.length) {
      const toggle = button(
        soundExpanded ? "收起声音编辑" : `编辑 ${entries.length} 条声音`,
        () => {
          soundExpanded = !soundExpanded;
          render();
        },
        "text-btn sound-expand",
      );
      toggle.id = "sound-expand";
      toggle.setAttribute("aria-expanded", String(soundExpanded));
      sound.append(toggle);
      if (!soundExpanded) {
        const summary = make(
          "p",
          "sound-summary",
          entries
            .map(
              (item) =>
                (({
                  dialogue: "台词",
                  sfx: "音效",
                  music: "音乐",
                  ambience: "环境声",
                })[item.audio_type] || "环境声") +
                " · " +
                (item.content || "待填写").slice(0, 28),
            )
            .join("\n"),
        );
        sound.append(summary);
        return;
      }
    }
    if (!entries.length)
      sound.append(
        make(
          "p",
          "field-help",
          "添加台词、音效、音乐或环境声。台词可以关联镜头中的说话角色。",
        ),
      );
    for (const item of entries) {
      const row = make("div", "shot-sound-row");
      row.dataset.itemId = item.id;
      const type = select(
        {
          dialogue: "角色台词",
          sfx: "音效",
          music: "音乐",
          ambience: "环境声",
        },
        item.audio_type || "ambience",
        "声音类型",
      );
      type.onchange = () => {
        board.updateItems([item.id], { audio_type: type.value });
        render();
      };
      row.append(type);
      if (type.value === "dialogue") {
        const speakers = { "": "未指定角色" };
        for (const person of characters)
          speakers[person.character_id] =
            person.name + (person.enabled ? "" : "（未加入镜头）");
        if (item.speaker_id && !speakers[item.speaker_id])
          speakers[item.speaker_id] = "原角色（当前未加入镜头）";
        const speaker = select(speakers, item.speaker_id || "", "说话角色");
        speaker.onchange = () =>
          board.updateItems([item.id], { speaker_id: speaker.value || null });
        row.append(speaker);
      }
      const content = make("textarea");
      content.rows = 2;
      content.maxLength = 20000;
      content.placeholder =
        type.value === "dialogue"
          ? "直接填写这位角色的台词…"
          : type.value === "music"
            ? "音乐的风格、节奏与情绪…"
            : "描述需要听到的声音…";
      content.setAttribute("aria-label", "声音内容");
      editInput(content, item, "content");
      row.append(
        content,
        button("移除声音", () => board.removeItems([item.id]), "text-btn"),
      );
      sound.append(row);
    }
  }
  function render() {
    const snapshot = board.getState(),
      groups = board.getGroups(),
      characters = board.getCharacters();
    renderPicture(snapshot);
    renderSound(snapshot, characters);
    grid.replaceChildren();
    const visible = groups.filter(
      (group) =>
        !group.items.every(
          (item) =>
            item.kind === "text" &&
            (item.role === "audio" ||
              (item.role === "scene" && !item.preset_id && !item.character_id)),
        ),
    );
    const filtered = visible.filter(
      (group) =>
        filter === "all" ||
        (filter === "action"
          ? ["action", "camera"].includes(group.purpose)
          : filter === "layout"
            ? ["layout", "storyboard"].includes(group.purpose)
            : filter === "general"
              ? ["style", "general", "audio"].includes(group.purpose)
              : group.purpose === filter),
    );
    count.textContent = `${visible.filter((group) => group.enabled).length} 项用于镜头 · ${characters.filter((group) => group.enabled).length} 个角色`;
    tabs.querySelectorAll("button").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.filter === filter);
      tab.setAttribute("aria-pressed", String(tab.dataset.filter === filter));
    });
    for (const group of filtered) {
      const card = make(
        "article",
        "shot-asset" + (group.enabled ? "" : " is-unused"),
      );
      card.dataset.assetId = group.asset_id;
      card.dataset.groupId = group.id;
      if (group.character_id) card.dataset.characterId = group.character_id;
      card.tabIndex = 0;
      card.setAttribute("aria-label", group.name);
      const ids = group.items.map((item) => item.id),
        media = group.items
          .filter((item) => item.kind !== "text")
          .sort(
            (a, b) => Number(a.enabled === false) - Number(b.enabled === false),
          );
      const top = make("div", "shot-asset-top");
      top.append(
        make("span", "asset-purpose", purposes[group.purpose] || "参考"),
        make(
          "span",
          "asset-participation",
          group.enabled ? "已用于镜头" : "暂不使用",
        ),
      );
      const handle = button("移动", null, "asset-drag-handle");
      handle.draggable = false;
      handle.title = "拖动调整图版顺序";
      handle.setAttribute("aria-label", "拖动 " + group.name);
      handle.onpointerdown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const origin = { x: event.clientX, y: event.clientY },
          rect = card.getBoundingClientRect();
        let ghost = null,
          target = null;
        handle.setPointerCapture(event.pointerId);
        handle.onpointermove = (move) => {
          if (
            !ghost &&
            Math.hypot(move.clientX - origin.x, move.clientY - origin.y) < 5
          )
            return;
          if (!ghost) {
            dragged = group.id;
            ghost = card.cloneNode(true);
            ghost.classList.add("gallery-drag-ghost");
            Object.assign(ghost.style, {
              width: rect.width + "px",
              left: rect.left + "px",
              top: rect.top + "px",
            });
            document.body.append(ghost);
            card.classList.add("dragging");
          }
          ghost.style.transform = `translate(${move.clientX - origin.x}px,${move.clientY - origin.y}px)`;
          grid
            .querySelectorAll(".drop-target")
            .forEach((el) => el.classList.remove("drop-target"));
          target = document
            .elementFromPoint(move.clientX, move.clientY)
            ?.closest(".shot-asset");
          if (target === card) target = null;
          target?.classList.add("drop-target");
          const area = host.getBoundingClientRect();
          if (move.clientY > area.bottom - 35) host.scrollTop += 14;
          else if (move.clientY < area.top + 45) host.scrollTop -= 14;
        };
        const finish = (finishEvent) => {
          const destination = target?.dataset.groupId;
          ghost?.remove();
          card.classList.remove("dragging");
          grid
            .querySelectorAll(".drop-target")
            .forEach((el) => el.classList.remove("drop-target"));
          handle.onpointermove =
            handle.onpointerup =
            handle.onpointercancel =
              null;
          if (handle.hasPointerCapture(event.pointerId))
            handle.releasePointerCapture(event.pointerId);
          dragged = null;
          if (destination && finishEvent.type !== "pointercancel")
            board.reorderAsset(group.id, destination);
        };
        handle.onpointerup = handle.onpointercancel = finish;
      };
      top.append(handle);
      card.append(top);
      if (media.length) {
        const montage = make("div", "asset-montage");
        const first = media[0],
          visual = make(
            first.kind === "image" ? "img" : "video",
            "asset-cover",
          );
        visual.src =
          "/input/" + first.file.split("/").map(encodeURIComponent).join("/");
        visual.draggable = false;
        if (first.kind === "image") {
          visual.alt = group.name;
          visual.loading = "lazy";
        } else {
          visual.preload = "metadata";
          visual.muted = true;
        }
        montage.append(
          visual,
          button("放大", () => board.previewItem(first.id), "asset-enlarge"),
        );
        if (media.length > 1) {
          const strip = make("div", "asset-filmstrip");
          for (const item of media.slice(1, 5)) {
            const thumb = button(
                "",
                () => board.previewItem(item.id),
                "asset-thumb-preview",
              ),
              img = make(item.kind === "image" ? "img" : "video");
            img.src =
              "/input/" +
              item.file.split("/").map(encodeURIComponent).join("/");
            img.draggable = false;
            if (item.kind === "video") {
              img.preload = "metadata";
              img.muted = true;
            }
            thumb.setAttribute(
              "aria-label",
              "查看 " + group.name + " 的参考素材",
            );
            thumb.append(img);
            strip.append(thumb);
          }
          montage.append(strip);
        }
        card.append(montage);
      }
      const body = make("div", "shot-asset-body");
      body.append(make("h3", "", group.name));
      const description = group.description || media[0]?.notes;
      if (description)
        body.append(make("p", "shot-asset-description", description));
      body.append(
        make(
          "p",
          "asset-detail-count",
          `已选 ${media.filter((item) => item.enabled !== false).length} / 共 ${media.length} 份视觉参考${group.items.some((item) => item.kind === "text" && item.enabled !== false) ? " · 说明已关联" : ""}`,
        ),
      );
      const actions = make("div", "shot-asset-actions");
      actions.append(
        button(
          group.enabled
            ? "移出镜头"
            : group.member_count
              ? "加入镜头"
              : "选择生成参考",
          () => {
            if (!board.setAssetEnabled(ids, !group.enabled)) {
              showEditor(group);
              board.toast("这项素材尚未选择生成内容，请逐项勾选需要的参考");
            }
          },
          group.enabled ? "btn quiet" : "btn primary",
        ),
        button("编辑", () => showEditor(group), "btn quiet"),
      );
      if (group.character_id)
        actions.append(
          button(
            "放入 3D",
            async () => {
              try {
                if (!window.LumenLayout?.addCharacter)
                  throw Error("3D 预演正在准备，请稍后再试");
                await window.LumenLayout.addCharacter(group);
              } catch (error) {
                board.toast(error.message, true);
              }
            },
            "text-btn",
          ),
        );
      actions.append(
        button(
          "存为预设",
          () => {
            board.selectItems(ids);
            window.LumenPresetLibrary.saveSelection();
          },
          "text-btn",
        ),
      );
      body.append(actions);
      card.append(body);
      card.onclick = (event) => {
        if (event.target.closest("button,input,textarea,select,a")) return;
        board.selectItems(ids);
        grid
          .querySelectorAll(".shot-asset")
          .forEach((el) => el.classList.toggle("selected", el === card));
      };
      card.ondblclick = (event) => {
        if (event.target.closest("button,input,textarea,select,a")) return;
        event.preventDefault();
        board.removeItems(ids);
        host.focus({ preventScroll: true });
        board.toast("已从当前图版移除，可撤销；角色库与原文件保留");
      };
      card.ondragover = (event) => {
        if (dragged && dragged !== group.id) {
          event.preventDefault();
          card.classList.add("drop-target");
        }
      };
      card.ondragleave = () => card.classList.remove("drop-target");
      card.ondrop = (event) => {
        event.preventDefault();
        card.classList.remove("drop-target");
        board.reorderAsset(dragged, group.id);
        dragged = null;
      };
      grid.append(card);
    }
    if (!filtered.length) {
      const empty = make("div", "gallery-empty");
      empty.append(
        make("h3", "", "把这一镜需要的素材放进来"),
        make(
          "p",
          "",
          "从角色与场景库调用，或导入图片、视频。每个角色的图与说明会放在一起。",
        ),
        button(
          "打开角色 / 场景库",
          () =>
            window.LumenPresetLibrary.open({
              category:
                filter === "character"
                  ? "character"
                  : filter === "scene"
                    ? "scene"
                    : "",
            }),
          "btn primary",
        ),
      );
      grid.append(empty);
    }
    window.dispatchEvent(
      new CustomEvent("lumen:characters-changed", { detail: { characters } }),
    );
  }
  host.addEventListener("dragover", (event) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
  host.addEventListener("drop", (event) => {
    if (event.dataTransfer.files.length) {
      event.preventDefault();
      board.uploadFiles(event.dataTransfer.files);
    }
  });
  document.addEventListener("focusout", (event) => {
    if (
      event.target.closest("#shot-workspace,#shot-sound-panel,#gallery-editor")
    )
      setTimeout(schedule, 0);
  });
  window.addEventListener("lumen:board-changed", schedule);
  window.LumenGallery = {
    editAsset(assetId, characterId) {
      const group = board
        .getGroups()
        .find((value) => characterId ? value.character_id === characterId : value.asset_id === assetId);
      if (group) showEditor(group);
    },
  };
  editDialog.addEventListener("close", schedule);
  document.querySelector(".board-footer>span").textContent =
    "双击移除图版项 · Ctrl+Z 撤销 · 原素材保留";
  render();
})();
