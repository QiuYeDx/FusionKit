# 外部 Agent 接入：主进程桥接 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。
元数据引用需求与 AC；不要复制 AC 文本。负责人可连续完成多个任务，但同一时刻只领一个。

### T-BRIDGE-01 共享契约、设置存储与设置 IPC

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-BRIDGE-01 |
| 验收 | AC-BRIDGE-01-1, AC-BRIDGE-01-2, AC-BRIDGE-01-3, AC-BRIDGE-01-4, AC-BRIDGE-01-5 |
| 依赖 | - |
| 写集 | src/agent/external/contract.ts, electron/main/external-agent/, electron/preload/external-agent-api.ts, electron/preload/index.ts, electron/main/index.ts, src/vite-env.d.ts, package.json, pnpm-lock.yaml |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i1/T-BRIDGE-01.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md「共享契约」「设置存储」「设置与状态 IPC」「preload」实现。组合根在 `setupAgentSessionsIPC()` 之后调用 `setupExternalAgent`。新通道前缀加入旧通道桥两个拒绝列表。令牌重置后的会话关闭由 T-BRIDGE-02 的宿主重启实现，本任务提供重置与持久化。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-BRIDGE-01-1 | unit | required | pnpm vitest run test/external-agent/settings-store.test.ts | - |
| V-BRIDGE-01-2 | integration | required | pnpm vitest run test/external-agent.electron.test.ts（设置默认值、重启保留、非主窗口直接调用设置 IPC 被拒绝、重置令牌） | - |
| V-BRIDGE-01-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-BRIDGE-02 本机 HTTP 端点与 MCP 会话

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-BRIDGE-02, R-BRIDGE-03 |
| 验收 | AC-BRIDGE-02-1, AC-BRIDGE-02-2, AC-BRIDGE-02-3, AC-BRIDGE-02-4, AC-BRIDGE-02-5, AC-BRIDGE-02-6, AC-BRIDGE-03-1, AC-BRIDGE-03-2, AC-BRIDGE-03-3, AC-BRIDGE-03-4, AC-BRIDGE-03-5 |
| 依赖 | T-BRIDGE-01 |
| 写集 | electron/main/external-agent/, src/agent/external/catalog.ts, src/agent/external/instructions.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-BRIDGE-01 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i1/T-BRIDGE-01.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i1/T-BRIDGE-02.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md「HTTP 端点」实现 `guardRequest` 纯函数、请求体读取与 413、会话表（上限、闲置清理、DELETE）、每会话低层 Server、tools/list 与参数校验、状态广播、开关/端口/令牌变更时重启。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-BRIDGE-02-1 | unit | required | pnpm vitest run test/external-agent/http-host.test.ts（guardRequest 全分支、413、会话上限与闲置清理、目录映射与参数校验，使用真实 SDK 客户端连接未接 Electron 的宿主） | - |
| V-BRIDGE-02-2 | integration | required | pnpm vitest run test/external-agent.electron.test.ts（握手、列工具、401/403/404、DELETE 后 404、关闭开关后拒绝连接、端口占用状态、会话状态推送） | - |

### T-BRIDGE-03 工具调用转发到渲染进程

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-BRIDGE-04 |
| 验收 | AC-BRIDGE-04-1, AC-BRIDGE-04-2, AC-BRIDGE-04-3, AC-BRIDGE-04-4, AC-BRIDGE-04-5 |
| 依赖 | T-BRIDGE-02 |
| 写集 | electron/main/external-agent/renderer-bridge.ts, electron/main/external-agent/index.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-BRIDGE-02 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i1/T-BRIDGE-02.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i1/T-BRIDGE-03.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md「渲染转发」实现就绪等待、调用登记、取消、超时、回传校验、窗口导航/崩溃/销毁时失败进行中调用、结果大小上限。时间常量可注入以便单测。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-BRIDGE-03-1 | unit | required | pnpm vitest run test/external-agent/renderer-bridge.test.ts（假 webContents：就绪等待超时、取消、超时、非法发送方与未知调用 ID、导航失败、结果过大） | - |
| V-BRIDGE-03-2 | integration | required | pnpm vitest run test/external-agent.electron.test.ts（真实窗口回传数据；与页面重载竞争的调用要么等到新宿主成功、要么得到 fusionkit_window_unavailable，重载后调用成功） | - |
| V-BRIDGE-03-3 | unit | required | pnpm vitest run test/external-agent/http-host.test.ts（真实 SDK 客户端取消请求后，转发调用的中止信号被触发） | - |

### T-BRIDGE-04 端点发现文件与 stdio 桥

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-BRIDGE-05, R-BRIDGE-06 |
| 验收 | AC-BRIDGE-05-1, AC-BRIDGE-05-2, AC-BRIDGE-06-1, AC-BRIDGE-06-2, AC-BRIDGE-06-3, AC-BRIDGE-06-4 |
| 依赖 | T-BRIDGE-03 |
| 写集 | electron/main/external-agent/, resources/external-agent/, electron-builder.subtitle-studio.json, src/agent/external/contract.ts, electron/preload/external-agent-api.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-BRIDGE-03 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i1/T-BRIDGE-03.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i3/T-BRIDGE-04.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md「I3：端点发现文件与 stdio 桥」实现端点文件、桥脚本、打包资源与 connection-info IPC。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-BRIDGE-04-1 | unit | required | pnpm vitest run test/external-agent/endpoint-file.test.ts test/external-agent/stdio-bridge.test.ts | - |
| V-BRIDGE-04-2 | integration | required | pnpm vitest run test/external-agent-stdio.electron.test.ts（运行中经桥调用；应用未运行时桥拉起应用后调用；关闭接入后端点文件消失） | - |
