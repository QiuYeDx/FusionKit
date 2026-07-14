# 工作包 FE-R03：Route-aware 双向语音竖切

## 基本信息

- 日期：2026-07-14
- 状态：已完成
- 对应执行计划工作包：`FE-R03`

## 本次实现内容

- 将 RealtimeVoice 页面从 legacy audio profile/context 切换到 standalone
  `realtimeVoice` assignment、route definition 与精确音频设置回跳。
- Registry 补齐双向语音的 input/output format 和 voice allowlist；main 在 adapter 前
  按 route 约束拒绝非法字段及 voice/caption 模型交叉。
- Voice Store 升至 v4，只持久化 sanitized preferences；删除 profile defaults 播种，
  清空对话不再丢失 active response 与打断入口。
- 输入/输出格式改为完整 Radix RadioGroup，移除永久不可用 manual 控件；voice 使用
  route presets Select，并保留无 allowlist route 的文本输入 fallback。
- 增加 route/profile snapshot、generation、start/stop locks、mount cleanup flush、
  late-result guard 和 response-scoped interrupt。
- 将生成完成与播放缓冲生命周期解耦：`response.done` 只结束生成，只有
  output buffer `stopped/cleared` 才确认打断完成并清除 speaking/active response。
- 硬化共享 WebRTC service：RTC 启动步骤 Abort/超时、streamless track、owned
  `srcObject` 解绑、late track、播放失败及本地 track ended 清理。
- 增加 config/store/service/main 与 Electron 宽窄交互验证。

## 修改文件

- `src/lib/audio-provider-registry.ts`
- `electron/main/audio/realtime-ipc.ts`
- `src/store/tools/audio/realtimeVoiceConfig.ts`
- `src/store/tools/audio/useRealtimeVoiceStore.ts`
- `src/pages/Tools/Audio/RealtimeVoice/index.tsx`
- `src/pages/Tools/Audio/shared/AudioToolShell.tsx`
- `src/services/audio/audioRealtimeService.ts`
- `src/lib/audio-provider-registry.test.ts`
- `src/store/tools/audio/realtimeVoiceConfig.test.ts`
- `src/store/tools/audio/useRealtimeVoiceStore.test.ts`
- `src/services/audio/audioServices.test.ts`
- `test/audio/audioRealtimeSession.test.ts`
- `test/e2e.spec.ts`
- `docs/v0.2.11/audio-toolkit/fix/2026-07-14_FIX-R03_realtime-voice-routing-lifecycle.md`

## 接口或数据结构变化

- `AudioRealtimeRouteConstraints` 新增 `outputAudioFormats` 与 `voices`。
- 新增 `resolveRealtimeVoiceConfigSummary()`、
  `getRealtimeVoiceRouteIdentity()`、`normalizeRealtimeVoicePreferences()`。
- `buildRealtimeVoiceSessionConfig()` 改为消费 route constraints，不再接受或派生任何
  API Key、Base URL、provider、transport 或 model。
- `fusionkit-realtime-voice` 从 v3 升至 v4，持久化 envelope 只包含
  `{ preferences }`。
- `OpenAIRealtimeWebRtcSessionOptions` 新增可测试的单步启动超时配置；handle stop 负责
  owned remote audio detach。
- `AudioRealtimeSessionEvent` 的 `assistant_audio_started/stopped` 增加
  `source: response | output_buffer`，buffer cleared 事件另带 `cleared`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/lib/audio-provider-registry.test.ts src/store/tools/audio/realtimeVoiceConfig.test.ts src/store/tools/audio/useRealtimeVoiceStore.test.ts src/services/audio/audioServices.test.ts test/audio/audioRealtimeSession.test.ts test/audio/audioIpcService.test.ts --reporter=dot
node_modules/.bin/vitest run --exclude test/e2e.spec.ts --reporter=dot
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'route-aware realtime voice' --reporter=dot
git diff --check
```

结果：

- 聚焦 6 files / 150 tests；全量非 Electron 88 files / 811 tests。
- TypeScript、四语言 i18n（各 1514 keys）、Vite test build、Electron 聚焦与
  `git diff --check` 通过。
- Electron 生成 3 张宽窄截图，确认 loading 已退出、RadioGroup 完整可交互且无页面级
  横向溢出。
- 未运行 pnpm，`package.json` 与 `pnpm-lock.yaml` 未修改。
- Electron/fake server 由 E2E `afterAll` 关闭；会话结束前仍再次检查进程表。

## 未完成事项

- Legacy audio facade cleanup 已由后续 FE-R03 记录完成。
- `QA-R02` 真实 OpenAI、真实麦克风与扬声器验收未执行。

## 下一步建议

- FE-R03 最终收口见 `2026-07-14_FE-R03_legacy-audio-facade-cleanup.md`；当前下一工作包为
  `I18N-R01`。
