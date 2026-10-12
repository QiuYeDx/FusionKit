# agent-multi-session 任务

每个任务块是唯一任务台账；总览由脚本生成。顺序即建议执行顺序：先在内存里打通多会话与并发（T-01、T-02），再落盘（T-03）、标题（T-04），然后界面（T-05、T-06），最后端到端与回归（T-07）。

### T-SESSION-01 会话槽、投影与会话管理动作

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SESSION-01, R-SESSION-05 |
| 验收 | AC-SESSION-01-1, AC-SESSION-01-2, AC-SESSION-01-4, AC-SESSION-05-1, AC-SESSION-05-2, AC-SESSION-05-4 |
| 依赖 | - |
| 写集 | src/agent/types.ts, src/agent/session-schema.ts, src/agent/session-schema.test.ts, src/store/agent/useAgentStore.ts, src/store/agent/useAgentStore.test.ts, src/store/agent/agent-store-test-utils.ts, src/agent/session-list.ts, src/agent/session-list.test.ts, src/agent/session-drafts.ts, src/agent/session-title.ts, src/agent/session-title.test.ts |
| 负责人 | Claude（本会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/T-SESSION-01.md |
| 集成版本 | - |

#### 实现要点

按 design 第 1 节：`SessionSlot`、`slots`、`catalog`、`activeSessionId`、平铺投影、`patchSlot`、`forSession(id)`；`createSession / activateSession / removeSession / renameSession / setPinned / clearAllSessions`；空会话规则；`updatedAt` 只随内容变化。`AgentSession` 增可选 `title / titleSource / pinned`，schema 同步并补 `revision_applied`。`session-list.ts` 实现分组、排序、搜索纯函数；`session-drafts.ts` 实现按会话草稿。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SESSION-01-1 | unit | required | pnpm vitest run src/store/agent/useAgentStore.test.ts：新建/切换/空会话复用/删除当前会话/重命名/置顶；每个动作后投影等于当前槽；后台槽写入不改投影 | - |
| V-SESSION-01-2 | unit | required | pnpm vitest run src/agent/session-schema.test.ts：全部 AgentUiEventKind 与 AgentLogEntryType 及新可选字段往返通过 | - |
| V-SESSION-01-3 | unit | required | pnpm vitest run src/agent/session-list.test.ts：置顶/今天/昨天/近 7 天/更早分组、组内排序、不区分大小写搜索、无匹配 | - |
| V-SESSION-01-4 | static | required | pnpm exec tsc --noEmit | - |

### T-SESSION-02 按会话的回合、工具归属与并发

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SESSION-02, R-SESSION-03 |
| 验收 | AC-SESSION-02-1, AC-SESSION-02-2, AC-SESSION-02-3, AC-SESSION-02-5, AC-SESSION-03-1, AC-SESSION-03-2, AC-SESSION-03-3, AC-SESSION-03-4, AC-SESSION-03-5 |
| 依赖 | T-SESSION-01 |
| 写集 | src/agent/turn-context.ts, src/agent/orchestrator.ts, src/agent/orchestrator.test.ts, src/agent/tool-executor.ts, src/agent/tool-executor-scope.test.ts, src/agent/tool-executor-translation.test.ts, src/agent/modern-tools.ts, src/agent/modern-tools.test.ts, src/agent/planning-tools.ts, src/agent/knowledge-tools.ts, src/agent/knowledge-tools.test.ts, src/agent/web-tools.test.ts, src/agent/prepared-actions.ts, src/agent/prepared-actions.test.ts, src/agent/pipeline-watch.ts, src/agent/pipeline-watch-session.test.ts, src/pages/HomeAgent/widget-actions.ts, src/pages/HomeAgent/conversation.tsx, src/pages/HomeAgent/components/AgentPreparedActions.tsx |
| 负责人 | Claude（本会话） |
| 依赖确认 | T-SESSION-01：同一工作树 5cf4dba+I1，其单元测试（records/unit-agent.log）通过后开发 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/T-SESSION-02.md |
| 集成版本 | - |

#### 实现要点

按 design 第 2 节：`turns` Map、`bindTurnSession / sessionOfSignal`、回合内一律 `forSession(sid)`、系统提示按会话构造、删除即 abort、按会话事件队列、`abortSessionTurn / abortAllTurns`、后台完成置未读。工具改法表逐项落实；先全仓 grep `session.id`、`getState().session`、`useAgentStore.subscribe`，把每处归类为「回合会话」「当前会话（UI）」「会话删除」并写入实施记录。卡片事件按卡片所属会话上报。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SESSION-02-1 | unit | required | pnpm vitest run src/agent/orchestrator.test.ts：A 回复中切到 B 不中断且只写 A；A、B 并行；停止 B 不影响 A；删除 A 中止其回合；事件进入所属会话队列；后台完成置未读 | - |
| V-SESSION-02-2 | unit | required | pnpm vitest run src/agent/tool-executor-scope.test.ts src/agent/tool-executor-translation.test.ts src/agent/modern-tools.test.ts：后台回合的输入路径/覆盖意图只看本会话消息；执行确认、计划写入回合会话；会话删除后工具判为已变更 | - |
| V-SESSION-02-3 | unit | required | pnpm vitest run src/agent/prepared-actions.test.ts src/agent/pipeline-watch-session.test.ts：切换会话不作废、删除会话作废；流水线回报归属发起会话 | - |
| V-SESSION-02-4 | unit | required | pnpm vitest run src/agent src/pages/HomeAgent src/pages/AgentDock src/store/agent：既有 agent 单测全部通过 | - |

### T-SESSION-03 本地持久化

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SESSION-04, R-SESSION-05 |
| 验收 | AC-SESSION-04-1, AC-SESSION-04-2, AC-SESSION-04-3, AC-SESSION-04-4, AC-SESSION-04-5, AC-SESSION-04-6, AC-SESSION-05-3, AC-SESSION-05-5, AC-SESSION-05-6, AC-SESSION-05-7 |
| 依赖 | T-SESSION-01, T-SESSION-02 |
| 写集 | src/agent/session-store-contract.ts, src/agent/session-persistence.ts, src/agent/session-persistence.test.ts, src/agent/session-io.ts, src/agent/session-io.test.ts, electron/main/agent-sessions/, electron/main/index.ts, electron/preload/agent-sessions-api.ts, electron/preload/index.ts, electron/preload/legacy-ipc-bridge.ts, src/vite-env.d.ts, src/main.tsx, test/agent-sessions/ |
| 负责人 | Claude（本会话） |
| 依赖确认 | T-SESSION-01、T-SESSION-02：同一工作树 5cf4dba+I1，其单元测试（records/unit-agent.log）通过后开发 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/T-SESSION-03.md |
| 集成版本 | - |

#### 实现要点

按 design 第 3、4 节：契约与通道；主进程仓库（串行队列、id/meta/大小校验、原子写、索引核对与重建、损坏标记、trusted 调用方）；预加载冻结 API 与旧桥拒绝；渲染进程启动加载目录、去抖与立即保存、超限裁剪日志、失败状态与重试、打开会话时槽化（授权不跨重启）、主进程不可用降级。导出按 id、导入为新会话、删除与清空落到磁盘。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SESSION-03-1 | unit | required | pnpm vitest run test/agent-sessions：仓库在临时目录中保存/列出/加载/删除/清空；拒绝非法 id 与超限内容；写入中途失败不损坏旧文件；索引缺失或与文件不一致时重建；损坏文件标为无法读取；非主框架调用被拒绝 | - |
| V-SESSION-03-2 | unit | required | pnpm vitest run src/agent/session-persistence.test.ts src/agent/session-io.test.ts：去抖与回合结束立即保存、空会话不保存、超限裁剪、失败状态与重试、加载后计划进行中步骤改待办且无待确认授权、导入为新会话保留标题、按 id 导出未加载会话 | - |
| V-SESSION-03-3 | static | required | pnpm run pretest（含 check-preload-bundle）与 pnpm exec tsc --noEmit | - |

### T-SESSION-04 会话标题

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SESSION-06 |
| 验收 | AC-SESSION-06-1, AC-SESSION-06-2, AC-SESSION-06-3, AC-SESSION-06-4 |
| 依赖 | T-SESSION-02 |
| 写集 | src/agent/session-title-generator.ts, src/agent/session-title-generator.test.ts, src/agent/orchestrator.ts |
| 负责人 | Claude（本会话） |
| 依赖确认 | T-SESSION-02：同一工作树 5cf4dba+I1，其单元测试（records/unit-agent.log）通过后开发 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/T-SESSION-04.md |
| 集成版本 | - |

#### 实现要点

按 design 第 5 节：首条亲手输入消息时截取；首个成功回合后不带工具的生成请求（固定指令前缀、20 s 超时、会话删除即中止）；清洗、手动优先、用量 `keepContext` 计入、失败日志与下一次成功回合重试一次。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SESSION-04-1 | unit | required | pnpm vitest run src/agent/session-title.test.ts src/agent/session-title-generator.test.ts：截取（多行、长句、表情与代理对）、清洗（引号、句末标点、空结果）、生成请求不带工具且用量计入不改上下文占用、手动重命名后不覆盖、失败保留截取并在下次成功回合重试一次 | - |

### T-SESSION-05 主页会话侧栏与工具栏

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SESSION-07, R-SESSION-05, R-SESSION-01, R-SESSION-02 |
| 验收 | AC-SESSION-07-1, AC-SESSION-07-2, AC-SESSION-07-4, AC-SESSION-07-5, AC-SESSION-05-1, AC-SESSION-05-2, AC-SESSION-05-3, AC-SESSION-05-4, AC-SESSION-05-5, AC-SESSION-05-7, AC-SESSION-01-1, AC-SESSION-01-3, AC-SESSION-02-4 |
| 依赖 | T-SESSION-03, T-SESSION-04 |
| 写集 | src/pages/HomeAgent/SessionSidebar.tsx, src/pages/HomeAgent/home-layout.ts, src/pages/HomeAgent/components/SessionList.tsx, src/pages/HomeAgent/index.tsx, src/pages/AgentDock/handoff.ts, src/pages/AgentDock/handoff.test.ts, src/locales/ |
| 负责人 | Claude（本会话） |
| 依赖确认 | T-SESSION-03、T-SESSION-04：同一工作树 5cf4dba+I1，其单元测试（records/unit-agent.log）通过后开发 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/T-SESSION-05.md |
| 集成版本 | - |

#### 实现要点

按 design 第 6 节「主页侧栏布局」「主页工具栏」：常驻/浮层阈值 1000 px、收起偏好、表面与结构、分组标题、行与行尾固定槽、行内菜单、重命名、删除确认、空状态与保存失败提示；工具栏新对话无二次确认、导入为新会话；草稿随会话切换。`SessionList` 供 T-SESSION-06 复用（紧凑变体无行内菜单）。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SESSION-05-1 | browser | required | Electron 静默窗口，主页 1440×900 与 1000×700、786×540，浅/深色、中/英文，design 第 6 节验收样本（20 个会话、长标题、运行中、未读、无法读取）：截图并实际查看侧栏常驻与浮层、行状态组合、Tooltip、菜单、重命名、删除确认；按方向→结构→细节→交互→适配记录问题、修复、复验 | - |
| V-SESSION-05-2 | integration | required | test/agent-sessions.electron.test.ts 侧栏部分：新建/切换/草稿保留、重命名（Enter/Esc/空串）、置顶、搜索与无结果、删除当前会话后为新空会话、导入为新会话、从行菜单导出未切换的会话、键盘 Tab/方向键/Enter/Esc 可达 | - |
| V-SESSION-05-3 | static | required | pnpm i18n:check 与 pnpm exec tsc --noEmit | - |

### T-SESSION-06 悬浮面板切换器与设置清空

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SESSION-07, R-SESSION-05, R-SESSION-01 |
| 验收 | AC-SESSION-07-3, AC-SESSION-07-4, AC-SESSION-07-5, AC-SESSION-05-6, AC-SESSION-01-3 |
| 依赖 | T-SESSION-05 |
| 写集 | src/pages/AgentDock/index.tsx, src/pages/Setting/components/AgentConfig.tsx, src/locales/ |
| 负责人 | Claude（本会话） |
| 依赖确认 | T-SESSION-05：同一工作树 5cf4dba+I1，其单元测试（records/unit-agent.log）通过后开发 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/T-SESSION-06.md |
| 集成版本 | - |

#### 实现要点

按 design 第 6 节「悬浮面板切换器」「设置 → Agent」：头部标题区变为切换器按钮与 Popover（搜索、新对话、紧凑列表），其他会话运行中/未读圆点；重置按钮改为新对话；草稿随会话切换；设置中显示已保存会话数与清空全部（Dialog 确认）。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SESSION-06-1 | browser | required | Electron 静默窗口，字幕工作台页打开悬浮面板（默认尺寸与最小窗口），浅/深色、中/英文：截图并实际查看切换器按钮、圆点、Popover 列表与搜索、长标题省略；设置页清空按钮与确认卡片；记录问题、修复、复验 | - |
| V-SESSION-06-2 | integration | required | test/agent-sessions.electron.test.ts 面板部分：工具页切换会话不跳页、新建、搜索；设置清空后列表为空、磁盘无会话文件、正在回复的会话被停止 | - |

### T-SESSION-07 端到端与回归

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SESSION-02, R-SESSION-03, R-SESSION-04, R-SESSION-06 |
| 验收 | AC-SESSION-02-1, AC-SESSION-02-2, AC-SESSION-02-3, AC-SESSION-02-4, AC-SESSION-03-2, AC-SESSION-04-1, AC-SESSION-04-2, AC-SESSION-04-6, AC-SESSION-06-2, AC-SESSION-06-3 |
| 依赖 | T-SESSION-06 |
| 写集 | test/agent-sessions.electron.test.ts, test/agent-dock.electron.test.ts, test/agent-handoff.electron.test.ts, test/agent-knowledge.electron.test.ts, test/agent-web.electron.test.ts, test/subtitle-studio/cue-structure-revision-ui.test.ts, scripts/readme-screenshots/capture.mjs, scripts/home-agent-qa.mjs |
| 负责人 | Claude（本会话） |
| 依赖确认 | T-SESSION-06：同一工作树 5cf4dba+I1，其单元测试（records/unit-agent.log）通过后开发 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/T-SESSION-07.md |
| 集成版本 | - |

#### 实现要点

新端到端测试用本地模拟 Responses 接口（可挂起某个回复以制造并发），覆盖：A 回复中切 B 并在 B 发送、停止 B、A 完成后未读、待确认卡片切走切回仍可确认、标题由截取变为生成且请求无工具、生成前手动重命名不被覆盖、重启（同一 userData 目录重新启动应用）后列表/内容/计划/卡片失效与新空会话。现有 agent 端到端测试的模拟服务识别 `You name conversations.` 前缀单独应答标题请求。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SESSION-07-1 | integration | required | pnpm run pretest 后 FUSIONKIT_AGENT_SESSIONS_E2E=1 pnpm vitest run test/agent-sessions.electron.test.ts（静默窗口） | - |
| V-SESSION-07-2 | integration | required | 现有 agent 端到端测试：agent-dock、agent-handoff、agent-knowledge、agent-web、home-composer、subtitle-studio/cue-structure-revision-ui 按各自开关运行通过 | - |
| V-SESSION-07-3 | integration | required | pnpm test 完整回归，与基线 5cf4dba 的已知失败对照，新增失败为零 | - |
