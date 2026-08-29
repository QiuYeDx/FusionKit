# 音频转文本工具增强 Final Design

> 版本目标：v0.3.1 及后续兼容版本
> 文档状态：设计冻结，待拆分执行计划
> 调研与设计日期：2026-08-30
> 适用范围：`/tools/audio/transcriber` 远程大模型 API 音频转文本工具

## 0. 评审结论

这次增强不能只在页面上增加 `srt/lrc` 两个选项，也不能只在文件过大时按固定字节截断。现有实现把“用户要保存什么格式”与“供应商接口返回什么格式”都放在 `responseFormat` 中，并在文件授权阶段直接套用供应商格式与大小限制，因此默认 GPT 转写模型只返回 JSON 时，页面也只能提供 JSON；MiMo 只接受 WAV/MP3 时，用户在选择阶段就无法加入其他媒体；超过单次请求上限的文件则直接失败。

最终方案冻结为以下四项：

1. **用户导出格式与供应商响应格式解耦。** 用户选择 `TXT / JSON / SRT / VTT / LRC`；Electron main 根据可信的 provider route、模型、时间戳能力和任务模式，私下选择供应商 `response_format`。所有响应先归一化为 FusionKit canonical transcript，再由本地 exporter 生成最终格式。
2. **文件选择不再等于供应商上传。** 页面接受常见音频和视频媒体；main 先做 sender-bound 授权、ffprobe 探测和音轨选择，再决定直传、抽取音轨、转码或分片。供应商不支持原媒体格式时，由 bundled FFmpeg 转为该 route 接受的 MP3 或 WAV。
3. **大文件由一个可取消的 main-process 任务编排。** 任务拥有媒体准备、边界检测、分片、逐片请求、合并和导出阶段。传输分片以供应商 payload 上限为边界，VAD 只辅助寻找自然切点；任何分片都必须保留原始媒体的绝对时间域。
4. **远程音频转写与本地字幕转写继续隔离。** 不把远程 ASR 变成本地字幕工具的另一种 engine，也不让 `audio:*` 调用本地 Whisper Job Manager。可以抽取 bundled FFmpeg resolver、受控子进程、媒体探测、原子文本产物等无 provider 语义的基础设施，但两套 route、Store、IPC、任务和 capability registry 仍保持独立。

### 0.1 必须遵守的约束

- 不得再用 provider preset 单独判断 ASR 能力；必须使用 `providerPreset + route.transport + route.model` 解析完整 route 约束。
- 不得让 renderer 提交真实路径、FFmpeg 路径、供应商 payload 上限、内部响应格式或分片时间边界。
- 不得把源文件大小与供应商单次上传大小混为同一上限；大源文件可接受，但每个实际请求必须独立通过 route payload 校验。
- 不得把 VAD 检测到的语音拼接成“去静音时间轴”后直接用于字幕；canonical 时间必须映射回原媒体整数毫秒。
- 不得把供应商原生 SRT/LRC 当作最终产物；必须经过统一 canonical、结构校验、时间轴校验和本地 exporter。
- 不得让页面卸载成为长任务的唯一 owner；SPA 路由切换后任务继续，窗口 owner 结束或用户取消时才收敛任务。
- 不得从系统 PATH、Homebrew、Chocolatey、注册表或用户选择的 executable 回退 FFmpeg；packaged 模式只使用 manifest 校验后的 app 资源。
- 不得因一个分片失败而提交看似完整的最终字幕；失败任务保留可重试的同会话分片检查点，只有全部计划单元完整覆盖后才能正常完成。

## 1. 背景、目标与非目标

### 1.1 背景

当前工具已经具备 OpenAI/MiMo route、文件 token、输出目录 token、取消、结果保存和 route-aware 字段显隐，但产品体验仍受单次 API 请求合同直接支配：

- 默认 OpenAI GPT transcription route 只开放 JSON，用户看不到 SRT/LRC。
- Whisper route 虽然可直接返回 SRT/VTT/verbose JSON，但 MiMo 和 GPT route 没有同等能力。
- OpenAI 路径当前接受 WAV、MP3、MP4、M4A、FLAC、OGG、WebM 等有限格式；MiMo 路径只接受 WAV/MP3。
- renderer 与 main 都会在开始前直接拒绝超过 25 MiB 或 MiMo Base64 预算的文件。
- 音频工具没有接入 FFmpeg/ffprobe、音轨选择、媒体规范化、上传分片、分片进度或 canonical 字幕导出。
- 当前 `audio:transcribe` 是一次 request/response；长媒体无法在页面导航后稳定重同步阶段和进度。

### 1.2 目标

1. 用户可选择常见音频和视频媒体，工具自动探测音轨并在必要时转码。
2. 用户可稳定导出 TXT、canonical JSON、SRT、VTT 和标准行级 LRC。
3. 超过供应商单次 payload 上限的媒体自动按可信预算分片，不要求用户手工裁剪。
4. 优先在静音/语音边界切片，避免句中硬切；无法取得可靠语音边界时有明确、可用的固定窗口 fallback。
5. 合并后文本顺序、原始时间轴、取消、错误、临时文件与输出提交都有可验证合同。
6. 用户在开始前能看到是否会转码、预计请求数、时间轴质量和可能的额外费用/耗时。
7. 保留现有 Audio API profile、assignment、provider route 和 renderer 安全边界。

### 1.3 成功标准

- 一个大于当前单次上传上限的长媒体可以自动完成转码、分片、逐片转写、合并和导出。
- MKV/MOV/MP4 等包含音轨的视频可以被选择；多音轨媒体可以选择目标音轨。
- MiMo route 下选择 M4A/MP4 等输入时，不再在 renderer 直接失败，而是转为 MiMo 接受的上传格式。
- 任一可用 transcription route 至少能导出 TXT 和 canonical JSON。
- 有原生时间戳或本地可解释估算时间轴时，可以导出 SRT/VTT/LRC；UI 明确显示“原生时间戳”或“智能估算时间轴”。
- 取消会中止当前 FFmpeg/VAD/HTTP 工作，等待 child `close`，清理任务临时目录，并阻止 late response 覆盖终态。
- 正常完成、失败重试、页面离开/返回和窗口退出均不泄漏文件 capability、API Key、原始路径、临时媒体或子进程。

### 1.4 非目标

- 不把本地 Whisper 加入 `/tools/audio/transcriber` 的 provider 列表。
- 不在本需求中实现批量媒体队列；首版仍一次准备一个源媒体，但一个任务内部可以有多个上传分片。
- 不承诺对所有 FFmpeg 可解码格式开放 UI；首版接受列表沿用本地字幕工具已验证的常见音视频格式，扩展需补 fixture 和 packaged QA。
- 不做说话人分离、逐词卡拉 OK LRC、人工时间轴编辑器或自动翻译。
- 不保证无时间戳 provider 的估算字幕达到强制对齐工具的精度；必须通过 `timingQuality` 和 UI 标签如实表达。
- 不在首版跨应用重启恢复未完成的远程任务；同会话失败可复用已完成分片，应用重启后用户需重新授权源文件。
- 不把供应商原始 JSON 作为稳定公开 schema；稳定合同是 FusionKit canonical JSON。

## 2. 当前实现与可复用资产

### 2.1 远程音频转写当前链路

| 层级 | 当前文件 | 现状与限制 |
| --- | --- | --- |
| 页面 | `src/pages/Tools/Audio/AudioTranscriber/index.tsx` | 单文件、一次请求；文件选择前按 route 限制格式/大小；等待最终结果 |
| 偏好 | `src/store/tools/audio/audioTranscriberConfig.ts` | `responseFormat` 同时表达用户输出和供应商响应；OpenAI 25 MiB、MiMo Base64 10 MiB 常量重复存在 |
| Store | `src/store/tools/audio/useAudioTranscriberStore.ts` | 仅 `idle/running/completed/failed/cancelled`，无阶段/分片进度；只持久化偏好 |
| Route registry | `src/lib/audio-provider-registry.ts` | 已按模型区分 GPT/Whisper/MiMo，但只有响应格式、语言、prompt、stream、timestamp 字段，没有输入媒体与 payload 约束 |
| IPC 类型 | `src/type/audio.ts`、`src/type/audioIpc.ts` | `CreateAudioTranscriptionRequest.responseFormat` 直接进入 adapter；结果可能把全文和 raw JSON 送入 renderer |
| 文件授权 | `electron/main/audio/audio-file.ts` | 授权时即验证供应商格式和单次请求大小；大文件无法成为合法 draft |
| Main IPC | `electron/main/audio/ipc.ts` | 消费文件 token 后直接调用一次 runtime；取消只管理当前 HTTP request controller |
| OpenAI adapter | `electron/main/audio/adapters/openai-audio-adapter.ts` | multipart 单文件请求；将整个已受限文件读入内存；可解析 JSON/text/SRT/VTT/verbose JSON |
| MiMo adapter | `electron/main/audio/adapters/mimo-chat-audio-adapter.ts` | 将整个文件编码为 data URI；只返回 JSON/text 语义，没有时间戳 |
| 保存 | `src/services/audio/audioTranscriptionService.ts` | 按供应商响应格式保存；尚无 LRC，也没有统一 canonical exporter |

### 2.2 已经存在但不能直接复制合同的能力

本地字幕转写已经实现以下可借鉴能力：

- `electron/main/local-subtitle/media-normalizer.ts`：bundled FFmpeg/ffprobe 校验、媒体探测、音轨选择、16 kHz mono PCM16 规范化、磁盘预算、机器进度和取消。
- `electron/main/local-subtitle/media-process.ts`：受控 spawn、最小环境、stdout stream/capture 分离、stderr 上限、SIGTERM/SIGKILL 与 `close` 确认。
- `electron/main/local-subtitle/pcm-window.ts`：基于 PCM frame 的精确窗口、文件身份和 parse-back。
- `electron/main/local-subtitle/subtitle-formats.ts`、`subtitle-exporter.ts`：整数毫秒、SRT/LRC 严格格式、parse-back、原子写入和 artifact token。
- `electron/main/local-subtitle/vad-manager.ts`：Silero VAD 资源 manifest、下载、哈希与占用管理。
- `electron/main/local-subtitle/session-registry.ts`、`session-lifecycle.ts`：main 权威状态、owner release 和分阶段清理。

这些模块带有 `local-subtitle` 类型、品牌证明、模型/任务语义，不能从 `audio:*` 直接调用。v0.3.1 应抽取真正通用的低层基础设施，同时为远程 ASR 建立独立 `AudioTranscriptionJobManager`、文件 lease、分片 planner、canonicalizer 和 exporter。

### 2.3 复用边界

| 可抽取为共享基础设施 | 必须继续独立 |
| --- | --- |
| bundled media runtime resolver 与 manifest 校验 | `audio:*` 和 `local-subtitle:*` IPC |
| native media process runner | 文件/目录 token registry 与 TTL |
| ffprobe schema/parser 与安全元数据清洗 | Audio API profile/assignment/route |
| PCM frame/time 换算、磁盘预算工具 | 本地 Whisper model/backend/runner |
| SRT/VTT/LRC 时间格式与 parse-back primitives | 两套任务状态、队列和错误 manifest |
| 原子 UTF-8 文本 artifact publisher | 本地字幕翻译 handoff 与 Artifact Registry |

首个重构 checkpoint 可以继续消费现有 `local-subtitle` resource bundle 中已经审计的 FFmpeg/ffprobe bytes，但共享 resolver 不得要求本地 Whisper 模型、VAD 或本地字幕 session 已启用。后续只有经过 packaged QA 后才可以迁移资源目录或 manifest 名称。

## 3. 外部 API 事实与 route 建模原则

### 3.1 OpenAI 当前事实

调研日 2026-08-30：

- OpenAI 官方 File transcription guide 说明 Transcriptions API 单文件上限为 25 MB，并建议大文件使用压缩格式或切成不超过上限且避免句中切断的片段：<https://developers.openai.com/api/docs/guides/speech-to-text>。
- 同一 guide 列出 MP3、MP4、MPEG、MPGA、M4A、WAV、WebM；当前 endpoint API reference 还列出 FLAC 和 OGG：<https://developers.openai.com/api/reference/python/resources/audio/subresources/transcriptions/methods/create>。
- endpoint API reference 的 `response_format` 与 timestamp 能力依赖具体模型；`chunking_strategy` 是上传后由部分模型执行的 server-side 分块能力，不能绕过客户端 25 MB 上传上限。

因此本文不把“OpenAI 只支持 WAV/MP3”写入产品结论，也不把 25 MB 写成所有供应商永远不变的常量。它只作为内置 OpenAI route 在当前版本的已验证默认值。

### 3.2 MiMo 与自定义兼容 API

当前仓库把 MiMo ASR 建模为：

- 输入只接受 WAV/MP3 MIME。
- data URI/Base64 总预算 10 MiB。
- 输出只接受 JSON/text。
- 没有 provider-native timestamp。

这组值是当前实现合同，不应散落在 renderer 和 `audio-file.ts`。实施前只需做一次范围明确的供应商文档/真实 fixture 复核；若真实值变化，更新 route registry 与 fixture，不改变通用 pipeline。

自定义 OpenAI-compatible route 必须 fail closed：默认只假设 JSON、无时间戳、无 stream，并要求高级配置显式声明输入 MIME、transfer encoding 和 payload budget 后才开放自动转码/分片。

### 3.3 Route 约束的新职责

`AudioTranscriptionRouteConstraints` 扩展为单一事实来源：

```ts
interface AudioTranscriptionRouteConstraints {
  providerResponseFormats: readonly AudioProviderTranscriptionResponseFormat[];
  languages?: readonly string[];
  supportsPrompt: boolean;
  supportsStreaming: boolean;
  timestampCapability: "none" | "segment" | "word_and_segment";
  serverChunking?: "unsupported" | "auto_vad";
  upload: {
    transfer: "multipart_file" | "base64_data_uri";
    acceptedMimeTypes: readonly string[];
    maxRawFileBytes?: number;
    maxEncodedPayloadBytes?: number;
    preferredNormalizedProfiles: readonly AudioUploadProfileId[];
  };
}
```

约束解析仍必须由现有 `resolveTranscriptionRouteDefinition({ providerPreset, transport, model })` 完成。renderer 只消费脱敏后的能力摘要；main 在开始任务时重新解析并冻结可信快照；adapter 在每个分片请求前再做 defense-in-depth 校验。

## 4. 最终用户体验

### 4.1 主流程

```text
选择/拖入媒体
  → main 授权并探测容器、时长、音轨
  → 用户确认音轨（只有多音轨时显示）
  → 页面展示执行预览：直传/转码、时间轴质量、预计分片/请求数
  → 开始任务
  → 准备媒体 → 智能分片 → 转写 i/n → 合并 → 导出
  → 预览、复制、保存/打开结果
```

### 4.2 输入体验

- `accept` 复用并抽取本地字幕工具当前常见媒体列表：`audio/*, video/*, .aac, .flac, .m4a, .mkv, .mov, .mp3, .mp4, .ogg, .wav, .webm`。
- `accept` 只是文件选择提示，不是安全边界；main 以签名、ffprobe 结果、真实音轨和版本化上限为准。
- 选择后立即显示：文件格式、时长、文件大小、音频 codec、声道、采样率、有效语言标签；隐藏 ffprobe 的 `und`。
- 单音轨自动选择；多音轨显示 RadioGroup，保留 codec、声道、采样率、有效语言/标题。
- 视频始终提取所选音轨，不把无用视频字节上传给供应商。
- 大文件不再显示“文件过大，不能使用”；改为“将自动转码并分为 N 段”。

### 4.3 输出格式

用户输出枚举固定为：

```ts
type AudioTranscriptionExportFormat = "txt" | "json" | "srt" | "vtt" | "lrc";
```

| 格式 | 可用条件 | 语义 |
| --- | --- | --- |
| TXT | 任一可用 route | canonical 全文，LF-only UTF-8 |
| JSON | 任一可用 route | FusionKit `schemaVersion: 1` canonical transcript |
| SRT | 有 provider 时间戳或可生成本地估算时间轴 | 本地 strict exporter |
| VTT | 同 SRT | 本地 strict exporter，保留现有能力 |
| LRC | 同 SRT | 标准行级 LRC，百分之一秒起始标签 |

SRT/VTT/LRC 不再因为供应商只返回 JSON 而从选择框消失。页面同时显示时间轴来源：

- `原生词级时间戳`
- `原生段级时间戳`
- `智能估算时间轴（VAD）`
- `固定窗口估算时间轴`
- `无时间轴`（只能 TXT/JSON）

当 route 没有原生时间戳而用户选择字幕格式时，页面必须在开始前显示预计请求数和“时间为本地估算”的非阻断提示；超过费用保护阈值时需要显式二次确认。

### 4.4 执行预览

开始按钮上方显示一个只读摘要：

- 输入：`MP4 · AAC · 02:13:24 · 日语音轨`
- 处理：`提取音轨 → 16 kHz mono MP3`
- 分片：`智能静音边界，预计 10 个上传分片`
- 输出：`SRT · 原生段级时间戳` 或 `LRC · 智能估算`
- 费用提示：`预计约 10 次 API 请求；实际以供应商计费为准`

摘要由 main 的 probe/plan preview 返回，renderer 不自行计算 payload budget 或时间边界。preview 不是执行授权；开始时 main 必须重新验证媒体身份、route revision、runtime generation 和输出 capability，并生成新的权威计划。

## 5. 最终架构

```text
Renderer: AudioTranscriber page + persisted preferences
        |
        | fixed preload methods; opaque file/output tokens
        v
Electron main: audio transcription namespace
  AudioTranscriptionIpcService
  AudioTranscriptionJobManager
  AudioTranscriptionMediaPipeline
  AudioTranscriptionChunkPlanner
  AudioTranscriptionOrchestrator
  AudioTranscriptCanonicalizer
  AudioTranscriptionExporter
        |
        +---- Shared media primitives
        |       verified FFmpeg/ffprobe
        |       process runner / probe / PCM frames / atomic text artifact
        |
        +---- Existing route resolver + OpenAI/MiMo adapters
                one bounded upload unit per adapter call
```

### 5.1 模块职责

| 模块 | 职责 |
| --- | --- |
| Page | 文件/音轨选择、偏好、执行预览、单一阶段进度、结果摘要和错误操作 |
| Renderer Store | 只持久化无敏感偏好；当前文件、token、任务、正文与进度只在当前 renderer session |
| Renderer runtime service | app 级订阅 main task 事件、snapshot/revision 重同步、取消和 capability cleanup retry |
| IPC service | 固定方法、payload schema、owner、config revision、token/lease 与 public error sanitization |
| Job Manager | 一次一个活动源任务、状态迁移、配置/媒体/计划快照、取消、同会话重试和 owner cleanup |
| Media Pipeline | runtime 校验、ffprobe、音轨选择、直传判断、转码、PCM 边界数据和临时目录 |
| Boundary detector | 返回原时间轴上的 speech/silence interval；Silero、能量检测和固定窗口实现共用接口 |
| Chunk Planner | route payload budget、目标 codec/bitrate、自然切点、overlap、请求数与完整覆盖 |
| Orchestrator | 顺序调用 adapter、接收分片结果、受控重试、上下文续接和进度事件 |
| Canonicalizer | 时间域映射、response schema 校验、边界重复仲裁、文本/时间规范化 |
| Exporter | 从同一 canonical 生成 TXT/JSON/SRT/VTT/LRC，parse-back、原子提交与 output token |

### 5.2 为什么新增 Job Manager

单个大媒体可能经历数十分钟和多个本地/网络阶段。继续让 React 组件 `await audio:transcribe` 会导致：

- 页面卸载后缺少可靠进度 owner。
- 只能取消当前 HTTP，无法统一取消 FFmpeg、VAD、后续分片和导出。
- 无法重试一个失败分片而复用已完成结果。
- 全量 canonical JSON/字幕可能超过合理 IPC payload。

Job Manager 仍属于 `audio:*`，不复用本地字幕 Job Manager；它只管理当前 renderer session 的远程转写任务。

## 6. 领域模型与公开合同

### 6.1 用户偏好

```ts
interface AudioTranscriberPreferencesV5 {
  language: string;
  outputFormat: AudioTranscriptionExportFormat;
  timingPreference: "auto" | "segment" | "word";
  boundaryStrategy: "smart" | "fixed";
  prompt: string;
  outputMode: "display_only" | "source_dir" | "custom_dir";
  outputDir: string; // 仅安全显示名，真实目录仍是 token
}
```

- 移除用户层 `responseFormat`；provider response format 由 main 协商。
- 文件 `stream` 不再作为通用持久化开关。只有单请求直传且 route 支持时可作为高级选项；进入转码/多片模式后使用“按完成分片逐步显示”，不混合多个 SSE token 流。
- `prompt` 不持久化，避免把可能包含用户内容的自由文本写入 localStorage；页面重开后清空。

### 6.2 Probe 与计划预览

```ts
interface AudioTranscriptionMediaProbeSummary {
  probeId: string;
  displayName: string;
  formatLabel?: string;
  byteSize: number;
  durationMs: number;
  tracks: AudioTrackSummary[];
  autoSelectedTrackId: string;
  expiresAt: number;
}

interface AudioTranscriptionPlanPreview {
  planKind: "direct" | "normalized_single" | "chunked" | "timed_estimation";
  uploadProfile: AudioUploadProfileId;
  estimatedRequestCount: number;
  timingQuality: AudioTranscriptTimingQuality;
  requiresTranscode: boolean;
  requiresExplicitConfirmation: boolean;
  warnings: AudioTranscriptionWarningCode[];
}
```

`probeId` 与 track ID 是短 TTL、owner-bound 的 main 证明。提交任务时把选择证明提升为 task-owned authority；draft LRU 被后续选择挤出不能让已提交任务失败。

### 6.3 Canonical transcript

```ts
type AudioTranscriptTimingQuality =
  | "provider_word"
  | "provider_segment"
  | "local_vad_estimated"
  | "fixed_window_estimated"
  | "none";

interface CanonicalAudioTranscriptCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  words?: Array<{
    startMs: number;
    endMs: number;
    text: string;
  }>;
  timingOrigin: AudioTranscriptTimingQuality;
  speaker?: string;
}

interface CanonicalAudioTranscript {
  schemaVersion: 1;
  source: {
    displayName: string;
    durationMs: number;
    selectedTrack?: {
      codec?: string;
      language?: string;
      channels?: number;
      sampleRateHz?: number;
    };
  };
  route: {
    providerPreset: AudioProviderPreset;
    transport: AudioTransport;
    model: string;
  };
  language?: string;
  timingQuality: AudioTranscriptTimingQuality;
  text: string;
  cues: CanonicalAudioTranscriptCue[];
  chunks: Array<{
    index: number;
    startMs: number;
    endMs: number;
    status: "transcribed" | "no_speech";
  }>;
  warnings: AudioTranscriptionWarningCode[];
}
```

Canonical 文本统一为 LF-only UTF-8；拒绝会破坏 JSON/字幕结构的控制字符和 unpaired surrogate。时间事实只使用整数毫秒；provider 浮点秒在 main 的响应边界立即校验和转换。

原始路径、API Key、endpoint、file/output token、FFmpeg 路径、临时文件、完整 HTTP body、stderr 和未经白名单的供应商字段不得进入 canonical 或 renderer。

### 6.4 任务状态

```ts
type AudioTranscriptionTaskStatus =
  | "queued"
  | "preparing_media"
  | "detecting_speech"
  | "planning_chunks"
  | "transcribing"
  | "merging"
  | "exporting"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "failed";

interface AudioTranscriptionTaskProgress {
  stage: AudioTranscriptionTaskStatus;
  stageProgress?: number;
  completedChunks?: number;
  totalChunks?: number;
}
```

UI 同时只显示一个与当前阶段一致的进度条：

- `preparing_media` 使用 FFmpeg 机器进度。
- `detecting_speech` 使用已扫描 PCM frame / 总 frame。
- `transcribing` 使用 `completedChunks / totalChunks`。
- 快速的 planning/merging/exporting 只显示阶段 spinner，避免多个互相矛盾的百分比。

`completed` 必须满足：所有计划 chunk 都是 `transcribed/no_speech`、canonical 通过结构校验，且用户请求的最终格式已成功提交或 display-only 私有 artifact 已完整生成。

### 6.5 公开结果

renderer 不再接收完整 raw JSON 和无限全文：

```ts
interface AudioTranscriptionTaskResultSummary {
  taskId: string;
  outputFormat: AudioTranscriptionExportFormat;
  previewText: string; // 有界
  previewTruncated: boolean;
  timingQuality: AudioTranscriptTimingQuality;
  durationMs: number;
  cueCount: number;
  requestCount: number;
  outputToken: string;
  outputFileName: string;
  warnings: AudioTranscriptionWarningCode[];
}
```

复制全文和保存操作由 fixed preload method 通过 `outputToken` 在 main 内完成；超出复制上限时 UI 引导保存文件，不把几十 MiB 文本塞进 IPC。

## 7. 媒体授权、探测与规范化

### 7.1 Draft 授权

当前 `AudioFileAuthorizationStore.authorize()` 在授权时调用 OpenAI 格式/25 MiB 校验，必须拆成：

1. **通用媒体授权**：验证真实 regular file、版本化源文件大小上限、canonical identity、owner、选择来源和 TTL；不判断 provider 格式或单次上传大小。
2. **媒体探测**：通过 verified ffprobe 返回有界 duration/track summary；路径保留在 main。
3. **任务提交**：原子复核 source identity、probe/track proof、route revision 和输出 authority，再把 draft capability 提升为 task lease。

Windows Explorer drag 必须复用现有 native selection resolver，识别 `%TEMP%` Shell proxy 并只授权唯一证明的原始文件；picker/drop 的原始 `FileList` 必须保留到 preload 授权完成。

### 7.2 直传决策

只有同时满足以下条件才允许 direct path：

- ffprobe 证明输入是单音轨或自动选择的音轨无需 remux。
- 不含需要丢弃的视频流；视频容器始终抽取音频，避免上传无用视频字节。
- 文件签名/MIME 在当前 route `acceptedMimeTypes` 内。
- 实际 byte size 小于 route 的安全 raw budget。
- 用户输出不要求该 route 无法提供的时间轴估算模式。
- route 与当前 adapter 已有真实 fixture 证明该格式可用。

否则进入 normalize/chunk path。

### 7.3 上传音频 profile

```ts
type AudioUploadProfileId =
  | "source_passthrough"
  | "speech_mp3_16k_mono_64k"
  | "speech_wav_pcm16_16k_mono";
```

- 默认优先 `speech_mp3_16k_mono_64k`，因为对长语音有较稳定的字节预算且 OpenAI/MiMo 都可接受。
- 只有 route 不接受 MP3 或 fixture 证明 WAV 更可靠时使用 PCM16 WAV。
- codec、采样率、声道、bitrate 与容器由 main 的 profile 固定；renderer 不提交 FFmpeg 参数。
- 每个生成 upload unit 在发送前重新检查实际 MIME、byte size、duration、source interval 和 task identity；干净 FFmpeg exit 不是完整性证明。

### 7.4 FFmpeg/ffprobe 运行合同

- 抽取共享 `VerifiedMediaRuntimeResolver`，继续消费已审计 manifest、target、arch、size、SHA-256、version 和 license reference。
- packaged 模式不回退系统 PATH，也不显示 executable picker。
- `-progress pipe:1` 使用 stream mode 的有界行 parser，不能累计整个任务 lifetime stdout。
- stderr 只保留有界 main-private diagnostics；公开错误只暴露稳定 code 和白名单元数据。
- Probe duration 是估算，不是资源证明。转码必须同时传入输出 duration/byte cap，在完成后按实际媒体结构再验证。
- 磁盘预算以最大可写 byte cap 加 reserve 计算；空间不足在写入前失败。
- 取消依次 AbortSignal、SIGTERM、SIGKILL，并等待 child `close` 后才清理 session。

### 7.5 临时目录

```text
<userData>/audio-transcription/jobs/<opaque-task-id>/
  source.snapshot
  normalized/
  chunks/
  results/
  final/
```

- 目录与 leaf 由 main 生成，不能包含用户文件名或路径。
- `source.snapshot` 只在需要转码/分片时创建，并绑定源 identity；不从 renderer path 直接反复读取。
- 正常完成、取消、清除结果和 owner release 都进入同一幂等 cleanup。
- 启动清理只扫描这个受控根及精确 owned leaf；不扫描用户输出目录。

## 8. 智能分片设计

### 8.1 两种完全不同的“片”

设计中必须区分：

1. **Transport chunk**：一次供应商 API 请求的上传文件，目标是满足 payload、超时和上下文边界。
2. **Canonical cue**：SRT/VTT/LRC 的一条时间文本，目标是可读性与时间轴。

一个 transport chunk 可以产生多个 provider timestamp cue；没有 provider timestamp 时，一个较短的 boundary-aligned request 可以在本地生成一个或多个估算 cue。不能把“切成 25 MB”直接当成字幕分句。

### 8.2 Payload 预算

每个 route 冻结一个有效预算：

```text
multipart:
  effectiveRawBytes = floor(maxRawFileBytes * safetyRatio)

base64 data URI:
  effectiveRawBytes = floor((maxEncodedPayloadBytes - fixedJsonOverhead) * 3 / 4)
  effectiveRawBytes = floor(effectiveRawBytes * safetyRatio)
```

`safetyRatio`、`fixedJsonOverhead` 和 route max 都是版本化 main policy。当前建议安全比例为 0.90；实际 encoded payload 仍必须在请求前精确复核，不能只依赖 bitrate 估算。

如果供应商仍返回 payload-too-large：

- 将当前 chunk 标记为可重规划。
- 在同一原时间区间内按 speech boundary 进一步二分。
- 最多进行有限深度重规划；不能无限重试或静默降低整个任务质量。
- 只重做当前 chunk，已完成 chunk 保持有效。

### 8.3 Boundary detector 接口

```ts
interface SpeechBoundaryDetector {
  readonly kind: "silero_vad" | "pcm_energy_v1" | "fixed_window";
  detect(
    input: BrandedPcmInput,
    options: AudioBoundaryDetectionOptions,
    signal: AbortSignal,
  ): Promise<readonly SpeechInterval[]>;
}
```

执行优先级：

1. `silero_vad`：仅在精确 pinned runtime 已证明可以独立产出结构化 speech interval 时启用。
2. `pcm_energy_v1`：TypeScript 对 16 kHz mono PCM frame 做有界、确定性的能量/静音检测，不新增 native ABI。
3. `fixed_window`：没有可靠静音点时保证完整覆盖的 fallback。

现有 `LocalSubtitleVadManager` 只证明 Silero 模型资源的安装与本地 Whisper 路径，不证明远程 ASR 已有独立 VAD executor。实施前先检查 pinned official runtime archive/structured surface；官方工具足够时由 Node 监管，只有真实验收需求无法满足时才评估自研 native bridge。Silero 不是基础大文件分片的阻塞条件。

### 8.4 Transport chunk planner

默认 planner 规则：

1. 以 source PCM frame 区间 `[0, totalFrames)` 为权威覆盖域。
2. 根据 upload profile bitrate 与有效 payload budget 算出目标时长，同时受版本化最大请求时长限制。
3. 在目标切点附近的有界搜索窗口中选择最长可信静音中心。
4. 找不到静音时在目标时长硬切，并添加小 overlap。
5. 所有 chunk 保留绝对 `startFrame/endFrame/coreStartFrame/coreEndFrame`；首尾连续覆盖，不遗漏、不倒序。
6. 生成实际 MP3/WAV 后检查 byte size；超预算则重规划当前区间。
7. 每个计划项最终必须是 `transcribed`、可信 `no_speech` 或显式失败。

建议初始 policy：transport 目标最长 15 分钟；自然切点搜索窗口不超过前后 15 秒；硬切 overlap 初始 750 ms。数值属于实现 policy，必须由 fixture 与真实样本校准后冻结，不能散落在 UI。

### 8.5 字幕格式且 provider 无时间戳

当用户选择 SRT/VTT/LRC，而 route `timestampCapability === "none"`：

1. planner 使用 VAD/能量 interval 生成更短的 boundary-aligned request unit，初始上限建议 30 秒。
2. 每个 request unit 的返回文本只归属于该绝对时间区间。
3. 按标点和 grapheme-safe 文本边界分成 cue，再按区间内 voiced duration 与字符权重分配整数毫秒。
4. cue 标记 `local_vad_estimated`；若使用固定窗口则标记 `fixed_window_estimated`。
5. 页面在开始前展示预计请求数；超过版本化费用保护阈值必须确认。

这种模式用更多请求换取可用时间轴，但不会伪装成 provider 原生词级时间戳。若用户不接受估算，应改选 TXT/JSON 或切换到支持 timestamp 的 route/model。

### 8.6 原时间轴与 VAD

- Boundary detector 输出必须使用原 PCM frame/原媒体绝对时间。
- 不允许先删除静音、拼接语音，再把压缩时间轴当成字幕时间。
- 如果某上游同时返回正确的 segment 时间与落在父 segment 外的 word 时间，丢弃 word timeline、保留 segment，并记录 main-private fallback diagnostic。
- 不用一个全局 offset 修复 VAD 压缩时间；静音累计是非线性的。

### 8.7 Overlap 与上下文

- 有 provider timestamp 时，将相对时间加 chunk 绝对 offset，并按相邻 core midpoint 归属 cue/word。
- 无 provider timestamp 时，只在相邻 overlap 边界做 suffix/prefix token 相似度去重，不做全文件字符串去重。
- 对支持 prompt 的 route，可把上一 chunk 的有界尾部文本作为 continuity hint；用户 prompt 与 continuity hint 分字段组合，不能把模型输出无限累积进 prompt。
- 不支持 prompt 的 route 保持顺序请求，不伪造上下文字段。
- 默认分片并发为 1，以保持顺序、上下文和费用可预测性；后续并发必须按 route rate limit 与无上下文模式另行设计。

### 8.8 Server-side chunking

route 若明确支持 `chunking_strategy=auto/server_vad`，adapter 可以在单个已满足 payload 上限的 upload unit 内启用它，尤其用于 speaker diarization 等模型合同。它不替代 FusionKit transport planner，也不能让一个超过 upload limit 的源文件直接上传。

## 9. Provider 请求协商与结果合并

### 9.1 Main-only response negotiation

| 用户目标 | Route 能力 | Main 请求策略 |
| --- | --- | --- |
| TXT/JSON | 任意 route | 优先结构化 JSON；只支持 text 时解析 text |
| SRT/VTT/LRC | provider word timestamp | 请求支持 word/segment 的结构化格式，canonical 后本地导出 |
| SRT/VTT/LRC | provider segment timestamp | 请求 segment 结构化格式，canonical 后本地导出 |
| SRT/VTT/LRC | 无 provider timestamp | boundary-aligned request + 本地估算时间轴 |

Whisper 即使可直接返回 SRT/VTT，也优先请求 `verbose_json` 并由本地 exporter 输出，避免多分片时拼接供应商文本文件。GPT/MiMo 的 JSON/text 同样进入 canonicalizer。

### 9.2 Adapter 边界

现有 OpenAI/MiMo adapter 继续只负责“一次已准备好的 upload unit”：

```ts
interface AudioPreparedTranscriptionUnit {
  unitId: string;
  filePath: MainPrivatePath;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sourceStartMs: number;
  sourceEndMs: number;
  providerResponseFormat: AudioProviderTranscriptionResponseFormat;
}
```

adapter 不负责源媒体 probe、FFmpeg、跨片进度、总任务状态、本地 SRT/LRC 或最终文件名。每次请求前必须复核 route、实际 file bytes、MIME、transfer budget 和 AbortSignal。

### 9.3 重试所有权

- HTTP 瞬时错误、`Retry-After`、连接重置和 5xx 的指数退避仍由现有 audio HTTP retry owner 负责。
- Job Manager 不再套一层同类盲重试，避免双重重试风暴。
- Job Manager 只处理语义不同的动作：payload-too-large 触发重规划；用户点击重试恢复失败 unit；stale config/media 需要重新 prepare。
- 4xx 鉴权、余额、字段或永久格式错误立即失败，并通过稳定 code 显示设置 CTA。

### 9.4 分片检查点

每个成功 unit 在 main 私有任务目录写入有界结果与 hash；检查点绑定：

- task ID / generation
- source identity 与 selected track proof
- route profile/revision/transport/model
- language、prompt hash、upload profile
- chunk planner policy version 与 exact interval
- provider response negotiation version

同会话重试只有上述 identity 完全匹配时复用成功 unit。route、prompt、语言、源文件或分片 policy 改变时，从头生成新 generation，不能混合旧结果。

应用重启不恢复任务，也不持久化源路径/API Key；启动只清理受控 stale job directories。

### 9.5 空响应

- planner 预先判定的可信静音区间可以记为 `no_speech`，不发 API 请求。
- 对已判定含语音并已发送的普通文件/unit，空响应仍是 `empty_response`，不能静默当作 no-speech。
- 只有专门的 realtime fixed-duration caption contract 继续允许空结果表示静音；不能把该语义扩大到文件转写。

## 10. Canonical 合并与输出

### 10.1 合并顺序

```text
provider response
  → strict schema / bounded text
  → relative seconds to integer ms
  → source absolute offset
  → parent/word timeline validation
  → overlap core ownership + boundary de-dup
  → punctuation-aware cue shaping
  → monotonic/bounds validation
  → canonical transcript
  → selected exporter
  → parse-back
  → atomic artifact commit
```

### 10.2 TXT

- 使用 canonical cue/text 顺序生成全文。
- LF-only UTF-8，无 BOM。
- 分片边界只保留一个自然空格或换行，不直接字符串拼接造成粘连。

### 10.3 JSON

- 输出 `CanonicalAudioTranscript schemaVersion: 1`。
- 不把任意供应商 raw response 作为顶层稳定合同。
- 为兼容诊断，可在 main 私有检查点保留有界 raw response；若未来允许用户导出，必须作为单独的高级 `provider_raw_json` 格式和独立隐私/大小合同，不能偷偷改变 canonical JSON。

### 10.4 SRT

- 时间格式 `HH:MM:SS,mmm`，序号从 1 开始。
- `startMs >= 0`、`endMs > startMs`、整体单调并且不超过源时长。
- UTF-8 无 BOM；导出后 strict parser 回读 cue 数、时间和文本。

### 10.5 VTT

- 使用标准 `WEBVTT` header 与 `HH:MM:SS.mmm`。
- 与 SRT 使用同一 canonical cue，不从供应商 VTT 文本二次解析拼接。

### 10.6 LRC

首版只输出标准行级 LRC：

```text
[00:01.20]第一句
[00:04.38]第二句
```

- `startMs` 投影为 `floor(startMs / 10)`，绝不把 cue 推迟到实际语音之后。
- 分钟至少两位；秒和百分秒固定两位。
- 相邻 cue 量化到同一标签时保留原顺序和两行文本，不合并、不丢失。
- parse-back 验证量化后的时间、行数和顺序。
- 逐词 LRC 不在首版范围；未来必须基于可信 word timeline 单独设计。

### 10.7 原子提交与冲突

- display-only 也在 app 私有目录生成完整 artifact，renderer 只拿 output token 和有界 preview。
- source/custom output 使用 task-owned 目录 authority；source 模式从仍有效的输入 parent identity 私下派生，不接受 renderer parent path。
- 先写同目录 owned `.partial`，flush/close，parse-back，再 no-clobber 发布最终 leaf。
- 首版继续使用 index 命名策略；不要为本需求新开 path-only overwrite。
- 取消在最终 commit 前删除 partial；commit 后到达的取消保留已提交结果并终结为 completed + warning，不能删除用户已得到的文件。

## 11. IPC、安全与生命周期

### 11.1 新的 fixed API

计划新增或替换为以下固定方法：

```ts
interface AudioTranscriptionApi {
  authorizeMedia(file: File, source: "picker" | "drop"): Promise<...>;
  probeMedia(request: { fileToken: string }): Promise<...>;
  previewPlan(request: AudioTranscriptionPlanPreviewRequest): Promise<...>;
  startTask(request: StartAudioTranscriptionTaskRequest): Promise<...>;
  getTaskSnapshot(request: { taskId: string }): Promise<...>;
  subscribeTask(listener: (event: AudioTranscriptionTaskEvent) => void): () => void;
  cancelTask(request: { taskId: string; generation: number }): Promise<...>;
  retryTask(request: { taskId: string; generation: number }): Promise<...>;
  copyOutput(request: { outputToken: string }): Promise<...>;
  saveOutput(request: { outputToken: string }): Promise<...>;
  revealOutput(request: { outputToken: string }): Promise<...>;
  clearTask(request: { taskId: string }): Promise<...>;
}
```

- file/path capture、output directory picker 和内部 capability envelope 继续使用 preload-private channel。
- generic `invoke` 精确 allowlist 不得包含内部 authorize/revoke channel。
- bridge shape 变化时升级固定 bridge version；preload bundle 必须只 externalize Electron 支持模块。
- production main composition 测试必须证明所有新 handler 在创建窗口前注册，不能只有 type/preload 测试。

### 11.2 Task event 与 snapshot

- 所有 event 带 `taskId`、`generation`、单调 revision 和当前权威 status。
- renderer 采用 subscribe-before-snapshot，并按 revision buffer/reconcile。
- 页面卸载只移除 view listener；app-level runtime service 保持订阅。
- 返回页面先读取 snapshot，再显示当前阶段/结果；不重复发起 probe 或新任务。
- 窗口/webContents owner release 才 fence 新 admission、取消活动任务、清理 capability 和私有目录。

### 11.3 取消

一个 task-scoped AbortController 贯穿：

- media probe/normalize process
- boundary detector
- 当前 provider HTTP request
- 后续尚未开始的 chunk
- merge/export/partial publication

`cancelTask` 幂等；必须等待底层工作收敛。renderer 的 bounded retry queue 同时处理 rejected Promise 和 `{ ok: false }`，SPA unmount 不丢取消 handle。main 返回 `cancelled: false` 且任务已 terminal 视为幂等成功。

### 11.4 清理顺序

owner release：

```text
Job Manager fence/abort
  → provider request + media process settle
  → temporary units/checkpoints cleanup
  → output/file capability registry cleanup
  → task registry finalization
```

app shutdown 的每个 phase 都必须无条件执行并保存首错；不能用会短路 side effect 的 `firstFailure ??= await phase()`。Composite shutdown Promise 必须在触发 AbortController 之前缓存，避免同步 abort listener 重入创建第二个 shutdown。

## 12. 页面交互设计

### 12.1 页面结构

继续使用现有 `AudioToolShell` 与标准工具详情布局：

- 配置区：语言、输出格式、时间精度、智能分片、prompt、输出位置。
- 工作区：文件投放、媒体/音轨摘要、执行预览、开始/取消、阶段进度、结果预览。
- 高级说明只在实际 plan 需要时出现，不展示 FFmpeg 参数、bitrate 或供应商内部 response format。

### 12.2 字段规则

- 语言、prompt 仍由 route constraints 控制。
- 输出格式不再直接等于 route response formats。
- `timingPreference=word` 只有 provider 支持可信 word timestamp 时可选；否则回退 `auto` 并显示一次说明。
- `boundaryStrategy=smart` 默认开启；Silero 不可用时可以透明回退 `pcm_energy_v1`，但 execution preview 必须显示实际策略。
- output directory 仍使用不透明 token；切换 output mode 时按现有 cleanup retry 规则撤销旧 token。

### 12.3 开始门禁

以下任一情况禁止开始并提供具体 CTA：

- Audio API/route 未配置或 model family 无法解析。
- 媒体 runtime 缺失、损坏、架构错误或无法受控启动。
- source/probe/track proof 过期或媒体已变化。
- 没有音轨、时长/大小/track 数超过产品上限。
- custom output capability 缺失/过期。
- timed output 的预计请求数超过硬上限。
- 自定义 compatible route 没有明确 upload contract。

费用保护阈值只要求用户确认，不把合理长媒体误报为 `limit_exceeded`。

### 12.4 结果状态

- 结果卡显示输出格式、时间轴质量、媒体时长、cue 数、请求数和 warning。
- preview 只显示有界开头/结尾；复制全文通过 main output token。
- 失败卡显示失败阶段、分片 `i/n`、是否可重试和安全诊断；不暴露路径、HTTP body、stderr 或 token。
- “重试失败分片”只有 exact checkpoint 仍有效时显示；配置或媒体改变后显示“重新开始”。

### 12.5 可访问性与响应式

- 音轨与有限枚举使用语义化 RadioGroup/Select，键盘可完整操作。
- 开始/取消状态使用 `aria-live` 的简短阶段文本，不连续播报每个百分比。
- 窄窗口保持工作区先于配置区；长文件名和诊断在卡片内可换行，不制造横向滚动。
- 所有新增用户文案进入 `src/locales/{zh,zh-Hant,en,ja}/audio.json` 并通过 source usage 检查。

## 13. 错误合同

在现有 `AudioIpcErrorCode` 基础上新增稳定分类：

```ts
type AudioTranscriptionPipelineErrorCode =
  | "media_runtime_missing"
  | "media_runtime_invalid"
  | "media_runtime_launch_failed"
  | "media_probe_failed"
  | "no_audio_stream"
  | "media_changed"
  | "disk_space_insufficient"
  | "media_normalization_failed"
  | "boundary_detection_failed"
  | "chunk_plan_failed"
  | "provider_payload_too_large"
  | "chunk_transcription_failed"
  | "transcript_timeline_invalid"
  | "transcript_merge_failed"
  | "artifact_too_large"
  | "output_validation_failed"
  | "cancel_failed";
```

公开 error 只允许以下安全字段：

- `stage`
- `chunkIndex` / `totalChunks`
- `retryable`
- `timingQuality`
- 版本化 `reason` 枚举
- 有界数字，如实际/最大 byte、duration、request count

任意 `Error.message`、路径、URL query、API Key、Authorization header、native stderr、完整供应商 response 和未知 metadata 都在 IPC 边界丢弃。UI summary 从固定 i18n 文案重建。

### 13.1 失败与部分结果

- 任一必需 chunk 缺失时任务是 `failed`，不自动发布“部分完成”的 TXT/SRT/LRC。
- 已成功 chunk 的 main-private checkpoint 可用于同会话重试。
- 如后续产品需要“导出不完整结果”，必须新增显式用户操作、缺失区间标记和独立 artifact warning；不在本设计中静默实现。
- 一个最终格式提交成功后取消，保留该文件并以 completed warning 收敛；当前 UI 首版只请求一个格式，因此没有多格式 partial 状态。

## 14. 性能与资源边界

建议建立 `AUDIO_TRANSCRIPTION_PIPELINE_LIMITS` 单一常量，初始值通过 fixture/真实样本冻结：

| 边界 | 建议初始值 | 目的 |
| --- | ---: | --- |
| 源媒体最大 byte | 64 GiB | 与现有媒体基础设施的安全上限一致 |
| 源媒体最大时长 | 24 h | 防止意外产生不可控费用；仍覆盖常见会议/视频 |
| 音轨数 | 128 | 与现有 ffprobe 合同一致 |
| Transport chunk 最长 | 15 min | 限制单请求延迟/超时并保留上下文 |
| 无原生时间戳 request unit 最长 | 30 s | 提供可解释估算字幕时间轴 |
| 最大 request unit | 2,000 | 阻止极端碎片化和费用失控 |
| 有界 preview | 256 KiB | 控制 snapshot/IPC |
| Canonical artifact | 64 MiB | 控制内存和磁盘 |
| 同 owner 活动转写任务 | 1 | 避免本地媒体与远程费用竞争 |

这些是 FusionKit 产品边界，不等于供应商限制。真正的单次 upload budget 始终来自 route constraints。

内存要求：

- 不把完整长媒体读入 renderer。
- OpenAI/MiMo adapter 只读取已经受 route 预算约束的一个 upload unit。
- canonical chunk 结果完成后写私有 checkpoint；merge 可流式读取，避免同时持有全部 raw responses。
- progress event 节流，不能按每个 FFmpeg stdout chunk 或每个 PCM frame 跨 IPC 发布。

## 15. 持久化、隐私与兼容迁移

### 15.1 Store v5 迁移

旧偏好映射：

| v4 `responseFormat` | v5 |
| --- | --- |
| `text` | `outputFormat: "txt"` |
| `json` | `outputFormat: "json"`, `timingPreference: "auto"` |
| `verbose_json` | `outputFormat: "json"`, `timingPreference: "word"` |
| `srt` | `outputFormat: "srt"` |
| `vtt` | `outputFormat: "vtt"` |

新增 `lrc` 无旧值。无效字段逐项 sanitize；迁移后仍只持久化语言、输出格式、时间偏好、分片偏好、输出模式和安全目录显示名。

### 15.2 不持久化

- `File`、真实路径、file/output token、probe/track ID。
- API Key、endpoint、route runtime snapshot。
- prompt、transcript、cue、raw response、临时媒体路径。
- 任务/分片 checkpoint 的用户路径。

### 15.3 JSON 兼容

旧版 JSON 保存的是供应商 raw response；新版 JSON 是稳定 canonical schema。这是有意的产品合同升级，UI 与 release note 必须说明。为降低迁移风险：

- `schemaVersion: 1` 必须固定并提供 golden fixture。
- 单请求 raw response 仅保留在 main-private diagnostic/checkpoint，不自动混入 canonical。
- 若真实用户依赖 raw JSON，再单独增加高级导出格式，不让 `json` 同时拥有两种结构。

### 15.4 旧 IPC 兼容

- `audio:transcribe` 在迁移期保留给现有 realtime recorded chunk/测试或 legacy direct path，但新页面切到 task API 后不得同时调用两条路径。
- 完成 production composition、preload、page、Store 和测试切换后，再评估删除旧 file-transcription request shape。
- Realtime captions 的 `transcribeRecordedChunk` 不进入本次媒体/长文件 Job Manager，避免把 5 秒静音语义和文件空响应语义混合。

## 16. 预计模块与文件

### 16.1 计划新增

| 文件 | 职责 |
| --- | --- |
| `electron/main/audio/transcription-job-manager.ts` | 远程转写任务状态、generation、取消、重试、cleanup |
| `electron/main/audio/transcription-media-pipeline.ts` | probe、音轨、直传/转码、task media proof |
| `electron/main/audio/transcription-chunk-planner.ts` | payload budget、speech boundary、frame coverage、重规划 |
| `electron/main/audio/transcription-boundary-detector.ts` | Silero/energy/fixed strategy 接口与结果校验 |
| `electron/main/audio/transcription-orchestrator.ts` | 顺序 adapter 调用、checkpoint、progress |
| `electron/main/audio/transcription-canonicalizer.ts` | response → canonical、时间域与 overlap merge |
| `electron/main/audio/transcription-exporter.ts` | TXT/JSON/SRT/VTT/LRC、parse-back、artifact commit |
| `electron/main/media/verified-media-runtime.ts` | 从本地字幕实现抽取的通用 runtime resolver |
| `electron/main/media/media-process.ts` | 通用 bounded native process runner |
| `electron/main/media/media-probe.ts` | 通用 ffprobe parser 与 track summary |
| `src/services/audio/audioTranscriptionRuntimeService.ts` | app 级 task 订阅、snapshot 重同步 |

名称是计划落点；执行时如发现已有通用目录更合适，可调整路径，但不能把远程 Job Manager 放进 `local-subtitle` namespace。

### 16.2 主要调整

| 文件 | 调整 |
| --- | --- |
| `src/lib/audio-provider-registry.ts` | route 输入 MIME、transfer、payload、timestamp/server chunking 能力 |
| `src/type/audio.ts` | 导出格式、canonical、route upload 约束 |
| `src/type/audioIpc.ts` | task fixed API、event/snapshot/error schema |
| `electron/preload/index.ts`、`audio-channel-policy.ts` | fixed bridge、内部/公开 channel 策略与 bridge version |
| `electron/main/audio/audio-file.ts` | 通用 media draft authorization 与 task lease；移除授权期供应商上限 |
| `electron/main/audio/ipc.ts` | probe/preview/start/snapshot/cancel/retry/output handler |
| `electron/main/audio/adapters/openai-audio-adapter.ts` | 单 prepared unit、main-only response negotiation |
| `electron/main/audio/adapters/mimo-chat-audio-adapter.ts` | 单 prepared unit、精确 Base64 payload 复核 |
| `electron/main/index.ts` | app singleton 与 production IPC composition |
| `src/store/tools/audio/audioTranscriberConfig.ts` | outputFormat、timing/boundary 偏好、Store v5 migration |
| `src/store/tools/audio/useAudioTranscriberStore.ts` | task summary/snapshot，不持久化正文和 token |
| `src/pages/Tools/Audio/AudioTranscriber/index.tsx` | probe、音轨、plan preview、阶段进度、结果 UX |
| `src/services/audio/audioTranscriptionService.ts` | task API 与 output-token 操作 |
| `src/locales/*/audio.json` | 新状态、格式、警告、错误、CTA |

### 16.3 必须保持独立的现有文件

- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `src/type/localSubtitle.ts`
- `src/type/localSubtitleIpc.ts`
- `src/store/tools/subtitle/useLocalSubtitleTranscriberStore.ts`

共享低层模块完成后，本地字幕可通过 adapter 消费它们；不能反向让 AudioTranscriber 构造本地字幕 task 或 session。

## 17. 测试与验收策略

### 17.1 单元与合同测试

Provider/route：

- 同一 OpenAI provider 下 GPT、Whisper、diarization/未知模型解析不同 response/timestamp/upload 能力。
- MiMo multipart/base64 budget 与自定义 compatible fail-closed。
- renderer、main、adapter 使用同一 route definition，不保留第二份 MIME/size 表。

媒体：

- WAV/MP3/M4A/FLAC/OGG/WebM 与 MP4/MKV/MOV probe fixture。
- 视频音轨抽取、多音轨 auto/explicit selection、`und` 隐藏、无音轨。
- 大源文件可授权；只在 task plan 上应用供应商单次预算。
- FFmpeg `-t/-fs`、实际输出 size、磁盘不足、超时报错、stream progress、abort/close、temp cleanup。
- 系统 PATH 隔离时 packaged resource 正常；缺失/hash 错/错架构/无法启动 fail closed。

Planner/VAD：

- 原 PCM frame 完整覆盖、首尾、短尾、自然静音切点、无静音 hard cut、overlap core。
- multipart 与 Base64 预算公式、生成后超预算重规划、有限深度。
- Silero interval schema、energy fallback、fixed fallback、取消。
- VAD 删除静音的压缩时间不得进入 canonical；后段语音仍保留原绝对时间。

Canonical/export：

- provider word/segment relative time映射、越父 segment 的 word fallback。
- overlap 边界重复、合法重复台词、无全局去重。
- 无时间戳 route 的 VAD/fixed estimated cue 与 warning。
- 空媒体/no-speech、含语音 unit 的空 response 失败。
- TXT/JSON/SRT/VTT/LRC golden fixture 与 parse-back。
- LRC 9/10/11 ms、分钟进位、1h+、相同标签保序。
- 有界 preview、大 artifact、output token owner/expiry、partial/atomic commit。

任务/lifecycle：

- 合法/非法状态迁移、task generation、late event、subscribe-before-snapshot。
- route/source/prompt 变化使 checkpoint 失效；同 identity 只重试失败 chunk。
- 页面离开/返回不重复开始任务；窗口 owner release 才取消。
- 转码、VAD、HTTP、merge、export 各阶段取消。
- shutdown 第一阶段失败后后续 cleanup 仍执行，所有 child/temporary/capability 收敛。

### 17.2 Fake provider 矩阵

扩展 `test/audio/fakeAudioApiServer.ts`：

- 每个 upload unit 记录 byte/MIME/model/response format。
- 返回相对 segment/word timestamp fixture。
- MiMo text/json 无时间戳 fixture。
- 413 后更小 chunk 成功。
- 指定 chunk 5xx/Retry-After/鉴权/余额/空响应/invalid schema。
- 延迟响应与 cancel 后 late response。

端到端断言：源媒体大于单次上限，但每个实际请求都低于预算；合并文本顺序正确；最终 SRT/LRC 时间仍是原媒体绝对时间。

### 17.3 Renderer/Electron 验收

- picker 与真实 Windows Explorer drag，包括长路径 `%TEMP%` proxy。
- 单/多音轨视频、超单次上限长媒体、MiMo 不支持的 M4A 自动转 MP3。
- 直传、单文件转码、多片、无原生时间戳估算四种 preview。
- 页面导航后任务继续，返回后 snapshot 恢复。
- 取消响应、费用确认、时间轴质量标签、错误 CTA、窄窗口和键盘操作。
- Electron 截图必须等待全局 preload loading 退出；启动的 Vite/Electron/FFmpeg 服务在验收后全部关闭。

### 17.4 验证命令

实现阶段至少运行：

```text
node_modules/.bin/vitest run test/audio src/lib/audio-provider-registry.test.ts src/store/tools/audio src/services/audio
node_modules/.bin/vitest run test/local-subtitle/mediaProcess.test.ts test/local-subtitle/mediaNormalizer.test.ts test/local-subtitle/subtitleFormats.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
node scripts/check-preload-bundle.mjs
git diff --check
```

共享 media primitive 的重构必须先让本地字幕原有测试全绿，再切换远程音频调用方，避免以新工具通过为代价破坏本地字幕。

### 17.5 有界真实样本

不建立过度研究门禁；准备以下最小产品样本即可：

- 一个小于单次上限的 MP3，验证 direct path。
- 一个超过上限的长 WAV/M4A，验证转码与多片。
- 一个含单音轨的 MP4/MKV 和一个双音轨视频。
- 一段长静音 + 后段语音，验证 VAD 原时间轴。
- 一段无明显静音的连续演讲，验证 fixed fallback。
- 中文、英文、日文各一段供人工检查边界与字幕可读性。

这些样本不进入 Git；只记录脱敏的格式、时长、请求数、timeline/parse-back 与人工结论。

## 18. 实施顺序建议

本文只冻结设计，不代替后续 execution plan。建议按以下依赖顺序拆包：

1. `PRE-001`：冻结 route upload/timestamp 矩阵、官方 runtime VAD 能力与最小真实 fixture。
2. `CORE-001`：导出格式、canonical、task/event/error/Store v5 类型。
3. `MEDIA-001`：抽取 shared media runtime/process/probe，不改变本地字幕行为。
4. `MEDIA-002`：Audio generic media authorization、probe、音轨与 task lease。
5. `CHUNK-001`：upload profiles、payload budget、frame planner、energy/fixed detector。
6. `VAD-001`：只有 PRE 证明现有官方 runtime surface 足够时接入 Silero；否则保持可插拔 backlog，不阻塞基础链路。
7. `BE-001`：Job Manager、orchestrator、prepared-unit adapter、checkpoint/cancel。
8. `OUT-001`：canonical merge 与 TXT/JSON/SRT/VTT/LRC exporter。
9. `IPC-001`：fixed preload、public policy、snapshot/event 与 production composition。
10. `FE-001`：页面 probe/音轨/preview/进度/结果与 Store migration。
11. `QA-001`：fake provider、Electron、packaged/no-PATH、长媒体与真实供应商矩阵。
12. `DOC-001`：README、release note、隐私/费用/格式说明。

优先闭环 `MP4/M4A → MP3 → 大文件多片 → TXT/canonical JSON`，再开放 SRT/LRC 估算时间轴；不要同时铺开所有格式、Silero、自定义 provider 与完整 UI 后才第一次跑通端到端。

## 19. 主要风险与决策

| 风险 | 决策 |
| --- | --- |
| 误认为当前只支持 WAV/MP3 | OpenAI 已支持更多格式；输入能力按完整 route 建模，用户层仍允许更广媒体并本地转换 |
| 用户输出被 provider response format 限制 | 两层格式解耦，统一 canonical + exporter |
| 25 MB 常量未来变化 | 内置 route 当前值 + fixture；通用 pipeline 不写死供应商 |
| Server-side VAD 被误当成上传分片 | 只在一个合规 upload unit 内使用；客户端仍拥有 transport planner |
| Silero 没有独立可调用 runtime | 先审计 pinned official surface；energy/fixed fallback 保证基础功能，不先写 native bridge |
| VAD 后字幕整体提前 | 只保存原 PCM frame interval，不拼接压缩时间轴 |
| 无 timestamp provider 的 SRT/LRC 不准 | 短 boundary-aligned requests + estimated timing + 明确标签/费用预览 |
| 大量小片导致费用或限流 | 默认顺序、请求数预览、确认/硬上限、优先原生 timestamp route |
| overlap 丢重复台词或重复半句 | 只在相邻边界按 core ownership/相似度仲裁，不做全局去重 |
| 大结果压垮 IPC/Store | main artifact + output token + 有界 preview，不持久化正文 |
| 页面离开导致任务/能力丢失 | app-level runtime service + main snapshot；route unmount 不释放 task owner |
| FFmpeg 只在开发机可用 | 只用 manifest 校验的 bundled runtime；packaged/no-PATH QA |
| 共享 media 重构破坏本地字幕 | 只抽取无业务语义 primitive；先跑本地字幕回归再接 Audio |
| JSON 结构升级破坏使用者 | 明确 canonical schemaVersion 与 release note；raw JSON 若需要另设格式 |
| 失败后提交不完整字幕 | 默认不发布 partial；同会话复用成功 chunk 后重试 |

## 20. 不得违反的实现约束

1. 不得把本地 Whisper、本地模型、GPU/backend 或 subtitle Job Manager 加入 `audio:*` 任务合同。
2. 不得让用户输出格式直接传为供应商 `response_format`。
3. 不得在 renderer 复制 route MIME/size/Base64 预算表。
4. 不得在 draft 文件授权阶段套用单次 API payload 上限。
5. 不得让 renderer 生成 FFmpeg 参数、chunk interval、bitrate 或 provider response format。
6. 不得把 ffprobe duration 当作唯一的磁盘/输出安全证明。
7. 不得累计完整 FFmpeg progress stdout 或把每个 native chunk 跨 IPC 发布。
8. 不得把一个 provider HTTP 200、JSON schema 通过或 SRT parse-back当作完整内容覆盖证明。
9. 不得把 VAD compressed word time 覆盖正确的原时间 segment。
10. 不得在相邻 overlap 之外做全文字符串去重。
11. 不得让普通文件转写的空响应复用 realtime 静音成功语义。
12. 不得把未验证的 Silero executor、自研 C++ bridge 或系统 FFmpeg设为开发前置。
13. 不得把真实路径、API Key、token、stderr 或 raw provider body写入 renderer Store、canonical JSON或公开诊断。
14. 不得让路由组件卸载取消已提交任务或释放其唯一 capability。
15. 不得只 `kill()` 不等待 child `close` 就删除临时目录。
16. 不得在一个 cleanup 阶段失败后跳过后续 task/media/capability cleanup。
17. 不得让自定义 OpenAI-compatible route 在缺少显式 upload contract 时继承内置 OpenAI 的乐观能力。
18. 不得在存在缺失 chunk 时发布正常完成的最终字幕。
19. 不得用直接覆盖已有目标文件来简化输出；首版使用 no-clobber index。
20. 不得用浏览器测试替代 Electron fixed preload、真实 Windows picker/Explorer drag 和 packaged resource 验收。

## 21. 下一步

下一会话应基于本文创建 `audio-transcriber-enhancement_execution_plan.md`，把第 18 节拆成单会话工作包和状态台账。首个实现包应只冻结 route/canonical/task 类型与 shared media 抽取边界，不立即改页面或删除 legacy `audio:transcribe`。
