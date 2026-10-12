# data 设计

总体方案见 [architecture.md](../../architecture.md)。这里写 I1 的实现落点、关键算法与验证方式。无 UI。

## 现状与约束

- 协议、校验、执行、快照位于 `src/translation-knowledge/`（约 1.7k 行），主进程服务位于 `electron/main/translation-knowledge/`（约 1.6k 行）。逐文件影响见 [architecture §7.1–7.3](../../architecture.md#71-共享协议-srctranslation-knowledge)。
- I1 完成后，旧页面和工作台渲染层在类型上暂时不通过，由 I2 / I3 修复。I1 以 vitest 单元 / 集成测试为准（vitest 只转译，不做类型检查），另外对 I1 范围单独运行 `tsc` 子集检查（见验证）。
- 写盘测试一律使用 `os.tmpdir()` 下的隔离目录。
- 不兼容旧数据：不保留旧协议副本，不写迁移，不做旧快照读取。

## 方案与取舍

### 1. 协议 `schemas.ts`

- 按 architecture §2.2 实现。`entrySchema` 为按 `kind` 判别的联合类型，导出 `TermEntry`、`ContextEntry`、`RuleEntry` 类型。
- `knowledgePackageSchema` 的 `schemaVersion: z.literal(2)`。
- `knowledgePackageJsonSchema()` 的标题改为 `FusionKit Translation Knowledge v2`。
- 新增 `summary.ts`，提供 `entrySummary(entry)`：术语输出 `source → target`；说明取正文第一行，截取 120 字。

### 2. 校验 `validation.ts`

沿用现有诊断框架：`Diagnostic { severity, code, path, message }`，最多 100 条，同时做 JSON 字节与深度检查。

规则：

- 结构用 zod 严格解析。版本字段不是 2 时，返回唯一诊断 `UNSUPPORTED_SCHEMA_VERSION`，不再继续解析。
- 唯一性：资料集、条目、预设的 id 在全库内唯一。
- 引用：条目的 `collectionId` 和预设的 `collectionIds` 必须存在，否则报 `MISSING_REFERENCE`。预设的方向必须与其资料集的方向一致，否则报 `PRESET_LANGUAGE_MISMATCH`。
- 术语：
  - `aliases` 不能等于 `source`；
  - 同一资料集内原词重复（用 `normalizeForMatching` 比较）时给出警告 `DUPLICATE_TERM`；
  - 不同资料集中原词相同、译法不同时给出警告 `TERM_DISAGREEMENT`。

### 3. 存储 `repository.ts`

- stored state：`{ format: 3, generation, data }`。指针：`{ version: 2, generation, file, digest }`。
- **版本不符时归档**：`open()` 时读取 `current.json`，只解析出 `version` 字段。
  - 不存在：空库。
  - 等于 2：正常读取。
  - 其他值（包括缺少 version 字段）：归档；`current.json` 不是合法 JSON 时视为损坏并报错（`CURRENT_CORRUPT`），不归档。归档步骤为：
    1. 创建 `archive/<YYYYMMDDTHHmmssZ>/`；
    2. 把根目录下所有普通文件（不含 `archive/` 目录本身）逐个 `rename` 进去；
    3. 全部移动成功后，以空库发布第 1 代。
  - 中途失败不发布，返回 `storage_unavailable`。下次启动时如果根目录仍有旧指针，就继续归档；新的时间戳目录与上次的并存，不合并。
  - 这条规则与旧结构无关，以后存储格式升级时同样适用。
- **损坏时报错**：版本为 2 但代文件缺失、摘要不符或内容非法时，抛出现有的 `storage_unavailable` 并附诊断，不归档。
- **保留代数**：发布成功后列出 `generation-<n>-<uuid>.json`，按 n 排序，删除第 21 代及更早的代文件。删除失败只记日志。
- **删除的旧逻辑**：清除日志的写入与恢复、`cleanupPending` 阻断、`previous` 链、import 收据、变更集。

### 4. 服务 `service.ts`

- `read()` 返回 `{ generation, data }`。
- `saveRecords(request)`：保留现有的单项保存函数结构，去掉 source、adopt、approve、invalidate。写入后对整库运行 `validatePackage`，有错误则拒绝写入。
- `deleteRecords({generation, items})`：
  - 收集被删资料集的全部条目；
  - 引用了被删资料集的预设，移除该 id 并把 revision 加 1；
  - 返回 `deleted`：修改前的完整记录，其中预设是修改前的版本。
- `restoreRecords({generation, records})`：
  - 资料集和条目只在 id 不存在时新建，revision 为 1；
  - 预设按 id 覆盖为给定的旧内容，revision 为当前值加 1；
  - 最后做整体校验，失败则整批拒绝。
- **导入**：
  - `previewImport(bytes, owner)`：解析 JSON，用 v2 `validatePackage` 校验（版本不符直接失败），然后与本地按 id 比较，生成预览。
  - 计划 `{ planId, owner, generation, expiresAt, incoming }` 存在内存中，15 分钟过期；同一 owner 选择新文件时作废旧计划。
  - `commitImport` 按决定合并并发布新的一代。「另存为副本」时为资料集和条目重新映射 id，预设中的引用同步改写。
  - 同一计划重复提交返回同一回执：回执只在内存中保存，有效期与计划相同。
- **导出**：`planExport({collectionIds, includeDisabled, includePresets})`：
  - 构造 v2 包，`package.name` 取单个资料集的名称，多个时用「翻译资料」；
  - 本地路径和疑似凭据的检测函数从现 `export-selection.ts` 迁出复用，结果作为 warnings 返回；
  - 冻结的字节交给 `export-plans.ts`。

### 5. IPC 与预加载

- `ipc.ts` 用 zod 定义 architecture §4 的请求，删除旧渠道。单条保存也走 `save-records`。
- `index.ts` 注册渠道，`readForExecution` 不变。
- `translation-knowledge-api.ts` 与 `vite-env.d.ts` 统一接口类型 `TranslationKnowledgeApi`，包含：`read`、`saveRecords`、`deleteRecords`、`restoreRecords`、`selectImport`、`importDroppedFile`、`commitImport`、`planExport`、`exportFile`、`exportSkill`。

### 6. 执行与快照

- `execution-contract.ts`：

```ts
export const knowledgeSelectionSchema = z.object({ version: z.literal(2), languagePair, collectionIds: ids.max(50),
  disabledEntryIds: ids.max(2000), instructions: text.max(4000).optional(), context: text.max(4000).optional() }).strict()
```

  - 保留 `normalizeKnowledgeSelection`（排序、去重、空字符串转为 undefined）。
  - `KNOWLEDGE_ISSUE_CODES` 只包含 architecture §5 中的码。
  - `CompiledKnowledgeItem` 删除 `title`、`condition`、`evidence`。
- `execution.ts`：按 architecture §5 重写 `resolveEnvironment`。只保留一个策略常量，删除 `supportedKnowledgeExecutionPolicy` 中的旧策略分支。`selectBatchKnowledge`、`compileKnowledge`、`checkRequiredTerms` 只改类型。
- `snapshot-contract.ts`：
  - `captureKnowledgeSelectionData(library, selection)` 返回 `{ collections, entries }`，内容为已选资料集及其全部条目，再加上本次被排除但不属于已选资料集的条目（用于解释）；
  - `frozenKnowledgeSnapshotSchema = { version: 2, generation, policyVersion, selection, data: { collections, entries }, batches, digest }`；
  - 删除 `knowledgeResourceReferences`。
- `automatic-snapshot-contract.ts`：
  - 单一常量 `AUTOMATIC_KNOWLEDGE_POLICY = 'automatic-knowledge-preparation/2;' + KNOWLEDGE_EXECUTION_POLICY`；
  - `frozenAutomaticKnowledgeSchema = { version: 2, policyVersion, generation, selection, data, digest }`；
  - 删除 `automaticKnowledgeExecutionPolicy` 中的旧策略分支和 `automaticKnowledgeResourceReferences`。

### 7. 提案 `proposal.ts`

- 输入 `KnowledgeChangeInput`：
  - `collections[]`：`{ref, name, description, languagePair}`；
  - `entries[]`：`{action: 'create'|'update'|'disable'|'enable', entryId?, revision?, collection, kind: 'term'|'context'|'rule', source?, target?, aliases?, note?, strength?, text?, required?, basis, url?, urlTitle?, accessedAt?}`。
- 输出 `KnowledgeProposal`：
  - `items`：每项包含状态（`new`、`update`、`exists`、`conflict`、`stale`、`invalid`）、`aiSourced` 和预览摘要；
  - `counts`；
  - `request(generation)`：返回 `SaveRecordsRequest`。
- 新建资料集时，如果已有同名同方向的资料集，直接复用。
- 种子到 id 的映射沿用现有实现，确保重建时得到相同的 id。
- `basis` 到 `origin.kind` 的映射：`user_stated → manual`、`user_revision → revision`、`document → import`、`agent_inferred → agent`、`web → web`。

### 8. 生成产物

- `build-artifacts.mjs` 输出 `resources/translation-knowledge/knowledge-v2.schema.json` 和 Skill 的 `references/knowledge-v2.schema.json`，并删除 v1 的同名文件。
- `skill-archive.mjs` 的文件清单同步更新。
- Skill 示例：
  - 新增 `minimal.fktk.json`、`ja-starter.fktk.json`、`multi-collection.fktk.json`（含预设和停用条目）；
  - 新增 `invalid/missing-collection.fktk.json`、`invalid/duplicate-key.fktk.json`、`invalid/unsupported-version.fktk.json`；
  - 删除 `multi-subject`、`update`、`invalid/expression-without-speaker`、`invalid/required-advisory`。
- `test/translation-knowledge/fixtures.ts` 改为加载 `multi-collection.fktk.json`。

## 代码落点

- `src/translation-knowledge/`：
  - 改写：`schemas.ts`、`validation.ts`、`ipc-contract.ts`、`export-contract.ts`、`execution-contract.ts`、`execution.ts`、`snapshot-contract.ts`、`automatic-snapshot-contract.ts`、`proposal.ts`；
  - 新增：`summary.ts`；
  - 删除：`review-policy.ts`、`task-reference-contract.ts`、`maintenance-contract.ts`。
- `electron/main/translation-knowledge/`：
  - 改写：`repository.ts`、`service.ts`、`export-selection.ts`、`export-plans.ts`、`ipc.ts`、`index.ts`、`errors.ts`、`skill-archive.generated.ts`；
  - 删除：`maintenance.ts`、`maintenance-storage.ts`、`task-gate.ts`。
- 其他：`electron/preload/translation-knowledge-api.ts`、`electron/preload/index.ts`、`electron/main/index.ts`、`src/vite-env.d.ts`。
- 生成脚本与产物：`scripts/translation-knowledge/*`、`resources/translation-knowledge/`、`.agents/skills/fusionkit-translation-knowledge/{examples,references/*.schema.json,scripts/validate.mjs}`、`package.json` / `vite.config.ts`（如需）。
- 测试：
  - 重写或新建 `test/translation-knowledge/{schema,validation,repository,service,import,export,export-plans,execution,snapshot,automatic-snapshot,proposal,protocol,skill-archive,ipc}.test.ts`；
  - 删除 `maintenance*.test.ts`、`task-maintenance.test.ts`、`batch-review.test.ts`、`export-selection.test.ts`，以及其他只测试旧概念的文件。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-DATA-01 | §1 协议、§2 校验 |
| R-DATA-02 | §3 版本不符时归档 |
| R-DATA-03 | §3 存储格式与保留代数 |
| R-DATA-04 | §4 saveRecords / deleteRecords / restoreRecords、§5 IPC |
| R-DATA-05 | §6 执行与快照 |
| R-DATA-06 | §4 导入导出 |
| R-DATA-07 | §7 提案 |
| R-DATA-08 | §8 生成产物 |

## 验证与风险

- **单元测试**：每条校验规则、每个问题码各有用例；摘要稳定性；提案 id 重建。
- **集成测试**：在真实临时目录中验证以下场景：
  - 归档：直接写入非当前版本的指针（如 `{"version":1,…}`）与若干任意文件，只验证「原样移动」。
  - 中断恢复：可注入的 rename 钩子在第 2 个文件处抛错。
  - 保留代数。
  - 增删改与撤销。
  - 导入导出。
- **类型子集检查**：I1 期间，`tsconfig.json` 全量检查会因旧页面报错，所以在 scratchpad 中用临时 tsconfig 只包含 `src/translation-knowledge/`、`electron/main/translation-knowledge/`、`src/subtitle-studio/`、`electron/main/subtitle-studio/` 及其测试，确保 I1 范围内类型正确。
- **风险**：用户真实资料库在首次启动时被归档（移动，不删除），由用户自己启动；开发与测试只使用隔离目录。
