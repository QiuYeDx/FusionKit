# 音频工具箱 Final Design

> [!IMPORTANT]
> 2026-07-12 起，本文的音频配置模型、TTS 模式/模型关系、字段禁用规则和相关验收口径，已由 [音频 API 配置与语音合成 UX 重构 Final Design](audio-toolkit-config-ux-refactor_final_design.md) 正式替代。本文其余 adapter、IPC 安全、文件、流式和 Realtime 合同继续有效；历史实施记录不倒改。

> 日期：2026-07-09
> Feature Slug：`audio-toolkit`
> 版本：`v0.2.11`
> 状态：2026-07-11 已完成 `FIX-001`～`FIX-007`、`AUDIT-001` 与 `QA-001`；IPC 信任边界、生命周期、Realtime GA 契约、TTS/ASR 正确性和四页 UX 已闭环并通过完整自动化、构建及 Electron 32 组合矩阵，当前仅剩 `QA-002` 真实供应商与真实设备验收
> 范围：新增音频转文本、文本转音频、实时字幕、Realtime/WebRTC 双向语音，并在设置页集中管理音频大模型 API 配置。

---

## 1. 评审结论

本需求不能按“两个工具页各自手填模型配置”实现。音频能力会同时覆盖文件 ASR、TTS、流式播放、麦克风实时字幕和双向语音会话，如果把 provider、base URL、API Key、模型 ID、协议 dialect 分散在各个工具详情页，用户会很难判断当前到底调用哪套 API，也无法做到和 OpenAI 官方音频模型无感切换。

最终设计采用：

1. 在设置页新增全局“音频模型配置”区域，统一管理音频连接、模型、协议、能力和任务生效选择。
2. 工具页不再提供独立的 API 配置选择；只展示当前全局生效的音频 profile、模型和能力，并提供跳转设置页的入口。
3. FusionKit 内部仍以 OpenAI 官方音频 API 字段为主契约；MiMo 通过 adapter 转换到 Chat Completions 音频结构。
4. 首版包含四类用户体验：音频转文本、文本转音频、实时麦克风字幕、Realtime/WebRTC 双向语音。
5. MiMo `mimo-v2.5-tts`、`mimo-v2.5-tts-voicedesign`、`mimo-v2.5-tts-voiceclone` 三个模型都必须接入流式输出路径；使用 `stream: true` 和 `pcm16` 低延迟播放链路。
6. OpenAI Realtime/WebRTC 使用 main 进程创建短期凭证，renderer 只拿临时 session secret，不持久化长期 API Key。

### 1.1 必须遵守的约束

- 音频大模型 API 的生效选择必须在设置页全局管理；工具页不得保存独立 provider、API Key、base URL、dialect、ASR/TTS/realtime 模型 ID。
- 工具页允许保存任务输入和临时参数，例如文件路径、文本、输出目录、语言、voice、MiMo 音色描述、参考音频路径；这些不等同于 API 生效配置。
- 以 OpenAI 官方音频字段作为 FusionKit 内部主契约；MiMo adapter 负责转换，不让业务 UI 直接依赖 MiMo 的 `messages/audio/asr_options` 结构。
- MiMo TTS 三个模型必须同页支持，并都接入非流式和流式输出：`mimo-v2.5-tts`、`mimo-v2.5-tts-voicedesign`、`mimo-v2.5-tts-voiceclone`。
- MiMo-only 字段必须有可见提示；当前全局生效 profile 不是 MiMo 时，音色设计、音色复刻、音频标签、`optimize_text_preview` 等控件必须禁用。
- OpenAI-only 字段必须按能力禁用；例如 OpenAI ASR 的 `srt/vtt/verbose_json/timestamp_granularities` 不应在 MiMo ASR 下可选。
- Realtime/WebRTC 双向语音首版至少支持 OpenAI Realtime dialect；MiMo 如未提供原生 WebRTC/realtime 双工接口，只能启用文件/分块 ASR 和流式 TTS，不得伪装为原生 WebRTC。
- 不把音频文件内容、生成音频 Base64、PCM chunk、API Key、Authorization 或 `api-key` header 写入 Zustand 持久化、日志、任务恢复文件或错误详情。
- 不用当前环境过新的 pnpm 改写 `pnpm-lock.yaml`。本仓库 lockfile 为 v6，依赖变更需要项目兼容的 pnpm 8.x 流程；首版设计不要求新增依赖。
- 如实现阶段启动 Vite/Electron/Playwright 服务，结束前必须关闭并检查无遗留进程。

## 2. 调研来源

- MiMo 语音合成 V2.5 文档：`https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5`
- MiMo 语音识别文档：`https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/Speech-Recognition`
- OpenAI Realtime 文档：`https://platform.openai.com/docs/guides/realtime`
- OpenAI Speech to text 文档：`https://platform.openai.com/docs/guides/speech-to-text`
- OpenAI Audio speech API reference：`https://platform.openai.com/docs/api-reference/audio/createSpeech`
- OpenAI Audio transcriptions API reference：`https://platform.openai.com/docs/api-reference/audio/createTranscription`
- 现有 OpenAI 新旧 API 格式兼容设计：`docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- 现有模型配置、端点与工具页代码：`src/type/model.ts`、`src/store/useModelStore.ts`、`src/lib/model-endpoint.ts`、`src/pages/Setting/components/ModelConfig.tsx`、`src/pages/Tools/_shared/*`

## 3. 背景与目标

FusionKit 目前已有字幕翻译、长文本翻译、名称翻译和 HomeAgent，模型配置已升级到 profile 体系，并支持 Chat Completions / Responses 两种文本调用格式。音频工具需要接入同一套全局配置和 proxy 能力，但不能污染已有文本 runtime。

### 3.1 目标

1. 新增全局音频模型配置：在设置页集中管理音频 profile、dialect、ASR/TTS/realtime 模型、默认 voice、任务生效选择和能力提示。
2. 新增音频转文本工具：选择本地音频或录音文件，调用 ASR 模型，输出纯文本或 OpenAI 支持的字幕/详细 JSON 结果。
3. 新增实时麦克风字幕工具：使用麦克风输入，实时展示 partial/final transcript，支持停止后保存字幕或纯文本。
4. 新增文本转音频工具：输入文本，使用全局 TTS 配置生成音频，支持非流式保存和流式低延迟播放。
5. 新增 Realtime/WebRTC 双向语音工具：支持麦克风输入、模型实时响应音频、字幕同步和会话状态管理。
6. MiMo ASR 支持 `mimo-v2.5-asr`，并通过 adapter 兼容 OpenAI ASR 的页面与 IPC 契约。
7. MiMo TTS 支持预置音色、音色设计、音色复刻三种模式；三种模式均接入流式输出路径。
8. OpenAI 官方音频模型可直接使用 OpenAI 音频端点和 Realtime/WebRTC 能力，不需要用户理解 MiMo 的 Chat Completions 特殊结构。
9. 错误、重试、取消、代理、超时、API Key 脱敏和前端进程清理与现有 `ModelRuntimeClient` 的质量标准对齐。

### 3.2 非目标

1. 首版不做批量长音频切片、说话人分离、多人时间轴人工校对器。
2. 首版不做本地离线 ASR/TTS，也不内置 FFmpeg 音频转码链路。
3. 首版不把生成音频接入音乐格式转换、素材库管理或项目资产库。
4. 首版不承诺所有 OpenAI-compatible 第三方都支持 Realtime/WebRTC；设置页必须通过 dialect 和 capability guard 禁用不可用能力。
5. 首版不做 SIP 电话接入、电话机器人或浏览器外的媒体服务器管线。

## 4. API 差异梳理

### 4.1 OpenAI 文件 ASR 契约

OpenAI 音频转写使用独立音频端点：

```text
POST <baseUrl>/audio/transcriptions
Content-Type: multipart/form-data
Authorization: Bearer <apiKey>
```

核心字段：

```ts
type OpenAITranscriptionInput = {
  file: File | Blob;
  model: string;
  language?: string;
  prompt?: string;
  response_format?: "json" | "text" | "srt" | "verbose_json" | "vtt";
  temperature?: number;
  timestamp_granularities?: Array<"word" | "segment">;
  stream?: boolean;
};
```

OpenAI 对已完成录音可使用 `stream: true` 获得转写事件；对持续麦克风输入应走 Realtime transcription。FusionKit 将文件转写和实时转写拆成两个 runtime 合同，避免把麦克风流塞进文件 API。

统一结果：

```ts
type AudioTranscriptionResult = {
  text: string;
  responseFormat: AudioTranscriptionResponseFormat;
  rawText?: string;
  rawJson?: unknown;
  segments?: AudioTranscriptSegment[];
  words?: AudioTranscriptWord[];
  outputPath?: string;
  model?: string;
};
```

### 4.2 MiMo ASR 契约

MiMo 文档当前仅支持 `mimo-v2.5-asr`。调用走 Chat Completions：

```text
POST https://api.xiaomimimo.com/v1/chat/completions
Content-Type: application/json
api-key: <MIMO_API_KEY>
```

请求要点：

- 音频在 `messages[0].content[]` 中作为 `type: "input_audio"` 传入。
- `input_audio.data` 可为带 MIME 前缀的 Base64 data URI，也可用 `data + format` 形态。
- 当前文档只支持 `wav/mp3`，Base64 编码后大小上限为 10MB。
- `asr_options.language` 支持 `auto`、`zh`、`en`；未配置时自动检测。
- 文档示例支持 `stream: true`，首版应实现文件/录音片段的流式转写事件，但不要把它标记为原生 WebRTC。

FusionKit 的 MiMo adapter 将 OpenAI 风格 request 映射为：

```ts
{
  model: "mimo-v2.5-asr",
  messages: [
    {
      role: "user",
      content: [
        {
          type: "input_audio",
          input_audio: {
            data: "data:audio/wav;base64,<...>"
          }
        }
      ]
    }
  ],
  asr_options: {
    language: "auto" | "zh" | "en"
  },
  stream?: true
}
```

MiMo ASR 不在文档中提供 OpenAI transcription 的 `srt/vtt/timestamp_granularities` 等能力。UI 在 MiMo 模式下只能启用 `json/text` 风格输出；字幕格式和时间戳控件禁用并显示“当前 MiMo ASR 文档未提供该能力”。

### 4.3 OpenAI TTS 契约

OpenAI 文本转语音使用独立端点：

```text
POST <baseUrl>/audio/speech
Content-Type: application/json
Authorization: Bearer <apiKey>
```

核心字段：

```ts
type OpenAISpeechInput = {
  model: string;
  input: string;
  voice: string;
  instructions?: string;
  response_format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  speed?: number;
};
```

响应为二进制音频流。Electron main 应以 `arraybuffer` 或 streaming reader 接收并写入本地文件，不经过 Renderer Base64。

### 4.4 MiMo TTS 契约

MiMo TTS 也走 Chat Completions，模型与能力如下：

| Model ID | 能力 | 首版 UI 模式 | 禁用项 |
| --- | --- | --- | --- |
| `mimo-v2.5-tts` | 使用预置音色合成 | 预置音色 | 不支持音色设计与音色复刻 |
| `mimo-v2.5-tts-voicedesign` | 通过文本描述生成定制音色 | 音色设计 | 不支持唱歌模式、预置音色、音色复刻 |
| `mimo-v2.5-tts-voiceclone` | 用音频样本复刻音色 | 音色复刻 | 不支持唱歌模式、预置音色、音色设计 |

通用调用规则：

- 目标合成文本放在 `role: "assistant"` 的消息中。
- `role: "user"` 消息可作为风格/语气指令；`voicedesign` 模式下为必填音色描述。
- 预置音色通过 `audio.voice` 设置，例如 `mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`。
- `voicedesign` 支持 `audio.optimize_text_preview`。
- `voiceclone` 将参考音频作为 `audio.voice = "data:<mime>;base64,<...>"` 传入。
- 流式输出必须使用 `stream: true` 和 `audio.format = "pcm16"`，按 24kHz PCM16LE mono 拼接或实时播放。

FusionKit 的 MiMo TTS adapter 将 OpenAI 风格 request 加 `mimoOptions` 映射为：

```ts
type MimoSpeechSynthesisMode = "preset_voice" | "voice_design" | "voice_clone";

type MimoSpeechOptions = {
  mode: MimoSpeechSynthesisMode;
  styleInstruction?: string;
  voiceDesignPrompt?: string;
  optimizeTextPreview?: boolean;
  voiceSamplePath?: string;
  voiceSampleMime?: "audio/mpeg" | "audio/mp3" | "audio/wav";
  audioTagsEnabled?: boolean;
};
```

首版对三个 MiMo TTS 模型都实现同一套 streaming parser，并以三模型低延迟流式均通过真实验收作为发布目标。若真实供应商对 `voicedesign` 或 `voiceclone` 返回兼容模式或非低延迟事件，相关工作包应标为 `阻塞` 或补充 `fix/` 文档，不能把降级路径当作首版完成；设置页也必须显示该 profile 未通过低延迟实测。

### 4.5 OpenAI Realtime/WebRTC 契约

Realtime 与文件音频 API 是独立能力。首版使用：

- Renderer 调用 `navigator.mediaDevices.getUserMedia()` 采集麦克风。
- Electron main 使用长期 API Key 创建 ephemeral session/client secret。
- Renderer 使用临时凭证建立 WebRTC 会话，发送麦克风音轨并播放远端音轨。
- 对实时字幕，监听 partial/final transcription event。
- 对双向语音，监听 input/output transcript、audio delta、response lifecycle、error 和 disconnect。

WebRTC 是浏览器/移动端直接采集和播放音频时的首选连接方式；WebSocket 更适合服务端已经拥有原始音频流的管线。Electron renderer 属于浏览器媒体场景，因此首版以 WebRTC 为主，WebSocket 作为 adapter 备用路径。

## 5. 当前项目状态

### 5.1 已可复用能力

- `src/type/model.ts` 已有 `ModelProfile`、`ModelApiFormat`、`ModelAssignment`。
- `src/store/useModelStore.ts` 已有 profile v3 持久化迁移和任务模型 assignment。
- `src/lib/model-endpoint.ts` 已能从 base URL 或 full endpoint 派生 `chatCompletionsUrl`、`responsesUrl`、`modelsUrl`。
- `electron/main/ai/model-runtime-client.ts` 已有文本 runtime 的错误、重试、代理、endpoint normalization 经验可参考。
- `src/pages/Setting/components/ModelConfig.tsx` 已有全局 profile 管理 UI，可扩展音频配置分区。
- `src/pages/Tools/_shared/ui/*` 提供了工具详情页布局、配置面板、文件拖拽、输出路径选择等组件。
- `electron/preload/index.ts` 已暴露 `electronUtils.getPathForFile()`，Renderer 可以拿到用户选择文件的真实路径。

### 5.2 需要新增或调整的地方

- `src/store/useModelStore.ts` 需要迁移到包含音频 profile 和音频 assignment 的新版本，或新增同等全局设置 store；推荐复用同一 store，保证设置页统一。
- `src/pages/Setting/components/ModelConfig.tsx` 当前远端模型列表过滤 `whisper/tts/audio/realtime/transcri`，这对聊天/翻译合理，但音频配置需要独立模型预设、手输和能力展示。
- `src/pages/Tools/_shared/toolMeta.ts` 当前 `music` 是 soon 状态，应新增独立 audio 分类和四个工具入口。
- `src/constants/router.ts` 和 `src/App.tsx` 需要新增四条音频路由。
- `electron/main/index.ts` 需要注册新的 `setupAudioIPC()` 和 `setupAudioRealtimeIPC()`。
- 需要新增 `src/type/audio.ts`、`src/type/audioIpc.ts`、`src/services/audio/*`、`src/store/tools/audio/*` 和 `electron/main/audio/*`。
- Realtime 工具需要处理 Electron 的麦克风权限、会话清理、页面离开自动断开、后台运行提示。

## 6. 最终架构

```text
Settings
  src/pages/Setting/components/AudioModelConfig.tsx
  src/store/useModelStore.ts
        |
        | global audio profiles + assignments
        v
Renderer tool pages
  /tools/audio/transcriber
  /tools/audio/speech-synthesis
  /tools/audio/realtime-captions
  /tools/audio/realtime-voice
        |
        | OpenAI-shaped request / stream session request
        v
Renderer services
  src/services/audio/audioTranscriptionService.ts
  src/services/audio/speechSynthesisService.ts
  src/services/audio/audioRealtimeService.ts
        |
        v
Electron IPC
  electron/main/audio/ipc.ts
  electron/main/audio/realtime-ipc.ts
        |
        v
AudioRuntimeClient
  electron/main/audio/audio-runtime-client.ts
        |
        +-- adapters/openai-audio-adapter.ts
        |     POST /audio/transcriptions
        |     POST /audio/speech
        |
        +-- adapters/mimo-chat-audio-adapter.ts
        |     POST /chat/completions
        |     ASR input_audio
        |     TTS messages + audio options + stream
        |
        +-- realtime/openai-realtime-adapter.ts
              ephemeral session
              WebRTC / WebSocket session events
```

### 6.1 全局音频配置模型

新增音频协议类型，不复用 `ModelApiFormat`：

```ts
export type AudioApiDialect =
  | "openai_audio"
  | "mimo_chat_audio"
  | "openai_realtime";

export type AudioCapability =
  | "file_transcription"
  | "streaming_transcription"
  | "speech_synthesis"
  | "streaming_speech_synthesis"
  | "realtime_transcription"
  | "realtime_duplex_voice"
  | "mimo_voice_design"
  | "mimo_voice_clone";

export type AudioAssignmentKey =
  | "transcription"
  | "speechSynthesis"
  | "realtimeCaptions"
  | "realtimeVoice";

export interface AudioModelProfile {
  id: string;
  name: string;
  connectionProfileId: string;
  audioDialect: AudioApiDialect;
  capabilities: AudioCapability[];
  models: {
    transcription?: string;
    speechSynthesis?: string;
    realtime?: string;
  };
  defaults: {
    language?: "auto" | "zh" | "en" | string;
    transcriptionResponseFormat?: AudioTranscriptionResponseFormat;
    ttsVoice?: string;
    ttsResponseFormat?: AudioSpeechResponseFormat;
    realtimeVoice?: string;
    mimoTtsMode?: MimoSpeechSynthesisMode;
    streamSpeechByDefault?: boolean;
  };
  verification?: {
    streamingSpeech?: "untested" | "verified" | "degraded" | "failed";
    realtimeVoice?: "untested" | "verified" | "failed";
    updatedAt?: string;
  };
}

export type AudioModelAssignment = Record<AudioAssignmentKey, string | null>;
```

`connectionProfileId` 指向现有 `ModelProfile`，复用 API Key、Base URL、Provider、Proxy 行为和脱敏逻辑。这样设置页只有一个长期 Key 来源，音频 profile 只管理音频专属模型和能力。

迁移建议：

- `fusionkit-model` 从 version 3 升到 version 4，新增 `audioProfiles` 与 `audioAssignment`。
- 老用户默认没有音频 profile，音频工具显示“请到设置页配置音频模型”。
- 设置页支持从现有 OpenAI / Other profile 一键创建音频 profile。
- 删除连接 profile 时，如果被音频 profile 引用，需要阻止删除或提示先迁移引用。

### 6.2 Runtime 调用配置

工具页发起任务时，通过全局 assignment 解析出运行时配置：

```ts
export interface AudioRuntimeModelConfig {
  audioProfileId: string;
  connectionProfileId: string;
  provider: Model;
  apiKey: string;
  baseUrl: string;
  audioDialect: AudioApiDialect;
  modelKey: string;
  capabilities: AudioCapability[];
}
```

`modelKey` 来自全局音频 profile 的 `models.transcription`、`models.speechSynthesis`、`models.realtimeTranscription` 或 `models.realtimeVoice`，不来自工具页本地状态。旧 `models.realtime` 只用于迁移并同时播种两个 Realtime 字段；工具页只读显示当前值。

默认推断：

- `provider === Model.OpenAI`：文件 ASR/TTS 默认 `openai_audio`，realtime 默认 `openai_realtime`。
- `baseUrl` 包含 `xiaomimimo.com` 或 `modelKey` 以 `mimo-v2.5-` 开头：建议 `mimo_chat_audio`。
- `provider === Model.Other`：允许 `openai_audio`、`openai_realtime`、`mimo_chat_audio`，但必须由用户在设置页明确选择。
- `provider === Model.DeepSeek`：音频工具中默认不可用，除非用户在设置页创建 Other/MiMo 兼容音频 profile。

### 6.3 Endpoint normalization

扩展或新增 `normalizeAudioEndpoint()`：

```ts
export interface NormalizedAudioEndpoint {
  baseUrl: string;
  chatCompletionsUrl: string;
  audioSpeechUrl: string;
  audioTranscriptionsUrl: string;
  realtimeClientSecretsUrl: string;
  realtimeCallsUrl: string;
  modelsUrl: string;
}
```

兼容输入：

- `https://api.openai.com/v1`
- `https://api.openai.com/v1/audio/speech`
- `https://api.openai.com/v1/audio/transcriptions`
- `https://api.openai.com/v1/realtime/client_secrets`
- `https://api.xiaomimimo.com/v1`
- `https://api.xiaomimimo.com/v1/chat/completions`

### 6.4 鉴权策略

```ts
function buildAudioAuthHeaders(dialect: AudioApiDialect, apiKey: string) {
  if (dialect === "mimo_chat_audio") {
    return { "api-key": apiKey };
  }
  return { Authorization: `Bearer ${apiKey}` };
}
```

OpenAI Realtime 的长期 Key 只在 main 进程使用。Renderer 建立 WebRTC 会话时只能使用 ephemeral credentials。

## 7. API 合同设计

### 7.1 ASR 请求与响应

```ts
export type AudioTranscriptionResponseFormat =
  | "json"
  | "text"
  | "srt"
  | "verbose_json"
  | "vtt";

export interface CreateAudioTranscriptionIpcRequest {
  assignmentKey: "transcription";
  fileToken: string;
  fileName: string;
  mimeType: string;
  language?: "auto" | "zh" | "en" | string;
  prompt?: string;
  responseFormat: AudioTranscriptionResponseFormat;
  temperature?: number;
  timestampGranularities?: Array<"word" | "segment">;
  stream?: boolean;
  outputPathMode?: "temp" | "source_dir" | "custom_dir";
  outputDir?: string;
}

export interface AudioTranscriptionResult {
  text: string;
  responseFormat: AudioTranscriptionResponseFormat;
  outputPath?: string;
  rawJson?: unknown;
  rawText?: string;
  segments?: AudioTranscriptSegment[];
  words?: AudioTranscriptWord[];
  model?: string;
  durationMs?: number;
}
```

MiMo adapter 行为：

- `language` 只接受 `auto/zh/en`；其他语言在 UI 层禁用或提交前报 validation error。
- `prompt` 首版不发送给 MiMo，UI 显示“MiMo ASR 文档未提供 prompt 参数”。
- `responseFormat` 非 `json/text` 时阻止提交。
- `timestampGranularities` 在 MiMo 模式下禁用。
- `stream: true` 时解析增量文本事件；如供应商只返回最终消息，也按 final event 处理并标记 `streamMode: "final_only"`。

### 7.2 TTS 请求与响应

```ts
export type AudioSpeechResponseFormat =
  | "mp3"
  | "opus"
  | "aac"
  | "flac"
  | "wav"
  | "pcm"
  | "pcm16";

export interface CreateSpeechSynthesisRequest {
  assignmentKey: "speechSynthesis";
  input: string;
  voice?: string;
  instructions?: string;
  responseFormat: AudioSpeechResponseFormat;
  speed?: number;
  stream?: boolean;
  outputPathMode?: "temp" | "source_dir" | "custom_dir";
  outputDir?: string;
  fileNameHint?: string;
  mimoOptions?: MimoSpeechOptions;
}

export interface SpeechSynthesisResult {
  outputPath: string;
  mimeType: string;
  responseFormat: AudioSpeechResponseFormat;
  sizeBytes: number;
  model?: string;
  durationMs?: number;
  streamStats?: AudioStreamStats;
}
```

OpenAI adapter 行为：

- 发送 `model/input/voice/instructions/response_format/speed`。
- 忽略 `mimoOptions`，并在 IPC validation 中禁止非空 `mimoOptions` 进入 OpenAI adapter。
- 非流式响应按二进制保存；流式响应使用 streaming reader 写文件并上报播放 chunk。

MiMo adapter 行为：

- 非流式允许 `wav`，从 `choices[0].message.audio.data` 解码保存。
- 流式强制 `responseFormat = "pcm16"`，请求体写入 `stream: true` 与 `audio.format = "pcm16"`。
- `speed` 不发送；UI 在 MiMo 下禁用 OpenAI 数值语速。
- `instructions` 映射为 `messages` 中的 `user` 内容；`voicedesign` 模式下使用 `voiceDesignPrompt` 作为 user 内容。
- `input` 映射为 `assistant` 内容；当 `optimizeTextPreview === true` 且 `input` 为空时，允许提交并显示“目标文本由 MiMo 优化生成”的提示。
- 流式解析 `choices[0].delta.audio.data`，兼容最终一次性 `choices[0].message.audio.data`。

### 7.3 流式 TTS 事件

```ts
export type SpeechSynthesisStreamEvent =
  | { type: "started"; requestId: string; sampleRate: 24000; channels: 1 }
  | { type: "audio_delta"; requestId: string; pcmBytes: Uint8Array }
  | { type: "text_delta"; requestId: string; text: string }
  | { type: "metadata"; requestId: string; stats: Partial<AudioStreamStats> }
  | { type: "completed"; requestId: string; result: SpeechSynthesisResult }
  | { type: "error"; requestId: string; error: AudioIpcError };
```

Main 进程职责：

- 将远端 Base64 音频 chunk 解码为 bytes。
- 写入临时 `.pcm` 或直接组装 `.wav`。
- 通过 IPC event 向 renderer 推送最小必要音频 chunk，不推送原始 request body。
- 完成后把 PCM16 包装为 WAV，返回最终 outputPath。

Renderer 职责：

- 使用 Web Audio 播放 PCM16 chunk。
- UI 显示首包延迟、已接收时长、完成状态。
- 页面离开或取消时发送 abort，并释放 AudioContext。

### 7.4 Realtime 会话合同

```ts
export interface AudioRealtimeSessionConfig {
  assignmentKey: "realtimeCaptions" | "realtimeVoice";
  mode: "caption" | "duplex_voice";
  instructions?: string;
  language?: string;
  voice?: string;
  turnDetection?: "server_vad" | "manual";
  inputAudioFormat?: "pcm16" | "pcmu" | "pcma";
  outputAudioFormat?: "pcm16" | "pcmu" | "pcma";
}

export type AudioRealtimeSessionEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "mic_state"; state: "requesting" | "granted" | "denied" | "muted" }
  | { type: "transcript_delta"; role: "user" | "assistant"; text: string; itemId?: string; responseId?: string; contentIndex?: number }
  | { type: "transcript_final"; role: "user" | "assistant"; text: string; itemId?: string; responseId?: string; contentIndex?: number }
  | { type: "audio_started"; role: "assistant" }
  | { type: "audio_stopped"; role: "assistant" }
  | { type: "response_started"; responseId: string }
  | { type: "response_completed"; responseId: string; status: "completed" | "cancelled" | "failed" | "incomplete" }
  | { type: "error"; error: AudioIpcError; fatal: boolean }
  | { type: "session_closed"; reason: "user" | "page_unload" | "error" };
```

Session lifecycle：

1. Tool page reads global assignment and validates capability.
2. Renderer requests microphone permission.
3. Main creates ephemeral Realtime credentials for OpenAI Realtime profiles.
4. Renderer establishes WebRTC peer connection and binds local/remote audio tracks.
5. Renderer and main exchange normalized realtime events for subtitles, status and cleanup.
6. Stop/page leave/error path must close peer connection, stop media tracks, revoke object URLs and clear session state.

首版 UI 只开放 `server_vad`。`manual` 保留在线协议类型中用于后续 push-to-talk，但在完整实现 `input_audio_buffer.commit`（Voice 还需 `response.create`）前必须禁用。

MiMo profile behavior：

- `mimo_chat_audio` 不标记 `realtime_duplex_voice`，除非未来文档提供原生双工实时接口。
- 实时字幕页面可以提供“分块录音转写”模式：MediaRecorder 按短片段送 main，main 调用 MiMo ASR streaming，UI 显示近实时结果；此模式必须标记为 `chunked_streaming_transcription`，不显示为 WebRTC。
- 双向语音页在 MiMo profile 下默认禁用，并提示当前全局 profile 不支持 Realtime/WebRTC 双向语音。

## 8. 能力矩阵与 UI 禁用规则

### 8.1 ASR 能力矩阵

| 功能 | OpenAI Audio | MiMo Chat Audio |
| --- | --- | --- |
| 上传音频文件 | 支持 | 支持 |
| `language` | ISO 语言码 | 仅 `auto/zh/en` |
| `prompt` | 支持 | 禁用 |
| `json/text` | 支持 | 支持 |
| `srt/vtt` | 支持 | 禁用 |
| `verbose_json` | 支持 | 禁用 |
| word/segment 时间戳 | 支持时启用 | 禁用 |
| 已完成音频流式转写 | 支持时启用 | 支持 `stream: true` |
| 麦克风实时字幕 | 走 Realtime transcription | 仅分块录音转写，不标记 WebRTC |

### 8.2 TTS 能力矩阵

| 功能 | OpenAI Audio | MiMo 预置音色 | MiMo 音色设计 | MiMo 音色复刻 |
| --- | --- | --- | --- | --- |
| 输入文本 | 必填 | 必填 | 可配合 `optimize_text_preview` 放宽 | 必填 |
| voice | OpenAI voice id | 预置音色 | 禁用 | 参考音频 data URI |
| instructions/style | `instructions` | user message | voice design prompt 必填 | 可保留为空 |
| 非流式格式 | OpenAI 官方格式 | `wav` | `wav` | `wav` |
| 流式格式 | 支持时启用 | `pcm16` | `pcm16` | `pcm16` |
| speed | 支持 | 禁用 | 禁用 | 禁用 |
| 音频标签 | 禁用 | 启用 | 禁用 | 禁用 |
| 唱歌模式 | 禁用 | 启用 | 禁用 | 禁用 |
| `optimize_text_preview` | 禁用 | 禁用 | 启用 | 禁用 |
| 上传参考音频 | 禁用 | 禁用 | 禁用 | 启用 |

### 8.3 Realtime 能力矩阵

| 功能 | OpenAI Realtime | MiMo Chat Audio |
| --- | --- | --- |
| 麦克风权限与录音 | 支持 | 支持分块录音 |
| 实时字幕 partial/final | 支持 | 分块近实时 |
| WebRTC 双向语音 | 支持 | 禁用 |
| 模型实时音频回复 | 支持 | 可用 TTS 流式单向播放，不等同双工 |
| ephemeral credentials | 必须 | 不适用 |

UI 规则：

- 设置页是唯一能更改音频 provider、base URL、dialect、模型 ID 和任务 assignment 的位置。
- 工具页顶部显示“当前使用：<Audio Profile Name> / <Model ID> / <Dialect>”，并提供“前往设置”按钮。
- 被禁用的控件保留可见但不可编辑，并用 `InfoHint` 说明“当前全局音频配置不支持”或“MiMo 专属能力”。
- 切换设置页的全局 assignment 后，工具页重新解析能力；不可用字段保留草稿但提交 payload 不包含 inactive 字段。
- 提交按钮旁显示当前会调用的协议，例如 `OpenAI Audio /audio/speech`、`MiMo Chat Audio /chat/completions`、`OpenAI Realtime WebRTC`。

## 9. 前端交互设计

### 9.1 设置页音频模型配置

新增设置页分区：

```text
设置
  模型配置
    文本模型配置
    音频模型配置
      音频 Profile 列表
      生效任务选择
      能力与实测状态
```

音频 Profile 表单字段：

- 名称。
- 连接 Profile：引用已有 `ModelProfile`。
- 音频协议：`openai_audio`、`openai_realtime`、`mimo_chat_audio`。
- ASR 模型 ID。
- TTS 模型 ID 或 MiMo TTS 模式默认值。
- Realtime 模型 ID。
- 默认 voice、语言、输出格式、是否默认流式。
- 能力提示和实测状态。

生效任务选择：

```text
音频转文本：<Audio Profile>
文本转音频：<Audio Profile>
实时字幕：<Audio Profile>
双向语音：<Audio Profile>
```

如果某个 profile 不具备任务所需 capability，设置页禁止保存 assignment，或保存时弹出明确错误。

### 9.2 工具入口

新增分类：

```text
音频工具箱
  - 音频转文本
  - 文本转音频
  - 实时字幕
  - 双向语音
```

新增路由：

```text
/tools/audio/transcriber
/tools/audio/speech-synthesis
/tools/audio/realtime-captions
/tools/audio/realtime-voice
```

涉及文件：

- `src/pages/Tools/_shared/toolMeta.ts`
- `src/pages/Tools/index.tsx`
- `src/App.tsx`
- `src/constants/router.ts`
- `src/locales/*/tools.json`

### 9.3 音频转文本页面

布局沿用 `ToolDetailLayout`：

- 顶部只读全局配置摘要：profile、dialect、ASR 模型、能力状态。
- 左侧任务参数：语言、输出格式、时间戳、prompt、是否流式、输出目录。
- 主区域：`ToolFileDropZone` 选择音频，文件信息，开始/取消按钮，结果文本区，复制、保存、打开目录。
- 状态：未配置全局 profile、未选择文件、模型未配置、格式不支持、转写中、完成、失败、取消。

文件输入：

- OpenAI 模式允许常见官方格式，至少包括 `wav/mp3/m4a/flac/ogg/webm/mp4/mpeg`。
- MiMo 模式首版只允许 `wav/mp3`，并通过 MIME 推断为 `audio/wav`、`audio/mpeg` 或 `audio/mp3`。
- MiMo 按 Base64 后 10MB 限制提交；OpenAI 默认建议首版限制 25MB，可在实现时作为常量。

### 9.4 文本转音频页面

布局沿用 `ToolDetailLayout`：

- 顶部只读全局配置摘要：profile、dialect、TTS 模型、是否支持流式。
- 左侧任务参数：voice、输出格式、OpenAI speed、是否流式、输出目录。
- 主区域：文本输入、instructions/style 输入、MiMo 专属配置区、生成按钮、流式播放状态、音频播放器、输出文件操作。
- MiMo TTS 三种模式使用 segmented control：预置音色、音色设计、音色复刻。

MiMo 专属配置：

- 预置音色：voice select，预置列表按语言/性别分组；支持手输 voice id。
- 音色设计：voice design prompt textarea，`optimize_text_preview` switch。
- 音色复刻：参考音频 dropzone，仅接受 `wav/mp3`；提交前在 main 进程转 data URI。
- 流式开关：MiMo 三种模式均可打开；打开后输出格式锁定为 `pcm16`，完成后保存为 `.wav`。

### 9.5 实时字幕页面

页面结构：

- 顶部只读全局配置摘要：profile、dialect、realtime/ASR 模型、模式标签。
- 主区为实时字幕流：partial 行、final 行、时间戳、复制/保存按钮。
- 底部控制条：开始、暂停/继续、停止、清空、保存。
- 麦克风状态：未授权、请求中、已授权、静音、输入音量。

OpenAI Realtime profile：

- 使用 WebRTC 或 realtime transcription session。
- 展示 partial/final transcript。
- 停止后可保存 `.txt/.srt`，如果没有 segment 时间戳则保存 `.txt`。

MiMo profile：

- 使用分块录音转写模式，UI 明确显示“分块近实时”。
- 不显示 WebRTC 标签。
- 每个片段的结果进入同一字幕流，允许后续人工合并。

### 9.6 双向语音页面

页面结构：

- 顶部只读全局配置摘要：Realtime profile、model、voice、连接状态。
- 主区：会话转写 timeline，区分 user/assistant partial/final。
- 控制条：连接、断开、静音、打断回复、清空会话。
- 音频输出：播放远端音轨，显示模型正在说话状态。

能力规则：

- 只有 `realtime_duplex_voice` capability 的 profile 可以启动。
- 首版 OpenAI Realtime 使用 WebRTC；如后续加入 WebSocket，仍通过同一 `AudioRealtimeSessionEvent` 标准化。
- 页面离开必须自动断开 session、停止 mic tracks、关闭 peer connection。

### 9.7 i18n

新增 namespace 建议为 `audio.json`，避免 `tools.json` 过大：

```text
src/locales/zh/audio.json
src/locales/en/audio.json
src/locales/ja/audio.json
src/locales/zh-Hant/audio.json
```

同时更新：

- `src/i18n/resources.ts`
- `src/i18n/constants.ts`
- `scripts/check-i18n.mjs` 验证。

## 10. 后端与 IPC 设计

新增文件：

```text
src/type/audio.ts
src/type/audioIpc.ts
src/services/audio/audioTranscriptionService.ts
src/services/audio/speechSynthesisService.ts
src/services/audio/audioRealtimeService.ts
electron/main/audio/ipc.ts
electron/main/audio/realtime-ipc.ts
electron/main/audio/audio-runtime-client.ts
electron/main/audio/adapters/openai-audio-adapter.ts
electron/main/audio/adapters/mimo-chat-audio-adapter.ts
electron/main/audio/realtime/openai-realtime-adapter.ts
electron/main/audio/audio-file.ts
electron/main/audio/audio-stream.ts
electron/main/audio/audio-errors.ts
```

IPC channel：

```ts
export const AUDIO_IPC_CHANNELS = {
  syncRuntimeConfig: "audio:sync-runtime-config",
  transcribe: "audio:transcribe",
  cancelTranscription: "audio:cancel-transcription",
  synthesizeSpeech: "audio:synthesize-speech",
  synthesizeSpeechStream: "audio:synthesize-speech-stream",
  cancelSpeechSynthesisStream: "audio:cancel-speech-synthesis-stream",
  revealOutput: "audio:reveal-output",
  realtimeCreateEphemeralSession: "audio:realtime:create-ephemeral-session",
  realtimeSessionEvent: "audio:realtime:session-event",
  realtimeStopSession: "audio:realtime:stop-session",
} as const;
```

IPC result：

```ts
export type AudioIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AudioIpcError };

export type AudioIpcErrorCode =
  | "invalid_ipc_request"
  | "audio_profile_not_configured"
  | "unsupported_audio_capability"
  | "unsupported_audio_format"
  | "microphone_permission_denied"
  | "file_too_large"
  | "file_read_failed"
  | "output_write_failed"
  | "stream_parse_failed"
  | "realtime_session_failed"
  | "network_error"
  | "request_timeout"
  | "http_unauthorized"
  | "http_forbidden"
  | "http_rate_limited"
  | "http_retryable"
  | "http_non_retryable"
  | "empty_response"
  | "invalid_response"
  | "aborted";
```

Main 进程职责：

- 接收设置/store 层同步的全局音频配置快照并仅在内存保存；工具页任务请求不得携带 provider、API Key、base URL、dialect 或模型 ID。
- 通过全局 audio assignment 解析 runtime config。
- 只接受 preload 从真实 `File` 选择结果换取的、绑定 sender 且有 TTL 的 `fileToken`；main 解析后再校验路径、文件头、大小和 dialect。
- 根据扩展名和 MIME 建立 data URI、multipart body 或 streaming body。
- 按 dialect 选择 endpoint 和鉴权 header。
- 统一 timeout、AbortSignal、proxy、Retry-After、错误脱敏。
- 将输出写到 temp/custom/source_dir，并返回 path 和 metadata。
- 创建 OpenAI Realtime ephemeral credentials，不向 renderer 暴露长期 API Key。
- 不把原始音频 Base64、PCM chunk、完整 request body 打印到 console。

## 11. 输出文件策略

默认路径：

- ASR：如果用户未选择输出目录，结果只在 UI 中显示；点击保存时写入 `.txt/.json/.srt/.vtt`。
- TTS 非流式：生成后必须落本地临时文件，用于 `<audio>` 播放。用户可选择输出目录时直接写入目标目录。
- TTS 流式：边播放边写入临时 PCM/WAV；完成后返回最终 `.wav` 或用户指定格式。
- 实时字幕：停止会话后写入 `.txt`；如有稳定 segment 时间戳，再支持 `.srt`。

命名：

```text
<sourceName>.transcript.txt
speech_<yyyyMMdd_HHmmss>.<ext>
realtime_captions_<yyyyMMdd_HHmmss>.txt
```

冲突处理：

- 首版采用自动追加 `-1/-2`，不覆盖已有文件。
- 后续如果需要，可复用长文本翻译的 conflict policy。

## 12. 错误处理与边界

- 未配置全局音频 profile：页面显示设置入口，不允许提交。
- 全局 assignment 不具备当前工具能力：提交前拦截，例如 MiMo profile 打开双向语音时提示需要 OpenAI Realtime profile。
- API dialect 与模型不匹配：设置页保存时拦截，例如 OpenAI Audio 下选择 `mimo-v2.5-tts-voiceclone` 时提示改用 MiMo Chat Audio。
- MiMo ASR 语言不是 `auto/zh/en`：提交前拦截。
- MiMo TTS 使用 OpenAI speed：控件禁用，不进入 payload。
- OpenAI TTS 使用 MiMo voice clone：控件禁用，不进入 payload。
- 文件过大：提交前拦截，提示建议压缩或拆分。
- 流式响应只返回最终一次：仍生成结果，但状态标记为 `final_only` 或 `degraded`。
- 麦克风权限被拒绝：保持页面可见状态，提供重新授权提示，不启动 session。
- 页面关闭或路由切换：自动 abort 请求、断开 realtime session、释放音频资源。
- 401/403/429/5xx：复用文本 runtime 的错误分类语义，消息不得泄露 key。

## 13. 测试与验证策略

自动化测试：

- `test/audio/fakeAudioApiServer.ts`：支持 OpenAI `/audio/transcriptions`、OpenAI `/audio/speech`、OpenAI realtime ephemeral session、MiMo `/chat/completions`、SSE/streaming fixture。
- `test/audio/audioRuntimeClient.test.ts`：覆盖成功、空响应、401、403、429 Retry-After、5xx retry、超时、取消、流式 chunk、降级 final-only。
- `src/type/audioIpc.test.ts`：覆盖 IPC request validation、global assignment resolution 和 capability guard。
- `src/store/useModelStore.test.ts`：覆盖 v4 audio profile migration、引用删除、assignment guard。
- `src/pages/Tools/Audio/*` 的纯函数测试：能力矩阵、禁用规则、输出文件名、流式状态 reducer。

建议验证命令：

```text
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
git diff --check
```

注意：不要直接运行环境中的新 `pnpm`。如果实现阶段确需 `pnpm`，先确认项目兼容 pnpm 8.x。

手工验收：

- 设置页：创建 OpenAI Audio profile、OpenAI Realtime profile、MiMo Audio profile，并分别设置四类 assignment。
- OpenAI ASR：`json/text` 至少各一次；如模型支持，补 `srt/vtt/verbose_json`。
- MiMo ASR：`auto/zh/en` 语言路径各一次，确认非支持格式被禁用；流式 fixture 与真实调用都记录。
- OpenAI TTS：生成一种二进制音频并可播放。
- MiMo TTS：预置音色、音色设计、音色复刻各完成非流式与流式调用。
- 实时字幕：麦克风授权、开始、partial/final 展示、停止保存。
- 双向语音：OpenAI Realtime WebRTC 连接、模型音频回复、打断、断开、页面离开清理。
- Electron UI：用实际 Electron 运行验证文件路径、播放器、打开目录；结束前关闭前端/Electron 服务。

## 14. 风险与后续

- MiMo 文档明确 `mimo-v2.5-tts` 已恢复低延迟流式，但 `voicedesign/voiceclone` 的低延迟实测状态需要真实供应商验收。首版交付目标是三模型低延迟流式全部可用；如真实调用仍降级为最终一次性返回，该能力不能标记为完成。
- OpenAI 音频模型、voices、response format 和 Realtime model 可能随时间变化。设置页要允许手输模型和 voice，预设只作为便利入口。
- 大音频 Base64 会放大内存占用。MiMo adapter 首版应严格限制文件大小；后续如 MiMo 支持 URL 或 multipart，应改为更省内存的上传路径。
- Realtime/WebRTC 在 Electron 中受权限、音频设备、网络和系统策略影响较大，必须有 session cleanup 和手工验收记录。
- 当前模型配置页过滤音频模型，音频配置不能依赖文本模型列表。后续可新增“音频模型列表拉取”，使用单独过滤规则。
- OpenAI ASR 的时间戳能力与具体模型有关，UI 应以 capability guard 加提示，而不是所有 OpenAI profile 一律开放。

## 15. 推荐实施顺序

1. `PRE-001`：冻结音频契约、能力矩阵、全局设置数据结构和 fake server。
2. `CORE-001`：实现全局音频 profile/assignment store migration 和设置页基础。
3. `CORE-002`：实现 endpoint、文件、输出、流式 PCM/WAV 工具。
4. `BE-001`：实现 OpenAI 文件 ASR/TTS adapter。
5. `BE-002`：实现 MiMo ASR/TTS 非流式 adapter。
6. `BE-003`：已实现 MiMo 三模型流式 TTS runtime、SSE parser、PCM16/WAV 输出、final-only 标记与流式事件回调；真实 `voicedesign/voiceclone` 低延迟仍需 QA-002 验证。
7. `BE-004`：已实现 Audio IPC、全局音频配置同步、stream event、流式取消与 renderer service facade。
8. `BE-005`：已实现 OpenAI Realtime ephemeral session、main 侧 WebRTC 凭证 IPC、renderer WebRTC/realtime bridge、server event 标准化和 cleanup 幂等测试；真实 Electron/WebRTC 连接仍需 QA-002 验证。
9. `FE-001`：已实现设置页全局音频模型配置，包括 audio profile 列表/编辑、四类任务 assignment、能力 guard、MiMo/OpenAI/Realtime 默认模型和四语言 i18n。
10. `FE-002`：已实现工具入口、音频路由、共享全局配置摘要、四个页面占位和 `audio/tools/common` i18n 基线。
11. `FE-003`：已实现音频转文本页面，包括文件选择、OpenAI/MiMo 能力禁用、结果展示、输出目录、复制、打开目录和 ASR 取消 IPC；文件流式转写控件首版可见但禁用。
12. `FE-004`：已实现文本转音频页面，包括 OpenAI 非流式合成、MiMo 三模式参数、MiMo 流式 PCM16 播放、最终文件播放器、输出目录、打开目录和非流式/流式取消；真实供应商与 Electron 视觉仍需 QA-002 验证。
13. `FE-005`：已实现实时字幕页面，包括 OpenAI Realtime/WebRTC 字幕流、麦克风权限、partial/final 展示、复制/下载、页面卸载 cleanup，以及 MiMo/非 Realtime profile 的短 WAV 分块近实时转写契约；真实麦克风与供应商验收仍需 QA-002。
14. `FE-006`：已实现 Realtime/WebRTC 双向语音页面，包括 OpenAI Realtime 连接/断开、静音、打断回复、远端音轨绑定、user/assistant timeline 和页面卸载 cleanup；真实 Electron/WebRTC 验收仍需 QA-002。
15. `DOC-001`：已同步 README、CHANGELOG、隐私影响说明和发布文档台账，明确本地音频/麦克风内容会发送到用户选择的第三方音频 API。
16. `QA-001`、`QA-002`：仍待自动化回归补强和 Electron/真实供应商验收；MiMo `voicedesign/voiceclone` 低延迟实测、OpenAI Realtime/WebRTC 真实连接和麦克风/远端音轨播放必须在 QA 中记录。

## 16. 2026-07-10 审计后发布门禁

四个音频工具页初版实现完成后，`AUDIT-001` 对 renderer、共享 store、service、Electron IPC/runtime、供应商 adapter 与测试做了全链路复核。白屏问题已由 `FIX-001` 修复，但审计确认当前实现仍不能作为发布候选。

发布前按以下顺序收口：

1. `FIX-002`：收紧 preload / IPC 信任边界，main 持有运行时配置与文件授权，校验 sender、文件 token 和真实文件类型。
2. `FIX-003`：统一录音、WebRTC、请求控制器和上传队列的 ownership；错误、取消、断开和卸载都必须释放资源。
3. `FIX-004`：对齐 OpenAI Realtime GA 事件、voice/transcription 模型拆分、音频格式、manual commit/response 与 WebRTC buffer clear。
4. `FIX-005`：修复 TTS 流式播放、首尾帧、取消、状态与输出文件正确性。
5. `FIX-006`：修复 ASR/provider 参数矩阵和全局 Profile 默认值、保存与取消一致性。
6. `FIX-007`：完成四页 UX、可访问性、i18n、持久化迁移和响应式视觉 QA。

完整问题、证据、优先级和逐包验收口径见 `docs/v0.2.11/audio-toolkit/fix/2026-07-10_audio-toolkit-four-page-release-audit.md`。`FIX-002`～`FIX-007` 与 `QA-001` 已在 2026-07-11 闭环；仍不得把 fixture 或 Electron 路由矩阵解释为 `QA-002` 真实供应商/真实设备发布通过。
