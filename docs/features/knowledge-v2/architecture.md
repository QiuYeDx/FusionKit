# 翻译资料 v2：总体设计

基线 `473d58e`。本文件是跨模块的总体方案与**全量影响清单**；各模块的可验收需求在 `modules/*/requirements.md`，实施细节在 `modules/*/design.md`。

## 1. 现状与问题

### 1.1 现有模型（FK-TK/1，`src/translation-knowledge/schemas.ts`）

7 类实体：`subjects`、`collections`、`sources`、`entries`、`styles`、`recipes`、`preferenceTemplates`。

- 条目 5 种：`term`、`context`、`expression`、`memory`、`rule`。
- 每条条目都带：
  - 标题；
  - 作用范围 `scope`：语言方向、必需对象及其角色、使用条件；
  - 状态（5 种）；
  - 至少一条证据（指向来源实体）；
  - 派生关系。
- 主进程另存 `approvals[entryId] = {revision, digest}`。条目必须同时满足「已采纳」和「指纹匹配」才算可信，否则界面显示为「待确认导入」。

### 1.2 哪些真正参与翻译（`src/translation-knowledge/execution.ts`）

- 参与翻译的只有：已选资料集中、可信、语言匹配的 term / context / rule。
- 方案只贡献两样东西：
  - `readCollectionIds`；
  - `instructions` / `context`。
- 风格（`execution.ts:78-86`）只做校验，不改变任何参与的条目。
- 偏好模板没有任何读取方。
- 表达习惯和参考译文会被直接标记为 `unsupported_kind`。
- 对象绑定：批量翻译（`translation-session.ts:89`、`knowledge-batch-translation.ts:100`）会清空 `bindings` 和 `confirmations`。整篇翻译只有 `documentTopicIds` 会变成主题绑定（`knowledge-translation.ts:28-45`）。

### 1.3 复杂度来源

- 存储协议几乎原样变成了界面结构：侧栏、表单和状态都直接对应协议字段。
- 为「审核 / 信任」与「可撤销的维护」配套了大量机制：
  - approvals 与指纹；
  - needs_review 级联；
  - 导入变更集与撤销；
  - 维护预览与提交；
  - 清除历史的日志与恢复；
  - 任务资源闸门（`task-gate.ts`、`knowledgeResourceReferences`）。
- 两套执行策略（v1 / v2）是为兼容冻结的旧记录而保留的。

## 2. v2 概念与数据模型

### 2.1 用户心智

| 概念 | 一句话 | 出现位置 |
| --- | --- | --- |
| 资料集 | 一个作品 / 主播 / 系列的词典和备忘，有一个翻译方向 | 资料页左侧、工作台选择器 |
| 术语 | 原词 → 译法；可设「必须 / 优先 / 保留原文」 | 资料集 · 术语表 |
| 说明 | 给 AI 的背景或要求，可标「重要」（始终发送） | 资料集 · 说明 |
| 启用 / 停用 | 停用的条目保留，但不参与翻译 | 条目开关 |
| 预设 | 工作台里常用的「资料集组合 + 翻译要求 + 内容说明」 | 工作台选择器 |

### 2.2 FK-TK/2 协议（`src/translation-knowledge/schemas.ts` 重写）

```ts
package = {
  format: 'fusionkit.translation-knowledge', schemaVersion: 2,
  package: { id, revision, name, description, createdAt, generator: { name, version? }, author?, sharingNote? },
  collections: Collection[], entries: Entry[], presets: Preset[], extensions?
}
Collection = { id, revision, name, description, languagePair: { source, target }, archived: boolean, extensions? }
Entry = { id, revision, collectionId, enabled: boolean, origin?: Origin, extensions? } & (
  | { kind: 'term',    payload: { source, target, aliases: string[], note: string,
                                  strength: 'required' | 'preferred' | 'keep_source',
                                  match: { mode: 'whole_term' | 'literal_phrase', caseSensitive: boolean } } }
  | { kind: 'context', payload: { text, required: boolean } }   // 背景
  | { kind: 'rule',    payload: { text, required: boolean } } ) // 要求
Origin = { kind: 'manual' | 'revision' | 'agent' | 'web' | 'import', note?, url?, title?, at? }
Preset = { id, revision, name, languagePair, collectionIds: uuid[], instructions: string, context: string, extensions? }
```

字段取舍：

- **语言方向放在资料集上**，条目不再各带一个；`languagePair` 必填。
- **删除条目标题**：列表和摘要直接从 payload 生成（`entrySummary`）。
- **删除以下概念**：
  - 状态和批准，由 `enabled` 取代；
  - 证据、来源实体、派生关系，由可选的 `origin` 取代（网页来源保留 url 和 title）；
  - 对象和作用范围。
- **其他字段的变化**：
  - `context.core` 和 `rule.strength` 统一为 `required`；
  - `rule.dimension` 和 `context.assertion` 删除；
  - `term.sense` 改名为 `note`。
- **不变的部分**：匹配引擎（`matching.ts`）及其 `match` 结构；资源上限 `LIMITS`。
- **版本**：`schemaVersion` 只接受 2。其他版本统一报 `UNSUPPORTED_SCHEMA_VERSION`，不做任何转换。

### 2.3 资料集「自带要求」与预设的分工

- **资料集自带要求**：就是该资料集「说明」下的要求条目，不另设 instructions 字段，避免同一件事在两处维护。
- **预设**：工作台层面的快捷组合。
  - 存在资料库里，会随导出一起带走；只在工作台选择器里创建和管理。
  - 应用预设 = 把它的资料集、翻译要求、内容说明填进本次选择。选择不保留对预设的引用。
- **最近使用**：工作台偏好（localStorage）记录最近 5 组资料集组合，不进资料库。

## 3. 旧版数据：直接作废，不做兼容

用户决定（2026-10-12）：当前不是正式版，历史数据直接作废；新代码中不引入任何读取、转换旧格式的逻辑。旧资料以后由用户借助 AI Agent，按 v2 规范重新创建。

| 旧数据 | 新版行为 |
| --- | --- |
| 资料库 `userData/translation-knowledge/` | 存储层只认当前存储格式。启动时发现 `current.json` 不是当前格式（不解析内容，只看版本字段），就把目录下的全部文件原样移入 `translation-knowledge/archive/<UTC 时间戳>/`，然后以空库启动。这是通用的「存储版本不符 → 归档后重新开始」规则，不了解也不读取旧结构。文件损坏（版本相符但摘要不对、内容非法）仍然报错，不归档、不清空 |
| v1 `.fktk.json` 资料包 | 导入时报「不支持的资料包版本（需要 2）」 |
| 字幕文档中冻结的旧资料（执行记录、转写后自动翻译意图） | 不做兼容。执行记录本来就以 unknown 形式存储，旧记录校验失败后会走现有的「记录不可用」路径（不能查看资料详情，也不能续跑）。自动翻译意图是严格校验的，含旧冻结资料的文档快照会读取失败；受影响的只有用过「转写后自动翻译 + 翻译资料」的文档，按作废处理 |
| 工作台偏好 `autoTranslation.knowledge` | 不做预处理。旧值不符合新结构时，`readTranscriptionPreferences` 走现有逻辑回落默认值（转写设置会重置一次） |
| Agent 会话中的旧资料工具结果 | 不迁移。结果渲染按新字段读取，字段不存在时不显示（这是对 unknown 数据的常规防御，不针对旧格式） |

后续重建旧资料的办法：在 I4 的资料编写 Skill 文档中加一节「从归档文件夹重建资料」。把归档目录中的 `generation-*.json` 交给 AI Agent（Claude Code / 应用内 Agent 均可），让它按 v2 协议整理出新的 `.fktk.json`，再导入应用。这只是文档，应用代码不涉及。

## 4. 存储与服务（主进程）

- **根目录不变**：`userData/translation-knowledge/`。
- **保留的机制**：不可变的 `generation-N-UUID.json`、`current.json` 指针替换发布、单队列串行、generation 冲突检测、记录级 revision。
- **stored state**：`{ format: 3, generation, data: KnowledgePackageV2 }`。指针：`{ version: 2, generation, file, digest }`。
- **保留代数**：每次发布成功后，只保留最近 20 代代文件，删除更早的。只删名称匹配、是普通文件、且不是当前代的文件。
- **IPC**（`translation-knowledge:*`，信封和 capability 机制不变）：

| 渠道 | 请求 | 返回 | 变化 |
| --- | --- | --- | --- |
| `read` | `{}` | `LibrarySnapshot{generation, data}` | 去掉 approvals、imports、maintenance |
| `save-records` | `{generation, items: [{group: 'collections' \| 'entries' \| 'presets', record}]}`，最多 200 项，全有或全无 | LibrarySnapshot | 去掉 source、adopt；新增 presets 组 |
| `delete-records` | `{generation, items: [{group, id}]}`，最多 500 项 | `{snapshot, deleted: Record[]}` | **新增**。删除资料集时连同其条目一起删除，并从预设中移除该资料集；返回被删记录，供撤销使用 |
| `restore-records` | `{generation, records}` | LibrarySnapshot | **新增**。撤销删除：按原 id 重建（revision 从 1 开始）；引用了不存在的资料集时拒绝 |
| `select-import` / `import-dropped-file` | — | `ImportPreview` | 预览按资料集汇总 |
| `commit-import` | `{planId, collections: [{id, action: 'add' \| 'merge' \| 'copy' \| 'skip'}], conflict: 'keep_local' \| 'use_incoming', presets: 'add' \| 'skip'}` | ImportReceipt | 去掉 adoptReady 和逐条决定 |
| `plan-export` | `{collectionIds, includeDisabled, includePresets}` | ExportPreview（计数 + 警告 + planId） | 去掉分享 / 备份之分，以及来源、记忆、待审核等选项 |
| `export-file` / `export-skill` | 不变 | 不变 | — |
| 删除的渠道 | `save-record`、`review-entries`、`plan-maintenance`、`commit-maintenance` | | |

- 执行侧的 `readForExecution` 不变，返回 v2 快照。

## 5. 执行解析 v3（`src/translation-knowledge/execution.ts`）

- **策略**：只有一个，`fktk-execution/4;${MATCH_POLICY_VERSION};term-context-rule`（2026-10-12 由 /3 升为 /4：长词优先）。删除 v1 / v2 两个旧策略。
- **选择**：`KnowledgeSelection = { version: 2, languagePair, collectionIds, disabledEntryIds, instructions?, context? }`。删除 recipeId、bindings、confirmations。
- **解析规则**：在已选资料集中挑出参与的条目。资料集不存在报 `resource_missing`，已归档报 `resource_archived`。条目需同时满足：
  - `enabled === true`（停用的直接跳过，不产生问题）；
  - 不在本次排除列表中（被排除的给出 `disabled` 提示）；
  - 资料集方向与选择方向一致（不一致报 `language_mismatch`）；
  - 术语需命中原文（未命中报 `no_match`）。
- **长词优先**：同一句中，一个术语的命中完全落在另一个术语更长的命中之内时归更长的术语（不算冲突）；短术语若在该句另有独立命中仍参与。
- **沿用部分**：其余冲突检测只看术语（部分重叠或同一位置译法不同）；资源预算、`compileKnowledge`、`checkRequiredTerms` 沿用。
- **`required` 的含义**：术语是 `strength !== 'preferred'`；说明是 `payload.required`。
- **问题码**：`selection_invalid`、`resource_missing`、`resource_archived`、`language_mismatch`、`disabled`、`no_match`、`term_conflict`、`resource_limit`、`budget_excluded`、`budget_required`、`required_term_suspect`。
- **冻结快照**（重写 `snapshot-contract.ts` 和 `automatic-snapshot-contract.ts`）：
  - 结构：`{ version: 2, policyVersion, generation, selection, data: { collections, entries }, … }`，不含 approvals 和 documentTopicIds。
  - 闭包：已选资料集及其全部条目。
  - 版本号不对时直接校验失败。

## 6. 导入、导出与编写 Skill

- **导出**：
  - 选择资料集，可选「包含停用条目」「包含引用这些资料集的预设」；
  - 生成单个 v2 `.fktk.json`，冻结字节、计划 id、原生保存边界沿用 `export-plans.ts`；
  - 发现本地路径或疑似凭据时作为**警告**展示，由用户决定是否继续。
- **导入预览**：按资料集分别列出：
  - 新资料集；
  - 与本地同 id 的资料集，给出新增条目数、内容不同条目数、相同条目数；
  - 预设。
- **导入决定**：
  - 资料集：新增 / 合并 / 另存为副本 / 跳过；
  - 冲突条目：统一选「保留本地」或「使用导入」；
  - 条目保持文件里的 `enabled`。
- **编写 Skill**：
  - 来源仍为 `.agents/skills/fusionkit-translation-knowledge/`，改写为 v2 文档和示例，并加入「从归档文件夹重建资料」一节（I4）；
  - `scripts/translation-knowledge/build-artifacts.mjs` 生成 `knowledge-v2.schema.json` 和 `validate.mjs`。

## 7. 全量影响清单

处理方式：**重写**、**改**（局部修改）、**删**（删除文件）、**新**（新建）、**留**（已核对，不改）。批次 = 负责该文件的增量。

### 7.1 共享协议 `src/translation-knowledge/`

| 文件 | 处理 | 批次 | 要点 |
| --- | --- | --- | --- |
| `schemas.ts` | 重写 | I1 | FK-TK/2；`ENTITY_ARRAYS = ['collections','entries','presets']`；导出 JSON Schema |
| `summary.ts` | 新 | I1 | `entrySummary`，供页面、Agent、工作台共用 |
| `validation.ts` | 重写 | I1 | v2 语义校验（见 data 设计） |
| `review-policy.ts`、`task-reference-contract.ts`、`maintenance-contract.ts` | 删 | I1 | |
| `ipc-contract.ts`、`export-contract.ts`、`execution-contract.ts`、`execution.ts`、`snapshot-contract.ts`、`automatic-snapshot-contract.ts`、`proposal.ts` | 重写 | I1 | §4–§6；proposal 去掉对象和 adopt |
| `library-events.ts`、`canonicalize.ts`、`json.ts`、`matching.ts`、`unicode/` | 留 | — | |

### 7.2 主进程 `electron/main/translation-knowledge/`

| 文件 | 处理 | 批次 | 要点 |
| --- | --- | --- | --- |
| `repository.ts` | 重写 | I1 | format 3、版本不符时归档并重新开始、保留 20 代；删除清除日志、恢复、cleanupPending、previous 链 |
| `service.ts` | 重写 | I1 | saveRecords / deleteRecords / restoreRecords / 导入 / 导出；删除审核、批准、级联失效、维护、旧导出 |
| `maintenance.ts`、`maintenance-storage.ts`、`task-gate.ts` | 删 | I1 | |
| `export-selection.ts` | 重写 | I1 | §6 |
| `export-plans.ts` | 改 | I1 | |
| `ipc.ts`、`index.ts`、`errors.ts` | 重写 / 改 | I1 | §4 |
| `skill-archive.generated.ts` | 重新生成 | I1 | |
| `README.md` | 重写 | I4 | |

### 7.3 预加载与主进程组合

| 文件 | 处理 | 批次 | 要点 |
| --- | --- | --- | --- |
| `electron/preload/translation-knowledge-api.ts`、`src/vite-env.d.ts` | 改 | I1 | 对齐新 IPC |
| `electron/preload/index.ts` | 改（如需） | I1 | 旧渠道拦截列表 |
| `electron/main/index.ts` | 改 | I1 | 删除 knowledgeGate 的注入 |
| 三个 provenance 审计 JSON | 改 | I4 | 最后一次修改 main / preload / package.json / vite.config.ts 之后重新记录 blob |

### 7.4 字幕工作台契约 `src/subtitle-studio/`

| 文件 | 处理 | 批次 | 要点 |
| --- | --- | --- | --- |
| `knowledge-translation-contract.ts`、`knowledge-batch-contract.ts`、`knowledge-trial-contract.ts` | 改 | I1 | 改用新选择结构；删除 `documentTopicIds` |
| `automatic-translation-contract.ts`、`persistence-contract.ts` | 改 | I1 | 引用 v2 冻结资料 |
| `automatic-knowledge-report-contract.ts` | 改 | I1 | 种子与摘要去掉主题和方案；只用新问题码 |
| `execution-record-contract.ts`、`execution-view-contract.ts` | 改 | I1 | 记录策略只有一个；视图去掉 recipeName、documentTopics |
| `consistency-contract.ts`、`cue-revision-contract.ts` | 改 | I1 | 新选择结构 |
| `transcription/preferences-contract.ts` | 改 | I1 | 自动翻译资料偏好 = 新选择字段 + enabled + sourceLanguage |

### 7.5 字幕工作台主进程 `electron/main/subtitle-studio/`

| 文件 | 处理 | 批次 | 要点 |
| --- | --- | --- | --- |
| `knowledge-translation.ts`、`knowledge-batch-translation.ts`、`knowledge-trial.ts` | 改 | I1 | 删除主题、绑定、确认、方案展开、闸门 |
| `knowledge-planner.ts`、`cue-revision-service.ts` | 改 | I1 | 发给模型的载荷去掉 condition 和 title |
| `automatic-knowledge.ts`、`automatic-knowledge-report.ts` | 改 | I1 | v2 冻结；摘要只含资料集名；删除旧策略 |
| `translation-service.ts` | 改 | I1 | 删除 knowledgeGate、knowledgeReference 和旧策略分支 |
| `execution-records.ts`、`execution-view.ts` | 改 | I1 | 单一策略；视图展示资料集和条目 |
| `consistency-service.ts` | 改 | I1 | 只用 enabled 的术语 |
| `document-repository.ts` | 改 | I1 | 删除资料引用扫描（L353-407） |
| `index.ts` | 改 | I1 | 删除闸门注入 |

### 7.6 字幕工作台渲染层

| 文件 | 处理 | 批次 | 要点 |
| --- | --- | --- | --- |
| `src/services/subtitle-studio/translation-draft.ts`、`translation-session.ts`、`transcription-controller.ts` | 改 | I2 | 新选择结构 |
| `src/store/tools/subtitle-studio/preferences.ts` | 改 | I2 | 最近使用组合 |
| `StudioMaterialsFields.tsx` | 重写 | I2 | 预设、最近使用、按方向过滤的资料集列表 |
| `StudioTranslation.tsx`、`StudioTranslationSettings.tsx` | 改 | I2 | 「存为预设」 |
| `StudioKnowledgeTrial.tsx` | 改 | I2 | 删除逐句角色和条件确认 |
| `StudioAutomaticKnowledge.tsx`、`StudioAutomaticKnowledgeFailure.tsx` | 改 | I2 | 删除主题和方案 |
| `StudioExecutionKnowledge.tsx`、`StudioExecutionRecord.tsx` | 改 | I2 | 删除方案、主题、condition |
| `knowledge-hints.ts`、`StudioConsistencyCheck.tsx`、`StudioCueRevision.tsx`、`StudioCueMenu.tsx`、`StudioCueTable.tsx`、`StudioKnowledgeBatch.tsx`、`StudioTranslationReview.tsx`、`index.tsx`、`agent-context.ts` | 改 | I2 | 类型、文案和选择结构 |
| `consistency-apply.ts`、`StudioBilingual`、`StudioExport`、`StudioTranscription`、`StudioTranslationOverview`、`StudioTranslationTask` | 留 | — | |
| `src/pages/TranslationKnowledge/QuickTermDialog.tsx`、`KnowledgeCaptureDialog.tsx`、`capture.ts` | 改 | I2 | 去掉 adopt 和来源实体；新建资料集时必须选方向 |

### 7.7 Agent

| 文件 | 处理 | 批次 | 要点 |
| --- | --- | --- | --- |
| `src/agent/knowledge-tools.ts` | 重写 | I2 | 三个工具的新输入输出，见 module-agent 需求 |
| `src/agent/prepared-actions.ts`、`orchestrator.ts`、`modern-tools.ts`、`web-tools.ts` | 改 | I2 | 去掉 adopt、对象、方案 |
| `capability-catalog.ts`、`navigation-tools.ts`、`ui-events.ts`、`tools.ts` | 留 / 改 | I2 | 只改描述文案 |
| `src/pages/HomeAgent/components/AgentKnowledgeChanges.tsx`、`AgentPreparedActions.tsx`、`AgentToolResult.tsx`、`AgentToolCall.tsx`、`action-error.ts`、`AgentCapabilities.tsx` | 改 | I2 | 删除 adopt 开关；加来源标签；结果展示资料集和预设 |
| `src/pages/TranslationKnowledge/agent-context.ts` | 重写 | I3 | |
| `scripts/home-agent-qa.mjs` | 改 | I4 | |

### 7.8 翻译资料页 `src/pages/TranslationKnowledge/`

| 文件 | 处理 | 批次 |
| --- | --- | --- |
| `index.tsx`、`KnowledgeSidebar.tsx` | 重写 | I3 |
| `model.ts`、`labels.ts`、`term-paste.ts`、`BulkTermPaste.tsx`、`InlineTermEditor.tsx`、`Controls.tsx`、`Exchange.tsx`、`KnowledgeTour.tsx`、`KnowledgeSkillDownload.tsx`、`KnowledgeScrollList.*`、`KnowledgeDisclosure.tsx` | 重写或改 | I3 |
| `CatalogEditor.tsx`、`EntryEditor.tsx`、`EntryDetails.tsx`、`EntrySettingsPanel.tsx`、`KnowledgeRecordDialog.tsx`、`knowledge-record-dialog.css`、`BatchReviewDialog.tsx`、`batch-review.ts`、`Maintenance.tsx`、`CollectionActionDialog.tsx`、`CollectionArchiveDialog.tsx`、`CollectionDeleteDialog.tsx`、`collection-action-dialog.css` | 删 | I3 |
| 新：`CollectionDialog.tsx`、`CollectionHeader.tsx`、`GlobalSearch.tsx`、`TermTable.tsx`、`NoteList.tsx`、`EntryDrawer.tsx`、`DeleteUndo.tsx` | 新 | I3 |

### 7.9 路由、文案、文档、测试

| 范围 | 处理 | 批次 |
| --- | --- | --- |
| `src/constants/router.ts`、`src/App.tsx`、`toolMeta.ts`、`Tools/index.tsx`、`FeaturedToolArtwork.tsx` | 留（路由和入口不变）；更新描述文案 | I4 |
| `src/locales/{zh,zh-Hant,en,ja}/knowledge.json` | 按新页面重建 | I3 新增，I4 清理 |
| `src/locales/*/materials.json`、`studio.json`、`home.json`、`tools.json` | 删除 adopt、方案、主题、对象、待审核相关键；新增预设相关键 | I2、I4 |
| `scripts/translation-knowledge/*`、`package.json` 的 `knowledge:*` 脚本、`vite.config.ts` 的检查插件 | 改：产物改为 v2 文件名 | I1 |
| `.agents/skills/fusionkit-translation-knowledge/**` | 示例改为 v2（I1）；文档重写并加入「从归档重建资料」（I4） | I1、I4 |
| `.agents/skills/fusionkit-pitfall-guard/references/*knowledge*` | 更新，或删除已失效的条目 | I4 |
| `README.md`、`README.en.md`、`CHANGELOG.md`、`docs/features/agent-knowledge-loop/README.md`（注明被 knowledge-v2 取代的原则） | 改 | I4 |
| `test/translation-knowledge/**`、`test/subtitle-studio/**` 中的资料相关测试、`test/agent-*.electron.test.ts`、`src/**/*.test.ts` | 按新模型重写；删除审核、维护、风格、方案、对象相关测试；共享夹具 `test/translation-knowledge/fixtures.ts` 改为加载 v2 示例 | I1–I3，I4 清理 |

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 用户真实资料库在首次启动时被归档 | 只移动、不删除；开发和测试只用隔离的 userData；首次在用户真实数据上运行，由用户自己启动 |
| 含旧冻结资料的字幕文档无法打开 | 用户已接受作废。I4 验收时提示用户：受影响的只有用过「转写后自动翻译 + 资料」的文档 |
| 漏改 | §7 清单逐项对应到任务写集；I3 结束时 `tsc` 全绿；I4 用 grep 检查生产代码中不再出现 `subjects`、`recipeId`、`approvals`、`preferenceTemplates`、`documentTopicIds`、`requiredSubjects`、`'candidate'` 等旧字段 |
| 开发期间工作树不可构建 | 按批次推进，单元 / 集成测试逐批通过；I3 结束时恢复 `tsc` 和构建 |
