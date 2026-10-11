# 边听边校对 设计

## 现状与约束

- **播放器**：`src/services/subtitle-studio/cue-audio-player.ts` 用单个 `HTMLAudioElement` 播放主进程返回的 WAV（48 kHz 单声道 16 位），状态 `{ key, documentId, rows, phase, progress, reason }`，`useCueAudio(key)` / `useCueAudioRows(documentId)` 按需订阅；缓存 6 段对象 URL。只能单段播放，无法知道“当前播放到原媒体的哪一毫秒”以外的连续位置，也无法无缝衔接。
- **主进程截取**：`electron/main/subtitle-studio/cue-audio-clip.ts`，参数 `-ss <start> -i file:<媒体> -t <时长> … -f s16le pipe:1`。`-t` 在 `-i` 之后是**输出**时长；加入 `atempo` 后输出变长，需改为输入选项（实测：`-t 30` 放在 `-i` 后时 0.75× 输出仍只有 30 秒）。`readCueAudio` 请求 `{ documentId, target, padMs }`，单段上限 120 秒。实测 30 秒 MKV 片段解码约 0.5 秒。
- **列表**：`StudioCueTable.tsx` 的 `onKey` 已占用 Enter/F2、T、P、Ctrl+Z/Y/C/M、Delete、←/→；`timingProblem` 与 `saveTiming` 实现时间检查与保存；`data-playing` 行标记由 `useCueAudioRows` 驱动。每页 100 条，翻页由 `index.tsx` 的 `select(doc, offset)` 完成（`StudioPagination onChange`）。
- **时间编辑器**：`StudioCueTimeEditor.tsx`，两个输入框 + 错误行，Enter 保存 / Esc 取消 / 离开保存，`check` 回调检查相邻字幕。
- **偏好**：`useStudioPreferences` 已有 `cueAudioPadMs`；`test/subtitle-studio/transcription-preferences.test.ts` 精确断言持久化键。
- **测试**：Electron 测试窗口静音（`mute-audio` 同样静音 Web Audio，`AudioContext.currentTime` 照常推进）。

## 方案与取舍

### 播放引擎：Web Audio（R-LISTEN-01）

| 方案 | 结论 |
| --- | --- |
| 继续用 `<audio>`，连续播放时逐段切换 `src` | 不采用：每次切换有几十毫秒空档；不能精确知道段间衔接时刻。 |
| MediaSource 拼接压缩音频 | 不采用：需新增编码与分段时间戳处理，复杂度高。 |
| Web Audio：PCM 直接转 `AudioBuffer`，`AudioBufferSourceNode` 按 `AudioContext` 时钟首尾调度（**采用**） | 无缝；位置可由时钟精确换算；循环用 `source.loop`；变速由主进程 `atempo` 完成（不变调），引擎始终 1× 播放。 |

- 单例引擎（保留 `cueAudioPlayer` 名称与现有 `toggle / stop / stopFor / invalidate / subscribe / snapshot` 接口，组件无需改调用方式）：
  - 惰性创建一个 `AudioContext`；PCM（跳过 44 字节头）→ `Float32Array` → `AudioBuffer(1 声道, 48000 Hz)`，由上下文自行重采样。
  - **单段**：`source.start(ctx.currentTime + 0.02)`；`loop` 偏好开启时 `source.loop = true`；`onended` 结束。进度 = 已播时长 / 片段时长（循环时取余）。
  - **连续**（`follow`）：段长 20 秒（原媒体时间）。段 k 开始播放时请求段 k+1；段 k+1 的开始时刻 = 段 k 的开始时刻 + 段 k 的时长（输出样本数 / 48000）。段 k 播完时段 k+1 仍未就绪则进入 `loading`，就绪后立即开始（不追赶）。
  - **位置**：`positionMs = 段.clipStartMs + (ctx.currentTime − 段.ctxStart) × 1000 × tempo − 输出延迟`，输出延迟取 `ctx.outputLatency || ctx.baseLatency || 0`；对外 `positionFor(documentId)` 返回当前位置（无播放时为 null），并以约 10 Hz 发布 `positionMs` 供连续跟读高亮（单段时也发布，供打点）。
  - **结束**：连续播放请求的开始已不早于已知媒体时长，或主进程返回 `no_audio` / `invalid_input`（超出结尾）时，不再请求，当前段播完结束。
  - **改速度**：连续或单段播放中速度改变时，按当前位置重新开始（连续：从当前位置请求新段；单段：从当前位置到原片段结尾作为 `range` 重新请求）。
  - **缓存**：单段缓存保留（键加入 tempo）；连续播放的段不缓存。
- **主进程**：`readCueAudio` 请求增加可选 `tempo: 1 | 0.75 | 0.5`（默认 1）；FFmpeg 参数改为 `-ss <start> -t <输入时长> -i file:<媒体> … [-af atempo=<tempo>]`；输出上限按 `输入时长 / tempo` 计算；返回值增加 `tempo`。时间段规则与单段上限不变。

### 连续跟读（R-LISTEN-02）

- 入口：`Shift+P`（`onKey`）、行菜单“从这里连续播放”（快捷键 Shift+P）。起点 = 当前行开始 − 前余量；终点 = 媒体时长（转写文档）或直到 `no_audio`。
- 播放器状态增加 `mode: 'clip' | 'follow'` 与 `positionMs`。表格用 `useCueAudioFollow(documentId, cues)`（选择器返回当前页中“开始 ≤ 位置的最后一条”的 id，只在变化时重渲染），给该行 `data-playing data-following`，变化时 `scrollIntoView({ block: 'nearest' })`。
- 翻页：位置超过本页最后一条的结束（或开始 + 5 秒）且还有下一页时，表格调用新增的 `onFollowPage(offset)`，`index.tsx` 以 `select(page.summary, offset)` 静默翻页；用户手动翻页离开播放位置时不拉回。
- 高亮行的序号单元格显示停止按钮（连续播放的 key 为 `follow:<文档>`，按钮 `playKey` 匹配时显示进度 / 停止）。

### 速度与循环设置（R-LISTEN-03）

- 偏好新增 `cueAudioTempo: 1 | 0.75 | 0.5`（默认 1）、`cueAudioLoop: boolean`（默认 false）；`partialize` / `merge` 校验非法值回落默认；偏好测试断言更新。
- “原始音频”面板在“前后余量”下增加“播放速度”三段选择与“循环播放”开关（`Switch`），底部提示改为两行：“P 播放 / 停止 · Shift+P 从此连续播放”“播放时 [ / ] 设定开始 / 结束”。
- 工具栏按钮在 tempo ≠ 1 或循环开启时，右下角显示小角标（“0.75”或循环图标）；与“未关联”琥珀点互斥时琥珀点优先。

### 打点（R-LISTEN-04）

- `onKey` 处理 `[`、`]`（无修饰键）：
  1. `cueAudioPlayer.positionFor(documentId)` 为 null → 状态区提示 `cue_listen.mark_needs_playback`；
  2. `editBlocked` → 提示该原因；
  3. 当前行 = `selection.lead ?? 第一个所选`；不存在 → 忽略；
  4. `[`：`{ startMs: pos, endMs: cue.endMs }`；`]`：`{ startMs: cue.startMs, endMs: pos }`；先用现有 `timingProblem` 检查（`end_before_start` 等），有问题 → 状态区显示 `timeProblemKeys` 文案；
  5. 通过 → `run({ kind: 'timing', changes: { [id]: … } }, 'timing', 1)`；`]` 成功后把选择移到下一条（同页内）。
- 状态区临时提示：复用 `.studio-cue-bar-status`，新增 4 秒自动消失的 `notice` 状态（只用于打点提示，文字短）。
- 菜单：在“播放原始音频”下加“从这里连续播放 Shift+P”；帮助列表加 `follow`（Shift+P）与 `mark`（[ / ]）两项。

### 波形（R-LISTEN-05，I2）

- 引擎新增 `cueAudioPlayer.peaks(request, buckets)`：以 tempo 1、无余量请求 `range`，在渲染进程把 PCM 折成 `buckets` 组 `[min, max]`（内存，按文档修订 + 范围缓存最近 4 个）。
- `StudioCueTimeEditor` 新增可选 `waveform` 属性（由表格在媒体可用时传入 `{ load(range) }`）：输入框下方 240×36 的 `canvas`（随列宽，最小 160），范围 = [开始 − 1.5 秒, 结束 + 1.5 秒]（结束未知时开始 + 5 秒），两条竖线标记开始 / 结束（拖动时以 10 毫秒取整写回输入框），右侧一个小播放按钮试听当前输入的时间段（`range`）。加载中显示同尺寸的浅色占位，失败不显示。
- 指针拖动用 Pointer Capture；键盘仍以输入框为主（波形不进入 Tab 顺序，按钮可）。

### UI（设计基准）

- **依据**：沿用 studio-cue-audio 的视觉与组件（`CueAudioButton`、`StudioCueMediaControl` 面板、`ToolRadioButtonGroup`、`StudioIconButton`），加上 `src/components/ui/switch.tsx`。颜色：播放强调色沿用 `--studio-cue-audio`（亮 oklch(58% .16 237) / 暗 oklch(76% .13 232)）；波形填充 `color-mix(var(--muted-foreground) 55%, transparent)`，标记线用强调色，范围外区域降低透明度。
- **连续跟读高亮**：当前行背景 `color-mix(in oklab, 强调色 8%, var(--card))`（与选中色区分：选中为天蓝 13%），左侧 2px 强调条沿用 `data-playing`；滚动只在当前行离开可视区时发生。
- **面板**：宽度不变（288px），新增两组控件后高度约增加 70px；786×660 下面板不超出窗口（碰撞边距 8px）。
- **时间编辑器**：波形在两输入框下方、错误行上方，宽度与输入行一致，高 36px，圆角 6px，背景 `color-mix(var(--muted) 45%, var(--background))`；窄列（786）时宽度最小 160px，不撑宽时间列（时间列宽 208px，减去内边距约 192px）。
- **状态**：引擎 idle / loading / playing / error × mode clip / follow；打点 成功 / 被拒（原因）/ 未播放；波形 加载 / 显示 / 无媒体 / 失败。
- **验收样本**：转写文档（30 段、跨 2 页需 >100 条，测试用 120 条短句）；测试音频为每 2 秒交替“有声 1.2 秒 + 静音 0.8 秒”的 WAV，便于验证波形峰值与连续播放位置。

## 实施中确定（2026-10-11）

- **播放与波形分道解码**：主进程每个窗口只保留一个解码，原设计中编辑时间时加载波形会取消连续播放的下一段。`readCueAudio` 新增可选 `purpose: 'play' | 'waveform'`，截取器按“窗口 + 用途”各保留一个解码（`cue-audio-clip.ts`），波形请求不打断播放。
- **波形按可见范围内的最大值归一**（增益上限 20 倍），轻声的语音也能看清，接近静音时不会放大成噪声；开始 / 结束标记用文字颜色绘制，与高亮的时间段区分。
- **连续跟读高亮**用中性底色（前景色 5% / 深色 8%）加播放强调条，避免与天蓝色选中行混淆（初版用播放色，与选中色色相相同，渲染审查时难以区分）。
- **面板**：三行快捷键说明改为紧凑的键位列表（复用帮助列表文案）；面板高度限制为 Radix 给出的可用高度，窗口较矮时在面板内滚动。
- **测试**：连续播放每句约 1 秒，Playwright 的轮询间隔会退避到 1 秒，跨页与打点步骤改为逐帧等待（`waitForFunction` + `raf`）。

## 代码落点

- `src/subtitle-studio/cue-audio.ts`（`tempo` schema 与结果字段）
- `electron/main/subtitle-studio/cue-audio-clip.ts`（输入时长、`atempo`、输出上限；`index.ts` 不变，组合审计无需更新）
- `src/services/subtitle-studio/cue-audio-player.ts`（Web Audio 引擎、follow、loop、位置、peaks）与其单元测试
- `src/store/tools/subtitle-studio/preferences.ts`、`test/subtitle-studio/transcription-preferences.test.ts`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueAudio.tsx` / `.css`（面板速度与循环、角标、跟读 key）
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx` / `.css`（Shift+P、[ ]、跟读高亮与滚动、翻页回调、提示）
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueMenu.tsx`（“从这里连续播放”）
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueWaveform.tsx`（新）、`StudioCueTimeEditor.tsx`、`StudioCueTable.css`（I2 波形）
- `src/pages/Tools/Subtitle/SubtitleStudio/index.tsx`（`onFollowPage`）
- `src/locales/{zh,en,ja,zh-Hant}/studio.json`
- 测试：`test/subtitle-studio/cue-audio.test.ts`（tempo）、`src/services/subtitle-studio/cue-audio-player.test.ts`（引擎）、`test/subtitle-studio/cue-listening-ui.test.ts`（新）、`test/subtitle-studio/cue-audio-ui.test.ts`（回归）
- 文档：`CHANGELOG.md`、`docs/TODO.md`

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-LISTEN-01 | Web Audio 引擎（单段 / 连续 / 循环 / 位置 / 结束 / 改速）、主进程 `tempo` 与输入时长 |
| R-LISTEN-02 | `Shift+P` 与菜单入口、`useCueAudioFollow` 高亮与滚动、`onFollowPage` 翻页 |
| R-LISTEN-03 | 偏好 `cueAudioTempo` / `cueAudioLoop`、面板控件、工具栏角标 |
| R-LISTEN-04 | `onKey` 的 `[` / `]`、`positionFor`、`timingProblem` 检查、状态区提示、`]` 后移到下一条 |
| R-LISTEN-05 | `peaks`、`StudioCueTimeEditor` 波形与拖动标记、试听当前输入 |

## 验证与风险

- **单元**：引擎用假的 `AudioContext`（可控 `currentTime`、记录 `start(when)`）验证首尾调度、预取时机、位置换算（含 tempo 与输出延迟）、循环、改速重启、结束判定、缓存键含 tempo；`peaks` 折算。
- **主进程（真实 FFmpeg）**：0.75× / 0.5× 输出时长 = 输入时长 / tempo（±1 块）且过零率频率与 1× 相同；输入时长在 `-i` 前生效。
- **Electron UI**（静音）：连续跟读跨 3 段与跨页高亮、P 停止；速度 / 循环偏好与重启；打点成功 / 被拒 / 未播放提示、撤销；波形出现、拖动标记改写输入、保存与撤销；1280 浅色与 786 深色截图审阅。
- **风险**：
  - 输出延迟估计因设备而异：打点误差主要来自人的反应（约 0.2 秒），延迟扣除只作修正；验收以引擎报告位置为准。
  - 预取在慢速磁盘或网络盘上可能来不及，表现为短暂停顿（有加载状态）。
  - Web Audio 解码 PCM 在主线程转换，每 20 秒段约 96 万个样本，耗时约数毫秒，可接受。
  - 引擎重写影响已有单段播放：以现有单元与 UI 测试做回归。
