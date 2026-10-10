# agent 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。
元数据引用需求与 AC；不要复制 AC 文本。负责人可连续完成多个任务，但同一时刻只领一个。

### T-AGENT-01 资料检索增强与目录工具

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-AGENT-01 |
| 验收 | AC-AGENT-01-1, AC-AGENT-01-2, AC-AGENT-01-3 |
| 依赖 | - |
| 写集 | src/agent/knowledge-tools.ts, src/agent/knowledge-tools.test.ts, src/agent/modern-tools.ts, src/agent/modern-tools.test.ts, src/agent/tools.ts, src/agent/capability-catalog.ts, src/agent/capability-catalog.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i1/T-AGENT-01.md |
| 集成版本 | 45a88e0 + 未提交工作树（I1） |

#### 实现要点

按 [设计·工具](design.md) 拆出 `knowledge-tools.ts`，迁移并增强检索，新增目录工具；`tools.ts` 合并；能力目录追加 operations；原检索测试迁移到新测试文件。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AGENT-01-1 | unit | required | node node_modules/vitest/vitest.mjs run src/agent/knowledge-tools.test.ts src/agent/modern-tools.test.ts src/agent/capability-catalog.test.ts | - |

### T-AGENT-02 准备资料变更工具与确认执行

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-AGENT-02, R-AGENT-03 |
| 验收 | AC-AGENT-02-1, AC-AGENT-02-2, AC-AGENT-02-3, AC-AGENT-02-4, AC-AGENT-03-1, AC-AGENT-03-2, AC-AGENT-03-3 |
| 依赖 | T-KNOWLEDGE-02, T-AGENT-01 |
| 写集 | src/agent/knowledge-tools.ts, src/agent/knowledge-tools.test.ts, src/agent/prepared-actions.ts, src/agent/prepared-actions.test.ts, src/agent/modern-tools.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-KNOWLEDGE-02、T-AGENT-01：同一工作树 45a88e0+I1，proposal 与工具测试通过后开发 |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i1/T-AGENT-02.md |
| 集成版本 | 45a88e0 + 未提交工作树（I1） |

#### 实现要点

`prepare_knowledge_changes` 构造提案并注册 `requiresConfirmation` 动作；`exposePrepared` 对其不自动确认；`confirmAction(id, choice)`；execute 读取最新库、按 id 种子重建、对账、`saveRecords`、错误映射；撤下本会话旧的就绪资料卡片。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AGENT-02-1 | unit | required | node node_modules/vitest/vitest.mjs run src/agent/knowledge-tools.test.ts src/agent/prepared-actions.test.ts（mock read/saveRecords，覆盖 prepared、自动执行不保存、invalid、unchanged、确认启用/待审核、过期失败、取消） | - |

### T-AGENT-03 资料变更卡片、行摘要与四语言文案

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-AGENT-03 |
| 验收 | AC-AGENT-03-4, AC-AGENT-03-5 |
| 依赖 | T-AGENT-02, T-KNOWLEDGE-03 |
| 写集 | src/pages/HomeAgent/components/AgentKnowledgeChanges.tsx, src/pages/HomeAgent/components/AgentPreparedActions.tsx, src/pages/HomeAgent/components/AgentToolCall.tsx, src/pages/HomeAgent/components/AgentToolResult.tsx, src/pages/HomeAgent/components/action-error.ts, src/pages/HomeAgent/presentation.test.ts, src/locales/zh/home.json, src/locales/en/home.json, src/locales/ja/home.json, src/locales/zh-Hant/home.json, scripts/i18n-usage-manifest.mjs |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-AGENT-02、T-KNOWLEDGE-03：同一工作树 45a88e0+I1，工具与资料页上下文测试通过后开发 |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i1/T-AGENT-03.md |
| 集成版本 | 45a88e0 + 未提交工作树（I1） |

#### 实现要点

按 [设计·卡片 UI 设计基准](design.md) 实现 `AgentKnowledgeChanges` 并接入 `ActionCard` 分支；开关值随确认传入；完成态跳转带 `knowledgeFocus`；行标题/摘要/错误码/能力描述文案四语言。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AGENT-03-1 | unit | required | node node_modules/vitest/vitest.mjs run src/pages/HomeAgent/presentation.test.ts src/pages/HomeAgent/feed.test.ts | - |
| V-AGENT-03-2 | static | required | pnpm run i18n:check 与 npx tsc --noEmit -p tsconfig.json | - |
| V-AGENT-03-3 | browser | required | Electron 隔离 profile：样本 12 项卡片（长原文、冲突、强制、已存在），1280×860 首页与 786×660 悬浮面板，浅/深色，zh/en；查看 ready、running、completed、failed 截图，检查换行、折叠、开关与按钮键盘操作；发现问题修复后重截复验 | - |

### T-AGENT-04 Agent 指引与背景对话端到端复现

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-AGENT-04, R-AGENT-03 |
| 验收 | AC-AGENT-04-1, AC-AGENT-04-2, AC-AGENT-03-4 |
| 依赖 | T-AGENT-03 |
| 写集 | src/agent/orchestrator.ts, src/agent/orchestrator.test.ts, src/pages/Tools/Subtitle/SubtitleStudio/agent-context.ts, test/agent-knowledge.electron.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-AGENT-03：同一工作树 45a88e0+I1，卡片单元测试与渲染审查后开发 |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i1/T-AGENT-04.md |
| 集成版本 | 45a88e0 + 未提交工作树（I1） |

#### 实现要点

系统提示「翻译资料」段与工作台说明补充；新增 Electron 场景（本地 SSE 脚本模型、隔离 userData）复现背景对话并点击卡片确认与跳转。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AGENT-04-1 | unit | required | node node_modules/vitest/vitest.mjs run src/agent/orchestrator.test.ts src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts | - |
| V-AGENT-04-2 | integration | required | 构建后运行 FUSIONKIT_AGENT_KNOWLEDGE_E2E=1 的 test/agent-knowledge.electron.test.ts：卡片出现 → 确认 → 资料库含新资料集与 ready 术语 → UI 事件回报 → 跳转资料页选中资料集；截图审阅 | - |
| V-AGENT-04-3 | unit | required | pnpm test 全量回归（记录通过/跳过数，与基线比较） | - |

### T-AGENT-05 修订应用事件与 Agent 跟进

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-AGENT-05 |
| 验收 | AC-AGENT-05-1, AC-AGENT-05-2, AC-AGENT-05-3 |
| 依赖 | T-STUDIO-02 |
| 写集 | src/agent/types.ts, src/agent/ui-events.ts, src/agent/ui-events.test.ts, src/agent/page-context.ts, src/agent/orchestrator.ts, src/agent/orchestrator.test.ts, src/pages/Tools/Subtitle/SubtitleStudio/agent-context.ts, src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts, src/locales/zh/home.json, src/locales/en/home.json, src/locales/ja/home.json, src/locales/zh-Hant/home.json |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-STUDIO-02：同一工作树 45a88e0+I2，修订对话框应用回调完成后开发 |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i2/T-AGENT-05.md |
| 集成版本 | 45a88e0 + 未提交工作树（I2） |

#### 实现要点

按 [设计·修订应用回报](design.md)：结果附 `knowledgeHints`，预设 `onApplied` 上报 `revision_applied`，事件文本、跟进条件、四语言事件行与提示词。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AGENT-05-1 | unit | required | node node_modules/vitest/vitest.mjs run src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts src/agent/orchestrator.test.ts src/agent/ui-events.test.ts | - |

### T-AGENT-06 Agent 发起一致性检查

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-AGENT-06 |
| 验收 | AC-AGENT-06-1, AC-AGENT-06-2 |
| 依赖 | T-STUDIO-04 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/agent-context.ts, src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts, src/pages/HomeAgent/components/AgentToolCall.tsx, src/pages/HomeAgent/components/AgentToolResult.tsx, src/locales/zh/home.json, src/locales/en/home.json, src/locales/ja/home.json, src/locales/zh-Hant/home.json |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-STUDIO-04：同一工作树 45a88e0+I3，检查窗口完成后开发 |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i3/T-AGENT-06.md |
| 集成版本 | 45a88e0 + 未提交工作树（I3） |

#### 实现要点

按 [设计·Agent 发起一致性检查](design.md)；行标题与摘要四语言。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AGENT-06-1 | unit | required | node node_modules/vitest/vitest.mjs run src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts src/pages/HomeAgent/presentation.test.ts | - |

### T-AGENT-07 Agent 联网工具与带来源的资料

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I4 |
| 需求 | R-AGENT-07 |
| 验收 | AC-AGENT-07-1, AC-AGENT-07-2, AC-AGENT-07-3, AC-AGENT-07-4 |
| 依赖 | T-WEB-02 |
| 写集 | src/agent/web-tools.ts, src/agent/web-tools.test.ts, src/agent/tools.ts, src/agent/knowledge-tools.ts, src/agent/knowledge-tools.test.ts, src/agent/orchestrator.ts, src/agent/orchestrator.test.ts, src/translation-knowledge/proposal.ts, src/pages/HomeAgent/components/AgentKnowledgeChanges.tsx, src/pages/HomeAgent/components/AgentToolCall.tsx, src/pages/HomeAgent/components/AgentToolResult.tsx, src/pages/HomeAgent/components/action-error.ts, src/locales/zh/home.json, src/locales/en/home.json, src/locales/ja/home.json, src/locales/zh-Hant/home.json, src/agent/navigation-tools.ts, src/pages/HomeAgent/presentation.test.ts, test/agent-web.electron.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-WEB-02：同一工作树 45a88e0+I4，设置存储完成后开发 |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i4/T-AGENT-07.md |
| 集成版本 | 45a88e0 + 未提交工作树（I4） |

#### 实现要点

按 [设计·联网查证](design.md)。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AGENT-07-1 | unit | required | node node_modules/vitest/vitest.mjs run src/agent/web-tools.test.ts src/agent/knowledge-tools.test.ts src/agent/orchestrator.test.ts src/agent/navigation-tools.test.ts test/translation-knowledge/proposal.test.ts src/pages/HomeAgent/presentation.test.ts | - |
| V-AGENT-07-2 | browser | required | 构建后运行 FUSIONKIT_AGENT_WEB_E2E=1 的 test/agent-web.electron.test.ts：未开启时的提示；开启后脚本模型调用 web_search/web_read（主进程网络注入固定样本）并准备带网页来源的资料卡片，确认后资料证据为 web；截图审阅 | - |
