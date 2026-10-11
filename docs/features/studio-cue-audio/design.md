# 字幕片段原始音频试听 设计

## 现状与约束

- **媒体路径已存在但私有**：转写文档在发布时由 `transcription/task-service.ts` 的 `resolveSourceLocation()` 调 `captureSourceInput(媒体路径)`，写入文档目录下的 `source-location.private.json`（`source-location-service.ts`，`origin: 'input'`，含 realpath 与文件身份）。导入的字幕文档同样记录的是**字幕文件**路径与其目录。注释明确“private receipts, never renderer capabilities”，渲染端只拿到 `SourceLocationSummary` 状态。
- **身份复核**：`verifySourceLocation()` 用 `lstat`/`realpath`/`localSubtitleFileIdentityForPath` 判断文件是否仍是当初那个；移动或修改即不可用。
- **FFmpeg 随应用打包并经校验**：`verifyLocalSubtitleRuntimeBundle({ environment, scope: 'media' })`（`transcription/native/resource-path.ts`）校验清单、许可与哈希后给出 `ffmpeg`/`ffprobe` 绝对路径；开发环境来自 `build/subtitle-studio-resources/transcription/win-x64/media/`。本机实测一次校验约 0.9 秒（哈希），因此不能每次试听都做。`media-process.ts` 的 `runLocalSubtitleMediaProcess` 提供 `shell:false`、超时、输出上限、取消与可注入 runner；`buildLocalSubtitleMediaEnvironment` 提供最小环境变量。`media-normalizer.ts` 的 `selectMediaTools` 未导出。
- **实测解码延迟**（本机，FFmpeg n8.1.2，30 分钟测试文件，从 25:00.25 截 4.5 秒，`-ss` 在 `-i` 前）：MKV（mpeg4+AAC）118–145 ms，MP3 169 ms，输出字节精确等于 4.5 s × 48000 × 2。
- **没有任何播放基础设施**：主进程无自定义协议、无 `file://` 媒体；渲染端现有播放方式是“主进程返回字节 → Blob URL → `<audio>`”（`SpeechSynthesizer/index.tsx`）。
- **IPC 约定**：`src/subtitle-studio/ipc-contract.ts` 的 `STUDIO_CHANNELS` / `requestSchemas`（zod strict）/ `SubtitleStudioApi`；主进程 `electron/main/subtitle-studio/index.ts` 一个循环注册，`ownerFor()` 校验能力信封、主框架与可信 URL，文档访问用 `owner.documents.has(id)`；preload `subtitle-studio-api.ts` 与 `subtitle-studio-channel-policy.ts` 白名单。错误统一 `StudioResult`，`ErrorCode` 被多个组件以 `satisfies Record<ErrorCode, string>` 穷举，新增错误码代价大。
- **UI**：`StudioCueTable.tsx` 每行 `#`/时间/文字/操作四列，工具栏在粘性表头最后一格（无选择时：AI 修订、一致性检查、撤销、重做、帮助）；`onKey` 已用 `t`（时间）、Enter/F2、Ctrl+M 等；`StudioCueMenu.tsx` 是右键/更多菜单；放大预览把同一个表格放大，并把区域外元素设为 inert（之后创建的 portal 不受影响）。`StudioCueRevision.tsx` 的建议行是 `<label>` 包裹复选框；`CueRevisionProposal` 只有 `cueId`/`index`，没有时间（整篇修订的建议可能不在当前页）。`StudioConsistencyCheck.tsx` 的出现项含 `documentId`/`cueId`，可跨文档。
- **测试**：Electron UI 测试默认 `FUSIONKIT_TEST_WINDOW=quiet`（`electron/main/test-window-mode.ts`），用户在跑测试时会玩游戏，不能出声或抢焦点。仓库内无二进制媒体夹具。

## 方案与取舍

### 总体：主进程按需截取片段，渲染端播放内存 WAV

```
渲染端 CueAudioButton / P 键
  → cue-audio-player（单例）：缓存命中直接播；否则
  → window.subtitleStudio.readCueAudio({ documentId, target, padMs })
      主进程：owner 校验 → 解析时间段（按文档当前内容）
             → CueMediaService.resolve(doc)：手动关联 / 转写来源 / 同名匹配，复核身份
             → MediaClipRunner：会话内已校验的 ffmpeg，-ss … -i 媒体 -t … → s16le 管道
             → 封装 WAV（内存）→ { bytes, clip 元数据 }
  ← Blob URL → 单个 HTMLAudioElement 播放，rAF 推进度
```

**取舍**：

| 方案 | 结论 |
| --- | --- |
| A. 自定义特权协议 + Range 流式读取整个媒体，`<audio>` 跳到开始时间 | 不采用。新增一个可被页面访问的读文件协议（攻击面）；Chromium 不支持 AVI/WMV/AC3/DTS/WMA 等常见字幕源媒体；VBR MP3 跳转可能偏差；仍需 FFmpeg 兜底，等于两套实现。保留为将来做“连续播放/波形”时的选项。 |
| B. 主进程 FFmpeg 截取片段，字节经 IPC 返回（**采用**） | 格式覆盖与转写一致；时间精确（解码级跳转，同转写时的时间基准）；不新增协议与临时文件；实测 ~150 ms 级延迟可接受；单段 ≤120 秒时 ≤11.5 MB。 |
| C. 预先把整份音频解码缓存到应用数据目录 | 不采用（用户明确不希望整份缓存；占盘大、失效难管理）。 |

时间基准：转写时用 `-copyts -start_at_zero` 从文件起点计时；FFmpeg 的输入 `-ss` 同样相对文件起点（自动计入流的 start_time），两者一致。导入字幕默认与媒体时间轴一致（本次不提供偏移）。

### 媒体关联（R-AUDIO-01）

新文件 `electron/main/subtitle-studio/cue-media-service.ts`：

- **手动关联记录** `cue-media.private.json`（与 `source-location.private.json` 同目录、同风格）：`{ schemaVersion: 1, documentId, bindingId, originFingerprint, mediaPath, mediaIdentity }`，`originFingerprint` 与来源记录相同算法（`sha256(JSON(doc.origin))`），文档来源变化（如“按原样导入”替换）后记录失效。仓库新增 `readCueMedia(id)` / `setCueMedia(id, record | null)`，沿用 `setSourceLocation` 的写入与 guard 方式；删除文档时随目录清理。
- **解析顺序** `resolve(documentId)` → `{ status, name, via, mediaPath?, mediaIdentity? }`（后两者仅主进程内使用）：
  1. 手动记录存在 → 复核 `lstat isFile` + `realpath` 不变 + 身份相同 → `ready / linked`；否则 `unavailable / linked`（不再往下回退，避免悄悄换成别的文件）。
  2. 来源记录 `origin: 'input'` 且文档 `origin.format === 'media'` → `verifySourceLocation` 通过 → `ready / transcription`；否则 `unavailable / transcription`。
  3. 字幕文档：来源记录可用时在 `capture.directoryPath` 中 `readdir`，用纯函数 `matchSiblingMedia(subtitleFileName, entries)`（`src/subtitle-studio/cue-audio.ts`）找唯一最佳候选 → 再做 `lstat isFile`（不跟随符号链接）与身份读取 → `ready / matched`。同目录条目上限 5000，超出视为未匹配。
  4. 否则 `missing`。
- **同名匹配规则**：`stem(name)` 去掉最后一个扩展名；字幕 stem 依次生成候选键：原 stem、去掉 1 段后缀、去掉 2 段后缀（后缀为 `.` 分隔、2–8 字符、字母开头的语言/版本标记，如 `en`、`zh-CN`、`chs`、`eng`、`forced`、`sdh`、`default`；纯数字不算）。比较时 NFC + 不区分大小写。按候选键顺序寻找，第一级出现唯一媒体即采用，同级多个则返回 `null`（不跨级继续）。
- **选择媒体文件**：`dialog.showOpenDialog(window, { properties: ['openFile'], filters: [媒体扩展名], defaultPath: 来源目录（若可用） })` → `realpath` + 身份 → 写手动记录。取消 → `null` 不变。
- **状态 DTO**（渲染端可见）：`CueMediaStatus = { status: 'ready' | 'unavailable', via: 'linked' | 'transcription' | 'matched', name: string } | { status: 'missing' }`，`name` 为 `path.basename`。

### 片段截取（R-AUDIO-02）

- **时间段解析**（纯函数，`src/subtitle-studio/cue-audio.ts`，主进程调用）：
  - `resolveCueAudioRange(cues, target, mediaDurationMs?)`：`target = { cueIds: [id] | [firstId, lastId] } | { range: { startMs, endMs } }`。字幕不存在 → `invalid_input`；首末顺序以文档顺序为准（反了自动交换）。未知结束：下一条 `startMs` 严格更大者，否则 `+5000`。`mediaDurationMs`（转写文档）作上限。返回 `{ startMs, endMs, truncated }`，长度 > 120000 时截为 120000 并 `truncated: true`。
  - `padMs ∈ {0, 300, 1000}`：`clipStartMs = max(0, startMs − pad)`、`clipEndMs = endMs + pad`（文件结尾由 FFmpeg 自然结束）。
- **运行器** `electron/main/subtitle-studio/cue-audio-clip.ts`：
  - `MediaToolsCache`：首次使用时 `verifyLocalSubtitleRuntimeBundle(scope: 'media')` + `selectCueAudioFfmpeg`（与转写同规则，见“实施中确定”）得到 ffmpeg；记录 ffmpeg 的 `lstat` 大小/修改时间。之后每次只比较 `lstat`，变化或进程启动失败时丢弃缓存并重新校验一次。
  - 参数：`-hide_banner -nostdin -v error -ss <clipStart 秒，3 位小数> -i <媒体路径> -t <时长> -map 0:a:0 -vn -sn -dn -ac 1 -ar 48000 -f s16le -acodec pcm_s16le pipe:1`。`cwd` 为应用数据目录下的 `subtitle-studio/cue-audio`（已存在则复用，仅作工作目录，不写文件）；环境用 `buildLocalSubtitleMediaEnvironment`。
  - 限制：超时 20 秒；`maxStdoutBytes = ceil(时长 × 96000) + 96000`；stderr ≤ 16 KiB。
  - 结果：退出码 0 且有数据 → `pcm` 截齐到 2 字节倍数，前加 44 字节 WAV 头（自写 `wavHeader(dataBytes, 48000, 1)`，不复用固定 16 kHz 的转写头）；退出码 0 但无数据 → `no_audio`；stderr 含 `matches no streams` / `does not contain any stream` → `no_audio`；其它失败 → `decode_failed`；校验失败 → `runtime_unavailable`。
  - 取消：每个 owner（`webContents.id`）只保留一个进行中的请求，新请求 `abort()` 旧的；owner 释放时中止。
- **IPC**（`STUDIO_CHANNELS` 新增，均需 `owner.documents.has(documentId)`）：

| 方法 | 通道 | 请求 | 返回值 |
| --- | --- | --- | --- |
| `getCueMedia` | `subtitle-studio:cue-media` | `{ documentId }` | `CueMediaStatus` |
| `chooseCueMedia` | `subtitle-studio:choose-cue-media` | `{ documentId }` | `CueMediaStatus \| null`（取消） |
| `clearCueMedia` | `subtitle-studio:clear-cue-media` | `{ documentId }` | `CueMediaStatus` |
| `readCueAudio` | `subtitle-studio:read-cue-audio` | `{ documentId, target, padMs }` | `CueAudioResult` |

`CueAudioResult = { kind: 'clip', bytes: Uint8Array, mimeType: 'audio/wav', revision, startMs, endMs, clipStartMs, clipEndMs, truncated } | { kind: 'unavailable', reason: 'no_media' | 'media_unavailable' | 'no_audio' | 'decode_failed' | 'runtime_unavailable' | 'cancelled' }`。媒体问题作为正常结果返回，不扩充 `ErrorCode`；请求不合法、无权访问等仍走现有错误码。

一致性检查可能涉及当前窗口未打开过的文档：`readCueAudio`/`getCueMedia` 只接受 `owner.documents` 中的文档。一致性检查的文档来自文档库选择，`listDocuments` 已把列出的文档登记到 `owner.documents`（`index.ts` 第 273–276 行），因此可直接使用；万一被拒绝则该项显示不可用，不报错。

### 渲染端播放器（R-AUDIO-03/04/05）

- `src/services/subtitle-studio/cue-audio-player.ts`：模块级单例 `cueAudioPlayer`
  - 状态 `{ key, phase: 'loading' | 'playing' | 'error', progress, reason? } | null`，`subscribe/getSnapshot`；组件用 `useCueAudio(key)`（`useSyncExternalStore`，非当前 key 返回同一个 `null`，只有正在播的按钮重渲染）。
  - `toggle(key, request)`：同 key 正在加载/播放 → `stop()`；否则停止当前、查缓存或调用 `readCueAudio`；返回过时（期间又发起了别的请求）则丢弃。
  - 单个 `new Audio()`（不挂 DOM），`ended` → 空闲；播放中 rAF 计算 `progress = currentTime / duration`，进度变化 < 1% 不发布。
  - 缓存：`Map<cacheKey, { url, meta }>` LRU 6，淘汰时 `URL.revokeObjectURL`；`cacheKey = documentId|revision|mediaEpoch|target|padMs`。`revision` 用返回结果中的文档修订号，命中判断要求调用方传入的当前修订号一致（一致性检查等不知道修订号的调用不查缓存）；关联变化时 `mediaEpoch++`（清空该文档缓存）。
  - `stop()`：暂停、清进度；`stopAll` 在文档切换、工作台卸载、对话框关闭时调用。
  - 错误：`phase: 'error'` 保留 4 秒或直到下次操作。
- 偏好：`useStudioPreferences` 新增 `cueAudioPadMs: 0 | 300 | 1000`（默认 300），`partialize`/`merge` 同步，非法值回落 300。
- 测试静音：`installTestWindowMode` 对 quiet/inactive 追加 `app.commandLine.appendSwitch('mute-audio')`（静音不影响 `currentTime` 推进）。

### UI（设计基准）

- **设计依据**：内置前端质量流程（`spec-driven-ai-coding/references/frontend-quality.md`）；视觉沿用工作台现有控件：`StudioIconButton`（ghost、`icon-sm`）、行操作按钮（`icon-xs`）、`StudioCueMenuContent` 菜单项带快捷键、`.studio-cue-bar-status` 的 aria-live 状态文字、`Popover`（`src/components/ui/popover.tsx`）。图标 lucide：`Play`、`Square`（停止）、`LoaderCircle`、`AudioLines`（原始音频）、`AlertCircle`。
- **用户与流程**：校对者在列表中逐行核对 → 对某行有疑问 → 悬停点 ▶ 或按 P 听原声 → 修改文字/时间 → 再听。AI 修订结果逐条勾选前先听原声判断建议是否正确。高频、短时操作，必须零布局位移、键盘可达。
- **预览列表**：
  - `#` 列（现宽约 44px）内叠放：默认显示序号；行悬停、键盘当前行（`data-lead`）、播放中时，序号淡出，原位置显示 20×20 圆形按钮（▶ / 加载旋转 / ■ + 进度环 / ⚠）。按钮绝对定位于单元格内，不改变列宽与行高；`tabIndex=-1`（键盘用 P，避免每行多一个 Tab 停靠点），有 `aria-label`（“播放第 12 条原始音频”/“停止”）。播放中行的序号单元格左侧 2px 强调色条（复用选中色系），序号以外内容不变。
  - 工具栏（无选择时在“AI 修订”前；有选择时在“翻译”前）新增“原始音频”按钮（`AudioLines`）：已关联为常规色，未关联/不可用为弱化色并在右下角 6px 琥珀点。点击打开 Popover（宽 280px，`align="end"`）：
    - 标题行“原始音频”；状态行：文件名（`StudioFileName` 中间省略）+ 关联方式小字（“转写来源”/“同名自动匹配”/“手动选择”），或“未找到原始媒体”/“原始媒体已移动或修改”与一句说明。
    - 按钮：“选择媒体文件…”（已关联时为“更换…”）、“取消关联”（仅手动关联时出现）。
    - “前后余量”`ToolRadioButtonGroup`（无 / 0.3 秒 / 1 秒）。
    - 底部一行提示“选中字幕后按 P 播放”。
  - 菜单：首项“播放原始音频”（快捷键 P）；不可用时禁用并在菜单底部说明“未关联原始媒体”（见“实施中确定”）。
  - 帮助列表加一项 `P — 播放/停止原始音频`。
  - 无媒体时按 P：打开“原始音频”面板（见“实施中确定”）。
- **AI 修订结果**：序号 `studio-cue-revision-number` 前加同款 20px 按钮（在 `<label>` 内，点击 `preventDefault + stopPropagation`，不切换复选框）；文档无可用媒体时不渲染按钮（不占位）。结构建议按钮请求：合并 → `range = proposal.timing`；删除 → `cueIds: [id]`；改时间 → `range = proposal.timing`（新时间）。
- **一致性检查**：每处出现行首加同款按钮（18px），请求 `{ documentId: 出现项文档, cueIds: [cueId] }`；按出现项文档读取一次媒体状态，没有可用媒体的出处不显示按钮、留空对齐。
- **状态矩阵**：媒体 ready / missing / unavailable × 按钮 idle / loading / playing / error；不可用原因文案：未关联原始媒体、原始媒体已移动或修改、媒体中没有音轨、无法解码该片段、播放组件不可用。
- **窄屏**：786 宽时 `#` 列宽度不变（按钮在列内）；Popover 碰撞边距 8px，宽度 `min(280px, 100vw − 24px)`。
- **动效**：进度环用 `stroke-dashoffset`，不加过渡；序号/按钮切换 120ms 透明度；`prefers-reduced-motion` 下去掉过渡与旋转之外的动画。
- **验收样本**：转写文档（日语长句 + 1–2 字短句相邻）；带 `.en.srt` 的同名 MKV 与 LRC（未知结束）；无媒体的 SRT；AI 修订“prepared”结构建议（合并/改时间）。

## 实施中确定（2026-10-11）

- **两处验收标准随渲染审查调整**（实现前的文字方案在真实界面中不理想，均在用户验收前修改）：
  - AC-AUDIO-03-3 旧：“按 P 时在列表状态区提示‘未找到原始媒体’并可从面板选择文件” → 新：“按 P 时打开‘原始音频’面板”。原因：提示文字放在表头状态区时与列标题挤在一起（截图 06 初版），而面板本身就说明原因并提供“选择媒体文件…”，少一步操作。影响：去掉 `cue_audio.no_media_notice` 文案。
  - AC-AUDIO-04-2 旧：“未关联媒体时按钮显示不可用原因” → 新：“不显示播放按钮（行首留空对齐）”。原因：与预览列表一致（无媒体不出按钮），避免对一整组无媒体文档的出处逐个点出错误；每个文档的状态按需读取一次。
- **菜单位置**：“播放原始音频”放在右键/更多菜单首项（只读操作，最常用），而非“复制”分组前。
- **弹出面板的事件**：面板 portal 到 body，但 React 合成事件仍沿组件树冒泡到字幕列表；列表的 `onMouseDown` 会抢焦点、`onPointerDown` 会改选择，导致面板一点就关。面板内容对 mouse/pointer/click/contextmenu 事件 `stopPropagation`；“选择媒体文件…”忙碌时不禁用按钮（禁用已聚焦按钮也会让焦点离开面板），以 `aria-busy` 和防重入代替。面板打开时隐藏触发按钮的提示，免得提示盖住面板。
- **行内按钮不取焦点**：点击时 `mousedown` 阻止默认行为，焦点留在列表，P 等快捷键继续可用，也不会因聚焦留下“停止播放”提示。
- **共享修复**：`StudioFileName` 把文件名拆成两段 flex 子项，断点处的空格会被折叠（“Picked take.wav” 显示成 “Pickedtake.wav”，库列表等处同样存在）。`.studio-file-name` 由 `white-space: nowrap` 改为 `pre`。
- **转写文档更换导出文件夹**：“选择来源文件夹”会覆盖记录转写媒体的来源回执，覆盖前先把媒体转存为手动关联（`keepTranscribedMedia`），试听不受影响。
- **冻结副本不改**：`transcription/native/media-normalizer.ts` 是由 provenance 重放逐字节核对的冻结副本（`test/subtitle-studio-provenance/replay.test.ts`），原计划“仅导出 `selectMediaTools`”会使重放失败。改为在 `cue-audio-clip.ts` 中以 `selectCueAudioFfmpeg` 按同样规则（证明有效、scope、ready、唯一 ffmpeg、`backend: media`、版本等于 `LOCAL_SUBTITLE_MEDIA_POLICY`）选出 ffmpeg，只读引用导出的策略常量。`electron/main/subtitle-studio/index.ts` 属于受审计的组合源，按惯例在 `resources/speech-resources/provenance/current-integration-audits.v1.json` 更新 `currentBlobOid` 并追加本次审查说明。
- **测试**：Radix 提示在指针离开后要等下一次移动才关闭，Playwright 的单步移动不会产生这次移动；测试中以两段移动模拟真实指针（真实使用不受影响）。

## 代码落点

- `src/subtitle-studio/cue-audio.ts`（新：扩展名、同名匹配、时间段解析、请求/结果 schema 与类型）
- `src/subtitle-studio/ipc-contract.ts`（通道、请求 schema、API 方法）
- `electron/main/subtitle-studio/cue-media-service.ts`（新：关联解析、选择、清除）
- `electron/main/subtitle-studio/cue-audio-clip.ts`（新：运行时缓存、FFmpeg 截取、WAV 封装、取消）
- `electron/main/subtitle-studio/document-repository.ts`（`readCueMedia` / `setCueMedia`）
- `electron/main/subtitle-studio/index.ts`（注册与 owner 校验、owner 释放时取消）
- `resources/speech-resources/provenance/current-integration-audits.v1.json`（`index.ts` 组合审计）
- 不改动转写冻结副本 `transcription/native/media-normalizer.ts`（只读引用其导出的策略常量，见“实施中确定”）
- `electron/preload/subtitle-studio-api.ts`、`electron/preload/subtitle-studio-channel-policy.ts`
- `electron/main/test-window-mode.ts`（静音）
- `src/services/subtitle-studio/cue-audio-player.ts`（新）
- `src/store/tools/subtitle-studio/preferences.ts`（余量偏好）
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueAudio.tsx` + `StudioCueAudio.css`（新：`CueAudioButton`、`StudioCueMediaControl`）
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx`、`StudioCueTable.css`、`StudioCueMenu.tsx`、`StudioCueRevision.tsx`、`StudioConsistencyCheck.tsx`、`index.tsx`
- `src/locales/{zh,en,ja,zh-Hant}/studio.json`
- 测试：`src/subtitle-studio/cue-audio.test.ts`、`test/subtitle-studio/cue-audio.test.ts`、`test/subtitle-studio/cue-audio-ui.test.ts`、`test/subtitle-studio/ipc.test.ts`（通道）
- 文档：`docs/electron-renderer-api-quick-reference.md`（如列有 studio 方法则补充）、`CHANGELOG.md`

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-AUDIO-01 | `cue-media-service.ts` 解析顺序与身份复核、`cue-media.private.json`、`matchSiblingMedia`、`getCueMedia`/`chooseCueMedia`/`clearCueMedia`、`CueMediaStatus` 不含路径 |
| R-AUDIO-02 | `resolveCueAudioRange`、`cue-audio-clip.ts`（运行时缓存、FFmpeg 参数、限制、WAV 封装、owner 级取消）、`readCueAudio`、`CueAudioResult` |
| R-AUDIO-03 | `cue-audio-player.ts`、`CueAudioButton`（`#` 列叠放）、`StudioCueMediaControl` 弹出面板、P 键、菜单项、帮助项、状态提示、放大预览共用表格 |
| R-AUDIO-04 | `StudioCueRevision` 建议行与结构建议行按钮、`StudioConsistencyCheck` 出现项按钮、对话框关闭 `stopAll` |
| R-AUDIO-05 | `test-window-mode.ts` 静音开关、播放器 LRU 6 与 `revokeObjectURL`、缓存键含修订号与关联版本 |

## 验证与风险

- **单元**：同名匹配（多级后缀、同级冲突、大小写、非媒体扩展名、条目上限）、时间段解析（未知结束、首末交换、上限截断、媒体时长约束、余量）、WAV 头。
- **主进程（真实 FFmpeg）**：在临时目录用随应用的 FFmpeg 生成分段频率测试音频（0–10 s 440 Hz，10–20 s 880 Hz，WAV 与 MKV/MP3 两种容器），截 9.5–10.5 s 之类跨界片段验证长度、频率位置（过零率估计）；未关联/移动/修改/无音轨（纯视频）/损坏文件/运行时校验失败（注入）各原因；并发请求取消（注入慢 runner 与真实进程）；临时目录无残留。若开发环境运行时不可用则该检查记为阻塞，不以 mock 冒充。
- **IPC**：新通道在白名单、未登记文档被拒、返回值不含路径（断言序列化结果中不含媒体目录字符串）。
- **Electron UI**（`FUSIONKIT_STUDIO_E2E=1`，quiet 静音）：种子转写文档 + 来源记录指向生成的测试音频；字幕文档 + 同名 MKV；无媒体 SRT。步骤：悬停播放→状态 playing→自然结束→idle；P 键多选连续；切换文档停止；未关联提示与选择文件（stub `dialog.showOpenDialog`）；余量切换；放大预览中 P；AI 修订 prepared 结构建议播放不改变勾选；一致性检查出现项播放。截图 1280×860 浅色、786×660 深色：行悬停、播放中、弹出面板（已关联/未关联）、修订结果；亲自查看并修复复验。
- **风险**：
  - 媒体时间轴与字幕不一致（导入字幕本身有偏移）：本次不处理，用户可见听到的位置不对——属内容问题，非实现缺陷。
  - 多音轨文件固定第一条音轨，可能不是转写时所选音轨：记录为已知限制。
  - 首次试听需校验运行时约 1 秒：按钮显示加载中；之后 ~150 ms。
  - 网络盘/大文件首次跳转可能更慢：20 秒超时兜底并可取消。
  - 120 秒 × 48 kHz 单声道 = 11.5 MB 经 IPC：可接受；不提供更长片段。
