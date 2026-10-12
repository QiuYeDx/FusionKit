# agent 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。
元数据引用需求与 AC；不要复制 AC 文本。命令约定同 [module-data/tasks.md](../module-data/tasks.md)。

### T-AGENT-01 资料工具、提示词与自动翻译参数

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-AGENT-01, R-AGENT-02, R-AGENT-03 |
| 验收 | AC-AGENT-01-1, AC-AGENT-01-2, AC-AGENT-01-3, AC-AGENT-02-3, AC-AGENT-02-4, AC-AGENT-03-1, AC-AGENT-03-2 |
| 依赖 | T-DATA-06 |
| 写集 | src/agent/knowledge-tools.ts, src/agent/knowledge-tools.test.ts, src/agent/prepared-actions.ts, src/agent/prepared-actions.test.ts, src/agent/orchestrator.ts, src/agent/orchestrator.test.ts, src/agent/modern-tools.ts, src/agent/modern-tools.test.ts, src/agent/web-tools.ts, src/agent/web-tools.test.ts, src/agent/capability-catalog.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-DATA-06：同一工作树，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i2/T-AGENT-01.md |
| 集成版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

#### 实现要点

按 [设计](design.md) 实现以下改动：
- 三个工具使用严格 schema；遇到旧字段时拒绝，并返回可读提示。
- 检索：条目继承所在资料集的名称参与检索；多个词必须全部命中。
- 目录：返回资料集与预设。
- 准备变更：调用新提案接口，不再有 adopt。
- prepared-actions：删除 adopt 选择。
- 提示词：去掉对象、方案、待审核相关内容。
- prepare_studio_transcription：支持展开 presetId。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AGENT-01-1 | unit | required | VT src/agent/knowledge-tools.test.ts src/agent/prepared-actions.test.ts src/agent/orchestrator.test.ts src/agent/modern-tools.test.ts src/agent/web-tools.test.ts src/agent/capability-catalog.test.ts | - |

### T-AGENT-02 资料变更卡片与结果展示

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-AGENT-02 |
| 验收 | AC-AGENT-02-1, AC-AGENT-02-2 |
| 依赖 | T-AGENT-01 |
| 写集 | src/pages/HomeAgent/components/AgentKnowledgeChanges.tsx, src/pages/HomeAgent/components/AgentPreparedActions.tsx, src/pages/HomeAgent/components/AgentToolResult.tsx, src/pages/HomeAgent/components/AgentToolCall.tsx, src/pages/HomeAgent/components/action-error.ts, src/pages/HomeAgent/presentation.test.ts, test/agent-knowledge.electron.test.ts, test/agent-web.electron.test.ts, src/locales/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-AGENT-01：同一工作树，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i2/T-AGENT-02.md |
| 集成版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

#### 实现要点

- 卡片：删除采纳开关；每行显示动作、类型、摘要、资料集和来源标签（AI 推断 / 网页站点）。
- 结果：展示资料集与预设；字段缺失时不显示。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AGENT-02-1 | unit | required | VT src/pages/HomeAgent/presentation.test.ts | - |
| V-AGENT-02-2 | browser | required | 改写 test/agent-knowledge.electron.test.ts 与 agent-web.electron.test.ts（静默窗口、模拟模型）：复现「记到绝区零资料」场景，确认后条目启用；网页来源标签可见 | - |
| V-AGENT-02-3 | manual | required | 截图审查资料变更卡片（中 / 英、亮 / 暗），包含 AI 推断与网页来源两类行 | - |
