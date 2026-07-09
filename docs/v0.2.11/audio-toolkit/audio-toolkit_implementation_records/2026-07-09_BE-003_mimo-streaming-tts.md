# 工作包 BE-003：MiMo TTS 三模型流式低延迟输出

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`BE-003`

## 本次实现内容

- 在 `AudioRuntimeRequestOptions` 中新增 `requestId` 与 `onStreamEvent`，供 Electron IPC 后续桥接流式 TTS 事件。
- MiMo TTS adapter 支持 `stream: true` 分支，请求体强制 `audio.format = "pcm16"`，非流式仍保持 `wav`。
- 新增 MiMo SSE parser，解析 `choices[0].delta.audio.data`、文本 delta、`[DONE]`，并兼容最终 `choices[0].message.audio.data` 的 final-only 响应。
- Main runtime 内部将远端 Base64 chunk 解码为 PCM16 bytes，对外只发送 `pcmBytes`，完成后包装为 WAV 并返回 `streamStats`。
- 支持取消请求：Abort 后停止流读取，不写 completed 结果，并向 stream callback 发送统一 `aborted` error event。
- 增强 fake audio API server，使 streaming fixture 可配置 model 与逐事件延迟。
- 新增 MiMo streaming TTS 专项测试，覆盖 preset voice、voice design、voice clone、final-only fallback、取消请求和敏感数据不回传。

## 修改文件

- `electron/main/audio/audio-runtime-client.ts`
- `electron/main/audio/adapters/mimo-chat-audio-adapter.ts`
- `test/audio/fakeAudioApiServer.ts`
- `test/audio/audioRuntimeClient.test.ts`
- `test/audio/mimoStreamingTts.test.ts`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`

## 接口或数据结构变化

- `AudioRuntimeRequestOptions` 新增：
  - `requestId?: string`
  - `onStreamEvent?: (event: SpeechSynthesisStreamEvent) => void | Promise<void>`
- MiMo streaming TTS 返回：
  - `responseFormat: "pcm16"`
  - `mimeType: "audio/wav"`
  - `streamStats.sampleRate = 24000`
  - `streamStats.channels = 1`
  - `streamStats.streamMode = "incremental" | "final_only"`
- MiMo streaming TTS validation：
  - `stream === true` 时仅允许 `responseFormat = "pcm16"`。
  - 非流式仅允许 `responseFormat = "wav"`。
  - 继续禁止 OpenAI-only `speed`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/audio/mimoStreamingTts.test.ts
node_modules/.bin/vitest run test/audio/fakeAudioApiServer.test.ts test/audio/audioRuntimeClient.test.ts
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- `test/audio/mimoStreamingTts.test.ts` 通过，1 file / 5 tests。
- `test/audio/fakeAudioApiServer.test.ts test/audio/audioRuntimeClient.test.ts` 通过，2 files / 15 tests。
- 全量音频相关测试通过，11 files / 65 tests。
- TypeScript `--noEmit` 通过。
- `git diff --check` 通过。

## 未完成事项

- 本轮未启动 Vite/Electron 前端服务，也未做 Electron UI 验收。
- 真实 MiMo `mimo-v2.5-tts-voicedesign`、`mimo-v2.5-tts-voiceclone` 是否具备低延迟增量音频仍需 QA-002 使用真实供应商 API 验证。当前 runtime 已能标记 `final_only`，设置页后续需要把真实验收状态展示为 verified/degraded/failed。

## 下一步建议

- 下一步认领 `BE-004`：注册 Audio IPC、stream event 与 renderer service facade，将本轮新增的 `onStreamEvent` 接到 `audio:speech-synthesis-stream`。
- BE-004 需要保持工具页不传 provider/API key/base URL/dialect/model ID，只从全局 audio assignment 解析 runtime model config。
