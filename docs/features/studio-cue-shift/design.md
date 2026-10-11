# 整篇时间偏移 设计

## 现状与约束

- **改时间**：`cue-edit-contract.ts` 的 `timing` 操作按字幕 id 列出新时间（每次最多 `CUE_EDIT_LIMIT = 1000` 条），`cue-edit-service.ts` 的 `writeTiming` 校验（结束不早于开始；转写文档结束 > 0 且不超过 `origin.durationMs`）并把 `timingRevision` 加 1；`keepsOrder` 禁止一条字幕的开始越过原本不越过的相邻字幕。撤销是反向的 `timing`。
- **对话框**：`StudioCueShift.tsx` 只处理当前页内所选字幕（`page.cues`），由 `StudioCueTable` 以 `timing` 操作应用，标签 `timing`。渲染端只持有当前页（100 条），所以整篇平移必须由主进程完成，不能由渲染端列出所有时间。
- **编辑通道**：`editCues { documentId, revision, operation }` → `cueEdits.apply`；读操作在 `index.ts` 中 `repository.readSnapshot` 之后处理（如 `readDocumentPage`）。修改 `index.ts` 需更新组合审计。
- **试听**：`readCueAudio` 支持任意范围目标 `{ range: { startMs, endMs } }`；`CueAudioButton` 以 `playKey` + 请求切换播放，关闭对话框的 `useStopCueAudioOnClose` 停止试听。
- **导出**：改过时间（`timingRevision > 1`）的 VTT / ASS / SSA 按新时间重新生成，平移沿用该机制，无需改动。

## 方案与取舍

整篇或从某条起的平移由主进程以一个新编辑操作完成（决策 A-01），越界时拒绝而不裁剪（A-02）；对话框在现有“平移时间”上增加范围、微调与试听。

### 主进程（R-SHIFT-01）

- `src/subtitle-studio/cue-shift.ts`（新，主进程与测试共用的纯函数）：
  - `CUE_SHIFT_MAX_MS = 86_400_000`；
  - `shiftRange(cues, fromCueId?)` → 起始下标（找不到 → `invalid_input`）；
  - `shiftProblem(cues, from, deltaMs, mediaDurationMs?)` → `'negative' | 'beyond_media' | 'before_previous' | null`：逐条检查新开始 ≥ 0；有媒体时长（转写文档）时新结束 ≤ 时长且 > 0；`from > 0` 时第 `from` 条的新开始不早于第 `from − 1` 条的开始（原本不早于时）。
- 契约：`singleOperationSchema` 增加 `{ kind: 'shift', deltaMs: int, ≠ 0, |deltaMs| ≤ CUE_SHIFT_MAX_MS, fromCueId?: id }`；`requestSchemas.previewCueShift { documentId, revision, deltaMs, fromCueId? }`，结果 `{ count: number; problem?: CueShiftProblem }`。
- `cue-edit-service.ts` 的 `shift`：确定范围 → `shiftProblem` 有问题则 `invalid_input`（整个编辑不生效，事务回滚）→ 逐条写入（不经 `writeTiming` 的单条校验，范围检查已覆盖；仍保持“结束不早于开始”的不变量，平移不改变时长）→ `timingRevision++` → 撤销 `{ kind: 'shift', deltaMs: −deltaMs, fromCueId }`，`changed` 为条数。反向平移总是可行（恢复原时间），撤销精确。
- `index.ts`：`previewCueShift` 在读快照之后处理（修订号不符按现有规则返回冲突）；`editCues` 无需改动。更新组合审计。
- 预检是辅助说明：真正应用时主进程会再次检查，界面以预检结果禁用按钮并说明原因。

### 渲染端（R-SHIFT-02）

- `StudioCueShift.tsx` 重写为带范围的对话框：
  - 属性：`page`、`selected`（当前页内所选，按文档顺序）、`initialScope`、`media`（是否可试听）、`busy`、`onClose`、`onApply(operation, label, count)`。
  - 范围：`ToolRadioButtonGroup` 风格的三段单选（有选择时三项，无选择时只有“整篇”且不显示单选）；默认规则见需求。
  - 偏移量：沿用毫秒输入框 + 四个微调按钮（`±1000`、`±100`）。
  - 预览：“所选”在本地用 `shiftedTimes` 计算（与现在一致）；“从第 X 条”与“整篇”调用 `previewCueShift`（输入变化后 150 毫秒去抖、过期结果丢弃），显示“第 X 条从 a 移到 b，共 N 条。”或原因。
  - 试听：`CueAudioButton`（`playKey = shift:<cueId>`），请求 `{ target: { range: { startMs: 参照开始 + Δ, endMs: 参照结束 + Δ } } }`；参照字幕为所选第一条，否则当前页第一条；结束未知时按下一条开始或 + 5 秒；平移后开始小于 0 时禁用。
  - 应用：“所选” → `{ kind: 'timing', changes }`，标签 `timing`；其余 → `{ kind: 'shift', deltaMs, fromCueId? }`，标签 `shift`，条数取预检结果。
- `StudioCueTable.tsx`：`shifting` 状态改为 `{ cueIds, scope }`；菜单“平移时间…”按需求计算默认范围（所选 = 当前页全部且 `cueCount > page.cues.length` 时为整篇）；工具栏在无选择时显示“平移整篇时间…”（`MoveHorizontal` 图标，翻译进行中禁用）。
- `cue-history.ts`：`CueEditLabel` 增加 `shift`；文案“平移 N 条字幕的时间”（i18n 计数插值）。

### UI 设计基准

- 参照：现有 `StudioCueShift` 的小对话框（宽 420，标题图标 + 说明、输入、预览一行、底部按钮）、`StudioCueRecognize` 的选项行、`ToolRadioButtonGroup` 的分段单选。
- 层级：标题“平移时间”；说明随范围变化（“将所选 / 从第 X 条起 / 整篇字幕整体提前或推后……”）；范围单选一行（窄屏换行）；偏移量输入与微调按钮一行；预览与试听一行；底部 取消 / 平移。
- 宽度放宽到 480 以容纳三段范围与四个微调按钮；786 宽下仍为单列。
- 样本：250 条文档（3 页）、所选为整页、从第 120 条、提前越界、转写文档推后越界、无媒体（无试听按钮）、786 深色。

## 实施中确定（2026-10-11）

- **“从第 X 条到结尾”在参照字幕是文档第一条时不显示**：它与“整篇”完全相同（在第 1 页按 Ctrl+A 时即是如此），只保留两项。
- **试听不标记列表行**：试听的是平移后的时间段，与列表中各行的现有时间不对应，所以请求不带 `rows`。
- **预览文案**改为“第 X 条从 a 移到 b，共 N 条。”（原为“第一条从…”），“所选”范围也用同一句；`test/subtitle-studio/cue-structure-ui.test.ts` 的对应断言随之更新（测试写集之外的一行改动）。
- **界面测试观察试听请求**：在主进程包装 `subtitle-studio:read-cue-audio` 的调用处理器记录请求，必须在工作台注册处理器之后再包装（过早包装会使工作台注册时报重复处理器）。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-SHIFT-01 | `cue-shift.ts`、`shift` 操作与撤销、`previewCueShift`、组合审计 |
| R-SHIFT-02 | `StudioCueShift` 范围 / 微调 / 预检 / 试听、表格入口与默认范围、历史标签 |

## 代码落点

- `src/subtitle-studio/cue-shift.ts`（新）、`src/subtitle-studio/cue-edit-contract.ts`、`src/subtitle-studio/ipc-contract.ts`、`electron/preload/subtitle-studio-api.ts`、`electron/preload/subtitle-studio-channel-policy.ts`
- `electron/main/subtitle-studio/cue-edit-service.ts`、`electron/main/subtitle-studio/index.ts`、`resources/speech-resources/provenance/current-integration-audits.v1.json`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueShift.tsx`、`StudioCueTable.tsx`、`src/services/subtitle-studio/cue-history.ts`
- `src/locales/{zh,en,ja,zh-Hant}/studio.json`
- 测试：`test/subtitle-studio/cue-structure-ui.test.ts`（预览文案）、`src/subtitle-studio/cue-shift.test.ts`（新）、`test/subtitle-studio/cue-shift.test.ts`（新，编辑服务与预检）、`test/subtitle-studio/ipc.test.ts`、`test/subtitle-studio/cue-shift-ui.test.ts`（新）

## 验证与风险

- 单元：纯函数的各原因与边界；编辑服务对 250 条文档平移、撤销精确、从某条起、拒绝不留改动、翻译进行中拒绝、转写文档媒体时长；预检不修改文档。
- 界面：真实 Electron（静默）验证 Ctrl+A 默认整篇、跨页生效与撤销、工具栏入口、微调、从第 120 条与越界原因、试听范围（读主进程收到的请求）、截图审查。
- 风险：10 万条文档平移在一次事务中写入，耗时与现有大编辑相当（主进程逐条修改内存对象后保存一次）；撤销栈每项只存一个小操作，不随条数增大。
