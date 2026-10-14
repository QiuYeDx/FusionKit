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

## I2：正则表达式与全词匹配（2026-10-14）

### 现状（I2 起点）

- 纯模块 `src/subtitle-studio/cue-find.ts`：`findRanges`（逐码元字面比较，不区分大小写用 `toLocaleLowerCase`，不重叠）、`searchDocument`（每条匹配数，截断 10000 条）、`replaceText`（全部匹配在同一格式片段内时逐片段替换，否则整行替换）。替换词按字面拼接。
- 查找词规则在 `cue-find.ts` 与 `cue-edit-contract.ts` 的 `replace` 中各写一份（避免循环引用）。
- 主进程 `searchCues`（`electron/main/subtitle-studio/index.ts`）与 `replace`（`cue-edit-service.ts`）都在主线程同步执行；字幕最多 10 万条、每条可达 64 KB。
- 渲染端 `StudioCueFind.tsx`：查找 150 毫秒去抖；`!found.ok` 时静默忽略；表格 `Spans` 对每行调用 `findRanges` 高亮。
- 内置 Agent 的 `studio_find_cues` 用自己的近似查找，不引用 `cue-find.ts`；外部 Agent 没有查找替换工具——I2 不影响 Agent。

### 匹配器（R-FIND-04）

- `cue-find.ts` 增加匹配选项 `{ matchCase, wholeWord, regex }`，统一为 `findMatches(text, query, options) → { start, end, groups? }[]`：
  - 字面：沿用现有比较；正则：`new RegExp(query, 'gmu' + (matchCase ? '' : 'i'))`，每段文字新建一次（不复用 `lastIndex` 状态）；空匹配跳过（`lastIndex` 按码点前进一位）。
  - 全词：对每个候选匹配检查两端——首字符为汉字 / 平假名 / 片假名 / 泰文（`\p{Script=Han}` 等）时左端不检查，否则要求前一个字符不是 `[\p{L}\p{N}_]`；右端同理。候选被拒时从其开始位置后一个码点继续（字面与正则相同处理），因此 “bobcat cat” 仍能找到第二个 cat。
  - `findRanges` 改为基于 `findMatches`，保持原签名的字面默认行为。
- 替换展开 `expandReplacement(replacement, match, text, regex)`：正则模式支持 `$1`…`$99`、`$<名称>`、`$&`、`$$`（不存在的组按字面保留，与 `String.prototype.replace` 一致）；字面模式原样。`replaceText` 接收已求得的匹配列表，按展开后的文字替换；展开后的结果再经 `storedTextProblem` 与 `<` `>` 检查（现有只查原始替换词）。
- 校验：`regex` 时 `new RegExp` 构造失败 → `invalid_pattern`。`searchCues` 与 `replace` 的 schema 都增加 `regex: boolean`、`wholeWord: boolean`（默认 false，旧调用不受影响）；两处的规则抽到 `cue-find-query.ts`（无依赖的小模块），供两边引用，消除重复。

### 主进程与超时（R-FIND-04）

- 正则模式的整篇匹配放到一次性的 `worker_threads` Worker（`new Worker(源码, { eval: true })`，源码由打包时内联的匹配函数生成，不需要额外入口文件）：主进程把要查的文字（字段、id、plain）交给 Worker，Worker 返回每条的匹配（含捕获组）；3 秒内未完成则 `terminate()` 并返回 `pattern_too_slow`。字面模式与全词字面仍在主线程（线性，无回溯风险）。
- `searchCues`：正则时经 Worker 求匹配后计数与截断；`replace`：正则时先经 Worker 求匹配，再在文档事务中按匹配展开替换（主线程不再执行正则）。Worker 的输入是只读快照，事务内重新核对修订号，期间文档改变则按现有冲突处理。
- `index.ts` 只改 `searchCues` 的调用（异步等待 Worker），更新组合审计。

### 渲染端（R-FIND-05）

- `StudioCueFind.tsx`：区分大小写旁加“全词匹配”（`WholeWord` 图标）与“使用正则表达式”（`Regex` 图标）两个 `aria-pressed` 按钮与提示；Alt+W / Alt+R（焦点在查找栏内）；状态保存在会话内的查找偏好（模块级状态，关闭查找栏不丢失）。
- `!found.ok` 不再静默：`invalid_pattern` 显示“正则表达式无效”、`pattern_too_slow` 显示“表达式过于复杂”，替换按钮禁用；渲染端也先用 `new RegExp` 检查以便即时提示。
- 高亮：`CueFindHighlight` 增加 `regex`、`wholeWord`；正则模式下只有主进程查找成功（同一查找词与选项）后才在可见行上运行正则，并按（文字、查找词、选项）缓存——主进程已在 3 秒内跑完整篇，可见的至多 100 行代价有界。
- i18n：`studio:cue_find.whole_word`、`whole_word_hint`、`regex`、`regex_hint`、`invalid_pattern`、`pattern_too_slow`，4 种语言。

### UI 设计基准（I2）

- 参照：现有查找栏的“区分大小写”切换按钮（尺寸、按下样式、提示）；错误说明与“无匹配”同位置、用 `text-destructive`。
- 样本：正则 `\d+年`、无效 `(abc`、全词 cat、1280 浅色与 786 深色。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-FIND-01 | `findRanges` / `searchDocument`、`searchCues` 通道 |
| R-FIND-02 | `replaceText`、`replace` 编辑操作与撤销 |
| R-FIND-03 | `StudioCueFind` 查找栏、表格的快捷键 / 高亮 / 跳转、历史标签 |
| R-FIND-04 | `findMatches` / 全词边界 / `expandReplacement` / `cue-find-query.ts`、Worker 超时、`searchCues` 与 `replace` 的新选项 |
| R-FIND-05 | `StudioCueFind` 两个开关与快捷键、错误显示、高亮选项与缓存 |

## 代码落点

- `src/subtitle-studio/cue-find.ts`（新）、`src/subtitle-studio/cue-edit-contract.ts`、`src/subtitle-studio/ipc-contract.ts`
- `electron/main/subtitle-studio/cue-edit-service.ts`、`electron/main/subtitle-studio/index.ts`、`electron/preload/subtitle-studio-api.ts`、`electron/preload/subtitle-studio-channel-policy.ts`、`resources/speech-resources/provenance/current-integration-audits.v1.json`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueFind.tsx`（新）、`StudioCueFind.css`（新）、`StudioCueTable.tsx`、`src/services/subtitle-studio/cue-history.ts`、`src/locales/{zh,en,ja,zh-Hant}/studio.json`
- 测试：`src/subtitle-studio/cue-find.test.ts`（新）、`test/subtitle-studio/cue-find.test.ts`（新）、`test/subtitle-studio/ipc.test.ts`、`test/subtitle-studio/cue-find-ui.test.ts`（新）

## 验证与风险

- I2 风险：Worker 每次查找新建（约数十毫秒），换取可终止；正则的 `i` 标志与字面模式的 `toLocaleLowerCase` 在少数字符上结果不同（如土耳其语 İ），以正则语义为准。

- 单元：区间（大小写、重叠、多处）、整篇查找（跨页、译文范围、上限）、替换（片段内保留格式、跨片段、空结果、非法字符）、`replace` 操作（全部 / 指定、撤销、1000 条上限、翻译进行中）。
- 界面：真实 Electron（静默）——Ctrl+F、计数、跨页跳转与高亮、替换当前与全部、撤销后重新查找、Esc；截图审查。
- 风险：高亮在渲染端按同一纯函数计算，与主进程结果一致；大文档查找为一次线性扫描（10 万条约毫秒级到数十毫秒）。
