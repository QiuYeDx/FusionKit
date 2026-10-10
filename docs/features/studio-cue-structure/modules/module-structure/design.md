# structure 设计

## 现状与约束

- 编辑：`src/subtitle-studio/cue-edit-contract.ts` 的 `cueEditOperationSchema` 与 `electron/main/subtitle-studio/cue-edit-service.ts` 的 `applyCueEdit(snapshot, op)`（事务内修改、返回 undo、最后 `validateDocument`）。删除 `deleteCues` 生成 `restore` 撤销，处理文本节点（`removedNodeIds`）、双语导入标记、已暂停任务。
- 校验：`domain.ts` `validateDocument` 第 105 行要求转写字幕时间等于片段时间且 `timingRevision === 1`。
- 导出：`export-planner.ts` 中 `preserve = bodies && 同格式`；保留模式下时间与原节点不符即 `invalid_time` 阻断（第 149 行）。
- 渲染：`StudioCueTable.tsx` 的工具栏（选中后：翻译、审阅、删除、更多、清除选择）、`StudioCueMenu.tsx` 的菜单、`StudioCueEditor` 行内编辑；`cue-history.ts` 标签；`index.tsx` `applyCueEdit` 记录撤销。选择限于当前页。

## 方案与取舍

### 编辑操作（契约）

新增三种 `CueEditOperation`：

- `timing { changes: Record<cueId, { startMs, endMs | null }> }`（1..1000）。主进程校验：每条 `endMs === null || endMs >= startMs`、`startMs >= 0`；转写文档 `endMs` 必填、`> 0`、`≤ origin.durationMs`；应用后整篇开始时间保持非递减（不重排）。被改的字幕 `timingRevision++`。撤销为同结构的旧值（撤销时 `timingRevision` 再递增，不回退——它只表示“动过”）。
- `merge { cueIds: string[2..50], source: SubtitleText, trackId?, target?: SubtitleText | null }`：`cueIds` 必须是文档中连续的字幕；`source`/`target` 由渲染端或修订预览按规则算好（主进程只校验文字合法）。主进程把第一条的原文改为 `source`、时间改为首尾，按 `target` 写译文（`null` 清除；省略则保留第一条原译文），再删除其余字幕（复用 `deleteCues`）。撤销为 `batch [restore 其余字幕, timing 旧值, revise 旧原文/旧译文条目]`。
- `batch { operations: CueEditOperation[1..200] }`：按序在同一事务中应用（不允许嵌套 batch），撤销为各子撤销的逆序 batch。供合并撤销与 I3 的“改字 + 合并 + 删除”一次应用使用。

合并文字规则（纯函数 `mergeTexts(texts)`，`src/subtitle-studio/cue-structure.ts`）：依次处理；规范化（NFKC、去空白与标点、小写）后与上一段相同或互相包含（较短一段长度 ≥ 较长一段的 50%）时保留较长者（等长保留前者）；否则拼接，前一段末字符或后一段首字符为中日韩文字/全角标点时直接相连，否则以空格相连。合并译文：所有字幕均有当前译文 → `mergeTexts(译文)`，条目 `origin: human, reviewStatus: reviewed`；部分有 → 拼接已有译文，条目 `sourceRevision` 取旧值使其显示“原文已变更”；都没有 → 省略。样式（加粗等）：拼接后若原样式不一致则按 `editedText` 规则丢弃混合样式。

### 校验放宽

- `validateDocument` 转写分支：`timingRevision === 1` 时保持现有相等要求；`> 1` 时只要求 `0 ≤ start ≤ end ≤ durationMs`。片段顺序仍严格递增（合并保留第一条的片段，其余为删除留下的空隙）。

### 导出

- `planSubtitleExport`：`const retimed = doc.cues.some(cue => cue.timingRevision > 1)`，`preserve = !!bodies && 同格式 && !retimed`。重新生成时现有的 `metadata_omitted`/`styles_removed` 等确认类提示照常出现。

### UI（设计基准）

- 目标用户与主流程：校对转写字幕的用户，在字幕预览中看到重复/时间错误 → 选中 → 合并或改时间 → 继续校对；全程键盘可达。
- 参照：选中工具栏的 `StudioIconButton`（删除按钮旁）、`StudioCueMenuContent` 菜单项、`StudioCueEditor` 行内编辑（输入框、保存/取消、错误说明）、`cueNotice` 提示条。
- 布局：
  - 工具栏：选中 ≥2 条时在「删除」左侧出现「合并」（lucide `Combine`），不连续时禁用、悬停说明「只能合并相邻的字幕」。
  - 菜单：「合并为一条」（多选时）、「编辑时间」（单条）、「平移时间…」（多选或单条），放在「编辑原文/译文」之后、复制之前。
  - 时间编辑：时间列变为两个紧凑输入框（等宽数字，宽约 12ch）与「→」，下方一行错误/提示；Enter 保存、Esc 取消、Tab 在两框间切换；与文字编辑互斥。
  - 平移：小对话框（`Dialog`），一个毫秒输入（可负）与预览“第 3–5 条：00:00:20.770 → 00:00:21.270”，确认后应用。
- 状态：编辑锁（翻译中）时按钮禁用并沿用现有提示；保存中禁用输入；失败显示错误码文案。
- 窄屏：786 宽时时间列两框上下排列。
- 样本：截图中的四条（含读点、长句 30+ 字）、LRC 未知结束、SRT 毫秒精度、转写文档。

## 实施中确定（2026-10-11）

- 合并文字：除“相同或互含（短 ≥ 长的 50%）”外，“一段是另一段的开头且至少 2 字”也视为重复（识别器重新起句，如「先輩みたいに」+ 完整句）；相邻重复检测（revision 模块）仍只用前者，避免误判。
- 时间顺序：不要求整篇开始时间单调（LRC 一行多时间戳时原本就可能乱序），改为“不越过原本未越过的相邻开始时间”；同一操作内多条一起移动时按移动后的位置检查。
- 合并后的译文：全部为当前译文 → `origin: human, reviewed`；部分 → 以旧版本号写入并标未复核，显示“原文已变更”；`revisionOperation` 用于 AI 修订时 `origin: ai`。
- 撤销：`merge` 的撤销为 `batch[revise 旧原文/条目, timing 旧值, restore 其余字幕]`；`batch` 的撤销把各子撤销逆序展开为一层。
- 快捷键：Ctrl+M 合并所选、T 编辑当前行时间；时间列双击编辑。时间输入框固定宽度（12ch + 内边距），窄列时换行而不压缩；结束占位文字为「未知」。
- `src/pages/Tools/Subtitle/SubtitleStudio/index.tsx` 无需修改（`applyCueEdit` 已对任意操作通用）。
- 来源审计：`real-default-comparison-analysis.test.ts` 中“转写字幕 `timingRevision = 2` 为无效文档”的断言随 R-STRUCTURE-03 改为有效（与 `sourceRevision = 2` 相同：有效的工作台编辑，但不是生产者输出，仍判为不一致）。

## 代码落点

- `src/subtitle-studio/cue-edit-contract.ts`、`src/subtitle-studio/cue-structure.ts`（新：`mergeTexts`、`mergePlan`、`parseStudioTime`、`isConsecutive`）
- `src/subtitle-studio/domain.ts`（校验放宽）
- `electron/main/subtitle-studio/cue-edit-service.ts`（timing / merge / batch）、`electron/main/subtitle-studio/export-planner.ts`（retimed）
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx`、`StudioCueMenu.tsx`、新 `StudioCueTimeEditor.tsx`、新 `StudioCueShift.tsx`、相关 CSS、`index.tsx`
- `src/services/subtitle-studio/cue-history.ts`（标签 `merge`、`timing`）
- `src/locales/{zh,en,ja,zh-Hant}/studio.json`
- 测试：`test/subtitle-studio/cue-structure.test.ts`（新，契约与服务）、`src/subtitle-studio/cue-structure.test.ts`（纯函数）、`test/subtitle-studio/cue-structure-ui.test.ts`（Electron，新）

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-STRUCTURE-01 | `merge` 操作、`mergeTexts`、工具栏/菜单/Ctrl+M、撤销 batch |
| R-STRUCTURE-02 | `timing` 操作、`parseStudioTime`、时间编辑器、平移对话框 |
| R-STRUCTURE-03 | 校验放宽、导出 `retimed`、历史标签 |

## 验证与风险

- 单元：合并规则（重复/包含/拼接/CJK 与拉丁）、合并 + 撤销往返（文本文档、双语导入文档、转写文档）、batch 撤销逆序、timing 顺序校验、导出 retimed 回退。
- Electron：导入双语样本 → 选中两条合并 → 截图 → 撤销/重做；编辑时间与错误态；平移；1280×860 浅色、786×660 深色。
- 风险：`timingRevision` 已被 `automatic-knowledge-report.ts` 的时间摘要使用，改时间会使该摘要变化（符合预期：时间确实变了）。
