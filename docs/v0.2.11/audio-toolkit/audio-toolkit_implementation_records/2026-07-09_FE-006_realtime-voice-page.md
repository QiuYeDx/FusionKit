# 工作包 FE-006：Realtime/WebRTC 双向语音页面

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`FE-006`

## 本次实现内容

- 实现双向语音页面：只读展示全局 realtime voice 配置，页面参数只包含 voice、会话指令、说话检测、输入/输出音频格式。
- 页面通过 `startOpenAIRealtimeWebRtcSession()` 创建 ephemeral session、请求麦克风权限、建立 WebRTC、绑定远端音轨，并处理 session、mic、transcript、audio、response、error、closed 事件。
- 新增连接、断开、静音/取消静音、打断回复、清空会话等控制。
- 展示 user/assistant partial/final timeline，显示模型正在说话、当前 response 和 session 状态。
- MiMo Chat Audio 或其它不具备 `realtime_duplex_voice` capability 的 profile 下禁用启动，并明确提示不是 WebRTC 双工。
- 扩展 realtime session handle，支持 `setMuted()` 和 `sendClientEvent()`，页面不直接操作裸 peer connection/data channel。

## 修改文件

- `src/pages/Tools/Audio/RealtimeVoice/index.tsx`
- `src/store/tools/audio/realtimeVoiceConfig.ts`
- `src/store/tools/audio/realtimeVoiceConfig.test.ts`
- `src/store/tools/audio/useRealtimeVoiceStore.ts`
- `src/services/audio/audioRealtimeService.ts`
- `src/locales/*/audio.json`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口或数据结构变化

- `AudioRealtimeSessionHandle` 新增 `setMuted(muted)` 和 `sendClientEvent(event)`。
- 新增 renderer-only `RealtimeVoicePreferences`、`RealtimeVoiceLine`、`RealtimeVoiceSessionStatus` 和 UI store。
- 未新增 main IPC channel；继续复用 OpenAI Realtime ephemeral session 和 WebRTC bridge。

## 验证结果

执行命令：

```text
node -e "const fs=require('fs'); for (const file of ['src/locales/zh/audio.json','src/locales/en/audio.json','src/locales/zh-Hant/audio.json','src/locales/ja/audio.json']) { JSON.parse(fs.readFileSync(file,'utf8')); console.log('ok', file); }"
node_modules/.bin/vitest run src/store/tools/audio/realtimeVoiceConfig.test.ts src/services/audio/audioServices.test.ts test/audio/audioRealtimeSession.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/audioTranscriberConfig.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts src/store/tools/audio/realtimeCaptionsConfig.test.ts src/store/tools/audio/realtimeVoiceConfig.test.ts
git diff --check
```

结果：

- JSON 解析通过。
- 定向测试通过，3 files / 17 tests。
- TypeScript 检查通过。
- i18n 检查通过，`audio` 329 keys x 4 locales；存在专名/格式名相同 warning：`SRT 字幕`、`VTT 字幕`、`OpenAI · MiMo`、`MiMo 音色`。
- 音频相关回归通过，19 files / 110 tests。
- `git diff --check` 通过。

## 未完成事项

- 未启动 Electron 做真实 WebRTC、麦克风权限、远端音轨播放和打断回复验收；该部分仍需 QA-002。
- OpenAI Realtime 真实供应商连接、音轨播放和 response.cancel 行为仍需 QA-002 记录。

## 下一步建议

- 开发类工作包 `PRE`、`CORE`、`BE`、`FE` 已闭环。
- 若继续遵循“QA 先不做”，可认领 `DOC-001` 发布文档同步；否则进入 `QA-001` / `QA-002`。
