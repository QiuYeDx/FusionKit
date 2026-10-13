# 外部 Agent 接入：设置与接入体验 设计

本模块需求均属 I3。

## 现状与约束

- 设置页 `src/pages/Setting/index.tsx`：左侧分区导航（`settingNavigation.ts` 的 `SETTING_TAB_KEYS`，URL `?tab=`），右侧 ScrollArea 内渲染 `components/*Config.tsx`；`<768px` 导航变为横向滚动。
- 同类参照：`components/AgentConfig.tsx`（一张 Card；行式「标签 + 说明 + 右侧 Switch」；`divide-y rounded-lg border` 列表；文字 13px / xs / 11px 层级；危险操作 `ConfirmDialog`）。
- 设置与状态由主进程持有（module-bridge）；`useExternalAgentStore` 缓存状态与每个连接的最近活动。
- 设计依据：项目 UI 规范 `.agents/skills/fusionkit-ui-design/SKILL.md`（复用共享组件、同类留白、真实 Electron 审查）。

## 方案与取舍

UI 设计基准如下（设计依据见上节）。

- 用户与流程：首次接入的用户进入 设置 → 外部 Agent → 打开开关 → 选客户端标签 → 复制配置粘贴到 Claude Code / Codex → 回到对话使用；之后偶尔回来看连接、改信任档位或重置令牌。失败恢复：端口冲突就地改端口；令牌泄露时重置。
- 布局（单张 Card，`space-y-6`，与 AgentConfig 同构）：
  1. 开关行：标题「允许外部 Agent 连接」+ 说明 + 右侧 Switch；说明下方一行状态：运行中（绿色小圆点 + 等宽地址）/ 已关闭 / 端口被占用（destructive 文字）。
  2. 权限：小标题 + `RadioGroup` 三行列表（`divide-y rounded-lg border`），每行名称 + 说明，推荐项名称后标「推荐」。
  3. 连接信息：端口（`Input` h-8 w-28，失焦或回车保存，非法就地提示）；令牌（等宽遮挡文本 + 图标按钮：显示/隐藏、复制、重置；重置走 `ConfirmDialog`）。
  4. 接入客户端：客户端标签 Claude Code / Codex / Cursor / JSON 与方式（HTTP 推荐 / stdio 自动启动）两组分段按钮上下两行排列（同一行会被读成一组），复用 `ClipPathTabs`（`shape="rounded"`、`size="sm"`，同字幕工作台视图切换）；一句放置位置说明；代码块 `pre`（`bg-muted/50 rounded-md border p-3 text-[12px] font-mono overflow-x-auto whitespace-pre`），右上角复制图标按钮（带边框与半透明底，避免压字）；代码块容器 `w-0 min-w-full`，因设置页 ScrollArea 内容按 table 布局，长行不得撑宽页面。关闭或无令牌时整块换成一行提示。
  5. 当前连接：`divide-y rounded-lg border` 列表，每行「客户端名 版本」+ 次行「已连接 N 分钟 · 最近：工具名 成功/失败」+ 右侧「断开」小按钮；空状态一行灰字。
  6. Skill：说明 + 两个 outline 小按钮「安装到 Claude Code」「安装到 Codex」，安装后在下方显示已安装路径，toast 同时提示。
- 标题栏：`AppTitleBar` 应用名前加 6px 绿色圆点（有连接时），`title` 为「N 个外部 Agent 已连接」，胶囊与窗口按钮逻辑不变。
- 组件：`Card`/`CardHeader`/`CardTitle`/`CardContent`、`Switch`、`Label`、`RadioGroup`/`RadioGroupItem`、`Input`、`Button`（ghost icon-sm / outline sm）、`ClipPathTabs`、`ConfirmDialog`、`toast`。文案 `setting:external_agent.*` 与 `setting:nav.external.*`（4 语言）。
- 状态：首帧用默认值，拿到设置后渲染；保存中禁用对应控件；运行 / 关闭 / 错误；有 / 无连接；令牌显示 / 遮挡；复制后图标变对勾 1.5 秒。
- 窄屏（<768px）：开关行与连接行保持左右结构，说明可换行；代码块横向滚动；分段按钮可横向滚动。
- 真实长度样本：开发态可执行文件 `…\node_modules\electron\dist\electron.exe` 与长 userData 路径；英文长说明；两个连接（claude-code、codex）。

## 片段生成 `src/agent/external/client-configs.ts`

纯函数 `buildClientConfig(client, transport, info)` → `{ language, text, hint }`：

| 客户端 | HTTP | stdio |
| --- | --- | --- |
| Claude Code（终端命令） | `claude mcp add --scope user --transport http fusionkit <url> --header "Authorization: Bearer <token>"` | `claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 fusionkit -- "<exe>" "<script>" --endpoint "<endpoint>" --launch "<exe>"`（开发版加 `--app "<app>"`） |
| Codex（`~/.codex/config.toml`） | `[mcp_servers.fusionkit]`、`url = '<url>'`、`http_headers = { Authorization = 'Bearer <token>' }` | `command = '<exe>'`、`args = [...]`、`env = { ELECTRON_RUN_AS_NODE = '1' }` |
| Cursor（`~/.cursor/mcp.json`）/ 通用 JSON | `{ "mcpServers": { "fusionkit": { "url", "headers" } } }` | `{ "mcpServers": { "fusionkit": { "command", "args", "env" } } }` |

TOML 用单引号字面量字符串承载 Windows 路径；JSON 用 `JSON.stringify`。客户端配置格式以各客户端当前文档为准，用户验收时确认。

## 主进程补充 IPC（module-bridge 落点）

`external-agent:connection-info`；`external-agent:install-skill`（`target: "claude" | "agents"` → 写 `<home>/.claude/skills/fusionkit-app/SKILL.md` 或通用目录 `<home>/.agents/skills/fusionkit-app/SKILL.md`（Codex、Cursor 等共用；2026-10-13 由 `.codex/skills` 更正），内容为构建时以 `?raw` 内联的 `.agents/skills/fusionkit-app/SKILL.md`，临时文件后替换，返回路径）；`external-agent:skill-status`（两处是否已安装且与内置内容一致）。`<home>` 默认为 `os.homedir()`，测试以 `FUSIONKIT_EXTERNAL_AGENT_HOME` 覆盖。

## 代码落点

- `src/pages/Setting/components/ExternalAgentConfig.tsx`（新）、`src/pages/Setting/index.tsx`、`src/pages/Setting/settingNavigation.ts`
- `src/agent/external/client-configs.ts`（新）、`src/agent/external/contract.ts`
- `src/pages/components/AppTitleBar.tsx`
- `electron/main/external-agent/{index,skill}.ts`、`electron/preload/external-agent-api.ts`
- `.agents/skills/fusionkit-app/SKILL.md`、`.agents/skills/fusionkit-app/agents/openai.yaml`（新）
- `src/locales/{zh,zh-Hant,en,ja}/setting.json`
- `README.md`、`README.en.md`、`docs/features/external-agent/README.md`

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-SETTINGS-01 | 开关/状态、权限、连接信息区块 |
| R-SETTINGS-02 | 当前连接区块、标题栏圆点、closeSession |
| R-SETTINGS-03 | client-configs.ts、接入客户端区块、connection-info |
| R-SETTINGS-04 | SKILL.md、install-skill / skill-status、README |

## 验证与风险

- 单元：client-configs 各组合（JSON 用 `JSON.parse` 校验；TOML 做结构与字面量断言）；skill 安装写入与覆盖；设置导航含 external。
- Electron 端到端 + 渲染审查（`test/external-agent-settings.electron.test.ts`）：开关、状态、端口冲突、信任档位、令牌显示/复制/重置、片段复制内容、连接列表与断开、标题栏圆点、Skill 安装到临时 HOME；截图 1280×860 / 900×700、浅/深、中/英，逐张审阅并修复复验。
- 风险：测试不写真实 `~/.claude`，以环境变量覆盖用户目录（仅测试使用）。

## 桌面版客户端与一键写入（变更 2026-10-13）

依据与查证来源见 `../../changes/2026-10-13-desktop-clients.md`。

- 客户端：Claude Code（终端与桌面 Code 标签共用配置）、Claude 桌面端（聊天，仅 stdio）、Codex（终端、桌面、IDE 共用 config.toml）、Cursor、其他。`clientTransports("claude-desktop") = ["stdio"]`，此时不显示方式切换，改为一行说明；英文/日文标签用较短的「Claude app / Claude アプリ」，避免在等宽分段按钮中被截断。
- 指引：每个客户端三步（`clients.guide.<client>.step1..3`），stdio 时追加一步说明桥会自动启动 FusionKit；文字写明终端版与桌面版各自的位置、菜单与生效方式。
- 一键写入（Claude 桌面端、Codex、Cursor）：主进程 `electron/main/external-agent/client-config-writer.ts`。路径：Claude 桌面端 Windows `%APPDATA%\Claude\claude_desktop_config.json`、macOS `~/Library/Application Support/Claude/…`、Linux `~/.config/Claude/…`；Codex `$CODEX_HOME/config.toml` 或 `~/.codex/config.toml`；Cursor `~/.cursor/mcp.json`。JSON 只设置 `mcpServers.fusionkit`；TOML 删除旧的 `[mcp_servers.fusionkit]` 及其子表后在末尾追加；写前备份为 `<文件>.fusionkit-backup`，临时文件后替换；无法解析的文件拒绝写入（`config_unreadable`）。不自动修改 `~/.claude.json`。IPC：`write-client-config`、`client-config-status`、`reveal-client-config`（在文件夹中显示）。
- 其他客户端：`connectionFields()` 逐项列出地址与请求头（HTTP）或命令、参数、环境变量（stdio），每项可复制。
- 验证：`test/external-agent/client-config-writer.test.ts`（路径、合并、备份、幂等、不可解析、TOML 子表）；设置端到端增加 Claude 桌面端 stdio、三种文件写入（含预置内容与损坏文件）与逐项字段，截图 `settings-claude-desktop-*`、`settings-other-fields-*`。

## Cursor 桌面版一键添加（变更 2026-10-13 追加）

- `cursorInstallLink(transport, input)` = `cursor://anysphere.cursor-deeplink/mcp/install?name=fusionkit&config=<encodeURIComponent(base64(UTF-8 JSON.stringify(jsonServerEntry)))>`（cursor.com/docs/mcp/install-links；base64 前按 UTF-8 编码，路径可含中文）。
- 主进程 IPC `open-client-install`（仅 `client: "cursor"`）在主进程生成链接，校验以 `CURSOR_INSTALL_PREFIX` 开头后 `shell.openExternal`；渲染进程不传入任意地址。
- 界面：Cursor 标签的按钮组首位为主按钮「添加到 Cursor」，其后「写入配置文件」「打开所在文件夹」；指引改为：安装确认 → 全局 / 项目 mcp.json → 侧边栏 Customize 中启用。
- 验证：client-configs 单测解码链接并与服务器项比较（含中文路径）；设置端到端在主进程替换 `shell.openExternal` 记录链接并解码比较，截图 `settings-cursor-zh-light-1280`。
