# 拆分与插入字幕 设计

## 现状与约束

- **编辑操作**：`cue-edit-contract.ts` 已有 source / target / clear / review / entries / revise / delete / restore / timing / merge / shift 与 batch；`cue-edit-service.ts` 在文档事务中应用并返回撤销操作。`delete` 的撤销是携带完整字幕与译文的 `restore`，`restore` 的撤销是 `delete`——因此“删除新字幕”作为撤销、“恢复同一条”作为重做时，新字幕的 id 与内容保持不变。
- **文本文档**：每条字幕有 `nodeId`，原文件节点 `preservation.nodes[].cueIds` 列出其字幕；校验要求每条字幕恰好映射到一个节点。`bindPreservedBodies`（VTT / ASS / SSA）目前拒绝一个节点对应多条字幕。改过时间（`timingRevision > 1`）的文档导出时按字幕重新生成，不再修补原文件。
- **转写文档**：每条字幕有 `segmentId`，校验要求字幕按片段顺序且片段**严格递增**（一个片段至多一条字幕），并要求字幕数不超过片段数；未改过的字幕（修订号为 1）必须与片段一致。转写片段可带字词时间 `words[{ startMs, endMs, text }]`，只在主进程的 `preservation.transcript` 中。
- **时间**：`parseStudioTime` / `formatStudioTime`；顺序规则 `keepsOrder`（开始不越过原本未越过的相邻字幕的开始）。
- **试听**：`CueAudioButton` 支持任意范围目标。

## 方案与取舍

两个新的单条编辑操作，都在原字幕旁加入一条新字幕：文本文档的新字幕与相邻字幕共用原文件节点，转写文档的新字幕与相邻字幕共用转写片段（决策 A-01）。新字幕的文字与时间修订号都为 2（视为已编辑），撤销为删除它（重做即 `restore`）。拆分时刻的建议由主进程计算（只有主进程持有字词时间）。

### 契约与校验（R-SPLIT-01、R-SPLIT-02）

- `cue-edit-contract.ts`：
  - `split`: `{ kind: 'split', cueId, sources: [text, text], splitMs, trackId?, targets?: [text, text] }`（`targets` 需同时给出 `trackId`）。
  - `insert`: `{ kind: 'insert', cueId, position: 'before' | 'after', timing: { startMs, endMs | null }, source: text, trackId?, target?: text }`（`target` 需 `trackId`）。
- `domain.ts` 转写校验：允许相邻两条字幕属于同一片段，条件是其中至少一条文字与时间都改过（两个修订号都 > 1）；去掉“字幕数不超过片段数”（仍受 `LIMITS.cues` 限制）。
- `formats/preserved.ts`：`bindPreservedBodies` 允许一个节点对应多条字幕；`export-planner.ts` 在任一节点对应多条字幕时不走修补原文件的路径（与改过时间相同，双重保证）。

### 主进程（R-SPLIT-01、R-SPLIT-02）

- `cue-edit-service.ts`：
  - 共用 `addCue(index, anchor, timing, source)`：生成新 id；文本文档复制锚点的 `nodeId` 与时间来源，插入 `doc.cues` 并按文档顺序加入节点的 `cueIds`；转写文档复制锚点的 `segmentId`。修订号为 2。
  - `split`：校验文字（`assertStoredText`）、`start < splitMs`、结束已知时 `splitMs < end`；记录原文字、时间与译文；写原字幕前半与结束时间，在其后加入新字幕；译文按需求处理（给出两半时都写为人工、已复核译文，并加轨道修订号）。撤销：`batch[ delete 新字幕, timing 原时间, revise 原文字与原译文 ]`。
  - `insert`：按位置找到前后相邻字幕，检查开始顺序、结束与媒体时长（`writeTiming` 的规则），加入新字幕，可选写入译文。撤销：`delete` 新字幕。
  - 拆分建议 `suggestCueSplit(doc, cueId, offset)`（纯函数，`src/subtitle-studio/cue-split.ts`）：转写文档、字幕两个修订号均为 1、片段有字词且字词文字拼接（去首尾空白）与字幕文字一致时，取累计长度首次 ≥ 拆分位置的字词边界（该字词的开始）；否则按字数比例在开始与有效结束之间取值，取整到 10 毫秒，并限制在开始与结束之间。返回 `{ splitMs, basis: 'words' | 'proportional' }`。
- 通道 `suggestCueSplit { documentId, revision, cueId, offset }`（只读，读快照后修订号检查，与 `previewCueShift` 同处）。修改 `index.ts` 更新组合审计。

### 渲染端（R-SPLIT-03）

- `StudioCueSplit.tsx`（新，`ScrollableDialog` 宽 520）：
  - 原文显示为只读多行文本框，点击、方向键改变光标即改变拆分位置；默认位置为离中间最近的标点或空格之后。
  - 预览两行（`studio-cue-split-part`）：序号、文字、时间段与试听按钮。
  - 拆分时刻输入（`studio-cue-split-time`），光标变化后 150 毫秒去抖请求建议并填入（用户手动修改后不再覆盖，直到光标再次移动），旁注依据（字词时间 / 字数估算）。
  - 有当前译文轨且这条有译文时显示“同时拆分译文”勾选与译文只读文本框（默认位置按原文位置比例取最近标点）。
  - 不合规时说明原因（时间不在范围内、一半为空）并禁用“拆分”。
- `StudioCueInsert.tsx`（新，宽 480）：开始 / 结束输入、文字多行输入（必填）、有译文轨时译文输入；默认时间：之后插入为 `[锚点结束 ?? 锚点开始, min(后一条开始, 开始 + 2 秒)]`，之前插入为 `[max(前一条结束 ?? 前一条开始, 锚点开始 − 2 秒, 0), 锚点开始]`，空隙为 0 时给 1 秒并由校验说明；试听所填时间段；本地检查顺序与结束（与时间编辑器相同规则）。
- `StudioCueMenu.tsx`：在“平移时间…”之后加入“拆分字幕…”（多选或翻译进行中禁用）、“在上方插入字幕…”“在下方插入字幕…”。`StudioCueTable.tsx` 管理两个对话框，应用后选中新字幕（拆分为第二条，插入为新条）。
- `cue-history.ts`：标签 `split`、`insert`。

### UI 设计基准

- 参照：`StudioCueShift`（小对话框、输入与预览）、`StudioCueRecognize` 的条目行（序号、试听、文字）、时间编辑器的时间格式与错误文案。
- 层级：标题与一句说明；原文文本框；两半预览；时间与依据；（译文）；底部按钮。插入对话框：时间一行两个输入 + 试听，文字，译文。
- 样本：中日文短句、长句、带字词时间的转写、无译文 / 有译文、786 深色。

## 实施中确定（2026-10-11）

- **拆分位置的文本框不用 `readOnly`**：Chromium 中只读文本框的光标不能用方向键移动，键盘用户无法放置拆分位置。改为普通文本框加 `aria-readonly`，并在原生 `beforeinput` 事件中拒绝一切修改（输入、删除、粘贴、拖放）。
- **字词时间的适用条件**按内容判断：字幕的文字与开始 / 结束仍与转写片段一致时使用字词时间（撤销一次拆分后修订号已增加，但内容又与片段一致，仍可按字词时间拆分），不再看修订号。
- **撤销插入或拆分时不提示“已删除 1 条字幕”**：这两种撤销实际是删除新字幕，原先按操作种类显示删除提示（带撤销按钮）。改为只在标签为“删除”的编辑（含其重做）时提示；撤销 / 重做时传入历史标签（`src/pages/Tools/Subtitle/SubtitleStudio/index.tsx`，写集之外的小改动）。
- **LRC 插入时结束可未知**：与时间编辑器一致——格式为 LRC 或相邻字幕结束未知时允许，主进程同样检查。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-SPLIT-01 | `split` 操作与撤销、转写与节点校验放宽、`suggestCueSplit` 纯函数与通道 |
| R-SPLIT-02 | `insert` 操作与撤销、顺序与媒体时长检查 |
| R-SPLIT-03 | `StudioCueSplit` / `StudioCueInsert` 对话框、菜单项、选中新字幕、历史标签 |

## 代码落点

- `src/subtitle-studio/cue-edit-contract.ts`、`src/subtitle-studio/cue-split.ts`（新）、`src/subtitle-studio/domain.ts`、`src/subtitle-studio/formats/preserved.ts`、`src/subtitle-studio/ipc-contract.ts`
- `electron/main/subtitle-studio/cue-edit-service.ts`、`electron/main/subtitle-studio/export-planner.ts`、`electron/main/subtitle-studio/index.ts`、`electron/preload/subtitle-studio-api.ts`、`electron/preload/subtitle-studio-channel-policy.ts`、`resources/speech-resources/provenance/current-integration-audits.v1.json`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueSplit.tsx`（新）、`StudioCueInsert.tsx`（新）、`StudioCueSplit.css`（新）、`StudioCueMenu.tsx`、`StudioCueTable.tsx`、`src/services/subtitle-studio/cue-history.ts`、`src/locales/{zh,en,ja,zh-Hant}/studio.json`
- 测试：`src/subtitle-studio/cue-split.test.ts`（新）、`test/subtitle-studio/cue-split-insert.test.ts`（新）、`test/subtitle-studio/ipc.test.ts`、`test/subtitle-studio/cue-split-insert-ui.test.ts`（新）

## 验证与风险

- 单元：建议时刻（字词边界、字数比例、未知结束）；拆分与插入在 SRT、VTT（保留格式）、LRC（结束未知）与转写文档上的结果、导出、撤销 / 重做的精确性（id 不变）、拒绝不留改动、译文处理、翻译进行中拒绝。
- 界面：真实 Electron（静默）——菜单入口、点击放置拆分位置、建议时刻、试听范围、应用后选中、撤销；插入的默认时间、校验与应用；截图审查。
- 风险：放宽转写校验后，旧数据不受影响（只是允许更多情形）；一个节点多条字幕只在改过时间时出现，修补原文件的导出路径另加判断。
