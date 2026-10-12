# agent 设计

I2 开始前细化。以下为已确定的方案。

## 现状与约束

逐文件清单见 [architecture §7.7](../../architecture.md#77-agent)。

- 三个工具位于 `src/agent/knowledge-tools.ts`；
- 确认卡片通过 `registerPreparedAction`（`prepared-actions.ts`）注册，由 `AgentKnowledgeChanges` / `AgentPreparedActions` 渲染；
- 保存走 `saveProposal` → `saveRecords`；
- 卡片不持久化，会话 JSON 中的 `toolResult.data` 为 unknown。

## 方案与取舍

- **工具 schema**：输入用 zod 严格定义，旧字段直接被拒绝。错误信息由现有工具错误通道返回给模型，让模型自行修正。
- **检索**：分词后对每条记录拼接可检索文本，规则如下（全部经 `normalize('NFKC').toLocaleLowerCase()` 处理）：
  - 资料集：名称和说明；
  - 术语：原词、译法、别名、备注；
  - 说明：正文。
  - 条目同时继承所属资料集的名称，因此「绝区零 大小姐」可以命中。
  - 分页沿用现有实现。
- **卡片**：
  - `PreparedKnowledgeChanges = { items, counts }`，`PreparedActionChoice` 删除；
  - `confirmAction(id)` 不再带参数；
  - 行内展示：动作（新建 / 修改 / 停用 / 启用）、类型、摘要、所属资料集、来源标签。
- **提示词**（`orchestrator.ts:119-124`）：
  - 改为「先用 list_translation_knowledge_catalog 找资料集；找不到就在 prepare_knowledge_changes 中新建一个，资料集名用作品 / 主播名，并写明翻译方向」；
  - basis 规则保留；
  - 「工作台中勾选资料集或应用预设后生效」。
- **自动翻译参数**：`modern-tools.ts` 读取库，展开 presetId，调用 `setAutomaticKnowledge({ enabled, sourceLanguage, collectionIds, disabledEntryIds: [], instructions?, context? })`。
- **结果渲染**：`AgentToolResult` 按新字段读取 knowledge 结果（`collections`、`entries`、`presets`），字段缺失时不显示；这是对 unknown 数据的常规防御，不针对旧格式，也不迁移会话文件。

## 代码落点

architecture §7.7 中的文件，以及 `src/locales/*/home.json` 的 knowledge 键。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-AGENT-01 | 工具 schema、检索 |
| R-AGENT-02 | 卡片、proposal 接入 |
| R-AGENT-03 | 提示词、自动翻译参数 |

## 验证与风险

- 单元：`src/agent/knowledge-tools.test.ts`、`prepared-actions.test.ts`、`orchestrator.test.ts`、`modern-tools.test.ts`、`web-tools.test.ts`、`HomeAgent/presentation.test.ts` 按新结构重写。
- e2e：`test/agent-knowledge.electron.test.ts` 用模拟模型脚本复现 AC-AGENT-02-1；`agent-web` 检查网页来源标签。
- 风险：模型可能仍按旧习惯传 `subjects`。对策：schema 拒绝时返回明确的错误文字（「资料集即作品，不需要 subjects」），并在工具描述中写明。
