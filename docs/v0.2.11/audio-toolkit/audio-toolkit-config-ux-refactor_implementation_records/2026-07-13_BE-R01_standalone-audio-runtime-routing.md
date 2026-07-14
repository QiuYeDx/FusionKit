# 工作包 BE-R01：Standalone Audio Runtime 与可信 Route 解析

## 基本信息

- 日期：2026-07-13
- 状态：已完成
- 对应执行计划工作包：`BE-R01`

## 本次实现内容

- 将 runtime snapshot 从 legacy connection/audio profiles 改为独立音频 API
  `profiles + assignment`，并继续以 renderer sender 和 revision 隔离配置。
- renderer task invoke 前串行同步最新 `useAudioApiStore` snapshot；同步期间发生设置
  变化时继续收敛到最新状态，stale retry 也不复用旧配置。
- main 新增可信 `resolveRoute`：按 assignment、TTS intent mode、route、provider
  constraints 解析 transport/model/凭证，再进入文件授权、controller 与 adapter。
- ASR、分块字幕、非流式/流式 TTS、Realtime captions/voice 全部切换到可信 route；
  同一 MiMo API 的 preset/design/clone intent 分别解析到 registry 的三条模型 route。
- 新增 owner-bound、30 分钟 TTL 的输出目录授权；renderer 只持有
  `outputDirToken`，公开任务结果只持有 output token，不暴露路径。
- 保留 legacy speech builder 作为 `FE-R02` 过渡输入，但 facade fail-closed；public
  IPC 只接受 provider-neutral intent，voice clone 只接受一次性 `voiceSampleToken`。
- renderer/service facade 捕获 IPC rejection 并统一映射为可恢复的 `network_error`。

## 审计修复

- preload public generic invoke 改为 public audio channel 精确 allowlist；文件与目录
  授权只允许 dedicated preload helper 通过私有闭包调用，legacy bridge 拒绝全部
  `audio:*` channel。
- 文件、目录、voice sample 与 output token 全部校验 owner；voice sample 单次消费，
  wrong-owner 请求不会撤销或消耗合法 owner 的 token。
- requestId 在授权前 reservation；pending 与 active 阶段共用 AbortController，取消或
  renderer 销毁后，即使授权 Promise 迟到 resolve/reject 也只返回 `aborted`，不会
  继续消耗下一项 capability、调用 runtime 或产生计费输出。
- owner generation 和 reservation identity 防止旧 finally 删除新 generation 的同名
  请求；无 requestId runtime、Realtime pending 请求和页面销毁 cleanup 同样纳入管理。
- runtime 忽略 abort 并迟到返回时，撤销相关 output token 并删除输出文件。
- 未知 fs/runtime 错误不公开原始 `Error.message`；provider `rawJson` 同时按敏感 key
  和 Bearer/key/path/data URI/长 Base64 字符串脱敏。
- 新增项目坑位 `FK-PIT-0007`，固化 preload internal IPC 不得进入 public generic
  invoke 的安全规则。

## 修改文件

- Runtime 与 IPC：`src/type/audio.ts`、`src/type/audioIpc.ts`、
  `electron/main/audio/audio-runtime-config.ts`、`electron/main/audio/ipc.ts`、
  `electron/main/audio/realtime-ipc.ts`、
  `electron/main/audio/realtime/openai-realtime-adapter.ts`。
- Capability 与边界：`electron/main/audio/audio-output-directory.ts`、
  `electron/main/audio/audio-file.ts`、`electron/preload/audio-channel-policy.ts`、
  `electron/preload/index.ts`。
- Runtime/adapter/error：`electron/main/audio/audio-runtime-client.ts`、
  `electron/main/audio/adapters/mimo-chat-audio-adapter.ts`、
  `electron/main/audio/audio-errors.ts`、`electron/main/audio/audio-http.ts`、
  `electron/main/audio/audio-ipc-errors.ts`。
- Renderer services/store：`src/services/audio/audioRuntimeConfigService.ts`、
  `src/services/audio/audioTranscriptionService.ts`、
  `src/services/audio/speechSynthesisService.ts`、
  `src/services/audio/audioRealtimeService.ts`、
  `src/store/tools/audio/audioOutputDirectory.ts` 及 ASR/TTS config/store builder。
- 测试：`test/audio/`、`src/type/audioIpc.test.ts`、
  `src/services/audio/audioServices.test.ts`、相关 config/store tests。
- 项目经验：`.agents/skills/fusionkit-pitfall-guard/references/`。

## 接口或数据结构变化

- `SyncAudioRuntimeConfigRequest` 现在只包含独立音频 API `profiles` 与
  `AudioTaskAssignment`，不再包含 connection profiles 或 legacy audio profiles。
- public TTS 请求使用 `CreateSpeechSynthesisIpcRequest` 和可判别的
  `SpeechSynthesisIntent`；`responseFormat` 必填，renderer 不得提交 model、transport、
  Base URL、API Key、`outputDir` 或 voice sample path。
- `CreateSpeechSynthesisRequest` 保留为 main → adapter 的可信内部 DTO，由 main 写入
  `voice`、`mimoOptions`、可信文件路径和输出目录。
- 新增输出目录选择/授权与 `outputDirToken`；公开 ASR/TTS 结果删除 `outputPath`，
  通过 output token 执行 read/reveal。
- route 错误统一为 `audio_api_not_configured`、`audio_route_not_configured`、
  `audio_route_unverified`、`invalid_task_parameters` 与 `stale_audio_config`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/audio/audioIpcService.test.ts --reporter=verbose
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/tools/audio src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/lib/audio-provider-registry.test.ts src/lib/audio-api-migration.test.ts src/store/useModelStore.test.ts src/store/useAudioApiStore.test.ts src/store/audioStoreBootstrap.test.ts src/services/audio/audioServices.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts --reporter=verbose
node_modules/.bin/vitest run
git diff --check
```

结果：

- Audio IPC：1 file / 42 tests 通过；包含 pending/active cancel、owner release、
  duplicate reservation、一次性 token、迟到输出和敏感信息边界。
- 音频矩阵：29 files / 244 tests 通过。
- 全量 Vitest：83 files / 691 tests 通过，其中 Electron E2E 2 tests 通过；覆盖
  4 个音频路由 × 4 种语言 × 2 个窗口尺寸，并等待 preload loading 退出。
- TypeScript 通过；i18n 四语言各 1425 keys 对齐（9 条 same-as-source 提示，无错误）。
- Vite test build 通过；只有既存 dynamic-import/chunk-size warning。
- `git diff --check` 通过。
- 未运行 pnpm；未因本包修改 `package.json` 或 `pnpm-lock.yaml`。

## 未完成事项

> 以下为本工作包于 2026-07-13 结束时的历史状态；`FE-R01` 已于 2026-07-13
> 完成，`FE-R02` 已于 2026-07-14 完成，当前后续工作包为 `FE-R03`。

- 截至本工作包结束时，`FE-R01` 尚未把设置页切到独立音频 API CRUD/assignment
  与首次配置返回链路。
- 截至本工作包结束时，`FE-R02` 尚未升级 TTS store/UI；当时页面 voice clone 仍保留
  renderer raw path，必须改成“选择即授权”并提交 `voiceSampleToken` 后才形成三模式 UI 闭环。
- `FE-R03` 尚未迁移其余三个工具并移除 legacy audio CRUD/selectors 与文本
  connection 删除保护。
- 当前 Electron E2E 是渲染/白屏回归，不替代 `QA-R01` 的首次配置、三模式 CTA、
  生成/取消交互，也不替代 `QA-R02` 的真实供应商和设备验收。

## 下一步建议

- 本工作包结束时建议下一会话认领 `FE-R01`：新增独立“设置 → 音频”入口和配置页面，停止设置页写
  legacy audio，并完成第一条兼容 API 的显式自动 assignment 与 returnTo 流程。
- `FE-R01` 继续复用 `useAudioApiStore` 和 provider registry，不在 UI 重新硬编码
  route/model 映射；长表单对话框使用 `ScrollableDialog`。
