# revision 设计

## 现状与约束

- `cue-revision-contract.ts`：`CueRevisionProposal { cueId, index, current, source?, target?, keptTarget? }`；提示词含“每条保持为一条、时间固定”；`parseCueRevisionResponse` 只读文字字段。
- `cue-revision-service.ts`：按 40 条分块、并发 3，结果按文档顺序合并。
- `StudioCueRevision.tsx`：预览逐条勾选，`apply()` 生成 `revise` 操作，经 `onApply` 进入撤销历史；预设（`preset`）可自动开始，`onApplied` 上报。
- Agent `agent-context.ts`：`studio_prepare_revision { instructions, scope, fields?, terms?, lines? }` 打开对话框并等待结果；`reportApplied` 发送 `revision_applied` 事件。
- 依赖 structure 模块的 `merge`、`timing`、`batch` 操作与 `mergeTexts`。

## 方案与取舍

### 结构提案

- 新类型 `CueStructureProposal = { kind: 'merge'; cueIds: string[]; indexes: number[]; current: {source,target?}[]; source: string; target?: string; startMs; endMs | null } | { kind: 'delete'; cueId; index; current } | { kind: 'timing'; cueId; index; current: {startMs,endMs}; startMs; endMs | null }`，`CueRevisionResult` 增加 `structure?: CueStructureProposal[]`。
- 应用：`buildRevisionOperation(proposals, structure, accepted)` 生成一个 `batch`：先 `revise`（未参与合并/删除的改字），再各 `merge`（按文档顺序倒序，避免序号影响——操作按 id 不受影响），最后 `delete`。只有改字时仍为 `revise`（保持现有行为与测试）。

### 相邻重复检测（R-REVISION-01）

- 纯函数 `findAdjacentDuplicates(cues, track)`（`cue-structure.ts`）：比较相邻两条原文（规范化后相同或互含且短 ≥ 长 50%、开始时间相差 ≤10 s），连续合并成组；输出 `merge` 提案，文字用 `mergeTexts`，时间按合并规则。
- 入口：修订对话框新增按钮「检查相邻重复」（与「生成修订」并列，不需要模型配置）；范围沿用对话框的“所选/整篇”。整篇时按页读取（每页 100 条，相邻页边界也比较）。
- 预设：`CueRevisionPreset` 增加 `mode: 'duplicates' | 'edits'`，Agent 用。

### AI 修订（R-REVISION-02）

- 提示词：把“每条保持为一条、时间固定”改为：默认每条保持为一条；只有当请求涉及重复识别、断句或无意义片段时，才可在 `merge`（相邻 id 列表 + 合并后的 source/target）与 `delete`（id 列表）中提出；时间由应用计算，不要输出时间。
- 解析：`merge: [{ ids: ["c3","c4"], source, target? }]`、`delete: ["c7"]`；校验 id 存在、相邻（块内位置连续）、不重复使用、文字合法；不合格计入 `rejected`。
- 服务：每块结果转换为结构提案（时间由块内字幕计算）；删除总数不得等于文档字幕数。

### Agent（R-REVISION-03）

- `studio_prepare_revision` 增加可选 `edits: [{ kind: 'merge', from, to } | { kind: 'delete', numbers } | { kind: 'timing', number, start?, end? }]`（编号从 1）与 `mode: 'duplicates'`；有 `edits` 时不调用模型：工具读取相关页面，构造提案，以预设打开修订预览（显示「由 Agent 准备」）。错误码：`invalid_cue_number`、`not_adjacent`、`invalid_time`、`too_many_edits`。
- 页面说明（`STUDIO_AGENT_INSTRUCTIONS`）补充：合并/删除/改时间用 `edits`；找重复用 `mode: 'duplicates'`；先用 `studio_read_cues` 查看序号与时间。
- `revision_applied` 事件值增加 `merged`、`deleted`、`retimed`。

### UI（设计基准）

- 参照：现有修订预览行（复选框、序号、`Diff`）与标签样式（「译文沿用」）。
- 合并行：序号显示「#10–11」，正文先列被合并的原文（删除线样式的次要文字），再列合并结果（正常文字），右侧时间范围「00:00:26.780 → 未知」；标签「合并」。删除行：序号 + 原文删除线 + 标签「删除」。改时间行：「00:00:20.770 → 00:00:21.270」，标签「时间」。
- 摘要行：「N 处修改：改字 a、合并 b、删除 c」。
- 窄屏：时间范围换到正文下方。

## 实施中确定（2026-10-11）

- Agent 工具不扩展 `studio_prepare_revision` 的参数，改为两个独立工具：`studio_prepare_cue_edits { edits: merge{from,to} | delete{numbers} | timing{number,start?,end?} }` 与 `studio_find_duplicates { scope }`（参数更窄，模型更易填对）；错误码 `invalid_cue_number`、`not_adjacent`、`invalid_time`、`overlapping_edits`、`too_many_edits`、`empty_selection`。
- 修订对话框预设 `mode: 'prepared' | 'duplicates'`：前者直接显示 Agent 准备的结构提案，后者自动运行相邻重复检查；两者都不需要模型配置，页脚不显示用量；摘要分别为「已准备：…」「建议修改：…（共检查 N 条）」。
- 模型每个请求最多提出 20 处合并、20 处删除（`CUE_REVISION_STRUCTURE_LIMIT`）；不相邻、重复使用、未知条目计入“未采用”；若删除会清空文档则丢弃全部删除建议。
- `revision_applied` 事件值增加 `merged`、`deleted`、`retimed`；不需要回应时（无可记入的译法、无待完成计划）不再丢弃事件，而是静默记入对话（`orchestrator.reportUiEvent`），Agent 在下一轮看到。
- 相邻重复检测还要求两条开始时间不倒退、间隔 ≤ 10 秒；连续多条为一组，超过 50 条拆为多组。

## 代码落点

- `src/subtitle-studio/cue-structure.ts`（`findAdjacentDuplicates`、提案类型与 `buildRevisionOperation`）
- `src/subtitle-studio/cue-revision-contract.ts`（提示词、解析、结果类型）、`electron/main/subtitle-studio/cue-revision-service.ts`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.tsx`（+ CSS）、`agent-context.ts`、`index.tsx`
- `src/agent/ui-events.ts`、`src/agent/types.ts`（事件值）
- `src/locales/{zh,en,ja,zh-Hant}/studio.json`、`home.json`（工具行与错误码）
- 测试：`src/subtitle-studio/cue-structure.test.ts`、`test/subtitle-studio/cue-revision.test.ts`（扩展）、`src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts`、`test/subtitle-studio/cue-structure-revision-ui.test.ts`（Electron，新）

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-REVISION-01 | `findAdjacentDuplicates`、「检查相邻重复」、结构提案预览与 batch 应用 |
| R-REVISION-02 | 提示词与解析、服务转换、预览行 |
| R-REVISION-03 | `edits`/`mode` 参数、页面说明、事件值 |

## 验证与风险

- 单元：重复检测（用户样本、包含关系、10 秒间隔、连续三条）、解析（相邻、越界、重复使用、删除全部）、操作构造与撤销。
- Electron：用户样本 → 检查相邻重复 → 预览截图 → 取消一组 → 应用 → 撤销；Agent 脚本模型调用 `edits` 合并 → 预览 → 应用 → 事件；截图审阅浅色/深色。
- 风险：真实模型是否在合适时提出合并取决于模型；检测阈值可能把有意的重复（如反复的台词）判为重复——预览中可取消。
