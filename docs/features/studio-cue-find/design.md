# 列表内查找替换 设计

## 现状与约束

- **已有查找**：`findCues`（`cue-revision-service.ts`）按词与近似误写查找，供 Agent 与 AI 修订定位，不适合逐字查找与替换。
- **渲染端只持有当前页**（100 条）：整篇查找与“全部替换”必须在主进程完成。翻页由 `onFollowPage(offset)` 交给页面组件读取新页。
- **编辑操作**：`revise`（多条原文与精确译文条目）与 `entries` 可精确恢复；单次编辑最多 1000 条（`CUE_EDIT_LIMIT`）。编辑原文使译文标为原文已变更；编辑译文写为人工、已复核。
- **列表**：`StudioCueTable` 在 `.studio-reader` 中滚动，表头（含工具栏）吸顶；字幕文字由 `Spans` 渲染格式片段；键盘由 `useCueSelection` 的 `onKey` 先处理（Ctrl+C、Ctrl+Z 等）。

## 方案与取舍

字面查找与替换的计算放在共享纯模块 `src/subtitle-studio/cue-find.ts`，主进程用于只读查找通道与新的 `replace` 编辑操作，渲染端用于高亮（只算当前页）。查找栏浮在列表右上角（吸顶于表头下方），不改变列表布局。

### 纯函数（R-FIND-01、R-FIND-02）

- `findRanges(plain, query, matchCase)`：不重叠的匹配区间（从左到右）；不区分大小写时按 `toLocaleLowerCase` 比较（长度不变的字符；长度变化时退回逐字比较）。
- `searchDocument(doc, { query, field, trackId?, matchCase }, limit = 10000)`：按文档顺序返回 `{ cues: [{ cueId, index, source: n, target: n }], occurrences, truncated }`；译文只看当前译文（与界面显示一致）。
- `replaceText(text, query, replacement, matchCase)`：没有匹配返回 `null`；所有匹配都在单个片段内时逐片段替换并保留格式，否则在纯文本上替换后按 `editedText` 规则重建（整行格式保留、局部格式移除）。

### 主进程（R-FIND-01、R-FIND-02）

- 通道 `searchCues { documentId, revision, query, field: 'source' | 'target' | 'both', trackId?, matchCase }`：读快照、修订号检查后调用 `searchDocument`（与 `previewCueShift` 同处）。修改 `index.ts` 更新组合审计。
- 编辑操作 `replace { query, replacement, matchCase, field, trackId?, cueIds? }`（`cueIds` 省略为全部）：逐条用 `replaceText`；原文经 `writeSource`，译文写为人工、已复核条目；替换词或结果不合规（`storedTextProblem`）拒绝；改变超过 1000 条拒绝（`limit_exceeded`）。撤销：`batch[ revise{ sources: 原文 }, entries{ trackId, entries: 原条目 } ]`；`changed` 为改变的字幕数。

### 渲染端（R-FIND-03）

- `StudioCueFind.tsx`（新）：查找栏组件，状态 `{ query, replacement, field, matchCase, replacing }`；查找（150 毫秒去抖，文档修订号变化后重新查找）、当前位置（字幕序号）、上一条 / 下一条循环、替换当前（`replace` + `cueIds:[当前]`，成功后前往下一条）、全部替换（`replace` 全部）。键盘：Enter / Shift+Enter、Esc 关闭、Ctrl+F 选中查找框文字。
- `StudioCueTable.tsx`：`Ctrl+F` 与工具栏查找按钮打开查找栏；把高亮参数传给 `Spans`（`<mark class="studio-cue-find-mark">`，当前条 `data-current`）；查找栏请求跳转时，若不在当前页则调用 `onFollowPage(页起点)` 并在页面到达后选中、滚动到该行。
- 查找栏样式：浮层定位于列表右上角，吸顶在表头下方（高度由表头实际高度给出），窄窗口时占满宽度；替换行在查找行下方。
- 历史标签 `replace`：“替换 N 条字幕”。

### UI 设计基准

- 参照：常见编辑器的浮动查找栏（查找框、计数、上下箭头、Aa、展开替换、关闭）；控件尺寸沿用工具栏 `StudioIconButton` 与 `h-8 text-xs` 输入框；高亮用浅黄底，当前条为橙色描边。
- 样本：中文词跨页匹配、英文大小写、译文范围、无匹配、786 深色。

## 实施中确定（2026-10-11）

- **查找栏是表头的第二行**（而不是浮在列表右上角）：初版浮层在 786 宽时几乎占满列表宽度，盖住了前几行，当前匹配在第一行时看不到（渲染审查截图 02 初版）。改为吸顶表头中的一行，靠右对齐，列表行在其下方；表头实际高度用 `ResizeObserver` 写入 `--studio-cue-head`，行滚动进入视野时的上边距随之变化，不会停在表头下面。
- **`replace` 契约字段内联**：`cue-edit-contract.ts` 不引用 `cue-find.ts`（后者引用前者的 `editedText`），避免模块循环；两处规则一致（字面、1–200 字、非空白）。
- **查找栏的 Esc 不冒泡**：关闭查找栏后焦点回到列表，不会触发工作台的返回。
- **替换后继续**：替换后的重新查找从上次所在的字幕序号起取第一个匹配，因此“替换当前”后自动来到下一条。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-FIND-01 | `findRanges` / `searchDocument`、`searchCues` 通道 |
| R-FIND-02 | `replaceText`、`replace` 编辑操作与撤销 |
| R-FIND-03 | `StudioCueFind` 查找栏、表格的快捷键 / 高亮 / 跳转、历史标签 |

## 代码落点

- `src/subtitle-studio/cue-find.ts`（新）、`src/subtitle-studio/cue-edit-contract.ts`、`src/subtitle-studio/ipc-contract.ts`
- `electron/main/subtitle-studio/cue-edit-service.ts`、`electron/main/subtitle-studio/index.ts`、`electron/preload/subtitle-studio-api.ts`、`electron/preload/subtitle-studio-channel-policy.ts`、`resources/speech-resources/provenance/current-integration-audits.v1.json`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueFind.tsx`（新）、`StudioCueFind.css`（新）、`StudioCueTable.tsx`、`src/services/subtitle-studio/cue-history.ts`、`src/locales/{zh,en,ja,zh-Hant}/studio.json`
- 测试：`src/subtitle-studio/cue-find.test.ts`（新）、`test/subtitle-studio/cue-find.test.ts`（新）、`test/subtitle-studio/ipc.test.ts`、`test/subtitle-studio/cue-find-ui.test.ts`（新）

## 验证与风险

- 单元：区间（大小写、重叠、多处）、整篇查找（跨页、译文范围、上限）、替换（片段内保留格式、跨片段、空结果、非法字符）、`replace` 操作（全部 / 指定、撤销、1000 条上限、翻译进行中）。
- 界面：真实 Electron（静默）——Ctrl+F、计数、跨页跳转与高亮、替换当前与全部、撤销后重新查找、Esc；截图审查。
- 风险：高亮在渲染端按同一纯函数计算，与主进程结果一致；大文档查找为一次线性扫描（10 万条约毫秒级到数十毫秒）。
