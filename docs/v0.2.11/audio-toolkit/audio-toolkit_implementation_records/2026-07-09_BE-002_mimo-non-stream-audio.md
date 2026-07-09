# 工作包 BE-002：MiMo ASR 与 MiMo TTS 非流式 adapter

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`BE-002`

## 本次实现内容

- 新增 `mimo-chat-audio-adapter.ts`，将 `mimo_chat_audio` dialect 接入 `sendAudioTranscription()` 与 `sendSpeechSynthesis()` runtime facade。
- MiMo ASR：
  - 读取本地音频并构造 `data:<mime>;base64,<...>`。
  - 按 MiMo 文档发送 `POST /chat/completions`，使用 `api-key` header。
  - 请求体包含 `messages[].content[].input_audio.data` 与 `asr_options.language`。
  - 仅允许 `auto/zh/en` 语言和 `json/text` 输出，拦截 `prompt`、`srt/vtt/verbose_json`、timestamp 和 non-stream adapter 中的 `stream: true`。
- MiMo TTS 非流式：
  - 支持 `preset_voice`、`voice_design`、`voice_clone` 三种模式。
  - 预置音色映射 `audio.voice`，文本目标放入 `assistant` message，风格指令放入 `user` message。
  - 音色设计将 `voiceDesignPrompt` 映射为 `user` message，支持 `audio.optimize_text_preview`。
  - 音色复刻读取参考音频并将 `audio.voice` 构造为 data URI。
  - 非流式从 `choices[0].message.audio.data` 解码 WAV 并写入本地输出文件。
- 补齐 `audioRuntimeClient.test.ts` 的 MiMo 非流式覆盖：ASR request body、`api-key` 鉴权、TTS 三模式请求体与文件保存，以及语言/格式/prompt/timestamp/speed/stream/模型模式不匹配/缺少 prompt/缺少参考音频/参考格式不支持等 validation guard。

## 修改文件

- `electron/main/audio/audio-runtime-client.ts`
- `electron/main/audio/adapters/mimo-chat-audio-adapter.ts`
- `test/audio/audioRuntimeClient.test.ts`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口或数据结构变化

- `sendAudioTranscription()` 新增 `mimo_chat_audio` 分支。
- `sendSpeechSynthesis()` 新增 `mimo_chat_audio` 分支。
- 新增 adapter 方法：
  - `sendMimoAudioTranscription()`
  - `sendMimoSpeechSynthesis()`

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/audio/audioRuntimeClient.test.ts -t "MiMo non-stream"
node_modules/.bin/vitest run test/audio/audioRuntimeClient.test.ts
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- `node_modules/.bin/vitest run test/audio/audioRuntimeClient.test.ts -t "MiMo non-stream"` 通过，1 个测试文件 / 5 个 MiMo non-stream 测试。
- `node_modules/.bin/vitest run test/audio/audioRuntimeClient.test.ts` 通过，1 个测试文件 / 11 个测试。
- `node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts` 通过，10 个测试文件 / 60 个测试。
- `node_modules/.bin/tsc --noEmit` 通过。
- `git diff --check` 通过。
- 本次未启动 Vite、Electron 或其他前端服务。

## 未完成事项

- `BE-002` 已闭环。
- MiMo TTS 三模型流式低延迟输出、Audio IPC facade、Realtime session 和前端页面仍未开始。

## 下一步建议

- 下一步认领 `BE-003`，实现 MiMo TTS 三模型流式低延迟输出，优先复用本次 adapter 的请求体构造与 `test/audio/fakeAudioApiServer.ts` 的 SSE fixture。
