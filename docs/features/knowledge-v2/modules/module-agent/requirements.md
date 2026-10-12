# agent 需求

需求行为只在这里定义；业务目标见 [brd.md](../../brd.md)。本模块替代 `docs/features/agent-knowledge-loop` 中与「待审核 / 对象 / 方案」有关的行为。agent-knowledge-loop 的其余原则不变：提议—确认—保存、原子保存、不删除、联网需开启。

## 目标与范围

Agent 的翻译资料工具（检索、目录、准备变更）、变更卡片、提示词，以及转写自动翻译工具的资料参数。

## 范围外

联网查证工具本身（`web-tools.ts` 只调整导入）；Agent 会话存储格式。

## 需求

### R-AGENT-01 检索与目录工具 v2

| 字段 | 值 |
| --- | --- |
| 来源 | BR-04 |
| 状态 | active |
| 批次 | I2 |
| 优先级 | P0 |

#### 说明

`search_translation_knowledge` 输入 `{query, collectionId?, kind?: all|term|context|rule, languagePair?, includeDisabled?, page?}`，返回条目（id、revision、kind、collectionId、enabled、summary）、资料集、预设；检索范围包括资料集名称与说明、术语原词 / 译法 / 别名 / 备注、说明正文。`list_translation_knowledge_catalog` 返回资料集（名称、说明、方向、条目数、启用数、是否归档）和预设（名称、方向、资料集名）。

#### 验收标准

- AC-AGENT-01-1: 库中有资料集「绝区零」及其术语时，搜索「绝区零 大小姐」能命中该资料集及含「大小姐」的条目（多词按空白分词，全部命中才算匹配）。
- AC-AGENT-01-2: 停用条目默认不返回，`includeDisabled: true` 时返回并带 `enabled: false`。
- AC-AGENT-01-3: 工具输出中不再出现 subjects、recipes、state、review 等字段；旧输入字段（如 `subjectId`、`state`）被 schema 拒绝，并给出可读的错误。

#### 边界与异常

资料库不可读时工具返回明确错误（storage_unavailable），不返回空结果冒充「没有资料」。

### R-AGENT-02 准备资料变更与确认卡片

| 字段 | 值 |
| --- | --- |
| 来源 | BR-04 |
| 状态 | active |
| 批次 | I2 |
| 优先级 | P0 |

#### 说明

`prepare_knowledge_changes` 输入：

- `collections[]`：`{ref, name, description?, languagePair}`；
- `entries[]`：`{action: create|update|disable|enable, entryId?, revision?, collection, kind: term|context|rule, source?, target?, aliases?, note?, strength?, text?, required?, basis, url?, urlTitle?}`。

工具调用 `buildKnowledgeProposal` 生成卡片，用户确认后原子保存，保存即生效。卡片没有采纳开关，对 `aiSourced` 的项显示「AI 推断」或「网页：{站点}」标签，并提示「请核对」。

#### 验收标准

- AC-AGENT-02-1: 复现「把泰姆菲尔德家的大小姐记到绝区零的资料里」：库中没有该资料集时，卡片包含新建资料集（带方向）与术语；确认后两者保存且术语启用，Agent 收到 `{executionStatus: 'saved', counts, collectionIds}`。
- AC-AGENT-02-2: 卡片项来自 `agent_inferred` 或 `web` 时显示来源标签；来自 `user_stated` 时不显示。
- AC-AGENT-02-3: 取消或保存失败时不写入任何内容；资料库在确认前已变化（generation 变化）时，重建提案后仍能保存；条目 revision 过期时卡片显示「资料已被修改，请让 Agent 重新准备」，不能确认。
- AC-AGENT-02-4: Agent 不能删除资料：输入中没有 delete 动作，提示词也明确只能新建、修改、停用。

#### 边界与异常

确认时资料库读取失败或保存失败，卡片显示失败原因，可重试；重试以相同 id 重建，不产生重复条目。

### R-AGENT-03 提示词与自动翻译参数

| 字段 | 值 |
| --- | --- |
| 来源 | BR-04 |
| 状态 | active |
| 批次 | I2 |
| 优先级 | P1 |

#### 说明

orchestrator 提示词改为「资料集对应作品 / 主播 / 系列」，删除对象、方案、待审核的说法；`prepare_studio_transcription` 的 `translation.knowledge` 改为 `{collectionIds, presetId?, sourceLanguage}`（presetId 由工具展开为资料集）。

#### 验收标准

- AC-AGENT-03-1: 系统提示词与工具描述中不再出现「对象 / subject / 方案 / recipe / 待审核 / adopt」。
- AC-AGENT-03-2: `prepare_studio_transcription` 传入 presetId 时，自动翻译设置写入该预设的资料集和要求；presetId 不存在时返回可读的错误，不写入。

#### 边界与异常

presetId 指向的预设方向与转写目标方向不一致时返回可读错误，不写入设置。
