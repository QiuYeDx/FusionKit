# 音频工具箱 Execution Plan

> 日期：2026-07-09
> Feature Slug：`audio-toolkit`
> 对应设计文档：`docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
> 当前状态：`PRE-001`、`CORE-001`、`CORE-002`、`BE-001`、`BE-002`、`BE-003`、`BE-004`、`BE-005`、`FE-001`、`FE-002`、`FE-003`、`FE-004`、`FE-005`、`FE-006`、`DOC-001` 已完成；开发与发布文档工作包已闭环，后续进入 QA

---

## 1. 每次开发会话的使用方式

每次实现会话开始前，Agent 必须：

1. 阅读 `docs/v0.2.11/README.md`。
2. 阅读 `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`。
3. 阅读本执行计划。
4. 检查第 5 节进度台账，认领一个最小可闭环工作包。
5. 检查 `git status --short`，保留用户已有改动，不回滚无关文件。
6. 如果要运行 `pnpm`，先确认版本为项目兼容的 8.x；不要用当前环境过新的 pnpm 改写 lockfile v6。
7. 如果需要启动 Vite、Electron、Playwright Electron 或其他前端服务，记录进程，并在最终回复前关闭。

每次实现会话结束前必须：

1. 运行该工作包列出的验证，或准确记录无法运行的原因。
2. 更新第 5 节进度台账。
3. 在 `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/` 新增实施记录。
4. 只有代码、测试、文档、台账和验证均闭环时，才把工作包标为 `已完成`。
5. 如实现证明 Final Design 假设不成立，先更新 Final Design 或补充 `feat/` / `fix/` 文档，不能静默偏离。
6. 回答用户前关闭本次启动的全部前端服务进程，并检查无遗留。

## 2. 状态规则

工作包状态只允许使用：

- `未开始`
- `进行中`
- `已完成`
- `阻塞`
- `废弃`

状态解释：

- `未开始`：尚未认领，或只做过不改变代码/文档契约的阅读。
- `进行中`：已有实现或验证工作，但尚未满足完整验收口径。
- `已完成`：实现、测试、文档、台账和实施记录均闭环。
- `阻塞`：存在明确外部阻塞，当前会话无法继续推进。
- `废弃`：设计更新后明确不再实施，必须记录替代方案或原因。

## 3. 推进原则

### 3.1 依赖优先级

按以下顺序推进：

1. 先冻结音频 API 契约、全局设置数据结构、能力矩阵、IPC 校验和 fake server，避免后续页面和 adapter 重复理解 MiMo/OpenAI 差异。
2. 再实现全局音频 profile、assignment、设置页管理和 store migration，因为工具页不得拥有独立 API 生效配置。
3. 完成 endpoint normalization、文件读写、输出命名、流式 PCM/WAV、错误分类等共享基础能力。
4. 打通 OpenAI 文件 ASR/TTS 非流式路径，形成可对照的基准。
5. 打通 MiMo ASR/TTS 非流式路径，再扩展 MiMo 三模型 TTS 流式低延迟输出。
6. 实现 OpenAI Realtime ephemeral session、WebRTC/realtime event bridge，再做实时字幕和双向语音 UI。
7. 前端按设置页、入口路由、文件 ASR、TTS、实时字幕、双向语音的顺序推进。
8. 最后做自动化回归、Electron 手工验收、真实供应商验收和发布文档同步。

### 3.2 首版发布最小闭环

首版发布前必须具备：

```text
设置页创建/选择全局音频 Profile
  -> 为音频转文本、文本转音频、实时字幕、双向语音设置全局 assignment
  -> 工具页只读消费全局配置，不保存 provider/API Key/base URL/dialect/model ID
  -> OpenAI 文件 ASR/TTS 可用
  -> MiMo ASR 可用
  -> MiMo TTS 三模式非流式和流式输出可用
  -> 实时麦克风字幕可用
  -> OpenAI Realtime/WebRTC 双向语音可用
  -> API Key、Base64、PCM chunk 不进入日志、持久化或错误详情
```

首版仍不要求：

- 批量长音频切片。
- 说话人分离。
- 多人时间轴编辑器。
- 本地离线 ASR/TTS。
- MiMo 原生 WebRTC 双向语音，除非后续文档提供该接口。

### 3.3 不得违反的设计约束

- 音频大模型 API 的生效选择必须在设置页全局管理；工具页不得保存独立 provider、API Key、base URL、dialect、ASR/TTS/realtime 模型 ID。
- 工具页只允许保存任务输入和临时参数，例如文件路径、文本、输出目录、语言、voice、MiMo 音色描述、参考音频路径。
- FusionKit 内部音频请求以 OpenAI 官方音频 API 字段为主契约；MiMo adapter 负责转换。
- `ModelProfile.apiFormat` 不代表音频协议；音频协议必须使用 `AudioApiDialect = "openai_audio" | "mimo_chat_audio" | "openai_realtime"`。
- MiMo TTS 三个模型必须同页支持，且三者都接入流式输出：`mimo-v2.5-tts`、`mimo-v2.5-tts-voicedesign`、`mimo-v2.5-tts-voiceclone`。
- MiMo 流式输出使用 `stream: true` 与 `audio.format = "pcm16"`；renderer 播放 PCM16 chunk，完成后保存为 WAV 或用户选择格式。
- MiMo-only 字段必须有可见提示；非 MiMo dialect 下必须禁用音色设计、音色复刻、音频标签、`optimize_text_preview` 等控件。
- OpenAI-only 字段必须按能力禁用；MiMo ASR 下不得启用 `srt/vtt/verbose_json/timestamp_granularities/prompt`。
- Realtime/WebRTC 双向语音只对具备 `realtime_duplex_voice` capability 的 profile 启用；MiMo Chat Audio 不得伪装为原生 WebRTC。
- MiMo 鉴权首版按文档使用 `api-key` header；OpenAI 使用 `Authorization: Bearer`。
- OpenAI Realtime 长期 API Key 只能在 Electron main 使用；renderer 只能拿 ephemeral credentials。
- 不把音频文件内容、生成音频 Base64、PCM chunk、API Key、Authorization、`api-key` header 或完整 request body 写入 Zustand 持久化、日志、任务恢复文件或错误详情。
- 用户可见文案必须同步 `src/locales/*`，并运行 `node scripts/check-i18n.mjs`。
- 不新增依赖，除非工作包明确记录理由并使用项目兼容 pnpm 8.x 流程。

## 4. 阶段与里程碑

| 里程碑 | 达成条件 |
| --- | --- |
| M0 协议与配置基线冻结 | `PRE-001` 完成，音频契约、全局设置数据结构、能力矩阵、IPC 校验和 fake server 可复用 |
| M1 全局设置可用 | `CORE-001`、`FE-001` 完成，设置页能创建音频 profile 并设置四类 assignment |
| M2 共享基础闭环 | `CORE-002` 完成，endpoint、文件读写、输出命名、流式 PCM/WAV 和错误类型稳定 |
| M3 文件 ASR/TTS 闭环 | `BE-001`、`BE-002`、`FE-003`、`FE-004` 完成，OpenAI/MiMo 文件 ASR/TTS 可用 |
| M4 流式与实时闭环 | `BE-003`、`BE-004`、`BE-005`、`FE-005`、`FE-006` 完成，MiMo 流式 TTS、实时字幕、双向语音可用 |
| M5 发布候选 | `QA-001`、`QA-002`、`DOC-001` 完成，自动化、Electron 手工验收、真实供应商验收和文档同步闭环 |

## 5. 进度台账

| ID | 状态 | 完成日期 | 标题 | 关键变更文件 | 验证 | 实施记录 | 未决问题 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PRE-001 | 已完成 | 2026-07-09 | 音频契约、全局设置模型、能力矩阵与 fake server | `src/type/audio.ts`、`src/type/audioIpc.ts`、`src/type/audioIpc.test.ts`、`test/audio/audioCapability.test.ts`、`test/audio/fakeAudioApiServer.ts`、`test/audio/fakeAudioApiServer.test.ts` | `node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts` 通过，3 files / 18 tests；`node_modules/.bin/tsc --noEmit` 通过；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_PRE-001_audio-contracts.md` | 无 |
| CORE-001 | 已完成 | 2026-07-09 | 全局音频 profile、assignment 与 store migration | `src/lib/audio-profile.ts`、`src/lib/audio-profile.test.ts`、`src/store/useModelStore.ts`、`src/store/useModelStore.test.ts` | `node_modules/.bin/vitest run src/store/useModelStore.test.ts src/lib/audio-profile.test.ts test/audio src/type/audioIpc.test.ts` 通过，5 files / 28 tests；`node_modules/.bin/tsc --noEmit` 通过；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_CORE-001_audio-model-store.md` | 删除被 audio profile 引用的 connection profile 时 store 会阻止删除，后续设置页需显示提示 |
| CORE-002 | 已完成 | 2026-07-09 | Endpoint、文件、输出与流式音频工具 | `src/lib/audio-endpoint.ts`、`src/lib/audio-endpoint.test.ts`、`electron/main/audio/audio-file.ts`、`electron/main/audio/audio-stream.ts`、`electron/main/audio/audio-errors.ts`、`test/audio/audioFile.test.ts`、`test/audio/audioStream.test.ts`、`test/audio/audioErrors.test.ts` | `node_modules/.bin/vitest run src/lib/audio-endpoint.test.ts test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts` 通过，9 files / 49 tests；`node_modules/.bin/tsc --noEmit` 通过；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_CORE-002_audio-foundation.md` | 无 |
| BE-001 | 已完成 | 2026-07-09 | AudioRuntimeClient 骨架与 OpenAI 文件 ASR/TTS adapter | `electron/main/audio/audio-runtime-client.ts`、`electron/main/audio/audio-http.ts`、`electron/main/audio/adapters/openai-audio-adapter.ts`、`test/audio/audioRuntimeClient.test.ts` | `node_modules/.bin/vitest run test/audio/audioRuntimeClient.test.ts` 通过，1 file / 6 tests；`node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts` 通过，10 files / 55 tests；`node_modules/.bin/tsc --noEmit` 通过；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_BE-001_openai-audio-runtime.md` | 无 |
| BE-002 | 已完成 | 2026-07-09 | MiMo ASR 与 MiMo TTS 非流式 adapter | `electron/main/audio/audio-runtime-client.ts`、`electron/main/audio/adapters/mimo-chat-audio-adapter.ts`、`test/audio/audioRuntimeClient.test.ts`、`test/audio/fakeAudioApiServer.ts` | `node_modules/.bin/vitest run test/audio/audioRuntimeClient.test.ts -t "MiMo non-stream"` 通过，1 file / 5 tests；`node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts` 通过，10 files / 60 tests；`node_modules/.bin/tsc --noEmit` 通过；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_BE-002_mimo-non-stream-audio.md` | 无 |
| BE-003 | 已完成 | 2026-07-09 | MiMo TTS 三模型流式低延迟输出 | `electron/main/audio/audio-runtime-client.ts`、`electron/main/audio/adapters/mimo-chat-audio-adapter.ts`、`test/audio/fakeAudioApiServer.ts`、`test/audio/audioRuntimeClient.test.ts`、`test/audio/mimoStreamingTts.test.ts` | `node_modules/.bin/vitest run test/audio/mimoStreamingTts.test.ts` 通过，1 file / 5 tests；`node_modules/.bin/vitest run test/audio/fakeAudioApiServer.test.ts test/audio/audioRuntimeClient.test.ts` 通过，2 files / 15 tests；`node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts` 通过，11 files / 65 tests；`node_modules/.bin/tsc --noEmit` 通过；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_BE-003_mimo-streaming-tts.md` | 代码侧已支持三模型 stream 与 final-only 标记；真实 `voicedesign/voiceclone` 是否低延迟仍需 QA-002 实测，当前官方文档提示可能降级为 final-only 时设置页必须显示 degraded |
| BE-004 | 已完成 | 2026-07-09 | Audio IPC、stream event 与 renderer service facade | `src/type/audioIpc.ts`、`electron/main/audio/ipc.ts`、`electron/main/index.ts`、`src/services/audio/audioRuntimeConfigService.ts`、`src/services/audio/audioTranscriptionService.ts`、`src/services/audio/speechSynthesisService.ts`、`src/type/audioIpc.test.ts`、`test/audio/audioIpcService.test.ts`、`src/services/audio/audioServices.test.ts` | `node_modules/.bin/vitest run src/type/audioIpc.test.ts test/audio/audioIpcService.test.ts src/services/audio/audioServices.test.ts` 通过，3 files / 15 tests；`node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts` 通过，13 files / 72 tests；`node_modules/.bin/tsc --noEmit` 通过；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_BE-004_audio-ipc-services.md` | 新增全局音频配置内存同步 channel，FE-001/应用入口后续需在设置变更或应用启动时调用 sync；普通任务 IPC 仍禁止 API config 字段 |
| BE-005 | 已完成 | 2026-07-09 | Realtime session runtime 与 OpenAI WebRTC bridge | `src/type/audioIpc.ts`、`electron/main/audio/audio-runtime-config.ts`、`electron/main/audio/audio-ipc-errors.ts`、`electron/main/audio/realtime-ipc.ts`、`electron/main/audio/realtime/openai-realtime-adapter.ts`、`electron/main/index.ts`、`src/services/audio/audioRealtimeService.ts`、`test/audio/audioRealtimeSession.test.ts`、`src/services/audio/audioServices.test.ts` | `node_modules/.bin/vitest run test/audio/audioRealtimeSession.test.ts src/services/audio/audioServices.test.ts` 通过，2 files / 9 tests；`node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts` 通过，14 files / 79 tests；`node_modules/.bin/tsc --noEmit` 通过；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_BE-005_realtime-session-runtime.md` | Electron WebRTC 真实连接、麦克风权限和远端音轨播放仍在 QA-002 验证；当前自动化覆盖 session contract、ephemeral request、MiMo WebRTC guard、错误脱敏与 cleanup 幂等 |
| FE-001 | 已完成 | 2026-07-09 | 设置页全局音频模型配置 | `src/pages/Setting/components/AudioModelConfig.tsx`、`src/pages/Setting/components/ModelConfig.tsx`、`src/locales/*/setting.json` | `node_modules/.bin/tsc --noEmit` 通过；`node scripts/check-i18n.mjs` 通过，setting 178 keys x 4 locales；`node_modules/.bin/vitest run src/store/useModelStore.test.ts src/lib/audio-profile.test.ts test/audio/audioCapability.test.ts` 通过，3 files / 16 tests；`node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts` 通过，14 files / 79 tests；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_FE-001_audio-model-settings.md` | 未启动 Electron 做视觉验收；后续 FE-003 进入页面后建议人工复核设置页滚动弹窗、长模型名与移动宽度 |
| FE-002 | 已完成 | 2026-07-09 | 工具入口、路由、共享状态与 i18n 基线 | `src/pages/Tools/_shared/toolMeta.ts`、`src/pages/Tools/index.tsx`、`src/App.tsx`、`src/constants/router.ts`、`src/store/tools/audio/audioToolConfig.ts`、`src/pages/Tools/Audio/*`、`src/i18n/*`、`src/locales/*/{audio,tools,common}.json` | `node -e` JSON 解析通过；`node_modules/.bin/vitest run src/store/tools/audio/audioToolConfig.test.ts` 通过，1 file / 3 tests；`node_modules/.bin/tsc --noEmit` 通过；`node scripts/check-i18n.mjs` 通过，audio/tools/common 四语言对齐；`node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts` 通过，15 files / 82 tests；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_FE-002_audio-tool-entry-routes.md` | 页面为后续 FE-003 至 FE-006 的入口与配置摘要基线，具体 ASR/TTS/realtime 交互仍未实现 |
| FE-003 | 已完成 | 2026-07-09 | 音频转文本页面 | `src/pages/Tools/Audio/AudioTranscriber/index.tsx`、`src/pages/Tools/Audio/shared/AudioToolShell.tsx`、`src/store/tools/audio/useAudioTranscriberStore.ts`、`src/store/tools/audio/audioTranscriberConfig.ts`、`src/store/tools/audio/audioTranscriberConfig.test.ts`、`src/locales/*/audio.json`、`src/type/audio.ts`、`src/type/audioIpc.ts`、`electron/main/audio/ipc.ts`、`src/services/audio/audioTranscriptionService.ts` | `node -e` JSON 解析通过；`node_modules/.bin/vitest run src/store/tools/audio/audioTranscriberConfig.test.ts src/type/audioIpc.test.ts test/audio/audioIpcService.test.ts src/services/audio/audioServices.test.ts` 通过，4 files / 26 tests；`node_modules/.bin/tsc --noEmit` 通过；`node scripts/check-i18n.mjs` 通过，audio 108 keys x 4 locales；`node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/audioTranscriberConfig.test.ts` 通过，16 files / 90 tests；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_FE-003_audio-transcriber-page.md` | 未启动 Electron 做视觉验收；文件 ASR 真实供应商路径仍需 QA-002，文件流式转写控件首版可见但禁用，避免后端未实现流式 ASR 时误导用户 |
| FE-004 | 已完成 | 2026-07-09 | 文本转音频页面与流式播放 | `src/pages/Tools/Audio/SpeechSynthesizer/index.tsx`、`src/pages/Tools/Audio/shared/pcm16StreamPlayer.ts`、`src/store/tools/audio/useSpeechSynthesizerStore.ts`、`src/store/tools/audio/speechSynthesizerConfig.ts`、`src/store/tools/audio/speechSynthesizerConfig.test.ts`、`src/locales/*/audio.json`、`src/type/audio.ts`、`src/type/audioIpc.ts`、`electron/main/audio/ipc.ts`、`src/services/audio/speechSynthesisService.ts` | `node -e` JSON 解析通过；`node_modules/.bin/vitest run src/store/tools/audio/speechSynthesizerConfig.test.ts src/type/audioIpc.test.ts test/audio/audioIpcService.test.ts src/services/audio/audioServices.test.ts` 通过，4 files / 30 tests；`node_modules/.bin/tsc --noEmit` 通过；`node scripts/check-i18n.mjs` 通过，audio 204 keys x 4 locales；`node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/audioTranscriberConfig.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts` 通过，17 files / 99 tests；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_FE-004_speech-synthesizer-page.md` | 未启动 Electron 做视觉验收；OpenAI/MiMo 真实 TTS 与三模式低延迟流式仍需 QA-002 验证 |
| FE-005 | 已完成 | 2026-07-09 | 实时字幕页面 | `src/pages/Tools/Audio/RealtimeCaptions/index.tsx`、`src/pages/Tools/Audio/shared/wavChunkRecorder.ts`、`src/store/tools/audio/useRealtimeCaptionsStore.ts`、`src/store/tools/audio/realtimeCaptionsConfig.ts`、`src/store/tools/audio/realtimeCaptionsConfig.test.ts`、`src/services/audio/audioRealtimeService.ts`、`src/type/audioIpc.ts`、`electron/main/audio/ipc.ts`、`src/locales/*/audio.json` | `node -e` JSON 解析通过；`node_modules/.bin/vitest run src/type/audioIpc.test.ts test/audio/audioIpcService.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/realtimeCaptionsConfig.test.ts` 通过，4 files / 33 tests；`node_modules/.bin/tsc --noEmit` 通过；`node scripts/check-i18n.mjs` 通过，audio 275 keys x 4 locales；`node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/audioTranscriberConfig.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts src/store/tools/audio/realtimeCaptionsConfig.test.ts` 通过，18 files / 107 tests；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_FE-005_realtime-captions-page.md` | 未启动 Electron 做麦克风/WebRTC 视觉验收；OpenAI Realtime 与 MiMo/分块近实时真实供应商验收仍需 QA-002 |
| FE-006 | 已完成 | 2026-07-09 | Realtime/WebRTC 双向语音页面 | `src/pages/Tools/Audio/RealtimeVoice/index.tsx`、`src/store/tools/audio/useRealtimeVoiceStore.ts`、`src/store/tools/audio/realtimeVoiceConfig.ts`、`src/store/tools/audio/realtimeVoiceConfig.test.ts`、`src/services/audio/audioRealtimeService.ts`、`src/locales/*/audio.json` | `node -e` JSON 解析通过；`node_modules/.bin/vitest run src/store/tools/audio/realtimeVoiceConfig.test.ts src/services/audio/audioServices.test.ts test/audio/audioRealtimeSession.test.ts` 通过，3 files / 17 tests；`node_modules/.bin/tsc --noEmit` 通过；`node scripts/check-i18n.mjs` 通过，audio 329 keys x 4 locales；`node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/audioTranscriberConfig.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts src/store/tools/audio/realtimeCaptionsConfig.test.ts src/store/tools/audio/realtimeVoiceConfig.test.ts` 通过，19 files / 110 tests；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_FE-006_realtime-voice-page.md` | 未启动 Electron 做真实 WebRTC/麦克风/远端音轨验收；仍需 QA-002 |
| QA-001 | 未开始 | — | 自动化回归矩阵 | `test/audio/*`、`src/type/audioIpc.test.ts`、`src/store/useModelStore.test.ts`、必要的页面纯函数测试 | `node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts`；`node_modules/.bin/tsc --noEmit`；`node scripts/check-i18n.mjs`；`git diff --check` | — | 覆盖成功、空响应、鉴权失败、限流、重试、超时、取消、文件过大、stream final-only |
| QA-002 | 未开始 | — | Electron 与真实供应商手工验收 | 验收记录、必要时 `docs/v0.2.11/audio-toolkit/fix/*` | OpenAI ASR/TTS、MiMo ASR、MiMo TTS 三模式非流式/流式、实时字幕、OpenAI Realtime 双向语音；如启动服务需结束前清理 | — | 真实 API Key 不得写入日志或文档 |
| DOC-001 | 已完成 | 2026-07-09 | README、CHANGELOG、隐私说明与发布文档同步 | `README.md`、`CHANGELOG.md`、`docs/v0.2.11/README.md`、`docs/v0.2.11/v0.2.11_iteration_execution_plan.md`、`docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`、`docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md` | `node_modules/.bin/tsc --noEmit` 通过；`node scripts/check-i18n.mjs` 通过；`node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/audioTranscriberConfig.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts src/store/tools/audio/realtimeCaptionsConfig.test.ts src/store/tools/audio/realtimeVoiceConfig.test.ts` 通过，19 files / 110 tests；`git diff --check` 通过 | `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_DOC-001_audio-release-docs.md` | 无；README/CHANGELOG 已说明本地音频文件、录音片段和麦克风内容会发送到用户选择的第三方音频 API，真实供应商验收仍归 QA-002 |

## 6. 工作包详情

### PRE-001：音频契约、全局设置模型、能力矩阵与 fake server

目标：在正式实现 adapter 和页面前，固定 FusionKit 内部音频契约、全局设置结构与供应商差异。

实施范围：

- 新增 `src/type/audio.ts`，定义 `AudioApiDialect`、`AudioCapability`、`AudioModelProfile`、`AudioModelAssignment`、ASR/TTS/realtime request/result/event、MiMo TTS mode/options。
- 新增 `src/type/audioIpc.ts`，定义 IPC channel、stream event、realtime event、result/error code、request validation。
- 新增 capability matrix 纯函数，例如 `resolveAudioCapabilities()`、`validateAudioCapability()`、`resolveAudioRuntimeModelConfig()`。
- 新增 `test/audio/fakeAudioApiServer.ts`，支持 OpenAI `/v1/audio/transcriptions`、OpenAI `/v1/audio/speech`、OpenAI realtime ephemeral session、MiMo `/v1/chat/completions`、SSE/streaming fixture。
- 固定 OpenAI ASR/TTS、MiMo ASR/TTS、MiMo streaming TTS、Realtime session 的成功、空响应、鉴权失败、限流、5xx、无效响应 fixture。

验收口径：

- fake server 不访问真实网络。
- request validation 能阻止工具页绕过全局 assignment。
- request validation 能阻止 MiMo-only 字段进入 OpenAI adapter，也能阻止 OpenAI-only 字段进入 MiMo adapter。
- 关键类型可被 Renderer、Electron main 和测试共同引用。

### CORE-001：全局音频 profile、assignment 与 store migration

目标：让设置页成为音频大模型 API 配置的唯一生效来源。

实施范围：

- `fusionkit-model` store 从 version 3 迁移到 version 4，新增 `audioProfiles`、`audioAssignment`。
- 新增 audio profile CRUD action、assignment action、connection profile 引用校验。
- 删除或更新被引用的 connection profile 时，阻止产生悬空 audio profile。
- 新增 helper：从 `AudioAssignmentKey` 解析 `AudioRuntimeModelConfig`。
- 补齐迁移测试：老数据、空数据、audio profile 引用、assignment reset。

验收口径：

- 旧文本模型配置迁移后不丢失。
- 没有音频 profile 时工具页能得到明确未配置状态。
- 工具页无法通过本地状态覆盖全局 provider/base URL/API Key/model ID。

### CORE-002：Endpoint、文件、输出与流式音频工具

目标：统一音频 endpoint、MIME 推断、文件大小限制、输出路径、PCM/WAV 流式处理和错误类型。

实施范围：

- 新增 `normalizeAudioEndpoint()`，兼容 base URL、`/audio/speech`、`/audio/transcriptions`、`/chat/completions`、`/realtime/client_secrets`。
- 新增音频 MIME/扩展名映射，OpenAI 与 MiMo 分别有允许列表。
- 新增文件大小限制常量：MiMo Base64 后 10MB，OpenAI 默认建议 25MB。
- 新增输出文件命名和冲突规避工具，默认追加 `-1/-2`，不覆盖已有文件。
- 新增 PCM16 chunk 写入、WAV header 包装、流式播放 metadata 计算。
- 新增 `AudioRuntimeClientError` 或等价错误映射，保持 API Key 脱敏。

验收口径：

- endpoint 测试覆盖 trailing slash、full endpoint、空值和 MiMo/OpenAI/Realtime base URL。
- 文件工具测试覆盖 `wav/mp3/m4a/flac/ogg/webm/mp4/mpeg` 推断和 MiMo 只允许 `wav/mp3`。
- PCM16 到 WAV 输出能被基础解析器识别采样率、声道、数据长度。
- 错误详情不包含 API Key、Base64 音频、PCM chunk 或完整 request body。

### BE-001：AudioRuntimeClient 骨架与 OpenAI 文件 ASR/TTS adapter

目标：打通 OpenAI 官方 Audio ASR/TTS 的文件最小闭环。

实施范围：

- 新增 `sendAudioTranscription()`、`sendSpeechSynthesis()` runtime facade。
- OpenAI ASR adapter 发送 multipart `/audio/transcriptions`，解析 `json/text/srt/vtt/verbose_json`。
- OpenAI TTS adapter 发送 JSON `/audio/speech`，以 `arraybuffer` 或 streaming reader 接收并写入本地音频。
- 支持 timeout、AbortSignal、proxy、Retry-After、HTTP 错误分类。
- 不把二进制音频传回 Renderer，只返回 output path 和 metadata。

验收口径：

- fake server 覆盖 ASR/TTS 成功路径。
- 401/403/429/5xx、空响应、超时、取消都映射到统一错误。
- 生成音频文件可读，sizeBytes 正确。

### BE-002：MiMo ASR 与 MiMo TTS 非流式 adapter

目标：在同一 ASR/TTS 契约下支持 MiMo 文件能力和 TTS 三模式非流式输出。

实施范围：

- 在 `mimo-chat-audio-adapter.ts` 中实现 ASR 请求构造。
- 从本地音频读取 bytes 并构造 `data:<mime>;base64,<...>`。
- 按文档使用 `api-key` header 和 `/chat/completions` endpoint。
- ASR 只允许 `auto/zh/en` 语言和 `json/text` 输出。
- TTS 预置音色：`audio.voice` 使用预置或手输 voice id，目标文本放 `assistant` message。
- TTS 音色设计：`voiceDesignPrompt` 映射到 `user` message，支持 `audio.optimize_text_preview`。
- TTS 音色复刻：读取参考音频文件，构造 `audio.voice = data:<mime>;base64,<...>`。
- 非流式从 `choices[0].message.audio.data` 解码保存。

验收口径：

- fake server 验证 ASR request body 包含 `input_audio` 与 `asr_options.language`。
- fake server 覆盖 TTS 三种模式的 request body 和响应保存。
- 非支持语言、`srt/vtt/verbose_json`、timestamp、prompt 均在 validation 阶段被拦截。
- `voicedesign` 缺少 voice design prompt 且未开启可接受 fallback 时被拦截。
- `voiceclone` 缺少参考音频或参考音频格式不支持时被拦截。
- Base64 不写日志、不回传 Renderer。

### BE-003：MiMo TTS 三模型流式低延迟输出

目标：支持 `mimo-v2.5-tts`、`mimo-v2.5-tts-voicedesign`、`mimo-v2.5-tts-voiceclone` 三种模式的流式输出。

实施范围：

- 流式请求强制 `stream: true` 与 `audio.format = "pcm16"`。
- 实现 SSE/streaming parser，读取 `choices[0].delta.audio.data` 和可能的文本/metadata delta。
- 支持 final-only 兼容路径：如真实响应只在最终 message 返回音频，仍保存文件并标记降级。
- Main 进程将 Base64 chunk 解码为 PCM bytes，写入临时文件并向 renderer 发送播放事件。
- 完成后包装为 WAV，返回 output path、首包延迟、chunk 数、总字节数。
- 三种 MiMo TTS 模式共用 stream parser，但 request body 按模式生成。

验收口径：

- fake server 覆盖三种模式的多 chunk 响应。
- 取消请求会停止远端读取、停止写文件、通知 renderer 释放 AudioContext。
- 流式事件不包含 API Key、完整 request body 或原始 Base64 日志。
- `voicedesign/voiceclone` 真实低延迟能力必须在 QA-002 验证；如真实接口降级为最终一次性返回，QA-002 与首版发布能力不得标为 `已完成`，并需把 profile verification 标记为 degraded/failed 或补充 fix 文档。

### BE-004：Audio IPC、stream event 与 renderer service facade

目标：让 Renderer 能通过安全 IPC 调用文件、流式和输出相关能力。

实施范围：

- 新增 `electron/main/audio/ipc.ts`，注册 `audio:sync-runtime-config`、`audio:transcribe`、`audio:cancel-transcription`、`audio:synthesize-speech`、`audio:synthesize-speech-stream`、`audio:cancel-speech-synthesis-stream`、`audio:reveal-output`。
- 在 `electron/main/index.ts` 调用 `setupAudioIPC()`。
- 新增 `src/services/audio/audioTranscriptionService.ts` 与 `src/services/audio/speechSynthesisService.ts`。
- 新增 `audioRuntimeConfigService`，由 renderer 从全局 store 同步音频配置快照到 main 内存；工具页任务请求仍不得传 provider/API key/base URL/dialect/model ID。
- IPC validation 只接受文件路径、任务参数和 assignment key，不接受完整音频内容或 Base64。
- renderer service 封装 stream event subscribe/unsubscribe，避免页面直接监听裸 IPC channel。

验收口径：

- IPC request validation 测试通过。
- TypeScript 能通过 main/renderer import 边界。
- 无 API Key、Base64、PCM chunk 或完整 request body 进入 console/log/result error details。
- 流式取消和页面卸载路径能调用 abort。

### BE-005：Realtime session runtime 与 OpenAI WebRTC bridge

目标：支持实时麦克风字幕和 Realtime/WebRTC 双向语音的后端/session 合同。

实施范围：

- 新增 `electron/main/audio/realtime-ipc.ts` 和 `openai-realtime-adapter.ts`。
- Main 进程使用长期 API Key 创建 OpenAI Realtime ephemeral session。
- Renderer service 使用 ephemeral credentials 建立 WebRTC peer connection。
- 标准化 session events：session started、mic state、transcript delta/final、audio started/stopped、response lifecycle、error、closed。
- 支持手动 stop、route leave cleanup、page unload cleanup。
- MiMo profile 下不暴露 `realtime_duplex_voice`；实时字幕可走分块录音转写服务，标记为 chunked mode。

验收口径：

- 单测覆盖 session config validation、ephemeral request payload、error mapping、cleanup idempotency。
- 不在 renderer 暴露长期 API Key。
- WebRTC 真实连接留给 QA-002，但实现必须有明确清理路径。

### FE-001：设置页全局音频模型配置

目标：实现音频模型 API 配置的全局管理和任务生效选择。

实施范围：

- 新增 `AudioModelConfig` 或在 `ModelConfig` 中加入音频配置分区。
- 支持 audio profile 创建、编辑、删除、从现有 connection profile 创建。
- 支持选择 dialect、ASR 模型、TTS 模型、Realtime 模型、默认 voice、默认语言、默认流式。
- 支持四类 assignment：音频转文本、文本转音频、实时字幕、双向语音。
- 展示 capability 和 verification 状态。
- 禁止把不具备 capability 的 profile 设为对应任务 assignment。

验收口径：

- 文本模型配置不被破坏。
- 音频配置用户可见文案通过 i18n 检查。
- 工具页无需本地 API 选择即可解析当前全局配置。

### FE-002：工具入口、路由、共享状态与 i18n 基线

目标：让音频工具箱在应用中可进入，并建立四个页面可共用的状态基础。

实施范围：

- `toolMeta.ts` 新增 `audioTranscriber`、`speechSynthesizer`、`realtimeCaptions`、`realtimeVoice`。
- `Tools/index.tsx` 新增“音频工具箱”分类，保留现有 `music` soon 卡片。
- `App.tsx` 和 `constants/router.ts` 新增四条路由。
- 新增 `src/locales/*/audio.json`，并更新 i18n resources/constants。
- 新增共享 helper：读取全局 audio assignment、能力禁用文案、模型摘要、MiMo voice 预设。

验收口径：

- 应用路由编译通过。
- 所有新增用户可见文案通过 i18n 检查。
- 不启动服务也能通过 TypeScript 与 i18n validation。

### FE-003：音频转文本页面

目标：实现文件 ASR 页面和 OpenAI/MiMo 能力禁用规则。

实施范围：

- 新增 `AudioTranscriber` 页面，使用 `ToolDetailLayout`、`ToolConfigPanel`、`ToolFileDropZone`。
- 顶部只读显示全局 profile、dialect、ASR model、能力状态和设置入口。
- 左侧任务参数只包含语言、response format、timestamp、prompt、是否流式、输出路径。
- 主区域显示文件信息、开始/取消、结果文本、复制、保存、打开目录。
- MiMo 模式下禁用 prompt、`srt/vtt/verbose_json`、timestamp；语言只允许 `auto/zh/en`。
- OpenAI 模式下允许官方 response format，并按模型能力启用 timestamp。

验收口径：

- 未配置全局 profile、未选文件、文件格式不支持、文件过大均有阻止提交状态。
- 成功结果可显示文本并保存。
- 错误状态不泄露 API Key。
- 页面不提供 provider/API Key/base URL/model ID 独立选择。

### FE-004：文本转音频页面与流式播放

目标：实现 TTS 页面、MiMo 三模式配置和流式播放。

实施范围：

- 新增 `SpeechSynthesizer` 页面，使用 `ToolDetailLayout`。
- 顶部只读显示全局 profile、dialect、TTS model、streaming capability 和设置入口。
- 左侧任务参数包含 voice、response format、OpenAI speed、是否流式、输出路径。
- 主区域包含文本输入、instructions/style、MiMo 专属配置、生成按钮、流式状态、播放器、打开目录。
- MiMo 三模式使用 segmented control：预置音色、音色设计、音色复刻。
- 非 MiMo dialect 下禁用 MiMo-only 配置；MiMo dialect 下禁用 OpenAI speed 和不支持格式。
- 流式播放使用 renderer service 订阅 IPC stream event，完成后切换到最终文件播放器。

验收口径：

- OpenAI payload 不包含 `mimoOptions`。
- MiMo payload 不包含 OpenAI-only `speed`。
- MiMo 三模式都能启动流式路径。
- 取消/页面离开能停止播放、释放 AudioContext、abort main 进程任务。

### FE-005：实时字幕页面

目标：实现麦克风实时字幕和 MiMo 分块近实时字幕。

实施范围：

- 新增 `RealtimeCaptions` 页面。
- 顶部只读显示全局 realtime/caption profile、dialect、model、模式标签。
- 处理麦克风权限状态、开始、暂停/继续、停止、清空、保存。
- 实时展示 partial/final transcript，支持复制和保存。
- OpenAI Realtime profile 走 realtime transcription session。
- MiMo profile 走分块录音转写，UI 明确显示“分块近实时”，不显示 WebRTC。

验收口径：

- 未配置或 profile 不具备能力时不能启动，并给出设置入口。
- 麦克风权限拒绝有可恢复提示。
- 停止/离开页面清理 MediaStream tracks。
- MiMo 分块模式不会被文案描述成原生 WebRTC。

### FE-006：Realtime/WebRTC 双向语音页面

目标：实现首版双向语音会话。

实施范围：

- 新增 `RealtimeVoice` 页面。
- 顶部只读显示全局 realtime profile、model、voice、连接状态和设置入口。
- 支持连接、断开、静音、打断回复、清空会话。
- 展示 user/assistant transcript delta/final timeline。
- 播放远端音轨，显示模型正在说话状态。
- 仅对具备 `realtime_duplex_voice` capability 的 profile 启用。

验收口径：

- OpenAI Realtime profile 可启动 WebRTC session。
- MiMo Chat Audio profile 下禁用启动按钮，并提示当前 profile 不支持双向语音。
- 页面离开必须释放 mic tracks、peer connection、remote audio、AudioContext。

### QA-001：自动化回归矩阵

目标：补齐音频工具的自动化回归，避免供应商协议差异被 UI 或 IPC 绕过。

实施范围：

- 汇总并补齐 `test/audio/*`。
- 覆盖全局 audio profile migration、assignment guard、工具页只读全局配置。
- 覆盖 OpenAI ASR/TTS、MiMo ASR、MiMo TTS 三模式非流式、MiMo TTS 三模式流式。
- 覆盖 Realtime session contract、ephemeral request、cleanup idempotency。
- 覆盖能力禁用：MiMo ASR 不允许 `srt/vtt/verbose_json/timestamp/prompt`；OpenAI TTS 不允许 voice clone；MiMo 不允许 WebRTC 双向语音。
- 覆盖错误：401、403、429 Retry-After、5xx retry、超时、取消、空响应、无效响应、文件过大、stream final-only。
- 运行 TypeScript、i18n 和 diff check。

验收口径：

- 自动化命令全部通过或记录明确阻塞。
- 所有新增测试不访问真实网络。
- 进度台账和实施记录更新准确。

### QA-002：Electron 与真实供应商手工验收

目标：确认真实 Electron 文件路径、播放器、麦克风、WebRTC、输出目录和真实供应商 API 行为。

实施范围：

- 用 Electron 验证文件选择、拖拽、输出保存、播放器、打开目录。
- 真实验证 OpenAI ASR、OpenAI TTS、MiMo ASR。
- 真实验证 MiMo TTS 预置音色、MiMo 音色设计、MiMo 音色复刻的非流式与流式输出。
- 真实验证实时字幕的麦克风授权、partial/final 展示、停止保存。
- 真实验证 OpenAI Realtime/WebRTC 双向语音的连接、模型音频回复、打断、断开。
- 如启动 Vite/Electron/Playwright，结束前关闭并检查进程。
- 真实 API Key 只放本地配置，不写入文档、日志或截图。

验收口径：

- 至少记录每条真实路径的模型、模式、结果状态和是否生成文件。
- MiMo `voicedesign/voiceclone` 流式低延迟状态必须记录为 verified/degraded/failed；首版发布要求 verified，degraded/failed 需要进入 `阻塞` 或补充 `fix/` 文档。
- 所有启动的前端/Electron 服务均清理。
- 若真实供应商返回与 fixture 不一致，新增 `fix/` 文档并更新 Final Design/Execution Plan。

### DOC-001：README、CHANGELOG、隐私说明与发布文档同步

目标：把音频工具的能力边界和隐私影响同步到用户可见文档。

实施范围：

- 更新 README 工具列表或功能说明。
- 更新 CHANGELOG 的 v0.2.11 未发布条目。
- 如项目有隐私或系统说明文档，补充“本地音频和麦克风内容会上传到所选第三方 API”的说明。
- 更新本 execution plan 的最终状态。

验收口径：

- 文档不夸大 MiMo/OpenAI 能力，不把 MiMo-only 功能描述成通用能力。
- 明确说明本地音频文件和麦克风内容会被发送到用户选择的 API 服务。
- `git diff --check` 通过。

## 7. 实施记录模板

每个实现会话结束前，在 `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/` 新增记录，文件名格式：

```text
YYYY-MM-DD_<work-package-id>_<short-title>.md
```

模板：

````markdown
# 工作包 <ID>：<标题>

## 基本信息

- 日期：
- 状态：已完成 / 部分完成 / 阻塞
- 对应执行计划工作包：

## 本次实现内容

-

## 修改文件

-

## 接口或数据结构变化

-

## 验证结果

执行命令：

```text

```

结果：

-

## 未完成事项

-

## 下一步建议

-
````

## 8. 下一步建议

开发类工作包 `PRE`、`CORE`、`BE`、`FE` 和发布文档工作包 `DOC-001` 已完成。下一次建议进入 `QA-001` 自动化回归补强；如可以使用真实 API Key 和麦克风/扬声器环境，再进入 `QA-002` Electron 与真实供应商手工验收。
