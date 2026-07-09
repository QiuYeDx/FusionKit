# 工作包 BE-004：Audio IPC、stream event 与 renderer service facade

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`BE-004`

## 本次实现内容

- 扩展 `src/type/audioIpc.ts`：
  - 新增 `audio:sync-runtime-config`，用于 renderer 从全局设置 store 同步音频运行时配置快照到 main 内存。
  - 新增 `audio:cancel-speech-synthesis-stream`，支持按 `requestId` 取消流式 TTS。
  - 新增 stream wrapper request、cancel request、reveal result 与 sync result 类型。
  - 保持普通任务 payload 校验禁止 provider/API key/base URL/dialect/model ID/raw audio/Base64/PCM 字段。
- 新增 `electron/main/audio/ipc.ts`：
  - 注册 transcribe、synthesize speech、stream synthesize、cancel stream、reveal output 和 sync runtime config IPC。
  - 通过内存态全局音频配置快照解析 `AudioRuntimeModelConfig`，再调用 runtime adapter。
  - 将 BE-003 的 `onStreamEvent` 桥接为 `audio:speech-synthesis-stream` event。
  - 管理流式请求的 `AbortController`，支持取消后停止 runtime。
- 在 `electron/main/index.ts` 注册 `setupAudioIPC()`。
- 新增 renderer service facade：
  - `audioRuntimeConfigService.ts`：从 `useModelStore` 同步全局音频配置快照，集中封装 `invokeAudioIpc`。
  - `audioTranscriptionService.ts`：封装音频转文本与 reveal output。
  - `speechSynthesisService.ts`：封装非流式 TTS、流式 TTS 事件订阅、取消和 requestId 管理。
- 新增测试覆盖 IPC contract、main service、renderer service。

## 修改文件

- `src/type/audioIpc.ts`
- `src/type/audioIpc.test.ts`
- `electron/main/audio/ipc.ts`
- `electron/main/index.ts`
- `src/services/audio/audioRuntimeConfigService.ts`
- `src/services/audio/audioTranscriptionService.ts`
- `src/services/audio/speechSynthesisService.ts`
- `src/services/audio/audioServices.test.ts`
- `test/audio/audioIpcService.test.ts`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`

## 接口或数据结构变化

- 新增 IPC command：
  - `audio:sync-runtime-config`
  - `audio:cancel-speech-synthesis-stream`
- 新增 result/request：
  - `SyncAudioRuntimeConfigRequest`
  - `SyncAudioRuntimeConfigResult`
  - `CreateSpeechSynthesisStreamIpcRequest`
  - `CancelSpeechSynthesisStreamRequest`
  - `CancelSpeechSynthesisStreamResult`
  - `RevealAudioOutputResult`
- 新增 `AudioIpcErrorCode`：
  - `connection_profile_not_configured`
  - `audio_model_not_configured`
- `SpeechSynthesisStreamEvent.audio_delta` 对外只允许 `pcmBytes: Uint8Array`，不允许 `pcmBase64`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/type/audioIpc.test.ts test/audio/audioIpcService.test.ts src/services/audio/audioServices.test.ts
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- BE-004 专项测试通过，3 files / 15 tests。
- 全量音频相关测试通过，13 files / 72 tests。
- TypeScript `--noEmit` 通过。
- `git diff --check` 通过。

## 未完成事项

- 本轮未启动 Vite/Electron 前端服务，也未做 Electron UI 验收。
- `audio:sync-runtime-config` 目前由 renderer service 在任务调用前同步；后续 `FE-001` 或应用入口可在设置页保存/启动时主动同步，减少首次任务前的延迟。
- Realtime/WebRTC 相关 IPC 仍留给 `BE-005`。

## 下一步建议

- 下一步认领 `BE-005`：实现 Realtime session runtime 与 OpenAI WebRTC bridge，重点覆盖 ephemeral session 创建、长期 API key 不进入 renderer、session cleanup 和错误映射。
