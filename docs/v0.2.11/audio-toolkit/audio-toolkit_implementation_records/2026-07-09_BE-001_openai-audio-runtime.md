# 工作包 BE-001：AudioRuntimeClient 骨架与 OpenAI 文件 ASR/TTS adapter

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`BE-001`

## 本次实现内容

- 新增 `AudioRuntimeClient` facade，提供 `sendAudioTranscription()` 与 `sendSpeechSynthesis()`，当前按 `openai_audio` dialect 路由到 OpenAI 文件 ASR/TTS adapter。
- 新增音频 HTTP helper，复用项目 proxy 设置，支持 timeout、AbortSignal、Retry-After、有限重试、HTTP 状态码分类和 API Key 脱敏。
- 新增 OpenAI Audio adapter：
  - ASR 使用 multipart 请求 `/audio/transcriptions`，发送 `file/model/language/prompt/response_format/temperature/timestamp_granularities[]/stream`。
  - ASR 解析 `json/text/srt/vtt/verbose_json`，支持 segments、words、rawJson/rawText，并可按请求写出 `.txt/.json/.srt/.vtt`。
  - TTS 使用 JSON 请求 `/audio/speech`，发送 `model/input/voice/instructions/response_format/speed`。
  - TTS 以 `arraybuffer` 接收二进制音频，写入本地输出文件，只返回 `outputPath/mimeType/responseFormat/sizeBytes/model/durationMs`。
- 补齐 `test/audio/audioRuntimeClient.test.ts`，覆盖 OpenAI ASR/TTS 成功路径、full endpoint 兼容、二进制落盘、401、429 retry、timeout、abort、空音频和 OpenAI 不支持 `pcm16` 的拦截。

## 修改文件

- `electron/main/audio/audio-runtime-client.ts`
- `electron/main/audio/audio-http.ts`
- `electron/main/audio/adapters/openai-audio-adapter.ts`
- `test/audio/audioRuntimeClient.test.ts`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口或数据结构变化

- 新增 runtime facade：
  - `sendAudioTranscription(request: AudioRuntimeTranscriptionRequest)`
  - `sendSpeechSynthesis(request: AudioRuntimeSpeechSynthesisRequest)`
- 新增 request option：
  - `timeoutMs`
  - `signal`
  - `proxy`
  - `retry`
  - `outputTempRoot`
  - `now`
- 新增 HTTP helper：
  - `runAudioRuntimeRequest()`
  - `createAudioHttpErrorFromResponse()`
  - `resolveAudioAxiosProxyConfig()`
  - `throwIfAudioRequestAborted()`

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/audio/audioRuntimeClient.test.ts
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- `node_modules/.bin/vitest run test/audio/audioRuntimeClient.test.ts` 通过，1 个测试文件 / 6 个测试。
- `node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts` 通过，10 个测试文件 / 55 个测试。
- `node_modules/.bin/tsc --noEmit` 通过。
- `git diff --check` 通过。
- 本次未启动 Vite、Electron 或其他前端服务。

## 未完成事项

- `BE-001` 已闭环。
- MiMo ASR/TTS 非流式 adapter、MiMo 三模型流式输出、IPC facade、Realtime session 和前端页面仍未开始。

## 下一步建议

- 下一步认领 `BE-002`，实现 MiMo ASR 与 MiMo TTS 三模式非流式 adapter，沿用本次新增的 HTTP helper、文件 data URI、输出写入和错误分类。
