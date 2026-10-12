# data 需求

需求行为只在这里定义；业务目标见 [brd.md](../../brd.md)，总体方案见 [architecture.md](../../architecture.md)。

## 目标与范围

FK-TK/2 协议与校验、主进程存储（版本不符时整体归档）与服务、IPC 与预加载、执行解析 v3 与冻结快照、导入导出、提案构造、生成产物；I4 负责编写 Skill 文档与全量一致性检查。

## 范围外

页面与工作台 UI（module-page / module-studio）；Agent 工具（module-agent）；旧版数据的迁移、转换与兼容读取（用户决定作废，见 [architecture §3](../../architecture.md#3-旧版数据直接作废不做兼容)）。

## 需求

### R-DATA-01 FK-TK/2 协议与校验

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

按 [architecture §2.2](../../architecture.md#22-fk-tk2-协议srctranslation-knowledgeschemasts-重写) 定义协议：资料集、三种条目、预设、可选 origin；`validatePackage` 做结构与语义校验并给出带路径的诊断。

#### 验收标准

- AC-DATA-01-1: 在合法的 v2 包（含三种条目、停用条目、带 origin 的条目、预设）上运行 `validatePackage`，结果为通过且没有错误诊断。
- AC-DATA-01-2: 包中出现条目引用不存在的资料集、预设引用不存在的资料集、预设方向与其资料集方向不一致、重复 id、未知字段时，校验失败，诊断指出对应 JSON 路径与错误码。
- AC-DATA-01-3: `schemaVersion` 不是 2 的包（包括 1）校验失败，错误码为 `UNSUPPORTED_SCHEMA_VERSION`，不做任何转换。
- AC-DATA-01-4: 同一资料集内重复的原词（规范化后相同）给出警告；不同资料集中原词相同但译法不同给出警告，不阻断。

#### 边界与异常

沿用 `LIMITS`（文件 32 MiB、实体 20000、文本 32 KiB）；超限报错，不截断。

### R-DATA-02 存储版本不符时归档并重新开始

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

存储层只认当前存储格式（指针 version 2、stored format 3）。启动时发现 `current.json` 的版本不是当前版本，就不解析旧内容，把资料库目录下的全部文件原样移入 `archive/<UTC 时间戳>/`，然后以空库开始。

#### 验收标准

- AC-DATA-02-1: 在隔离目录中放入基线版本产生的资料库文件（`current.json`、若干 `generation-*.json`、`purge-*.json`），`read()` 返回空的 v2 库；原文件全部出现在 `archive/<时间戳>/`，字节不变；资料库根目录只剩新库文件。
- AC-DATA-02-2: 归档后立即保存一个资料集成功；再次 `read()` 不再归档，数据保留。
- AC-DATA-02-3: 指针版本正确，但代文件缺失、摘要不符或内容非法时，`read()` 返回错误，不归档、不清空。
- AC-DATA-02-4: 归档中途移动失败时不发布新库，返回 `storage_unavailable` 与诊断；已移动的文件在归档目录，未移动的仍在原位；下次启动继续归档剩余文件后再开始。

#### 边界与异常

资料库目录不存在或为空时直接以空库开始，不创建归档目录。

### R-DATA-03 存储格式与保留代数

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P1 |

#### 说明

stored format 3 只保存 generation 与 v2 数据；每次发布后只保留最近 20 代代文件。

#### 验收标准

- AC-DATA-03-1: 连续保存 25 次后，目录中 `generation-*.json` 不超过 20 个，最新一代与 `current.json` 一致；`archive/` 目录与其他非代文件不受影响。
- AC-DATA-03-2: 携带过期 generation 的写请求返回 `revision_conflict`，不写入任何内容。

#### 边界与异常

保留代数的清理失败（文件被占用）只记日志，不影响本次写入结果，下次发布再试。

### R-DATA-04 资料增删改与撤销删除

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

`saveRecords`（资料集、条目、预设，全有或全无）、`deleteRecords`（删除资料集时连同条目，并从预设中移除）、`restoreRecords`（撤销删除）。保存即生效，没有审核。

#### 验收标准

- AC-DATA-04-1: 一次请求新建资料集与 3 条条目后，快照出现这些记录且 revision 均为 1；条目 `enabled` 按请求保存。
- AC-DATA-04-2: 编辑条目须携带当前 revision，成功后 revision 加 1；revision 过期返回 `revision_conflict`；内容完全相同的保存返回未变化的快照，generation 不增加。
- AC-DATA-04-3: 一次请求中任一项非法（引用不存在、校验失败）时整批不写入，诊断带 `/items/<i>` 前缀。
- AC-DATA-04-4: 删除一个资料集后，其条目一并消失，所有预设的 `collectionIds` 不再含它；返回值包含被删的全部记录（资料集、条目，以及预设修改前的样子）。
- AC-DATA-04-5: 把上一步返回的记录交给 `restoreRecords` 后，资料集、条目、预设引用全部恢复，内容与删除前一致（revision 重新从 1 开始，预设 revision 加 1）。
- AC-DATA-04-6: `restoreRecords` 遇到 id 已存在，或条目引用的资料集既不在本次恢复中也不在库中时，整批拒绝。

#### 边界与异常

单批上限：保存 200 项，删除与恢复 500 项；超出返回 `invalid_input`。

### R-DATA-05 执行解析 v3 与冻结快照 v2

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

按 [architecture §5](../../architecture.md#5-执行解析-v3srctranslation-knowledgeexecutionts) 解析选择：已选资料集中启用、方向一致、未被本次排除的条目参与，术语需命中原文；冻结快照只含所选资料集的闭包。

#### 验收标准

- AC-DATA-05-1: 选择两个资料集时，启用且命中的术语、启用的背景与要求出现在 `items` 中；停用条目不出现且不产生问题；被本次排除的条目产生 `disabled` 提示。
- AC-DATA-05-2: 选择不存在的资料集产生 `resource_missing` 错误；已归档资料集产生 `resource_archived` 错误；资料集方向与选择方向不一致产生 `language_mismatch`；句子源语言与选择方向不一致产生错误。
- AC-DATA-05-3: 两个必须术语在同一句同一位置给出不同译法时产生 `term_conflict` 错误；一必须一优先时，优先的被排除并给出警告。
- AC-DATA-05-6: 一个术语的命中完全落在另一个术语更长的命中之内时（例如「ホロウ」在「零号ホロウ」中），这一处归更长的术语，不产生冲突；短术语只在同一句另有独立命中时才参与该句。只部分重叠、或同一位置译法不同的，仍按 AC-DATA-05-3 处理。
- AC-DATA-05-4: `buildFrozenKnowledgeSnapshot` 与 `buildFrozenAutomaticKnowledge` 产出的快照只包含已选资料集及其条目，能被各自的校验函数重新校验，摘要稳定（同一输入两次得到相同 digest）。
- AC-DATA-05-5: 冻结快照被篡改（摘要不符、条目不在闭包中、版本号不对）时校验报错。

#### 边界与异常

选择的资料集超过 50 个或排除条目超过 2000 条时视为非法输入；资源预算超限时整体阻断（`resource_limit`），必须术语不截断。

### R-DATA-06 导入与导出

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

按 [architecture §6](../../architecture.md#6-导入导出与编写-skill)：导入预览按资料集汇总；导出选择资料集生成 v2 文件。

#### 验收标准

- AC-DATA-06-1: 导入 v2 包时，预览对每个资料集给出新增，或（与本地同 id 时）新增条目数、内容不同条目数、相同条目数；对预设给出新增数。
- AC-DATA-06-2: 提交时选「合并 + 保留本地」只新增条目，本地内容不同的条目不变；选「合并 + 使用导入」，内容不同的条目被替换为导入内容，revision 取本地加 1；选「另存为副本」生成新 id 的资料集与条目，预设引用随之改写；选「跳过」不写入。
- AC-DATA-06-3: 预览计划过期（15 分钟）或库已变化时，提交返回 `plan_expired` 或 `revision_conflict`，不写入。
- AC-DATA-06-4: 导入 `schemaVersion` 不是 2 的包时，预览失败并给出 `UNSUPPORTED_SCHEMA_VERSION`。
- AC-DATA-06-5: 导出选中的两个资料集（不含停用条目）得到的文件能通过 v2 校验，只含这两个资料集与它们的启用条目；勾选「包含预设」时带上只引用这些资料集的预设。
- AC-DATA-06-6: 内容含本地路径或疑似凭据时，导出预览列出警告与位置，用户仍可继续保存；保存不覆盖已存在的文件。

#### 边界与异常

文件超过 32 MiB、不是 UTF-8 JSON、`format` 不对时拒绝并给出诊断；同一计划重复提交返回同一结果，不重复写入。

### R-DATA-07 提案构造 v2

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

`buildKnowledgeProposal` 把 Agent 或记入对话框给出的变更描述（新建 / 修改资料集，新建 / 修改 / 停用 / 启用条目）转换为 `saveRecords` 请求，并给出每项状态（新增、已存在、冲突、过期、无效）与来源标注。没有 adopt，没有对象。

#### 验收标准

- AC-DATA-07-1: 描述「新建资料集『绝区零』（日→中）+ 术语 A→B（basis user_stated）」时，生成的请求包含一个资料集与一条启用的术语，origin 为 `manual`；用同一种子重新构造得到相同 id（确认时可重建）。
- AC-DATA-07-2: 资料集中已有完全相同的术语（无论启用与否）时该项状态为 `exists`，不进入请求；其他同方向资料集中已有同原词但不同译法的启用术语时，该项带 `term_conflict` 警告并附已有译法与资料集名，仍可保存。
- AC-DATA-07-3: basis 为 `agent_inferred` 时 origin 为 `agent`，为 `web` 时 origin 为 `web` 并带 url、title、访问时间；对应项标记 `aiSourced: true`，供卡片提示。
- AC-DATA-07-4: 修改、停用、启用条目时必须带当前 revision；revision 过期的项为 `invalid`（原因 `stale_revision`），整个提案不能确认。

#### 边界与异常

单次提案最多 200 项；资料集方向缺失时该项为 `invalid`，整张卡片不能确认。

### R-DATA-08 生成产物与示例

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P1 |

#### 说明

`knowledge:artifacts` 生成 v2 的 JSON Schema、校验器与 Skill 压缩包；Skill 示例改为 v2；测试共享夹具同步改为 v2。

#### 验收标准

- AC-DATA-08-1: `npm run knowledge:check` 通过；生成的 `knowledge-v2.schema.json` 与 `knowledgePackageJsonSchema()` 一致；Skill 中全部示例能通过 `validate.mjs`；仓库中不再有 v1 示例与 v1 Schema 文件。

#### 边界与异常

产物过期时 `vite build` 的检查插件失败，提示运行 `npm run knowledge:artifacts`。

### R-DATA-09 编写 Skill 文档与模块文档

| 字段 | 值 |
| --- | --- |
| 来源 | BR-06 |
| 状态 | deferred |
| 批次 | I4 |
| 优先级 | P1 |

#### 说明

改写 Skill 的 `SKILL.md`、`references/*`（协议 v2、应用用法、组织与匹配、资料调研），新增「从归档文件夹重建资料」：说明如何把 `archive/<时间戳>/` 中的旧数据交给 AI Agent 按 v2 规范整理成新资料包后导入；改写主进程 `README.md`、避坑笔记、CHANGELOG。

#### 验收标准

- AC-DATA-09-1: 上述文档中不再出现对象、风格、方案、偏好模板、表达习惯、参考译文、待审核等旧概念（「从归档重建」一节描述旧数据时可出现旧字段名）；Skill 压缩包重新生成后 `knowledge:check` 通过。

### R-DATA-10 全量一致性与回归

| 字段 | 值 |
| --- | --- |
| 来源 | BR-06 |
| 状态 | deferred |
| 批次 | I4 |
| 优先级 | P0 |

#### 说明

收尾检查：代码中不再残留旧概念；类型检查、构建、全量测试通过；provenance 审计重新记录。

#### 验收标准

- AC-DATA-10-1: 在 `src/`、`electron/`、`test/` 中 grep `subjects|recipeId|preferenceTemplates|approvals|documentTopicIds|requiredSubjects|'candidate'|needs_review|reviewEntries`，与翻译资料相关的命中为零（与资料无关的同名词人工核对后列出）。
- AC-DATA-10-2: `tsc --noEmit`、`vite build` 与全量 vitest 通过；已知无关失败与基线对比后单独列出。
- AC-DATA-10-3: `node scripts/subtitle-studio-provenance/shared-resource-integration.mjs` 通过。

## 约束

- 协议唯一事实来源是 `src/translation-knowledge/schemas.ts`，不保留任何旧协议副本。
- 所有写盘测试使用临时目录，不触碰真实 userData。
- Windows 下目录同步限制沿用现有处理。
