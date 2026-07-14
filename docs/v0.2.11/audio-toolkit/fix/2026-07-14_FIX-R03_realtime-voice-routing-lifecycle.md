# FIX-R03：双向语音 standalone 路由与 WebRTC 生命周期闭环

## 背景与现象

FE-R03 继续将双向语音从 legacy audio profile 迁移到 standalone 音频 API。
终审发现旧页面仍按 `audioDialect + capabilities` 决定可用性、播种 profile 默认
voice，并把会话状态与 route 生命周期分离，导致独立设置与实际 main 路由可能不一致。

同时存在以下运行时风险：

- assignment、API Key、Base URL、transport 或 model 改变后，旧 WebRTC 会话继续持有
  麦克风和远端 session；
- 快速双击连接/断开可重复创建 ephemeral session；
- `createOffer`、SDP 设置等 Promise 悬置时，Abort 无法及时释放已经取得的媒体；
- 清空对话会删除 active response，远端音频仍播放但用户失去打断入口；
- 任意旧 response 完成或 audio stopped 事件都可能覆盖当前 response 状态；
- `response.done` 被误当作远端音频播放结束，生成已完成但 output buffer 仍播放时无法打断；
- remote track 不带 `streams` 时无法播放，stop 后 `audio.srcObject` ownership 不闭环。

## 根因与设计缺口

1. 页面仍消费 `AudioToolShell` 的 legacy `useModelStore` fallback，renderer 与 main
   使用不同配置事实来源。
2. Voice Store v3 持久化 profile seed 标记，且同版本脏 envelope 可恢复 session、
   transcript 与 active response 等运行时状态。
3. route constraints 未声明 output format 和 voice allowlist，main 也未按完整
   `providerPreset + transport + route.model` 对这些字段做 defense-in-depth 校验。
4. WebRTC service 只在媒体获取前对 Abort 做真正竞速，后续 RTC 启动步骤仅在 await
   前后检查 signal。
5. 页面没有 generation、route identity、profile snapshot 与同步 start/stop lock；
   response 事件也没有按 response id 归属。

## 修复后行为

- 页面只消费 standalone `realtimeVoice` assignment 和完整 route definition；无 route
  时只显示精确设置 CTA：
  `/setting?tab=audio&returnTo=%2Ftools%2Faudio%2Frealtime-voice`。
- OpenAI/custom-compatible 共享输入/输出格式及 8 个 voice presets；renderer 和 main
  使用同一 registry constraints，非法 voice/format 与 voice-caption model 交叉均在
  adapter 前拒绝。
- Voice Store 升至 v4，仅持久化 sanitized preferences；删除 profile defaults 播种，
  v3 与同版本污染 envelope 均不恢复任何运行时状态。
- 永久不可用的 manual turn detection 不进入 DOM；输入/输出格式使用完整 Radix
  RadioGroup 交互面，支持 click、方向键、Home/End 与单一 tab stop。
- assignment/profile/route 改变、离页、连接中断和迟到启动结果统一按 generation +
  AbortController 释放本地资源，并把 remote stop 交给有界清理队列。
- RTC 启动的 offer、local description、SDP fetch/text、remote description 均支持
  Abort 和单步超时；streamless track 会构造 owned MediaStream，stop 仅解绑自己的
  `srcObject`，late track、播放失败和麦克风 track ended 均有明确清理路径。
- 打断请求携带当前 response id，完成事件只更新同一 response；清空转写不会清除
  active response 或 assistant speaking 状态。
- `response.done` 只表示生成完成；audio started/stopped 事件区分 `response` 与
  `output_buffer` 来源，打断只有收到 buffer `stopped/cleared` 才确认成功。生成已完成但
  缓冲仍播放时仍保留打断入口。

## 影响文件

- `src/lib/audio-provider-registry.ts`
- `electron/main/audio/realtime-ipc.ts`
- `src/store/tools/audio/realtimeVoiceConfig.ts`
- `src/store/tools/audio/useRealtimeVoiceStore.ts`
- `src/pages/Tools/Audio/RealtimeVoice/index.tsx`
- `src/pages/Tools/Audio/shared/AudioToolShell.tsx`
- `src/services/audio/audioRealtimeService.ts`
- 对应 registry/config/store/service/main/Electron tests

## 验证结果

```text
node_modules/.bin/vitest run src/lib/audio-provider-registry.test.ts src/store/tools/audio/realtimeVoiceConfig.test.ts src/store/tools/audio/useRealtimeVoiceStore.test.ts src/services/audio/audioServices.test.ts test/audio/audioRealtimeSession.test.ts test/audio/audioIpcService.test.ts --reporter=dot
node_modules/.bin/vitest run --exclude test/e2e.spec.ts --reporter=dot
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'route-aware realtime voice' --reporter=dot
git diff --check
```

- 聚焦 6 files / 150 tests 通过。
- 全量非 Electron 88 files / 811 tests 通过。
- TypeScript 与四语言 i18n 通过，每种语言 1514 keys。
- Vite test build 通过，仅保留既有 dynamic import 与 chunk size warning。
- Electron 聚焦 1 test 通过；覆盖零配置 CTA、legacy 备份隔离、字段矩阵、Store v4、
  两组 RadioGroup 键盘语义、快速双击、连接中断开、A/B response 交错、清空后打断、
  `response.done` 后 buffer clear 前打断、双断开和离页资源释放。
- 截图：`test-results/fe-r03-voice-1280x800.png`、
  `test-results/fe-r03-voice-786x540.png`、
  `test-results/fe-r03-voice-workspace-786x540.png`；均确认 preload loading 已退出且
  页面无横向溢出。

## 后续

- FE-R03 legacy facade cleanup 已完成，见
  `audio-toolkit-config-ux-refactor_implementation_records/2026-07-14_FE-R03_legacy-audio-facade-cleanup.md`；
  legacy 字段仍按设计保留一个版本的只读迁移备份。
- 真实供应商、真实麦克风与扬声器验收仍属于 `QA-R02`，不得在文档或日志记录 Key、
  ephemeral secret 或完整敏感 payload。
