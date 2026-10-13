# 变更：桌面版客户端的接入指引与一键写入配置

日期：2026-10-13

## 来源与分类

原始请求：2026-10-13 用户「其实有可能用的codex和Claude code不是CLI终端版，而是桌面端，也要能支持配置接入MCP，最好完善一下相关指引和接入所使用的信息」。

类型：behavior-change（扩展 R-SETTINGS-03 的客户端覆盖与接入方式）。

## 当前约定与实际差异

R-SETTINGS-03 只给出 Claude Code（终端命令）、Codex、Cursor、通用 JSON 的片段与一句放置说明，默认用户使用终端版。桌面版的实际情况（2026-10-13 查证，来源见下）：

- Claude Code 桌面端（Claude 应用的 Code 标签）与终端共用 `~/.claude.json`（user 范围）与 `.mcp.json`，本地 Code 会话还会加载 `claude_desktop_config.json`；没有添加自定义本地服务器的界面。来源：code.claude.com/docs/en/desktop「Shared configuration」「Connect external tools」、code.claude.com/docs/en/mcp。
- Claude 桌面端（聊天）只能在 `claude_desktop_config.json` 中配置本地 stdio 服务器（设置 → 开发者 → 编辑配置；需完全退出重启）；「自定义连接器」由 Anthropic 云端连接，无法访问 127.0.0.1。来源：support.claude.com 文章 11175166（自定义连接器从云端连接、需公网可达）；配置文件路径与菜单为第三方资料，标为待用户验收确认。
- Codex 桌面端与终端、IDE 扩展共用 `~/.codex/config.toml`；设置 → MCP 服务器 → 添加服务器的表单只有名称、传输方式与命令/地址，没有请求头与环境变量字段，保存后在该页点「重启」。来源：learn.chatgpt.com/docs/extend/mcp（OpenAI Codex 文档）。

## 影响与处理

- R-SETTINGS-03：客户端增加「Claude 桌面端」（仅 stdio）；每个客户端改为分步指引，写明终端版与桌面版各自的位置与生效方式；新增「一键写入配置」（Claude 桌面端、Codex、Cursor，合并写入并备份原文件；不自动改 `~/.claude.json`，它由 Claude Code 持续读写）；「其他客户端」增加逐项连接信息（地址、请求头、命令、参数、环境变量），便于填写其他客户端的表单。
- 新增 AC-SETTINGS-03-4、AC-SETTINGS-03-5；新增任务 T-SETTINGS-04。
- 写集：`src/agent/external/client-configs.ts`、`electron/main/external-agent/`（新增 client-config-writer）、`src/agent/external/contract.ts`、preload、设置分区、4 种语言、README 与 feature README。
- 风险：写入其他应用的配置文件——只在用户点击后执行，只改 `fusionkit` 一项，原文件先备份，无法解析的文件拒绝写入。

## 批准与文档更新

用户在本次请求中明确要求完善桌面端支持，作为 I3 范围扩展的批准依据；更新 module-settings 的需求、设计、任务与 spec.json 中 I3 的批准摘要。

## 实施与证据

见 T-SETTINGS-04 与 records/i3/T-SETTINGS-04.md。

## 追加：Cursor 桌面版一键添加（2026-10-13）

原始请求：用户「感觉可以再支持一下cursor桌面版的」。

查证（cursor.com/docs/context/mcp、cursor.com/docs/mcp/install-links）：Cursor 全局配置 `~/.cursor/mcp.json`、项目配置 `.cursor/mcp.json`；远程服务器用 `url` + `headers`，本地用 `command`/`args`/`env`；新版在侧边栏「Customize」中管理与启用 MCP；官方安装链接 `cursor://anysphere.cursor-deeplink/mcp/install?name=<名称>&config=<base64(JSON.stringify(服务器项))>`，打开后 Cursor 弹出安装确认。

处理：R-SETTINGS-03 增加「添加到 Cursor」（主进程只打开以该前缀开头的链接）并更新 Cursor 指引（安装链接、全局与项目配置、Customize 中启用）；新增 AC-SETTINGS-03-6 与任务 T-SETTINGS-05。

## 更正：Skill 的通用安装目录（2026-10-13）

原始请求：用户「skill的安装路径好像不太对 codex、cursor等通用的路径是.agents不是.codex，不需要专门向.codex路径下安装。只有claude需要在.claude下专门安装」。

类型：spec-correction。R-SETTINGS-04 原写「安装到 Codex（`~/.codex/skills/fusionkit-app/`）」有误。查证：OpenAI Codex 文档（learn.chatgpt.com/docs/build-skills，「Where Codex loads local skills」）用户级为 `$HOME/.agents/skills`，仓库级为 `.agents/skills`，未列出 `~/.codex/skills`。

处理：安装目标改为 `claude`（`~/.claude/skills/fusionkit-app/`）与 `agents`（通用目录 `~/.agents/skills/fusionkit-app/`，Codex、Cursor 等共用）；按钮与说明更新为「安装到通用目录（Codex、Cursor 等）」；不再写入 `~/.codex/skills`。新增任务 T-SETTINGS-06。
