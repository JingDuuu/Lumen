# 开发与验证

当前桌面运行环境是 Windows x64。Three.js 及控制器随源码固定版本分发，运行时不请求 CDN。生成引擎使用独立的 ComfyUI 进程，通过本机 HTTP/WebSocket 访问。

## 结构

| 文件 | 职责 |
|---|---|
| desktop.py / engine_runtime.py | 单实例窗口、进程生命周期与所属进程树 |
| runtime_config.py | 可移动配置与已有安装兼容 |
| app.py / tasks.py / lumen_core.py | HTTP、任务验证/进度、工作流与持久化 |
| reference_inputs.py | 媒体、角色、分区、关系到模型输入的编译 |
| asset_presets.py | 命名参考预设、媒体依赖与便携包 |
| agent_api.py / lumen.py | 机器接口、版本控制和 CLI |
| model_manager.py / models-manifest.json | 主动下载、固定版本和完整校验 |
| previs_store.py / format_bridge.py / blender_bridge.py | 三维文档与格式交换 |
| static/layout*.js | 三维编辑、骨架、表情、时间线及模型交换 |

## Python

完成基础安装后，在仓库根目录运行：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

测试使用临时数据目录，不应启动真实模型、提交视频任务或改写个人画板。桌面生命周期测试只启动小型哨兵进程；存在 Blender 时，格式测试可进行真实转换。

## 浏览器与三维

安装 Node.js 和开发依赖 `npm install`。浏览器测试使用系统 Microsoft Edge；可通过 `PLAYWRIGHT_MODULE_PATH` 指向已有 Playwright，通过 `LUMEN_PYTHON` 指定应用 Python。

```powershell
npm run test:scene
npm run test:ui
```

浏览器测试启动隔离的 Flask fixture，退出后清理临时目录。截图与检查结果进入被忽略的 `diagnostics/`。不要将真实用户画板截图作为公开附件。

## 发布

验证新功能、普通桌面启动/关闭、干净目录中的路径配置和依赖。仓库只提交源码、许可、通用示例与无个人内容的文档截图。不要提交 `data/`、`library/`、输入/输出、模型、日志或 `lumen.local.json`。

使用 `scripts/export_source.py --destination <新目录>` 从旧版安装导出白名单源码。脚本拒绝覆盖已有目录，并检查禁止的路径和大文件；发布前仍须审阅导出内容。
