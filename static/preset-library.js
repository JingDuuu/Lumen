/* Named reference presets for the board, separate from 3D Prefabs. */
const categories = {
  character: "角色",
  scene: "场景",
  action: "动作",
  camera: "镜头",
  style: "风格",
  general: "自由素材",
};
const el = (tag, cls = "", text = "") =>
  Object.assign(document.createElement(tag), {
    className: cls,
    textContent: text,
  });
async function api(path = "", options = {}) {
  const response = await fetch("/api/asset-presets" + path, options);
  const result = await response.json();
  if (!response.ok || result.ok === false)
    throw Error(result.error || "预设库操作失败");
  return result;
}
const post = (data) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});
const library = el("dialog", "preset-library-dialog");
library.id = "reference-preset-library";
library.setAttribute("aria-labelledby", "reference-library-title");
const top = el("div", "preset-library-top"),
  title = el("div");
title.append(el("p", "eyebrow", "本地参考资产"), el("h2", "", "参考预设库"));
title.lastChild.id = "reference-library-title";
const close = el("button", "icon-btn");
const closeIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
closeIcon.classList.add("icon");
closeIcon.setAttribute("aria-hidden", "true");
const closeSymbol = document.createElementNS(
  "http://www.w3.org/2000/svg",
  "use",
);
closeSymbol.setAttribute("href", "#icon-close");
closeIcon.append(closeSymbol);
close.append(closeIcon);
close.type = "button";
close.setAttribute("aria-label", "关闭参考预设库");
close.onclick = () => library.close();
top.append(title, close);
const intro = el(
  "p",
  "preset-library-intro",
  "把角色、场景与动作保存成自己的参考。再次调用时追加到画板，素材和内部连线一起保留。",
);
const controls = el("div", "preset-library-controls"),
  search = el("input"),
  category = el("select"),
  importButton = el("button", "btn", "导入预设包"),
  saveButton = el("button", "btn primary", "保存选中素材");
search.type = "search";
search.placeholder = "搜索名称、描述或素材文字";
search.setAttribute("aria-label", "搜索参考预设");
category.setAttribute("aria-label", "预设类别筛选");
for (const [value, label] of [
  ["", "全部类别"],
  ...Object.entries(categories),
]) {
  const option = el("option", "", label);
  option.value = value;
  category.append(option);
}
controls.append(search, category, importButton, saveButton);
const grid = el("div", "preset-library-grid"),
  status = el("p", "preset-library-status");
status.setAttribute("role", "status");
library.append(top, intro, controls, grid, status);
document.body.append(library);
const editor = el("dialog", "preset-save-dialog");
editor.id = "reference-preset-editor";
editor.setAttribute("aria-labelledby", "reference-editor-title");
const form = el("form"),
  editTitle = el("h2", "", "保存参考预设");
editTitle.id = "reference-editor-title";
const explanation = el("p", "field-help"),
  name = el("input"),
  type = el("select"),
  description = el("textarea");
name.required = true;
name.maxLength = 160;
name.id = "reference-preset-name";
description.rows = 3;
description.maxLength = 20000;
description.id = "reference-preset-description";
type.id = "reference-preset-category";
for (const [value, label] of Object.entries(categories)) {
  const option = el("option", "", label);
  option.value = value;
  type.append(option);
}
function field(label, input) {
  const wrapper = el("label", "preset-field", label);
  wrapper.append(input);
  return wrapper;
}
const actions = el("div", "preset-editor-actions"),
  cancel = el("button", "btn", "取消"),
  submit = el("button", "btn primary", "保存预设"),
  editStatus = el("p", "preset-library-status");
cancel.type = "button";
cancel.onclick = () => editor.close();
submit.type = "submit";
actions.append(cancel, submit);
editStatus.setAttribute("role", "status");
form.append(
  editTitle,
  explanation,
  field("名称", name),
  field("类别", type),
  field("描述与调用说明", description),
  editStatus,
  actions,
);
editor.append(form);
document.body.append(editor);
let revision = 0,
  searchTimer,
  editing = null,
  selection = null;
function setStatus(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}
function defaultCategory(item) {
  const role =
    item.kind === "text"
      ? { char: "character", extra: "general" }[item.role] || item.role
      : item.reference_role;
  return Object.hasOwn(categories, role) ? role : "general";
}
async function refresh() {
  const token = ++revision;
  setStatus("正在读取本地预设…");
  try {
    const params = new URLSearchParams();
    if (search.value.trim()) params.set("q", search.value.trim());
    if (category.value) params.set("category", category.value);
    const result = await api("?" + params);
    if (token !== revision) return;
    grid.replaceChildren();
    for (const entry of result.presets) {
      const card = el("article", "reference-preset-card");
      card.dataset.presetId = entry.id;
      const preview = el("div", "preset-preview");
      if (entry.preview_url) {
        const media = el(entry.preview_kind === "video" ? "video" : "img");
        media.src = entry.preview_url;
        if (media.tagName === "VIDEO") {
          media.preload = "metadata";
          media.muted = true;
        } else {
          media.alt = entry.name;
          media.loading = "lazy";
        }
        preview.append(media);
      } else preview.append(el("span", "preset-text-mark", "Aa"));
      const body = el("div", "preset-card-body");
      body.append(
        el("span", "preset-category", categories[entry.category]),
        el("h3", "", entry.name),
        el(
          "p",
          "preset-card-description",
          entry.description || "已保存的画板参考",
        ),
        el(
          "small",
          "",
          `${entry.item_count} 张卡片 · ${entry.connection_count} 条连线 · ${entry.media_count} 份素材`,
        ),
      );
      const buttons = el("div", "preset-card-actions"),
        use = el("button", "btn primary", "加入画板"),
        rename = el("button", "btn", "编辑"),
        download = el("a", "text-btn", "导出包"),
        remove = el("button", "text-btn", "删除");
      use.type = rename.type = remove.type = "button";
      download.href =
        "/api/asset-presets/" + encodeURIComponent(entry.id) + "/package";
      download.download = "";
      use.onclick = async () => {
        use.disabled = true;
        try {
          const payload = await api("/" + entry.id + "/instantiate", {
            method: "POST",
          });
          await window.LumenBoard.addReferencePreset(payload);
          library.close();
        } catch (error) {
          setStatus(error.message, true);
        } finally {
          use.disabled = false;
        }
      };
      rename.onclick = () => openEditor(entry);
      remove.onclick = async () => {
        if (
          !window.confirm(
            `从预设库删除「${entry.name}」？画板和已导入的素材会保留。`,
          )
        )
          return;
        try {
          await api("/" + entry.id, { method: "DELETE" });
          await refresh();
        } catch (error) {
          setStatus(error.message, true);
        }
      };
      buttons.append(use, rename, download, remove);
      body.append(buttons);
      card.append(preview, body);
      grid.append(card);
    }
    if (!result.presets.length) {
      const empty = el("div", "preset-library-empty");
      empty.append(
        el("h3", "", "从一个常用角色或场景开始"),
        el(
          "p",
          "",
          search.value || category.value
            ? "没有符合筛选的预设，请换个关键词。"
            : "在画板选中相关文字、图片和视频，再点“保存为参考预设”。例如：蓝色大飞鱼、教室、推进镜头。",
        ),
      );
      grid.append(empty);
    }
    setStatus(
      `${result.presets.length} 个预设 · 预设包会携带素材副本，不依赖原文件一直留在输入目录。`,
    );
  } catch (error) {
    if (token === revision) setStatus(error.message, true);
  }
}
function openEditor(entry = null) {
  editing = entry;
  selection = null;
  editStatus.textContent = "";
  if (entry) {
    editTitle.textContent = "编辑参考预设";
    name.value = entry.name;
    type.value = entry.category;
    description.value = entry.description;
    explanation.textContent =
      "修改名称、类别与描述，不改变已保存的卡片和素材。";
  } else {
    try {
      selection = window.LumenBoard.getSelectedReferences();
    } catch (error) {
      setStatus(error.message, true);
      if (!library.open) library.showModal();
      return;
    }
    editTitle.textContent = "保存选中素材";
    name.value = selection.items.every(
      (item) => item.preset_name === selection.items[0].preset_name,
    )
      ? selection.items[0].preset_name || ""
      : "";
    type.value = defaultCategory(selection.items[0]);
    description.value = "";
    explanation.textContent = `${selection.items.length} 张卡片 · ${selection.connections.length} 条内部连线。原卡片与生成配置保留，预设库另存媒体副本。`;
  }
  editor.showModal();
  name.focus();
}
form.onsubmit = async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  submit.disabled = true;
  editStatus.textContent = "正在收集本地素材并保存…";
  try {
    const values = {
      name: name.value.trim(),
      category: type.value,
      description: description.value,
    };
    if (editing)
      await api("/" + editing.id, { ...post(values), method: "PATCH" });
    else await api("", post({ ...selection, ...values }));
    editor.close();
    if (!library.open) library.showModal();
    await refresh();
    setStatus(
      editing ? "预设信息已更新" : "预设已保存。下次可直接从这里加入画板。",
    );
  } catch (error) {
    editStatus.textContent = error.message;
    editStatus.dataset.error = "true";
  } finally {
    submit.disabled = false;
  }
};
search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 180);
});
category.onchange = refresh;
saveButton.onclick = () => openEditor();
importButton.onclick = () => {
  const input = el("input");
  input.type = "file";
  input.accept = ".zip";
  input.onchange = async () => {
    if (!input.files[0]) return;
    importButton.disabled = true;
    setStatus("正在检查预设包并收集素材…");
    try {
      const body = new FormData();
      body.append("file", input.files[0]);
      const result = await api("/import", { method: "POST", body });
      search.value = "";
      category.value = "";
      await refresh();
      setStatus(`已导入「${result.preset.name}」，可加入画板。`);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      importButton.disabled = false;
    }
  };
  input.click();
};
function openLibrary() {
  if (!library.open) library.showModal();
  refresh();
  search.focus();
}
window.LumenPresetLibrary = {
  open: openLibrary,
  saveSelection: () => openEditor(),
};
document
  .getElementById("open-reference-presets")
  ?.addEventListener("click", openLibrary);
document
  .getElementById("save-reference-preset")
  ?.addEventListener("click", () => openEditor());
