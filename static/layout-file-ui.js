/* Local scene library and real interchange. No remote assets or runtime packages. */
const node = (tag, className = "", text = "") =>
  Object.assign(document.createElement(tag), { className, textContent: text });
async function request(path, options = {}) {
  const response = await fetch("/api/previs" + path, options);
  const value = await response.json();
  if (!response.ok || value.ok === false)
    throw Error(value.error || "本地文件操作失败");
  return value;
}
const jsonOptions = (value) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
export function mountFileUI(container, handlers) {
  let activeDocument = null,
    activeJob = null,
    disposed = false,
    category = "recent",
    busy = false;
  const dialog = node("dialog", "previs-file-dialog");
  const heading = node("div", "previs-file-heading"),
    title = node("h2", "", "场景文件与格式互通"),
    close = node("button", "btn", "关闭");
  close.type = "button";
  close.onclick = () => dialog.close();
  heading.append(title, close);
  const name = node("input");
  name.placeholder = "场景名称";
  name.maxLength = 160;
  name.setAttribute("aria-label", "场景名称");
  const actions = node("div", "previs-file-actions"),
    tabs = node("div", "previs-file-actions"),
    list = node("div", "previs-file-list");
  const status = node(
    "p",
    "previs-file-progress",
    "场景、模板和预制体保存在此电脑；资产会一同收集。",
  );
  status.setAttribute("role", "status");
  const cancel = node("button", "btn", "取消导出 / 转换");
  cancel.hidden = true;
  cancel.onclick = () => {
    if (activeJob)
      request("/jobs/" + activeJob + "/cancel", { method: "POST" }).catch(
        report,
      );
    else if (busy) {
      handlers.cancelExport?.();
      info("正在取消烘焙…");
    }
  };
  const transfer = node("div", "previs-file-actions");
  const exportFormat = node("select");
  exportFormat.setAttribute("aria-label", "导出格式");
  for (const value of ["glb", "gltf", "obj", "fbx", "abc"]) {
    const option = node(
      "option",
      "",
      value === "abc" ? "Alembic (.abc)" : value.toUpperCase(),
    );
    option.value = value;
    exportFormat.append(option);
  }
  const includeAnimation = node("input");
  includeAnimation.type = "checkbox";
  includeAnimation.checked = true;
  includeAnimation.setAttribute("aria-label", "包含动画");
  const animationLabel = node("label", "previs-export-option");
  animationLabel.append(includeAnimation, document.createTextNode("包含动画"));
  const exportFps = node("input");
  exportFps.type = "number";
  exportFps.min = "1";
  exportFps.max = "60";
  exportFps.step = "1";
  exportFps.value = "24";
  exportFps.setAttribute("aria-label", "导出帧率");
  const fpsLabel = node("label", "previs-export-option", "FPS");
  fpsLabel.append(exportFps);
  const limitations = node(
    "p",
    "field-help",
    "GLB/glTF 尽量保留层级、PBR 材质与动画；OBJ 为静态网格；FBX 会烘焙；Alembic 为几何缓存，格式差异会在转换结果中说明。",
  );
  dialog.append(
    heading,
    name,
    actions,
    tabs,
    list,
    transfer,
    limitations,
    status,
    cancel,
  );
  document.body.append(dialog);
  function report(error) {
    status.textContent = error.message || String(error);
    status.dataset.error = "true";
  }
  function info(text) {
    status.textContent = text;
    delete status.dataset.error;
  }
  function action(label, run, parent = actions) {
    const button = node("button", "btn", label);
    button.type = "button";
    button.onclick = () => Promise.resolve().then(run).catch(report);
    parent.append(button);
    return button;
  }
  function currentScene() {
    const scene = handlers.getScene();
    if (!scene || scene.version !== 3) throw Error("编辑器场景尚未就绪");
    return structuredClone(scene);
  }
  async function refresh() {
    const value = await request(
      category === "recent" ? "/recent" : "/documents?kind=" + category,
    );
    list.replaceChildren();
    if (!value.documents.length)
      list.append(node("p", "muted", "这里还没有保存的文件。"));
    for (const entry of value.documents) {
      const row = node("div", "previs-file-row"),
        text = node("div");
      text.append(
        node("strong", "", entry.name),
        node(
          "small",
          "",
          `${entry.kind === "prefab" ? "预制体" : entry.kind === "template" ? "模板" : "场景"} · ${entry.object_count} 个对象 · ${new Date(entry.updated_at * 1000).toLocaleString()}`,
        ),
      );
      row.append(text);
      action(
        entry.kind === "prefab" ? "加入场景" : "打开",
        async () => {
          const { document: documentData } = await request(
              "/documents/" + entry.id,
            ),
            scene = documentData.resolved_scene || documentData.scene;
          if (entry.kind === "prefab") {
            if (!handlers.addPrefab) throw Error("编辑器未提供预制体插入接口");
            await handlers.addPrefab(scene);
            info("预制体已加入当前场景");
          } else {
            await handlers.loadScene(scene);
            activeDocument = entry.kind === "scene" ? documentData : null;
            name.value = entry.name;
            info("已打开 " + entry.name);
            dialog.close();
          }
        },
        row,
      );
      const download = node("a", "btn", "场景包");
      download.href = "/api/previs/documents/" + entry.id + "/package";
      download.download = "";
      row.append(download);
      list.append(row);
    }
  }
  async function save(kind = "scene", asNew = false) {
    let scene = currentScene();
    if (kind === "prefab") {
      if (handlers.createPrefab) scene = await handlers.createPrefab();
      else {
        const selection = new Set(
          (handlers.getSelection?.() || []).map((value) =>
            typeof value === "string" ? value : value.id,
          ),
        );
        if (!selection.size) throw Error("先在场景中选择要保存的对象或层级");
        let added = true;
        while (added) {
          added = false;
          for (const object of scene.objects)
            if (selection.has(object.parentId) && !selection.has(object.id)) {
              selection.add(object.id);
              added = true;
            }
        }
        scene.objects = scene.objects
          .filter((object) => selection.has(object.id))
          .map((object) => ({
            ...object,
            parentId: selection.has(object.parentId) ? object.parentId : null,
          }));
        if (scene.sequence?.tracks)
          scene.sequence.tracks = scene.sequence.tracks.filter((track) =>
            selection.has(track.targetId || track.objectId || track.target),
          );
      }
    }
    const title = name.value.trim() || "未命名场景";
    const payload = { kind, name: title, scene };
    if (!asNew && kind === "scene" && activeDocument?.kind === "scene")
      payload.id = activeDocument.id;
    const result = await request("/documents", jsonOptions(payload));
    if (kind === "scene") activeDocument = result.document;
    name.value = title;
    info("已保存 " + title + "，资产依赖已收集");
    await refresh();
    return result.document;
  }
  action("保存", () => save());
  action("另存为", () => save("scene", true));
  action("保存为模板", () => save("template", true));
  action("选中层级存为预制体", () => save("prefab", true));
  for (const [value, label] of [
    ["recent", "最近"],
    ["scene", "场景"],
    ["template", "模板"],
    ["prefab", "预制体"],
  ])
    action(
      label,
      async () => {
        category = value;
        await refresh();
      },
      tabs,
    );
  async function conversion(endpoint, file, format, fps = 24) {
    if (activeJob) throw Error("已有格式转换在进行，可等待完成或取消");
    const body = new FormData();
    body.append("file", file, file.name || "scene.glb");
    if (format) body.append("format", format);
    body.append("fps", String(fps));
    info("正在提交本地转换…");
    const accepted = await request(endpoint, { method: "POST", body });
    activeJob = accepted.job.id;
    cancel.hidden = false;
    try {
      let job = accepted.job;
      while (!disposed && ["queued", "running"].includes(job.status)) {
        const progress = job.progress?.total
          ? ` ${job.progress.step}/${job.progress.total}`
          : "";
        info(
          job.stage_label +
            progress +
            " · 已等待 " +
            Math.round(job.elapsed_seconds || 0) +
            " 秒",
        );
        await new Promise((resolve) => setTimeout(resolve, 350));
        job = (await request("/jobs/" + activeJob)).job;
      }
      if (disposed) return;
      if (job.status !== "done") throw Error(job.error || "转换已取消");
      const result = job.result;
      info(
        "转换完成" + (job.warnings.length ? "：" + job.warnings.join(" ") : ""),
      );
      return result;
    } finally {
      activeJob = null;
      cancel.hidden = true;
    }
  }
  function choose(accept, run) {
    const input = node("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () =>
      input.files[0] && Promise.resolve(run(input.files[0])).catch(report);
    input.click();
  }
  const importButton = action(
    "导入模型",
    () =>
      choose(".glb,.gltf,.obj,.fbx,.abc,.zip", async (file) => {
        if (busy) throw Error("已有导出或转换在进行，请等待或取消");
        setBusy(true);
        try {
          const result = await conversion("/import", file);
          if (result)
            await handlers.onImportAsset({
              ...result,
              name: file.name,
              sourceFormat: result.sourceFormat,
            });
        } finally {
          setBusy(false);
        }
      }),
    transfer,
  );
  transfer.append(exportFormat, animationLabel, fpsLabel);
  const exportButton = action(
    "导出当前场景",
    async () => {
      if (busy) throw Error("已有导出或转换在进行，请等待或取消");
      if (!handlers.exportGLB) throw Error("编辑器尚未提供 GLB 导出");
      if (!exportFps.reportValidity()) return;
      const fps = Number(exportFps.value),
        scene = currentScene();
      if (
        includeAnimation.checked &&
        Math.ceil(
          Number(scene.sequence?.duration ?? scene.duration ?? 0) * fps,
        ) > 3600
      )
        throw Error(
          "动画最多导出3600帧，请降低帧率、缩短片段，或取消“包含动画”导出静帧模型",
        );
      setBusy(true);
      cancel.hidden = false;
      try {
        info("正在烘焙场景和动画…");
        const payload = await handlers.exportGLB({
          fps,
          includeAnimation: includeAnimation.checked,
          onProgress: (progress) => {
            if (typeof progress === "string") info(progress);
            else if (typeof progress === "number")
              info("正在烘焙 " + Math.round(progress) + "%");
            else
              info(
                (progress.stage || progress.message || "正在烘焙") +
                  (progress.totalFrames
                    ? ` · ${progress.frame}/${progress.totalFrames} 帧`
                    : "") +
                  (Number.isFinite(progress.progress)
                    ? ` · ${Math.round(progress.progress)}%`
                    : ""),
              );
          },
        });
        const blob =
          payload instanceof Blob
            ? payload
            : new Blob([payload.blob || payload], {
                type: "model/gltf-binary",
              });
        const result = await conversion(
          "/export",
          new File([blob], "scene.glb", { type: "model/gltf-binary" }),
          exportFormat.value,
          fps,
        );
        if (result) {
          const link = node("a");
          link.href = result.download_url + "?download=1";
          link.download = "";
          link.click();
        }
      } finally {
        setBusy(false);
        cancel.hidden = true;
      }
    },
    transfer,
  );
  function setBusy(value) {
    busy = value;
    for (const control of [
      importButton,
      exportButton,
      exportFormat,
      includeAnimation,
      exportFps,
    ])
      control.disabled = value;
  }
  action(
    "打开场景包",
    () =>
      choose(".zip", async (file) => {
        const body = new FormData();
        body.append("file", file);
        const value = await request("/documents/import", {
          method: "POST",
          body,
        });
        await handlers.loadScene(
          value.document.resolved_scene || value.document.scene,
        );
        activeDocument = value.document;
        name.value = activeDocument.name;
        info("场景包与依赖已导入本地库");
        await refresh();
      }),
    transfer,
  );
  const launch = action(
    "文件 / 模板",
    async () => {
      if (!busy) {
        const scene = handlers.getScene?.();
        exportFps.value = String(scene?.sequence?.fps || scene?.fps || 24);
      }
      if (!dialog.open) dialog.showModal();
      await refresh();
    },
    container,
  );
  return {
    open: () => launch.click(),
    save: () => save(),
    getActiveDocument: () => activeDocument,
    dispose() {
      disposed = true;
      dialog.remove();
      launch.remove();
    },
  };
}
