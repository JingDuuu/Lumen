/* Copy the installation's real local-agent contract; do not infer client presence. */
(() => {
  const make = (tag, cls = "", text = "") => Object.assign(document.createElement(tag), {className: cls, textContent: text});
  const action = (text, run, cls = "btn") => {
    const el = make("button", cls, text); el.type = "button"; el.onclick = run; return el;
  };
  const open = document.querySelector("#agent-connect-open"), dialog = make("dialog", "agent-connect-dialog");
  dialog.id = "agent-connect-dialog";
  dialog.setAttribute("aria-labelledby", "agent-connect-title");
  document.body.append(dialog);
  let loading = false;
  function header() {
    const row = make("div", "agent-connect-heading"), title = make("h2", "", "连接你的 Agent");
    title.id = "agent-connect-title";
    const close = action("×", () => dialog.close(), "agent-connect-close");
    close.setAttribute("aria-label", "关闭 Agent 连接");
    row.append(title, close); return row;
  }
  async function copy(input, button) {
    try {
      await navigator.clipboard.writeText(input.value);
      window.LumenBoard.toast(input.id === "agent-mcp-config" ? "已复制，请合并到 Agent 的 MCP 设置" : "已复制，可粘贴到 Agent 聊天框");
      button.textContent = "已复制";
    } catch {
      input.focus(); input.select();
      window.LumenBoard.toast("内容已选中，按 Ctrl+C 复制");
    }
  }
  function textPanel(label, value, id, copyLabel) {
    const panel = make("section", "agent-copy-panel"), input = make("textarea"), button = action(copyLabel, () => copy(input, button), "btn primary");
    input.id = id; input.value = value; input.readOnly = true; input.spellcheck = false; input.setAttribute("aria-label", label);
    const row = make("div", "agent-copy-heading"); row.append(make("h3", "", label), button);
    panel.append(row, input); return panel;
  }
  async function show() {
    if (loading) return;
    loading = true;
    if (!dialog.open) dialog.showModal();
    dialog.replaceChildren(header(), make("p", "agent-muted", "正在读取这台电脑的连接信息…"));
    try {
      const response = await fetch("/api/agent/bootstrap", {cache: "no-store"});
      if (!response.ok) throw Error("暂时无法读取 Agent 接入信息（" + response.status + "）");
      const data = await response.json();
      if (typeof data.prompt !== "string" || !data.prompt.trim() || !data.mcp_config || typeof data.mcp_config !== "object")
        throw Error("接入信息不完整，请重新打开 Lumen 后再试");
      const status = make("div", "agent-connection-status"), connection = data.connection || {};
      for (const [label, ready] of [["本机接口", connection.service === "ready"], ["H3 引擎", connection.engine_ready === true], ["模型文件", connection.models_ready === true]]) {
        const entry = make("span", ready ? "is-ready" : "is-pending", label + (ready ? " · 就绪" : " · 待就绪")); status.append(entry);
      }
      const intro = make("p", "agent-connect-intro", "复制下面的提示词，发给能使用本机工具的 Agent。以后直接在聊天里描述镜头，生成的片子会同时回到 Lumen。");
      const endpoint = make("p", "agent-endpoint", "本机地址 "); endpoint.append(make("code", "", data.api_url || location.origin));
      const prompt = textPanel("通用启动提示词", data.prompt, "agent-bootstrap-prompt", "复制提示词");
      const mcp = make("details", "agent-config-details"); mcp.append(make("summary", "", "为支持 MCP 的 Agent 配置连接"));
      mcp.append(make("p", "agent-muted", "在 Agent 的 MCP 设置中合并这段配置，然后重新连接。已有配置请保留。"), textPanel("本机 MCP 配置", JSON.stringify(data.mcp_config, null, 2), "agent-mcp-config", "复制配置"));
      const folder = make("p", "agent-output-folder", "成片保存位置 "); folder.append(make("code", "", data.output_directory || "由本机运行配置决定"));
      const boundary = make("p", "agent-connection-boundary", data.boundary || "Agent 需要本机工具或本机 MCP 连接。纯云端聊天框无法仅靠提示词访问这台电脑。此面板表示接入入口就绪，不代表某个 Agent 已连接。");
      dialog.replaceChildren(header(), intro, status, endpoint, prompt, mcp, folder, boundary);
    } catch (error) {
      dialog.replaceChildren(header(), make("p", "agent-connect-error", error.message), action("重新读取", show));
    } finally { loading = false; }
  }
  open.addEventListener("click", show);
})();
