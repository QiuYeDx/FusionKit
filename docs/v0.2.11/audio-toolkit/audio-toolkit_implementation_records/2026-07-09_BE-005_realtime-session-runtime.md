# 工作包 BE-005：Realtime session runtime 与 OpenAI WebRTC bridge

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`BE-005`

## 本次实现内容

- 新增 main 进程共享音频运行时配置 store，让普通 Audio IPC 与 Realtime IPC 读取同一份由 renderer 同步的全局音频配置。
- 新增 OpenAI Realtime client secret adapter，使用长期 API Key 在 main 进程调用 `/realtime/client_secrets`，renderer 只接收 ephemeral client secret 与 `/realtime/calls` URL。
- 新增 Realtime IPC：`audio:realtime:create-ephemeral-session`、`audio:realtime:stop-session`，并在 Electron main 启动流程注册。
- 新增 renderer `audioRealtimeService`，支持创建 Realtime ephemeral session、建立 OpenAI WebRTC peer connection、SDP exchange、OpenAI server event 到 FusionKit `AudioRealtimeSessionEvent` 的映射、手动/页面卸载 cleanup。
- 补充单测覆盖 ephemeral request payload、MiMo profile WebRTC guard、HTTP 错误脱敏、renderer 同步全局配置、事件映射和 cleanup 幂等。

## 修改文件

- `src/type/audioIpc.ts`
- `electron/main/audio/audio-runtime-config.ts`
- `electron/main/audio/audio-ipc-errors.ts`
- `electron/main/audio/ipc.ts`
- `electron/main/audio/realtime-ipc.ts`
- `electron/main/audio/realtime/openai-realtime-adapter.ts`
- `electron/main/index.ts`
- `src/services/audio/audioRealtimeService.ts`
- `src/services/audio/audioServices.test.ts`
- `test/audio/audioRealtimeSession.test.ts`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口或数据结构变化

- `RealtimeEphemeralSessionResult` 新增 `realtimeCallsUrl?: string`，供 renderer 使用 ephemeral client secret 发起 WebRTC SDP exchange。
- 新增 `StopAudioRealtimeSessionRequest`、`StopAudioRealtimeSessionResult` 与 `validateStopAudioRealtimeSessionIpcRequest()`。
- `AudioRealtimeIpcService` 只允许 `openai_realtime` dialect 走原生 WebRTC ephemeral session；MiMo streaming transcription 不能通过该 IPC 伪装成 WebRTC。
- `AudioIpcService` 的运行时配置解析改为共享 `AudioRuntimeConfigStore`，保持 `audio:sync-runtime-config` 仍是唯一同步入口。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/audio/audioRealtimeSession.test.ts src/services/audio/audioServices.test.ts
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts
git diff --check
```

结果：

- `test/audio/audioRealtimeSession.test.ts` 与 `src/services/audio/audioServices.test.ts` 通过，2 files / 9 tests。
- `node_modules/.bin/tsc --noEmit` 通过。
- 音频相关回归通过，14 files / 79 tests。
- `git diff --check` 通过。

## 未完成事项

- Electron 中真实 WebRTC 连接、麦克风权限、远端音轨播放、打断和断开仍需 `QA-002` 手工验收。
- 设置页尚未实现音频 profile 管理与四类 assignment UI，后续页面暂时依赖已有 store/service contract。

## 下一步建议

- 下一步认领 `FE-001`：设置页全局音频模型配置。
- `FE-001` 需要在设置页暴露 OpenAI Audio、OpenAI Realtime、MiMo Audio profile 的创建/编辑/assignment，并在设置变更或应用启动时调用 `syncAudioRuntimeConfigFromStore()`。
