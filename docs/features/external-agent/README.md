# 外部 Agent 接入（MCP）

让 Claude Code、Codex、Cursor 等外部 AI Agent 通过 MCP 连接正在运行的 FusionKit，读取状态并操作字幕工作台。翻译由外部 Agent 自己完成并写回，用户无需在 FusionKit 中配置 API Key。

- 业务范围与路线图：[brd.md](brd.md)
- 主进程桥接（端点、鉴权、会话、转发、端点文件、stdio 桥）：[modules/module-bridge](modules/module-bridge/)
- 工具面（工具、信任档位、应用内确认、Studio 新增写入能力）：[modules/module-tools](modules/module-tools/)
- 设置与接入体验（设置页、配置片段、Skill、文档）：[modules/module-settings](modules/module-settings/)
- 批次与批准：[spec.json](spec.json)；实施记录：[records/](records/)

## 怎样接入

1. FusionKit **设置 → 外部 Agent**，打开「允许外部 Agent 连接」（默认关闭；只监听 `127.0.0.1`，默认端口 47361，需要令牌）。
2. 选客户端与方式，复制配置：
   - **HTTP**（推荐）：Claude Code 运行页面给出的 `claude mcp add --scope user --transport http fusionkit http://127.0.0.1:47361/mcp --header "Authorization: Bearer <令牌>"`；Codex 追加 `[mcp_servers.fusionkit]` 到 `~/.codex/config.toml`；Cursor 合并到 `~/.cursor/mcp.json`。
   - **stdio**：由 FusionKit 可执行文件以 `ELECTRON_RUN_AS_NODE=1` 运行随附的 `fusionkit-mcp-stdio.cjs`，FusionKit 未运行时会自动启动它。
3. 可选：一键安装随附 Skill（`~/.claude/skills/fusionkit-app/` 或 `~/.codex/skills/fusionkit-app/`），源文件在 `.agents/skills/fusionkit-app/SKILL.md`。

## 工具

| 工具 | 类别 | 作用 |
| --- | --- | --- |
| get_fusionkit_status | 读取 | 版本、当前页面、信任档位、模型是否配置（不含 Key）、工作台计数 |
| list_studio_documents | 读取 | 搜索工作台文档，返回 documentId 与 revision |
| read_studio_document | 读取 | 按页读取句子、时间、原文、轨道与译文 |
| get_studio_tasks | 读取 | 翻译 / 转写任务进度 |
| search_translation_knowledge / list_translation_knowledge_catalog | 读取 | 检索翻译资料与资料集 |
| get_confirmation_result | 读取 | 等待用户在 FusionKit 中的确认结果 |
| open_fusionkit_page | 界面 | 切换 FusionKit 页面 |
| import_studio_subtitles | 写入 | 按路径导入字幕 |
| create_studio_translation_track | 写入 | 新建由外部 Agent 填写的译文轨道 |
| write_studio_translations | 写入 | 批量写入译文（AI、未复核，一次可撤销） |
| export_studio_document | 写入（overwrite 为破坏性） | 导出到源文件夹或由用户选择位置 |
| start_studio_transcription | 写入 | 用本地模型转写音视频 |
| prepare_knowledge_changes | 总是确认 | 新建 / 修改翻译资料 |

## 安全边界

- 只绑定 IPv4 回环；令牌定长比较；拒绝任何带 `Origin` 的请求与非回环 Host（防浏览器与 DNS rebinding）；请求体上限 4 MiB；最多 8 个会话，闲置 2 小时结束。
- 只读档在主进程直接拒绝修改；确认档的修改在 FusionKit 中弹窗确认（可本次连接放行同类）；自动档的修改直接执行，覆盖文件与翻译资料变更仍需确认。
- 工具结果不含 API Key 与模型地址；错误信息脱敏。外部 Agent 写入的译文只能写在它自己新建的轨道上。

## 最终验收清单（用户）

自动化测试已覆盖协议、鉴权、工具、确认对话框、设置页与 stdio 桥（使用 MCP 官方 SDK 客户端与真实 Electron 应用）。以下需要在你的环境用真实客户端确认：

1. 设置页打开开关，复制 Claude Code 的 HTTP 命令运行，在 Claude Code 中 `/mcp` 可见 fusionkit 已连接；FusionKit 标题栏出现绿点。
2. 让 Claude Code「把字幕工作台里的某个日语字幕翻译成中文并导出双语 SRT」：首次写入时 FusionKit 弹出确认，勾选本次连接放行后后续写入不再询问；工作台出现以客户端命名的译文轨道，导出文件在原字幕旁。
3. 对 Codex 重复一次（`~/.codex/config.toml` 的 HTTP 片段；如你的 Codex 版本不支持 HTTP，改用 stdio 片段）。
4. 关闭 FusionKit 后用 stdio 配置的客户端发起请求，确认 FusionKit 被自动启动并完成调用。
5. 在 macOS 上确认 stdio 片段中的可执行文件路径可用（自动化测试只在 Windows 上运行）。
