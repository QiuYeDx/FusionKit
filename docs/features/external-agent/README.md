# 外部 Agent 接入（MCP）

让 Claude Code、Codex、Cursor 等外部 AI Agent 通过 MCP 连接正在运行的 FusionKit，读取状态并操作字幕工作台。翻译由外部 Agent 自己完成并写回，用户无需在 FusionKit 中配置 API Key。

- 业务范围与路线图：[brd.md](brd.md)
- 主进程桥接（端点、鉴权、会话、转发、端点文件、stdio 桥）：[modules/module-bridge](modules/module-bridge/)
- 工具面（工具、信任档位、应用内确认、Studio 新增写入能力）：[modules/module-tools](modules/module-tools/)
- 设置与接入体验（设置页、配置片段、Skill、文档）：[modules/module-settings](modules/module-settings/)
- 批次与批准：[spec.json](spec.json)；实施记录：[records/](records/)

## 怎样接入

1. FusionKit **设置 → 外部 Agent**，打开「允许外部 Agent 连接」（默认关闭；只监听 `127.0.0.1`，默认端口 47361，需要令牌）。
2. 选择客户端，按页面上的步骤操作（终端版与桌面版都覆盖；依据见 [changes/2026-10-13-desktop-clients.md](changes/2026-10-13-desktop-clients.md)）：

| 客户端 | 配置在哪里 | 推荐做法 | 生效 |
| --- | --- | --- | --- |
| Claude Code 终端版 | `~/.claude.json`（user 范围） | 运行页面给出的 `claude mcp add --scope user …`（HTTP） | 新会话中 `/mcp` 可见 |
| Claude Code 桌面版（Claude 应用的 Code 标签） | 与终端共用 `~/.claude.json`；本地会话也读取 `claude_desktop_config.json` | 装了终端版就运行上面的命令；没装就用「Claude 桌面端」的「写入配置文件」 | 新开本地会话（云端会话访问不到本机） |
| Claude 桌面端（聊天） | `claude_desktop_config.json`（Windows `%APPDATA%\Claude\`，macOS `~/Library/Application Support/Claude/`；Claude 中 设置 → 开发者 → 编辑配置） | 「写入配置文件」（stdio；自定义连接器从云端连接，访问不到本机） | 完全退出 Claude 再打开 |
| Codex 终端版 / 桌面版 / IDE 扩展 | 共用 `~/.codex/config.toml` | 「写入配置文件」（HTTP，令牌写在 `http_headers`）；桌面版「添加服务器」表单不能填请求头与环境变量 | 桌面版 设置 → MCP 服务器 → 重启；终端重启 codex |
| Cursor 桌面版 | 全局 `~/.cursor/mcp.json`；项目 `.cursor/mcp.json` | 「添加到 Cursor」（Cursor 官方安装链接，弹出安装确认）；或「写入配置文件」、复制 JSON | 在侧边栏「Customize」（旧版 设置 → MCP）中确认已启用，未出现时重启 Cursor |
| 其他客户端 | 各自的 MCP 配置 | 复制 JSON，或按页面逐项填写地址、请求头 / 命令、参数、环境变量 | 依客户端 |

「写入配置文件」只改 `fusionkit` 一项，原文件另存为 `<文件>.fusionkit-backup`；文件无法解析时不做任何修改。`~/.claude.json` 由 Claude Code 持续读写，FusionKit 不自动修改它。

3. 两种连接方式：**HTTP**（`http://127.0.0.1:47361/mcp`，请求头 `Authorization: Bearer <令牌>`）；**stdio**（FusionKit 可执行文件以 `ELECTRON_RUN_AS_NODE=1` 运行随附的 `fusionkit-mcp-stdio.cjs`，FusionKit 未运行时会自动启动它）。
4. 可选：一键安装随附 Skill：Claude Code 装到 `~/.claude/skills/fusionkit-app/`；Codex、Cursor 等其他 Agent 共用的通用目录为 `~/.agents/skills/fusionkit-app/`。源文件在 `.agents/skills/fusionkit-app/SKILL.md`。

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
| split_studio_cue / insert_studio_cue | 写入（“修改字幕结构”，单独放行） | 拆分一条字幕、在某条前后插入字幕（I2 of studio-cue-split-insert，一次可撤销） |
| export_studio_document | 写入（overwrite 为破坏性） | 导出到源文件夹或由用户选择位置 |
| start_studio_transcription | 写入 | 用本地模型转写音视频 |
| prepare_knowledge_changes | 总是确认 | 新建 / 修改翻译资料 |
| convert_subtitle_files / extract_subtitle_language | 写入（overwrite 为破坏性） | 按路径转换字幕格式、提取双语字幕中的一种语言（I4） |
| get_classic_tasks | 读取 | 经典工具页中的任务进度（I4） |
| inspect_name_paths | 读取 | 列出要改名的文件 / 文件夹及身份标识（I4） |
| rename_paths / undo_name_changes | 总是确认 | 按外部 Agent 给出的名称重命名（先核对，由深到浅、失败回滚）与撤销（I4） |

## 安全边界

- 只绑定 IPv4 回环；令牌定长比较；拒绝任何带 `Origin` 的请求与非回环 Host（防浏览器与 DNS rebinding）；请求体上限 4 MiB；最多 8 个会话，闲置 2 小时结束。
- 只读档在主进程直接拒绝修改；确认档的修改在 FusionKit 中弹窗确认（可本次连接放行同类）；自动档的修改直接执行，覆盖文件与翻译资料变更仍需确认。
- 工具结果不含 API Key 与模型地址；错误信息脱敏。外部 Agent 写入的译文只能写在它自己新建的轨道上。

## 最终验收清单（用户）

自动化测试已覆盖协议、鉴权、工具、确认对话框、设置页与 stdio 桥（使用 MCP 官方 SDK 客户端与真实 Electron 应用）。以下需要在你的环境用真实客户端确认：

1. 设置页打开开关，复制 Claude Code 的 HTTP 命令运行，在 Claude Code 中 `/mcp` 可见 fusionkit 已连接；FusionKit 标题栏出现绿点。
2. 让 Claude Code「把字幕工作台里的某个日语字幕翻译成中文并导出双语 SRT」：首次写入时 FusionKit 弹出确认，勾选本次连接放行后后续写入不再询问；工作台出现以客户端命名的译文轨道，导出文件在原字幕旁。
3. 对 Codex 重复一次：桌面版点「写入配置文件」后在 设置 → MCP 服务器 中重启，确认 fusionkit 出现且可用（如你的版本不认 HTTP 的 `http_headers`，切到 stdio 再写入一次）。
3b. Cursor：「Cursor」标签点「添加到 Cursor」，在 Cursor 中确认安装后能看到 FusionKit 的工具。
3a. Claude 桌面端（聊天）：「Claude 桌面端」标签点「写入配置文件」，完全退出再打开 Claude，在对话中确认能看到 FusionKit 的工具；Claude 应用的 Code 标签新开本地会话同样可用。
4. 关闭 FusionKit 后用 stdio 配置的客户端发起请求，确认 FusionKit 被自动启动并完成调用。
5. 在 macOS 上确认 stdio 片段中的可执行文件路径可用（自动化测试只在 Windows 上运行）。
6. （I4）让外部 Agent「把某个文件夹里的 ASS 都转成 SRT」「把这个双语字幕只留中文」：FusionKit 弹出确认，新文件出现在原文件旁。
7. （I4）让外部 Agent「把这个文件夹里的日文文件名翻译成中文」：它先检查条目、给出译名，FusionKit 列出“旧名 → 新名”确认后改名；再让它撤销，名称恢复。
