# knowledge 设计

只详细设计当前增量（I1）。整体链路见 [总体设计](../../architecture.md)。

## 现状与约束

- `KnowledgeService.saveRecord`（`electron/main/translation-knowledge/service.ts:254`）在 `repository.transact` 内完成：generation 检查 → 记录 revision 检查 → 可选证据 → 写入并删除批准 → adopt → `invalidate` 依赖 → `checkPackage` 整库校验 → adopt 批准。没有批量版本。
- IPC：`electron/main/translation-knowledge/ipc.ts` 定义请求 schema，`index.ts` 按 capability 令牌分发；preload `electron/preload/translation-knowledge-api.ts` 暴露 `window.translationKnowledge`；渠道常量与 API 接口在 `src/translation-knowledge/ipc-contract.ts`。
- 校验器 `validatePackage` 与 `canonicalize` 为纯 TS（无 node 依赖），渲染进程可直接用于预检。
- 资料页 `src/pages/TranslationKnowledge/index.tsx` 用 `query.collection` 表示所选资料集，`view` 表示视图，`batchSelection` 表示批量选择。

## 方案与取舍

### saveRecords

把 `saveRecord` 事务体抽成内部 `applySave(state, item, existing, changed, reviewed)`，`saveRecord` 与 `saveRecords` 共用：

```ts
interface SaveRecordsRequest { generation: number; items: { group: EntityGroup; record: KnowledgeEntity; source?: Source; adopt?: boolean }[] } // 1..200
```

- 先逐项 `parse`（与 saveRecord 相同的 schema）；任一项失败时把诊断路径前缀为 `/items/<i>`。
- 事务内：`requireGeneration` 一次 → 依次 `applySave`（`existing` 在每项后刷新，保证同批后项能引用前项新建的记录）→ 汇总 `changed` 与 adopt 集合，`invalidate` 一次 → `checkPackage` 一次 → 对 adopt 条目逐个检查依赖并批准。
- 任一步抛错则 `transact` 不提交，天然整体回滚（repository 只在回调返回 state 时写 generation 文件）。
- 同批重复 id 在 schema 层拒绝。无任何变化时返回 `{ result: snapshot }`，generation 不变，满足重放幂等。
- IPC schema：`items` 数组 1..200，元素与 saveRecord 相同；`publicKnowledgeChannels` 自动包含新渠道；preload 增加方法。

不改 `saveRecord` 的外部行为；它改为调用同一内部函数，现有 `service.test.ts` 作为回归。

### 提案构造 `src/translation-knowledge/proposal.ts`

```ts
type Ref = { id: string } | { ref: string };              // 已有 id 或同一提案内的临时引用
interface ProposalInput {
  languagePair?: { source: string; target: string };    // 条目默认语言对
  subjects?: { ref: string; name: string; kind: 'work'|'person'|'domain'|'other'; aliases?: string[]; description?: string }[];  // ≤5
  collections?: { ref: string; name: string; description?: string; subjects?: Ref[]; languagePair?: {...} }[];               // ≤5
  entries?: ({ action: 'create'; collection: Ref; kind: 'term'; source: string; target: string; aliases?: string[]; note?: string; strength?: 'preferred'|'required'|'keep_source' }
            | { action: 'create'; collection: Ref; kind: 'rule'; text: string; dimension?: ...; strength?: 'preferred'|'required' }
            | { action: 'create'; collection: Ref; kind: 'context'; text: string; core?: boolean }
            | { action: 'update'; entryId: string; revision: number; /* 同 kind 的可改字段 */ }
            | { action: 'archive'; entryId: string; revision: number }
           ) & { basis: Basis; evidence?: string; subjects?: Ref[]; languagePair?: {...} }[];               // ≤50
}
interface ProposalItem { key: string; group: 'subjects'|'collections'|'entries'; status: 'new'|'update'|'archive'|'exists'|'invalid';
  reason?: string; kind?: Entry['kind']; label: string; detail?: string; collectionName?: string; basis?: Basis;
  warnings: { code: 'term_conflict'|'individual_review'; collectionName?: string; target?: string }[] }
interface KnowledgeProposal { items: ProposalItem[]; saveable: boolean; nothingToSave: boolean; adoptDefault: boolean;
  counts: { subjects; collections; created; updated; archived; existing };
  request(adopt: boolean, generation: number): SaveRecordsRequest; }
```

- 记录生成沿用资料页约定：term `match: { mode: 'literal_phrase', caseSensitive: false }`、`requiredSubjects: []`、`condition: none`、`aboutSubjectIds` 取条目/资料集关联对象；title 取原文或文本前 120 字。
- 证据：每个新建/修改条目一条新 source（id 新生成），kind 与 support 按 basis 映射；摘录为 `evidence` 字段或「原文 → 译文」。归档不新增证据。
- 修改：在原条目上覆盖提供的字段，保留 id/revision（服务端递增）；启用形态 adopt=true，待审核形态 state=candidate（原为 ready 的也降为 candidate，视为需重新审核）。归档：state=archived，不 adopt。
- 预检：把生成的记录合入快照数据副本后跑 `validatePackage`；错误按记录 id 映射回项（invalid + 原因码 `validation_<CODE>`），`TERM_TRANSLATION_CONFLICT` 警告映射为 term_conflict（附对方资料集名/译文）；required/core 条目附 individual_review 提示。
- exists：同资料集、同语言对、NFC 后同原文与同译文、未归档/未拒绝的 term；rule/context 为同资料集同文本。新对象与库中未归档的同类同名对象、新资料集与未归档同名资料集视为同一记录并复用（AC-KNOWLEDGE-02-6）；用同一 id 种子重建时，已在库中的 id 视为已保存。只被未保存条目引用的新对象/资料集不单独写入。
- 语言规范化：`zh`/`zh-CN`/`zh-SG`/`zh-Hans-*` → `zh-Hans`，`zh-TW`/`zh-HK`/`zh-MO` → `zh-Hant`，其余经 `Intl.getCanonicalLocales`；失败为 invalid。
- `adoptDefault`：所有新建/修改条目 basis ∈ {user_stated, user_revision} 时为 true。
- `request(adopt, generation)` 在确认时基于最新快照重新构造（见 module-agent 设计），保证新 id 不变：构造函数接受可选的 id 种子映射（key → uuid），首次生成后复用。

### 资料变更广播

`src/translation-knowledge/library-events.ts`：页面外保存（Agent 卡片、后续工作台对话框）成功后 `announceKnowledgeChange(snapshot)` 派发窗口事件；资料页监听并用 `newerSnapshot` 只接受更新的 generation，打开中的资料页无需刷新即显示新资料。事件只携带数据，不授予任何权限。

### 资料页上下文与定位

`src/pages/TranslationKnowledge/agent-context.ts` 导出 `knowledgePageContext(state)`，`index.tsx` 通过 `useAgentPageContext` 注册：

- 快照：`view`、`collection`（id/name/languagePair/entryCount，或 "all"）、`visibleEntries`（当前页前 20 条：id、revision、kind、summary≤160、state）、`selectedEntryIds`（批量模式≤50）、`counts`（待审核数）。
- `instructions`：说明可用 `prepare_knowledge_changes` 修改/归档快照中的条目（使用快照内 id 与 revision），不在页面外推断未列出的条目。
- 不注册页面工具（写入统一走全局工具；读取用检索工具）。
- 定位：`useLocation().state?.knowledgeFocus = { collectionId?: string }`，首次加载快照后若资料集存在且未归档，`setView('materials')` + `setQuery({ ...initialQuery, collection })`，随后 `navigate(location.pathname, { replace: true, state: null })` 清除状态，避免返回时重复定位。

### 批量记入对话框（I2，R-KNOWLEDGE-04）

`src/pages/TranslationKnowledge/KnowledgeCaptureDialog.tsx`，外壳与控件复用 `QuickTermDialog` 所用的 `KnowledgeDialog`、`TextField`、`Choice`、`LanguageField`、`ErrorNotice`（`Controls.tsx`），与快捷记录同一视觉。

- 入参：`rows: { source; target; note? }[]`、`languagePair?`、`preferredCollectionId?`、`basis`（默认 user_revision）、`evidence?`（如修订说明），`onSaved(snapshot, collectionId)`。
- 布局（自上而下）：说明一行（弱文本）→ 行列表（每行：Checkbox + 两列 `TextField` 原文/译文，下方 `text-xs` 状态：已存在 / 与「X」译为「Y」不同）→ 资料集 `Choice`（已有 + 新建），新建时出现名称输入 → 源/目标语言两列 `LanguageField` → 「保存后直接启用」`Switch` 与随状态切换的说明 → 底部主按钮「记入 N 条」。窄宽度（<640px）原文/译文改为上下堆叠（沿用 `sm:grid-cols-2`）。
- 状态计算用纯函数 `captureRows(rows, snapshot, collectionId, pair)` → 每行 exists/conflict；保存用 `buildKnowledgeProposal`（新资料集为同提案内 ref），id 种子保存在 ref 中，失败重试不重复。成功后 `announceKnowledgeChange`、`toast.success`、关闭。
- 已存在行默认不勾选；全部不可保存时按钮禁用。

## 代码落点

- `electron/main/translation-knowledge/service.ts`、`ipc.ts`、`index.ts`
- `electron/preload/translation-knowledge-api.ts`
- `src/translation-knowledge/ipc-contract.ts`、`src/translation-knowledge/proposal.ts`（新）
- `src/translation-knowledge/library-events.ts`（新）
- `src/pages/TranslationKnowledge/agent-context.ts`（新）、`index.tsx`
- 测试：`test/translation-knowledge/service.test.ts`（扩充）、`test/translation-knowledge/ipc.test.ts`（扩充）、`test/translation-knowledge/proposal.test.ts`（新）、`src/pages/TranslationKnowledge/agent-context.test.ts`（新）

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-KNOWLEDGE-01 | `saveRecords` 事务、IPC schema、preload |
| R-KNOWLEDGE-02 | `proposal.ts` 构造、预检、exists/冲突、语言规范化、basis→证据 |
| R-KNOWLEDGE-03 | `agent-context.ts` 快照、`knowledgeFocus` 导航状态 |
| R-KNOWLEDGE-04 | `KnowledgeCaptureDialog`、`capture.ts` 行状态与提案输入 |

## 验证与风险

- 服务测试用临时目录真实读写，覆盖三项依赖保存、整体回滚、过期 generation、幂等重放、adopt 依赖归档。
- IPC 测试覆盖 200 上限、重复 id、未注册调用方。
- 提案测试覆盖 AC-KNOWLEDGE-02 全部条款及 id 种子复用。
- 资料页定位在 module-agent 的 Electron 场景（AC-AGENT-03-4）中真实点击验证；快照用单元测试。
- 风险：`invalidate` 在批量下一次性计算，与逐条保存相比，后项对前项新建记录的依赖不会被误降级（新建项不在 existing 中）；以测试覆盖「同批修改资料集归档状态 + 条目」的组合不出现在 Agent 提案中（提案不改资料集）。
