# 外部 Agent 接入：主进程桥接 设计

I1 部分见「总体链路」至「preload」；I3 部分见「I3：端点发现文件与 stdio 桥」。

## 现状与约束

- 内置 Agent 及其工具、会话、确认卡片全部在渲染进程（`src/agent/*`、`src/store/agent/useAgentStore.ts`）。
- 主进程各能力按「应用窗口主框架」校验调用方：Studio 还用 capability 令牌与 `owner.documents` 管控文档访问（`electron/main/subtitle-studio/index.ts` 的 `ownerFor`），Agent 会话 IPC 用 `trusted(event)`（`electron/main/agent-sessions/index.ts`）。
- 主进程只有一个主窗口 `win`（`electron/main/index.ts`），所有窗口关闭即退出（macOS 除外）。
- P0 实验（2026-10-13，scratchpad `spike/spike.mjs`）：`@modelcontextprotocol/sdk@1.30.1` 的 `StreamableHTTPServerTransport` 挂在 `node:http` 上，`enableJsonResponse: true` + `sessionIdGenerator` 有状态会话、zod v4 schema、SDK 客户端握手/列工具/调用、裸 JSON-RPC 初始化均正常。

## 方案与取舍

### 总体链路

```
外部 MCP 客户端 ──HTTP──▶ ExternalAgentHost（主进程）
                           ├─ 请求守卫：路径 / Host / Origin / 令牌 / 大小
                           ├─ 会话表：sessionId → { transport, server, client, lastActiveAt }
                           ├─ MCP Server（低层 Server 类）：tools/list ← catalog；tools/call → 校验 → RendererBridge
                           └─ RendererBridge ──IPC──▶ 渲染进程工具宿主（module-tools）
```

取舍：工具执行放在渲染进程（复用其 IPC 访问控制、zustand 状态与界面联动），主进程只做协议、鉴权与转发。代价是 FusionKit 窗口必须存在；窗口不可用时返回明确错误。

### 共享契约 `src/agent/external/contract.ts`

纯 zod/TS，无 Electron 依赖，主进程、preload、渲染进程共用：

- `EXTERNAL_AGENT_CHANNEL_PREFIX = "external-agent:"`，通道：`get-settings`、`update-settings`、`regenerate-token`、`get-status`（invoke）；`status`、`call`、`cancel`（主→渲染推送）；`ready`、`respond`（渲染→主）。
- `externalAgentSettingsSchema`：`{ version: 1, enabled, port, token, trust }`；`settingsUpdateSchema`：`enabled? port? trust?`（strict）。
- `ExternalAgentStatus`：`{ enabled, state: "stopped" | "running" | "error", port, url?, error?, trust, sessions: { id, client: { name, version }, connectedAt, lastActiveAt }[] }`。
- 调用信封 `ExternalToolCall`：`{ callId, sessionId, client, tool, arguments }`；回传 `ExternalToolResponse`：`{ callId, result: { ok: true, data } | { ok: false, error, detail? } }`。
- 常量：`DEFAULT_PORT = 47361`、`MAX_SESSIONS = 8`、`SESSION_IDLE_MS = 2h`、`READY_WAIT_MS = 15s`、`CALL_TIMEOUT_MS = 150s`、`MAX_BODY_BYTES = 4 MiB`。

### 工具目录 `src/agent/external/catalog.ts`（module-tools 维护内容）

`EXTERNAL_TOOLS: Record<name, { title, description, inputSchema: ZodObject, access: "read" | "write" | "destructive" }>`。主进程用 `z.toJSONSchema(schema, { io: "input" })` 生成 tools/list 的 `inputSchema`，并由 `access` 推出标注：read → `readOnlyHint: true`；write → `readOnlyHint: false, destructiveHint: false`；destructive → `destructiveHint: true`；全部 `openWorldHint: false`。说明文本 `EXTERNAL_AGENT_INSTRUCTIONS` 放在 `src/agent/external/instructions.ts`。

### 设置存储 `electron/main/external-agent/settings-store.ts`

- 读：文件不存在或 JSON 损坏 → 默认值；逐字段用 schema 校验，非法字段回落默认（`safeParse` 单字段），保留合法字段。
- 写：`update(patch)` 先用 `settingsUpdateSchema` 校验整体，合并后写临时文件再 `rename`；失败抛错、内存不变。开启且无令牌时用 `randomBytes(32).toString("base64url")` 生成。
- `regenerateToken()` 生成新令牌并持久化。

### HTTP 端点 `electron/main/external-agent/http-host.ts`

- `node:http` 服务，`listen(port, "127.0.0.1")`；`EADDRINUSE` → 状态 error / `port_in_use`；其他 → `listen_failed`。
- 守卫顺序（纯函数 `guardRequest(req, { port, token })`，便于单测）：路径非 `/mcp` → 404；`Origin` 存在 → 403；Host ∉ {`127.0.0.1:port`, `localhost:port`} → 403；令牌缺失或 `timingSafeEqual` 不等（先比长度）→ 401 + `WWW-Authenticate: Bearer`。
- 请求体先由宿主读入（超过 4 MiB 立即 413 并销毁连接），再以 `transport.handleRequest(req, res, parsedBody)` 交给 SDK。
- 会话：无 `mcp-session-id` 的请求才能新建（且只能是 initialize，SDK 自行校验）；会话数达到 8 → 503 JSON-RPC 错误 `too_many_sessions`。有会话 ID 但不存在 → 404（SDK 约定客户端随即重新初始化）。每次请求刷新 `lastActiveAt`；每分钟清理闲置超过 2 小时的会话（`transport.close()`）。
- 每个会话一个低层 `Server`（SDK `server/index.js`），声明 `capabilities: { tools: {} }` 与 `instructions`；`oninitialized` 时读取 `server.getClientVersion()` 记录客户端名称与版本并广播状态。
- tools/call：目录无此工具 → 抛 `McpError(InvalidParams)`；参数 `safeParse` 失败 → `isError: true`、`{ error: "invalid_arguments", issues: [...] }`（最多 10 条 `path: message`）；成功 → `RendererBridge.call(...)`，SDK 传入的 `extra.signal` 接到取消。
- 结果：`{ content: [{ type: "text", text: JSON.stringify(data) }] }`；失败加 `isError: true`。
- 停止：关闭全部 transport、`server.close()`，状态 stopped。设置变更（开关、端口、令牌）后整体重启监听：令牌变化时关闭全部会话。

### 渲染转发 `electron/main/external-agent/renderer-bridge.ts`

- `getWindow()` 由组合根注入（`() => win`）。`ready` 只认该窗口 `webContents` 主框架；窗口 `did-start-navigation`（主框架）/`render-process-gone`/`destroyed` 时清除就绪并让进行中调用失败为 `fusionkit_window_unavailable`。
- `call(envelope, signal)`：未就绪则等待就绪（至多 15 秒）；`webContents.send("external-agent:call", envelope)`；登记 `pending[callId] = { resolve, timer(150s), webContentsId }`；`signal` 中止时 `send("external-agent:cancel", { callId })` 并以 `cancelled` 结束（渲染侧随后回传的结果被忽略）。
- `respond`：`ipcMain.handle("external-agent:respond")` 校验发送方是当前窗口主框架且调用 ID 存在，再用 schema 校验结果；序列化超过 4 MiB → `result_too_large`。

### 设置与状态 IPC `electron/main/external-agent/index.ts`

`setupExternalAgent({ getWindow, version, userData })`：创建存储、宿主、桥；注册 4 个 invoke 通道（`trusted(event)` 同 agent-sessions）；状态变化时向窗口推送 `external-agent:status`；启动时若 enabled 则开始监听；`app.on("before-quit")` 停止。返回句柄供测试。

### preload `electron/preload/external-agent-api.ts`

`window.externalAgent`：`getSettings / updateSettings / regenerateToken / getStatus`、`onStatus(listener) → unsubscribe`、`onCall(listener)`、`onCancel(listener)`、`ready()`、`respond(response)`。`assertLegacyExternalAgentChannelAllowed` 加入旧通道桥两个拒绝列表。

## 代码落点

- `src/agent/external/contract.ts`、`src/agent/external/instructions.ts`（新）
- `electron/main/external-agent/{index,settings-store,http-host,renderer-bridge}.ts`（新）
- `electron/preload/external-agent-api.ts`（新）、`electron/preload/index.ts`（暴露 + 拒绝列表）
- `electron/main/index.ts`（组合根一行）、`src/vite-env.d.ts` 或对应全局类型声明
- 溯源审计：`resources/speech-resources/provenance/current-integration-audits.v1.json`、`scripts/subtitle-studio-provenance/current-composition-audits.json`
- `package.json` / `pnpm-lock.yaml`（开发依赖）

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-BRIDGE-01 | settings-store、设置 IPC 与 trusted 校验、令牌生成与重置 |
| R-BRIDGE-02 | http-host 监听与 guardRequest、413、端口冲突状态、开关重启 |
| R-BRIDGE-03 | 每会话低层 Server、instructions、catalog → tools/list、参数校验、会话上限与闲置清理、状态广播 |
| R-BRIDGE-04 | renderer-bridge 就绪、调用/取消/超时、回传校验 |
| R-BRIDGE-05 | endpoint-file.ts、apply 同步、退出清理 |
| R-BRIDGE-06 | fusionkit-mcp-stdio.cjs、extraResources、connectionInfo |

## 验证与风险

- 单元（vitest，node 环境）：`guardRequest` 全分支；settings-store 默认值/损坏/合法字段保留/原子写；catalog → JSON Schema 与标注映射；renderer-bridge 用假 webContents 覆盖就绪等待、取消、超时、非法回传。
- Electron 端到端（`test/external-agent.electron.test.ts`，临时用户数据目录，安静窗口）：预写 settings.json 开启接入与随机空闲端口 → 用 SDK 客户端握手、列工具、调用 `get_fusionkit_status` / `list_studio_documents`；401/403/404/413；DELETE 后 404；运行中关闭开关后拒绝连接；重置令牌后旧令牌 401。
- 风险：SDK 低层 `Server` 与 `StreamableHTTPServerTransport` 的取消信号传递以实测为准；Codex 等客户端对 Origin/Host 的实际行为在 I3 用户验收时确认（客户端为 Node 进程，预期不发送 Origin）。

## I3：端点发现文件与 stdio 桥

### 端点文件 `electron/main/external-agent/endpoint-file.ts`

`apply()` 每次得到运行结果后同步：running → 写 `endpoint.json`（`{ version: 1, url, token, pid, appVersion }`，`mode 0o600`，临时文件后替换）；stopped/error → 删除；`before-quit` 与 `stop()` 删除。写删失败只记日志，不影响 HTTP 端点。

### stdio 桥 `resources/external-agent/fusionkit-mcp-stdio.cjs`

- 纯 CommonJS、只用 Node 内置模块，由 FusionKit 可执行文件以 `ELECTRON_RUN_AS_NODE=1` 运行；参数 `--endpoint <endpoint.json>`、可选 `--launch <可执行文件>`、可选 `--app <应用目录>`（开发模式启动 Electron 时作为第一个参数）。
- 逐行读取 stdin 的 JSON-RPC 消息并串行转发：`POST url`，带 `Authorization: Bearer`、`Accept: application/json, text/event-stream`、`Content-Type: application/json`，已有会话时带 `mcp-session-id` 与 `mcp-protocol-version`；JSON 响应写一行到 stdout，202 不写；`text/event-stream` 响应按 `data:` 行逐条写出（兜底）。
- 记住客户端的 initialize 请求与 `notifications/initialized`；收到 404（会话失效，FusionKit 重启）时先重放二者取得新会话，再重试原请求。
- 读不到端点文件或连接被拒：有 `--launch` 时以 detached、`stdio: "ignore"`、去掉 `ELECTRON_RUN_AS_NODE` 的环境启动一次 FusionKit，每 500 ms 重读端点并重试，最多 60 秒；仍失败则对该请求回 JSON-RPC 错误 `-32000`，消息提示打开 FusionKit 并开启 设置 → 外部 Agent。
- 诊断写 stderr；stdin 关闭时退出。

### 打包与路径

- `electron-builder.subtitle-studio.json` 的 `extraResources` 增加 `{ from: "resources/external-agent", to: "external-agent" }`。
- 主进程 `connectionInfo()`：`exePath = process.execPath`；`scriptPath` 安装版为 `process.resourcesPath/external-agent/fusionkit-mcp-stdio.cjs`，开发/测试版为 `app.getAppPath()/resources/external-agent/…`；`endpointPath`；`appPath` 仅开发版给出。经 IPC `external-agent:connection-info` 提供给设置页。
- Skill 安装 IPC `external-agent:install-skill` / `external-agent:skill-status`（见 module-settings 设计）也在本模块主进程落点 `electron/main/external-agent/skill.ts`。

## I3 验证与风险

- 单元：端点文件写删；桥以子进程运行，对接测试内 HTTP 宿主：转发、通知不回写、会话 404 重放、无端点时报错、`--launch` 启动替身程序并等待端点。
- Electron 端到端：真实应用开启接入后，SDK `StdioClientTransport` 以 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1` 运行桥完成调用；应用未运行时桥带 `--launch`（Electron + `--app`）拉起应用并完成调用。
- 风险：依赖未关闭 runAsNode fuse（当前未配置 fuses）；macOS 路径由 `process.execPath` 给出，需在 mac 上验收。
