# 工作包 PRE-001：音频契约、全局设置模型、能力矩阵与 fake server

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`PRE-001`

## 本次实现内容

- 新增音频领域类型契约，覆盖 `AudioApiDialect`、`AudioCapability`、`AudioModelProfile`、`AudioModelAssignment`、ASR/TTS/realtime request/result/event 相关类型。
- 新增 capability matrix 与 runtime config 解析 helper，明确工具页通过 `assignmentKey` 使用全局音频配置，不从工具页传 provider、API Key、base URL、dialect 或 model ID。
- 新增 audio IPC channel、result/error、请求校验、stream event 校验和 realtime event 校验。
- 新增 fake audio API server，支持 OpenAI `/audio/transcriptions`、`/audio/speech`、`/realtime/client_secrets`、MiMo `/chat/completions`、`/models`、二进制响应和 SSE fixture。
- 新增自动化测试覆盖 capability guard、IPC 防绕过校验、raw audio payload 拦截和 fake server 基础能力。

## 修改文件

- `src/type/audio.ts`
- `src/type/audioIpc.ts`
- `src/type/audioIpc.test.ts`
- `test/audio/audioCapability.test.ts`
- `test/audio/fakeAudioApiServer.ts`
- `test/audio/fakeAudioApiServer.test.ts`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`

## 接口或数据结构变化

- 新增 `AudioApiDialect = "openai_audio" | "mimo_chat_audio" | "openai_realtime"`。
- 新增全局音频 profile 与 assignment 类型：`AudioModelProfile`、`AudioModelAssignment`、`DEFAULT_AUDIO_MODEL_ASSIGNMENT`。
- 新增 `resolveAudioCapabilities()`、`validateAudioCapability()`、`resolveAudioRuntimeModelConfig()`。
- 新增 `AUDIO_IPC_CHANNELS`、`AUDIO_EVENT_CHANNELS`、`AudioIpcResult<T>`、`AudioIpcError`。
- 新增 IPC validation：`validateCreateAudioTranscriptionIpcRequest()`、`validateCreateSpeechSynthesisIpcRequest()`、`validateAudioRealtimeSessionIpcRequest()`、`validateRevealAudioOutputIpcRequest()`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- `node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts` 通过，3 个测试文件 / 18 个测试。
- `node_modules/.bin/tsc --noEmit` 通过。
- `git diff --check` 通过。
- 本次未启动 Vite、Electron 或其他前端服务。

## 未完成事项

- `PRE-001` 已闭环。
- 全局 store migration、设置页 UI、endpoint/file/stream 工具和具体 adapter 尚未开始。

## 下一步建议

- 下一步认领 `CORE-001`，实现 `fusionkit-model` v4 migration、`audioProfiles` / `audioAssignment`、audio profile CRUD、assignment guard 和 connection profile 引用校验。
