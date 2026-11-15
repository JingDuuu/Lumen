/* A live overview of the same board and tasks used by local agents. */
(() => {
  const board = window.LumenBoard, workspace = document.querySelector("#shot-workspace");
  const make = (tag, cls = "", text = "") => Object.assign(document.createElement(tag), {className: cls, textContent: text});
  const button = (text, run, cls = "btn") => {
    const el = make("button", cls, text);
    el.type = "button"; el.onclick = run; return el;
  };
  const overview = make("section", "board-overview");
  overview.id = "board-overview";
  overview.setAttribute("aria-label", "镜头看板总览");
  const cast = make("section", "board-cast");
  cast.id = "board-cast";
  cast.setAttribute("aria-label", "当前镜头角色");
  const picture = document.querySelector("#shot-picture-panel");
  picture.before(overview, cast);

  function addCharacter() {
    if (window.LumenPresetLibrary) window.LumenPresetLibrary.open({category: "character"});
    else board.toast("角色库正在准备，请稍后再试");
  }
  function stage(label, headline, description, run, cls = "") {
    const el = button("", run, "board-stage " + cls);
    el.append(make("span", "board-stage-label", label), make("strong", "", headline), make("span", "board-stage-detail", description));
    return el;
  }
  function render() {
    const groups = board.getGroups(), characters = board.getCharacters(), activity = board.getActivity();
    const used = characters.filter((group) => group.enabled).length;
    const scenes = groups.filter((group) => group.purpose === "scene" && group.enabled).length;
    const active = activity.tasks.filter((task) => task.active), task = active[0];
    const last = activity.tasks.find((entry) => entry.status === "done" && entry.outputs?.length);
    overview.replaceChildren(
      stage("01 · 当前镜头", `${used} 个角色 · ${scenes} 个场景`, "准备画面与参考", () => document.querySelector("#shot-description")?.focus()),
      stage("02 · 生成中", task?.stage_label || (task ? "等待生成" : "暂无运行任务"),
        task ? task.progress?.total ? `采样 ${task.progress.step || 0} / ${task.progress.total} 步` : task.title : "可在聊天中发起，也可在这里生成",
        () => board.showPage("tasks"), task ? "is-running" : ""),
      stage("03 · 最近成片", last?.title || "还没有成片", last ? `已存入本地素材库${last.source?.client_name ? " · " + last.source.client_name : ""}` : "生成结果会出现在这里",
        () => last ? board.openTask(last.id) : board.showPage("library"), last ? "has-result" : ""),
    );
    const heading = make("div", "board-cast-heading"), list = make("div", "board-cast-list");
    heading.append(make("h2", "", "这一镜的角色"), make("span", "", `${used} / ${characters.length} 位参与`));
    for (const character of characters) {
      const tile = make("div", "cast-tile" + (character.enabled ? "" : " is-unused"));
      tile.dataset.characterId = character.character_id;
      const edit = button("", () => window.LumenGallery.editAsset(character.asset_id, character.character_id), "cast-edit");
      edit.title = "编辑 " + character.name;
      const image = character.items.find((item) => item.kind === "image");
      if (image) {
        const img = make("img"); img.src = "/input/" + image.file.split("/").map(encodeURIComponent).join("/");
        img.alt = ""; img.loading = "lazy"; edit.append(img);
      } else edit.append(make("span", "cast-monogram", character.name.slice(0, 1)));
      edit.append(make("span", "cast-name", character.name));
      const toggle = button(character.enabled ? "参与镜头" : "暂不使用", () => {
        if (!board.setAssetEnabled(character.items.map((item) => item.id), !character.enabled)) {
          window.LumenGallery.editAsset(character.asset_id, character.character_id);
          board.toast("先选择要用于生成的角色参考");
        }
      }, "cast-participation");
      toggle.setAttribute("aria-label", (character.enabled ? "停用 " : "启用 ") + character.name);
      toggle.setAttribute("aria-pressed", String(character.enabled));
      tile.append(edit, toggle); list.append(tile);
    }
    const add = button("", addCharacter, "cast-add"); add.id = "board-add-character";
    add.append(make("span", "cast-add-icon", "+"), make("span", "", "添加角色"));
    list.append(add);
    if (!characters.length) list.append(make("p", "cast-empty", "从角色库选好人物，随时加入或移出这一镜。"));
    cast.replaceChildren(heading, list);
  }
  window.addEventListener("lumen:board-changed", render);
  window.addEventListener("lumen:activity-changed", render);
  document.querySelector(".page-heading h1").textContent = "镜头看板";
  workspace.setAttribute("aria-label", "当前镜头看板");
  render();
})();
