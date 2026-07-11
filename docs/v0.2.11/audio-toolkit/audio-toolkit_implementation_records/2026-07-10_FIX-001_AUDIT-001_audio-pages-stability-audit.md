# 工作包 FIX-001 / AUDIT-001：音频页白屏修复与四页发布前审计

## 基本信息

- 日期：2026-07-10
- 状态：已完成
- 对应执行计划工作包：`FIX-001`、`AUDIT-001`

## 本次实现与审计内容

- 定位四个音频工具页打开即白屏的共同根因：`AudioToolShell` 传给 Zustand 的 selector 每次都返回新的配置摘要对象，React 19 的 `useSyncExternalStore` 因同一 store snapshot 得到不同引用而持续同步更新，最终触发 maximum update depth。
- 新增按 `profiles`、`audioProfiles`、`audioAssignment` 三个 slice 引用缓存的 selector factory；`AudioToolShell` 按 assignment key memoize selector，保证未变化 snapshot 返回同一对象引用。
- 新增 referential-stability 回归测试，覆盖相同 state、外层 state 变化但依赖 slice 未变化、assignment slice 真正变化三种情况。
- 在 Electron 中等待 `.app-loading-wrap` 和 `#app-loading-style` 完全移除后逐一挂载音频转文本、文本转音频、实时字幕和双向语音四个路由，确认无 renderer console error 与 `pageerror`。
- 对四页及共享 store、renderer service、preload/IPC、main runtime、OpenAI/MiMo adapter、音频资源与现有测试做发布前审计。
- 审计归纳 6 个 P0、23 个 P1、14 个 P2，并拆为 `FIX-002`～`FIX-007` 六个后续工作包；前三项为发布阻断。
- 按 OpenAI 2026-07-10 官方 Realtime GA 文档复核事件名称、transcription model、PCM 24 kHz/PCMU/PCMA、manual commit/response.create 和 WebRTC buffer clear。

## 修改文件

- `src/store/tools/audio/audioToolConfig.ts`
- `src/store/tools/audio/audioToolConfig.test.ts`
- `src/pages/Tools/Audio/shared/AudioToolShell.tsx`
- `docs/v0.2.11/audio-toolkit/fix/2026-07-10_audio-toolkit-react19-zustand-snapshot-white-screen.md`
- `docs/v0.2.11/audio-toolkit/fix/2026-07-10_audio-toolkit-four-page-release-audit.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-10_FIX-001_AUDIT-001_audio-pages-stability-audit.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口或数据结构变化

- 新增 `createAudioToolConfigSummarySelector(assignmentKey)`，供 React/Zustand 订阅路径稳定复用配置摘要。
- 未修改持久化 schema、Electron IPC wire contract 或供应商请求结构。

## 验证结果

- selector 定向回归：1 file / 4 tests，通过。
- 完整音频回归：19 files / 111 tests，通过。
- `node_modules/.bin/tsc --noEmit`：通过。
- `node scripts/check-i18n.mjs`：通过，9 个 namespace、四语言各 1371 个 key；5 个 same-as-source warning 均为现有专名/格式。
- Vite `build --mode=test`：renderer、main、preload 均通过；保留现有 chunk size 与 dynamic/static import warning。
- Electron 四路由 smoke：等待全局 loading 退出后，四页标题正确挂载，无 renderer console error / `pageerror`，验证进程已在 `finally` 中关闭。
- 未使用真实 OpenAI/MiMo Key，未测试真实麦克风、扬声器、远端音轨和长会话。
- 追加的 1280×800 / 786×540 截图矩阵因本轮 GUI 审批额度耗尽未执行，已列入 `FIX-007` / `QA-002`。

## 未完成事项

- `FIX-002`：音频 IPC 信任边界与文件 ownership。
- `FIX-003`：Realtime/录音生命周期、请求 ownership 与上传队列背压。
- `FIX-004`：OpenAI Realtime GA 事件、模型拆分、音频格式与 manual/WebRTC 合同。
- `FIX-005`：TTS 流式播放、输出与任务状态正确性。
- `FIX-006`：ASR/provider 参数矩阵与全局 Profile 默认值。
- `FIX-007`：四页 UX、可访问性、i18n、持久化迁移与视觉 QA。

## 下一步建议

先认领 `FIX-002`，再依次完成 `FIX-003`、`FIX-004`。这三个发布阻断清零后，再执行 `FIX-005`～`FIX-007`、`QA-001` 和 `QA-002`；不得用 fixture、冒烟或真实供应商单次成功替代安全、协议与生命周期验收。
