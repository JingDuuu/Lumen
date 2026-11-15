# 在 Agent 聊天里调用 Lumen

打开 Lumen 的「连接 Agent」，复制启动提示词到新聊天。应用会把当前安装目录填入提示词。只有具备本机工具权限或本机 MCP 连接的聊天宿主能执行；纯云端聊天需要先配置连接。

## 在公司或另一台电脑使用

1. 在目标电脑下载并解压这个仓库，按 [独立安装指南](../PORTABLE_INSTALL.md) 运行 `Setup-Lumen.cmd`。仓库包含程序和接入功能；H3 权重需在目标电脑主动下载，或在 `lumen.local.json` 指向该电脑已有的 ComfyUI 和模型。
2. 打开目标电脑上的 Lumen，完成「模型与安装」检查，再点「连接 Agent」。从这里复制**这台电脑生成的提示词和 MCP 配置**。
3. 将提示词发给目标电脑上能使用本机工具的 Agent。使用 MCP 时，将配置合并到该电脑聊天宿主的 MCP 设置，保留已有服务，再重新连接。

每台电脑的安装目录、Python 和输出位置可能不同。不要直接复用旧电脑聊天中的 `C:\ComfyUI\...` 路径、旧的 `lumen.local.json` 或已渲染的启动提示词。独立安装默认把素材和成片放在安装目录下的 `data/input`、`data/output`，由应用提供的实际路径为准。`http://127.0.0.1:8088` 指当前电脑，不会连接另一台电脑上的 Lumen。

程序更新不会自动同步角色、场景和生成视频。需要带走可复用角色/场景时，在素材库导出预设包，再在新电脑导入；需要完整迁移时，备份并迁移已配置的数据、输入和输出目录，随后重新检查本机路径。模型权重可以单独保留。

## 终端接入

这些命令由 Agent 执行即可。使用实际安装目录中的完整 `lumen.bat` 路径，PowerShell 调用前加 `&`。

```powershell
& '安装目录\lumen.bat' doctor --json
& '安装目录\lumen.bat' ensure --timeout 180 --json
& '安装目录\lumen.bat' discover --json
& '安装目录\lumen.bat' chat --prompt '海边灯塔，镜头缓慢推进。只有海浪和风声。' --request-id 'lighthouse-shot-001' --wait --timeout 600 --json
```

`doctor` 只读检查路径、权重文件尺寸和连接，不会启动或下载模型。尺寸匹配不代表重读了全部 SHA-256。
`ensure` 复用已有 Lumen；未运行时打开正常桌面入口，等待引擎和任务进度连接。它不会开第二套常驻服务，也不会终止其他端口的进程。
`chat` 先等待服务就绪，再用稳定请求 ID 提交。默认的新镜头使用服务端当前默认参数；指定预设用一个或多个 `--preset-id`。输出自动进入本机文件夹和 Lumen 素材库。

默认新镜头不会改当前看板。要生成当前看板，先读取版本：

```powershell
& '安装目录\lumen.bat' board get --json
& '安装目录\lumen.bat' chat --current-board --expected-revision '读取到的revision' --request-id 'board-shot-001' --wait --json
```

自定义完整请求放入 UTF-8 JSON 文件并使用 `chat --input 文件路径 --wait --json`。请求使用 `prompt`、`board` 或 `use_current_board:true` 三者之一，结构以当前 `discover` / `schema` 为准。保留服务端支持的媒体上传、角色和声音字段，不把角色来源说明当成镜头内容。

## 结果返回聊天

成功的 CLI JSON 的 `result` 是服务端结果：`ready:true`、`files`、`record_id` 等。每个文件提供 `local_path`、`url`、`download_url`、类型和尺寸。

- 有本地视频展示/附件能力的宿主：直接展示或附上 `local_path` 指向的原文件。
- 只能显示 Markdown 的宿主：给出完整本地路径链接；回环 HTTP 链接也只能由本机访问。
- 云端宿主无法读取本地文件时：明确告知当前连接限制，不能假装已上传或内嵌了视频。Lumen 不会为了返回聊天自动向外传视频。

等待超时会返回 `WAIT_TIMEOUT`、`record_id` 和 `cancelled:false`，继续查询原任务：

```powershell
& '安装目录\lumen.bat' job wait 'record_id' --timeout 60 --json
& '安装目录\lumen.bat' job result 'record_id' --json
```

`ready:false` 不是生成成功；它可能仍在运行，也可能已失败或输出文件被移走。生成请求响应不明时，沿用原 `request_id` 核对，不能随意生成新 ID 重复提交。

## MCP 接入

「连接 Agent」提供当前安装的 MCP stdio 配置。把它加入聊天宿主的 MCP 服务配置后重启该宿主，并通过能力发现调用 Lumen 工具。配置示例只负责连接，不会自动开始生成。支持 MCP 的宿主使用同一组本地 API、任务 ID 和文件结果。

仓库中的 [完整 JSON 模板](../examples/agent/mcp-local.json) 和 [单个服务模板](../examples/agent/mcp-server-entry.json) 使用显式占位符，不能原样运行：`<LUMEN_INSTALL_DIR>` 是目标电脑的 Lumen 安装目录，`<LUMEN_PYTHON_EXE>` 是该安装的 Python 绝对路径。普通独立安装通常使用安装目录下的 `.venv/Scripts/python.exe`；已有引擎的配置以应用「连接 Agent」实际返回的值为准。接受 `mcpServers` JSON 的宿主可合并完整配置；其他宿主按自身配置格式填写相同的 `command`、`args` 和 `cwd`。应用生成的配置比手工替换模板更直接。

原有 `generate` 命令继续兼容；新聊天工作流优先使用 `chat` 和 `job`，便于防止重复提交并返回经验证的实际文件。关闭 Lumen 桌面窗口会关闭它拥有的引擎；退出 CLI 等待不会取消任务。
