# 记住转写时的音轨 设计

## 现状与约束

- **转写选择**：渲染端入队请求 `files[].audioStreamId`（探测结果中的不透明 id，可省略）；冻结的 `media-normalizer.ts` 按 id 找到音轨并以 `-map 0:<streamIndex>` 解码，省略时用 `autoSelectedOrdinal`（唯一默认音轨，否则第一条）。探测摘要 `LocalSubtitleMediaProbeSummary` 含 `audioTracks[{ streamId, ordinal, isDefault, language?, title? … }]` 与 `autoSelectedStreamId`；`ordinal` 为该音轨在全部音频流中的序号（从 1 开始，按流顺序），与 FFmpeg 的 `0:a:<ordinal−1>` 一致。
- **可改范围**：`transcription/native/*` 为冻结副本不可改；`transcription/runtime.ts`（有组合审计）、`task-service.ts`、`document-sink.ts`、`document-adapter.ts`、`src/subtitle-studio/domain.ts` 为工作台自有。探测由 `runtime.ts` 的 `media.probe` 调用 `probeDraft`。
- **文档来源**：媒体文档 `origin = { format: 'media', displayName, durationMs, transcriptDigest }`（strict）；`origin` 参与源位置与所选媒体记录的指纹（新文档创建时即带音轨，不影响已有记录）。
- **截取**：`CueAudioClipper.decode` 固定 `-map 0:a:0`；`CueMediaService.resolve` 返回媒体路径与来源（linked / transcription / matched）；`readCueAudio` 与 `recognizeCue` 都经由它。
- **假运行时**（界面测试）替换整个 `runtime.ts`，自己创建任务并用真实的 `createTranscriptionDocumentSink` 发布文档。

## 方案与取舍

在入队时由运行时门面把“实际使用的音轨”解析为序号、语言与标题，随任务记录交给文档发布，写入文档来源（决策 A-01）；截取时按来源中的序号选择音频流，手动选择的媒体同样沿用并在缺少该流时回退（A-02）。

### 主进程（R-TRACK-01）

- `src/subtitle-studio/domain.ts`：媒体文档 `origin` 增加可选 `audioTrack: { ordinal: 整数 1..64, language?: ≤ 64 字符, title?: ≤ 255 字符 }`（strict）。导出不变；摘要随 `origin` 带出，供面板显示。
- `document-adapter.ts`：`transcriptToDocument(input, { …, audioTrack? })` 写入 `origin.audioTrack`。`document-sink.ts`：选项增加 `audioTrack`，传给适配器。
- `task-service.ts`：选项增加可选的 `describeAudioTrack(owner, fileToken, audioStreamId?)`；入队创建记录时解析并保存，创建 sink 时传入。
- `runtime.ts`：`media.probe` 成功后按 owner + fileToken 缓存探测摘要（随 owner 释放清除，最多保留最近 200 个）；`describeAudioTrack` 用所选 id，否则 `autoSelectedStreamId` 找到音轨。缓存缺失时不记音轨（行为同旧版）。更新组合审计。
- 假运行时：入队时按其探测摘要同样解析，并传给 sink。

### 截取（R-TRACK-02）

- `cue-media-service.ts`：解析结果的媒体增加 `audioOrdinal`（来源为 transcription 或 linked 时取 `origin.audioTrack.ordinal`，否则 1）。`CueMediaStatus`（ready / unavailable）增加可选 `track`（同样条件，文档记住音轨时给出）。
- `CueAudioClipper.decode(…, audioOrdinal = 1)`：`-map 0:a:<ordinal−1>`；ordinal > 1 且 FFmpeg 报告没有该流时，用 `0:a:0` 重试一次。
- `readCueAudio`、`recognizeCue` 传入 `audioOrdinal`。

### 渲染端（R-TRACK-02）

- `StudioCueMediaControl` 面板在文件名与来源下增加一行“音轨 N · 语言 · 标题”（`studio-cue-media-track`），没有 `track` 时不显示。

### UI 设计基准

- 参照“原始音频”面板现有的文件名 + 来源两行（`studio-cue-media-name` / `studio-cue-media-via`），新行与来源同样式（次要文字、单行省略）。
- 样本：第 2 条音轨“ja · 通訳音声”、只有序号、786 深色。

## 实施中确定（2026-10-11）

- **解析放在共享纯函数**：`audioTrackOfProbe(probe, audioStreamId?)` 在 `src/subtitle-studio/cue-audio.ts`，运行时门面与假运行时共用，单元测试直接覆盖。
- **渲染端总是显式发送所选音轨**：入队请求中每个文件都带 `audioStreamId`（未改动时为自动选择的那条），解析结果与“自动规则”一致。
- **假运行时的文档补上源位置**：生产环境发布的转写文档带有源文件的位置记录，假运行时之前没有传给 sink，导致界面测试中的转写文档没有原始音频；现在与生产一致。
- **测试文件**：单元测试放在已有的 `test/subtitle-studio/cue-audio.test.ts`（已有 FFmpeg 夹具与测频工具）与 `transcription-task-service.test.ts`，未另建 `cue-audio-track.test.ts`。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-TRACK-01 | `origin.audioTrack`、适配器 / sink / 任务服务 / 运行时的音轨解析与缓存、组合审计 |
| R-TRACK-02 | 解析结果的 `audioOrdinal`、`decode` 选流与回退、`CueMediaStatus.track`、面板一行 |

## 代码落点

- `src/subtitle-studio/domain.ts`、`src/subtitle-studio/cue-audio.ts`
- `electron/main/subtitle-studio/transcription/document-adapter.ts`、`document-sink.ts`、`task-service.ts`、`runtime.ts`、`resources/speech-resources/provenance/current-integration-audits.v1.json`
- `electron/main/subtitle-studio/cue-media-service.ts`、`cue-audio-clip.ts`、`cue-recognize-service.ts`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueAudio.tsx`、`StudioCueAudio.css`、`src/locales/{zh,en,ja,zh-Hant}/studio.json`
- 测试：`test/subtitle-studio/helpers/transcription-ui-runtime.ts`、`test/subtitle-studio/cue-audio.test.ts`、`test/subtitle-studio/transcription-task-service.test.ts`、`test/subtitle-studio/cue-audio-track-ui.test.ts`（新）

## 验证与风险

- 单元：真实 FFmpeg 生成两条音轨（440 / 880 Hz）的 MKV，按记住的序号解码并测频率；单音轨文件回退；文档校验；运行时缓存解析（选择、默认、无缓存）。
- 界面：假运行时构建中探测摘要有两条音轨，选第 2 条转写，打开生成的文档看面板一行；截图审查。
- 风险：探测与入队之间文件被替换时，冻结的规范化器以 `media_changed` 拒绝任务，记住的信息不会写入文档。
