# HomeAgent 运行可靠性任务

### T-RUNTIME-04 Agent 页面导航工具

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I4 |
| 需求 | R-RUNTIME-04 |
| 验收 | AC-RUNTIME-04-1, AC-RUNTIME-04-2, AC-RUNTIME-04-3, AC-RUNTIME-04-4 |
| 依赖 | - |
| 写集 | src/agent/navigation-tools.ts, src/agent/navigation-tools.test.ts, src/agent/tools.ts, src/agent/orchestrator.ts, src/pages/AgentDock/index.tsx, src/pages/HomeAgent/components/AgentToolCall.tsx, src/pages/HomeAgent/components/AgentToolResult.tsx, src/pages/HomeAgent/components/action-error.ts, src/locales/zh/home.json, src/locales/en/home.json, src/locales/ja/home.json, src/locales/zh-Hant/home.json, scripts/i18n-usage-manifest.mjs |
| 负责人 | root |
| 依赖确认 | I3 已完成；基于本会话未提交改动 |
| 完成日期 | 2026-10-09 |
| 实施记录 | records/i4/T-RUNTIME-04.md |
| 集成版本 | df64e8f + 本会话未提交改动 |

#### 实现要点
按本模块 I4 设计。

#### 验证计划
| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-RUNTIME-04-1 | unit | required | vitest run src/agent：枚举、无导航器、等待注册与超时、已在目标页 | - |
| V-RUNTIME-04-2 | static | required | tsc、check-i18n、check-i18n-usage | - |


### T-RUNTIME-03 页面上下文注册表与每轮注入

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-RUNTIME-03 |
| 验收 | AC-RUNTIME-03-1, AC-RUNTIME-03-2, AC-RUNTIME-03-3, AC-RUNTIME-03-4 |
| 依赖 | - |
| 写集 | src/agent/page-context.ts, src/agent/page-context.test.ts, src/agent/orchestrator.ts, src/agent/orchestrator.test.ts |
| 负责人 | root |
| 依赖确认 | 基线 df64e8f 加本会话未提交的字幕 AI 修订改动；orchestrator 与 guarded-tools 契约不变 |
| 完成日期 | 2026-10-09 |
| 实施记录 | records/i3/T-RUNTIME-03.md |
| 集成版本 | df64e8f + 本会话未提交改动 |

#### 实现要点
按本模块 I3 设计实现注册表、`useAgentPageContext`、`buildPageContextSection`、`pageTools`，在 orchestrator 第一次 await 前解析页面并合并工具；固定工具同名优先。不持久化，不改变会话导出。

#### 验证计划
| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-RUNTIME-03-1 | unit | required | node node_modules/vitest/vitest.mjs run src/agent src/store/agent：注册/注销/替换、路由匹配、快照截断与异常、请求含当前页面段与页面工具、失效注册返回 page_unavailable，既有用例无回归 | - |
| V-RUNTIME-03-2 | static | required | node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json | - |


### T-RUNTIME-02 修复停止、确认上下文与归档协议

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-RUNTIME-02 |
| 验收 | AC-RUNTIME-02-1, AC-RUNTIME-02-2, AC-RUNTIME-02-3, AC-RUNTIME-02-4 |
| 依赖 | - |
| 写集 | src/agent/orchestrator.ts, src/agent/orchestrator.test.ts, src/agent/runtime/responses-agent-adapter.ts, src/agent/runtime/responses-agent-adapter.test.ts, src/agent/tool-executor.ts, src/agent/tool-executor-translation.test.ts, src/agent/session-io.ts, src/agent/session-io.test.ts, src/services/rename/nameTranslationPlanner.ts, src/services/rename/nameTranslationPlanner.test.ts |
| 负责人 | audit_runtime |
| 依赖确认 | 同一161b109基线；tools与UI消费已有接口，export typed结果已同步；共享executor本轮由runtime单写 |
| 完成日期 | 2026-10-03 |
| 实施记录 | records/i2/T-RUNTIME-02.md |
| 集成版本 | 161b109 + records/i2/source-snapshot.json (432f739d9aaad6c65a05c15e505a22fa14ecc77832273bd15cb1c729ee5c8495) |

#### 实现要点
按本模块 I2 design 与复审记录修复；保留原授权边界，Responses 仅当前 turn 内存回传，不改模型参数。

#### 验证计划
| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-RUNTIME-02-1 | unit | required | Vitest 定向运行上述测试：取消无后续请求、长历史确认投影、导出边界及取消、Responses原序与不完整流/密文预算 | - |
| V-RUNTIME-02-2 | static | required | tsc --noEmit 与 git diff --check | - |

### T-RUNTIME-01 建立可取消隔离的运行循环与完整工具历史

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-RUNTIME-01 |
| 验收 | AC-RUNTIME-01-1, AC-RUNTIME-01-2, AC-RUNTIME-01-3 |
| 依赖 | - |
| 写集 | src/agent/orchestrator.ts, src/agent/orchestrator.test.ts, src/agent/runtime/, src/agent/conversation-context.ts, src/agent/conversation-context.test.ts, src/agent/guarded-tools.ts, src/agent/guarded-tools.test.ts |
| 负责人 | audit_runtime |
| 依赖确认 | 无前置任务；共享 store/types/tools/executor 由集成负责人单写，集成时核对 abortSignal 与 catalog/plan 合约 |
| 完成日期 | 2026-10-03 |
| 实施记录 | records/T-RUNTIME-01.md |
| 集成版本 | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |

#### 实现要点

按 design.md 建立 turn 同步认领、会话变化取消和逐事件归属校验。实现工具串行及 call ID 去重包装，透传取消 context。抽取纯函数上下文预算，补完中断调用配对并接入两条 adapter。统一 incomplete、工具参数错误、tool-error、取消和 maxSteps 语义。系统提示词在集成时引用工具目录/当前计划，禁止重新引入旧的五工具限定描述。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-RUNTIME-01-1 | unit | required | node node_modules/vitest/vitest.mjs run src/agent/orchestrator.test.ts src/agent/guarded-tools.test.ts；覆盖迟到事件、重复发送、串行、取消、重复调用及中断 ledger | - |
| V-RUNTIME-01-2 | unit | required | node node_modules/vitest/vitest.mjs run src/agent/conversation-context.test.ts；覆盖预算、摘要、成对历史、最新用户完整性 | - |
| V-RUNTIME-01-3 | unit | required | node node_modules/vitest/vitest.mjs run src/agent/runtime；覆盖两种协议正常/失败/截断/参数错误/取消/步数上限 | - |
| V-RUNTIME-01-4 | static | required | node node_modules/typescript/bin/tsc --noEmit --pretty false 与 git diff --check | - |
