# 工作包 CORE-002：Endpoint、文件、输出与流式音频工具

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`CORE-002`

## 本次实现内容

- 新增 `normalizeAudioEndpoint()`，支持从 base URL 或 `/chat/completions`、`/audio/speech`、`/audio/transcriptions`、`/realtime/client_secrets`、`/realtime/calls`、`/models` 完整端点派生音频相关 endpoint。
- 新增音频文件基础工具，覆盖 MIME/扩展名推断、OpenAI/MiMo dialect allow list、OpenAI 25MB 上传限制、MiMo Base64 后 10MB 限制、data URI 读取、输出目录选择、输出文件名 hint 和 `-1/-2` 冲突规避。
- 新增 PCM16/WAV 工具，支持 24kHz mono 默认配置、自定义采样率/声道、WAV header 包装、WAV 文件写入和 stream stats 计算。
- 新增 `AudioRuntimeClientError` 与错误详情脱敏，隐藏 API Key、Authorization、data URI/Base64 音频、request body、PCM/buffer chunk，同时保留安全的数字大小元数据供 UI 提示使用。
- 补齐 `audioFile`、`audioStream`、`audioErrors` 单测，并将 `CORE-002` 纳入前置音频测试矩阵。

## 修改文件

- `src/lib/audio-endpoint.ts`
- `src/lib/audio-endpoint.test.ts`
- `electron/main/audio/audio-file.ts`
- `electron/main/audio/audio-stream.ts`
- `electron/main/audio/audio-errors.ts`
- `test/audio/audioFile.test.ts`
- `test/audio/audioStream.test.ts`
- `test/audio/audioErrors.test.ts`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口或数据结构变化

- 新增 `NormalizedAudioEndpoint` 与 `normalizeAudioEndpoint()`。
- 新增音频文件常量与 helper：
  - `AUDIO_MAX_UPLOAD_BYTES`
  - `MIMO_MAX_BASE64_AUDIO_BYTES`
  - `inferAudioMimeType()`
  - `resolveAudioInputFile()`
  - `readAudioFileAsDataUri()`
  - `resolveAudioOutputPath()`
  - `writeAudioOutputFile()`
  - `ensureUniqueOutputPath()`
- 新增 PCM/WAV helper：
  - `createPcm16WavBuffer()`
  - `writePcm16WavFile()`
  - `createAudioStreamStats()`
- 新增错误 helper：
  - `AudioRuntimeClientError`
  - `createAudioRuntimeError()`
  - `sanitizeAudioErrorDetails()`

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/lib/audio-endpoint.test.ts test/audio/audioFile.test.ts test/audio/audioStream.test.ts test/audio/audioErrors.test.ts
node_modules/.bin/vitest run src/lib/audio-endpoint.test.ts test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- `node_modules/.bin/vitest run src/lib/audio-endpoint.test.ts test/audio/audioFile.test.ts test/audio/audioStream.test.ts test/audio/audioErrors.test.ts` 通过，4 个测试文件 / 21 个测试。
- `node_modules/.bin/vitest run src/lib/audio-endpoint.test.ts test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts` 通过，9 个测试文件 / 49 个测试。
- `node_modules/.bin/tsc --noEmit` 通过。
- `git diff --check` 通过。
- 本次未启动 Vite、Electron 或其他前端服务。

## 未完成事项

- `CORE-002` 已闭环。
- 具体 OpenAI/MiMo adapter、IPC runtime facade、Realtime session 和前端页面仍未开始。

## 下一步建议

- 下一步认领 `BE-001`，实现 `AudioRuntimeClient` 骨架与 OpenAI 文件 ASR/TTS adapter，优先形成 OpenAI 官方音频 API 的基准路径。
