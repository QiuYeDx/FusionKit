# 工作包 FE-R03：Route-aware ASR 与实时字幕竖切

## 基本信息

- 日期：2026-07-14
- 状态：已完成
- 对应执行计划工作包：`FE-R03`

## 本次实现内容

- 将 AudioTranscriber 从 legacy audio profile/context 切到 standalone
  `AudioApiProfile` assignment 和 transcription route。
- 以共享 registry 的 `providerPreset + transport + route.model` 为唯一约束来源，
  分别支持 GPT Transcribe、Whisper、MiMo ASR 和 conservative custom-compatible。
- 按 route 条件渲染 language、format、prompt、timestamps、stream；零配置改为精确
  `/setting?tab=audio&returnTo=...` CTA，shared shell 展示 standalone API 摘要。
- transcriber store 升至 v4，只持久化 preferences；同版本/旧版本 hydration 均丢弃
  文件、目录授权、结果、错误和任务状态。
- main ASR 文件授权改为一次性 `consume()`；renderer 完成选择、替换、清除、route
  变化、离页、提交后释放，以及二次提交重新授权。
- 补齐 sync-to-dispatch 可取消预检、显式取消 bounded attempt、route/unmount 跨路由
  cancellation queue，避免 SPA 离页后丢失仍在 main/provider 运行的 requestId。
- 为输出目录新增 preload-private、owner-bound、幂等 revoke IPC；renderer 使用同步锁、
  generation/mounted/route snapshot 和带超时的撤销重试队列。
- 输出模式迁移到完整 Radix RadioGroup primitive，覆盖单一 roving tabindex、方向键、
  Home/End 和窄屏换行。
- 将 RealtimeCaptions 切到 standalone `realtimeCaptions` assignment/route；共享 registry
  按完整 route 区分 OpenAI 原生 WebRTC 和 MiMo 分块近实时，MiMo 语言精确收窄为
  `auto/zh/en`，main 与 renderer 使用同一 route definition。
- captions store 升至 v4，仅持久化 sanitized preferences；移除 profile defaults 播种，
  v3 和同版本污染 envelope 均不 hydration runtime session/transcript/error 状态。
- OpenAI 才渲染输入格式 RadioGroup；MiMo 隐藏 WebRTC-only 控件；永久不可用的
  turn detection、assistant transcript 和 instructions 不再进入 DOM；零配置改为精确 CTA。
- route/profile 变化与离页会先使 generation 失效并释放麦克风；chunk task 接入
  sync→dispatch abort gate，已 dispatch 取消和 Realtime session stop 使用跨路由
  timeout/backoff/TTL 清理队列，本地资源释放不等待远端 IPC。
- 四语言通用未配置文案改为任务中性；新增 `FK-PIT-0011`、`FK-PIT-0012`、
  `FK-PIT-0013`。
- 实时字幕终审与修复背景记录在
  `fix/2026-07-14_FIX-R03_realtime-captions-routing-lifecycle.md`。

## 修改文件

- `src/pages/Tools/Audio/AudioTranscriber/index.tsx`
- `src/pages/Tools/Audio/RealtimeCaptions/index.tsx`
- `src/store/tools/audio/audioTranscriberConfig.ts`
- `src/store/tools/audio/useAudioTranscriberStore.ts`
- `src/store/tools/audio/realtimeCaptionsConfig.ts`
- `src/store/tools/audio/useRealtimeCaptionsStore.ts`
- `src/store/tools/audio/audioToolConfig.ts`
- `src/pages/Tools/Audio/shared/AudioToolShell.tsx`
- `src/lib/audio-provider-registry.ts`
- `src/services/audio/audioRuntimeConfigService.ts`
- `src/services/audio/audioTranscriptionService.ts`
- `src/services/audio/audioRealtimeService.ts`
- `src/services/audio/boundedCleanupRetryQueue.ts`
- `src/type/audioIpc.ts`
- `electron/main/audio/ipc.ts`
- `electron/main/audio/realtime-ipc.ts`
- `electron/main/audio/audio-output-directory.ts`
- `electron/main/audio/adapters/openai-audio-adapter.ts`
- `electron/preload/index.ts`
- `src/locales/{zh,zh-Hant,en,ja}/audio.json`
- 对应 store/config/service/main/Electron tests 与项目 pitfall references

## 接口或数据结构变化

- `AudioRendererApi` 新增 `revokeOutputDirectory(outputDirToken)`，仅由 preload 固定
  internal channel 暴露；generic public invoke 仍无法调用 internal namespace。
- `AudioOutputDirectoryAuthorizationStore.revoke()` 返回 owner-bound 幂等 boolean。
- `invokeAudioTaskIpc()` 新增 optional signal/onDispatch gate，首轮 sync 和 stale resync
  后均在 dispatch 前检查 abort。
- `useAudioTranscriberStore` 版本升至 v4，持久化结构仅含 sanitized preferences。
- provider-only ASR constraints helper 被移除；renderer、main、adapter 共用 route-aware
  resolver，未知内置 model fail closed，自定义未知 model 使用 portable minimum。
- `resolveRealtimeRouteDefinition()` 以 provider/assignment/transport/model 解析 Realtime
  执行策略与字段约束；generic capability 不再决定 WebRTC/分块模式。
- `useRealtimeCaptionsStore` 升至 v4，只持久化 preferences；profile seed/session/runtime
  字段从 state persistence contract 移除。
- Realtime task service 接受 `AudioTaskInvocationOptions`；新增 recorded chunk cancel 与
  session stop 的 bounded cleanup queue，`stopped:false` 按幂等成功处理。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run <10 focused ASR/capability files> --reporter=dot
node_modules/.bin/vitest run <7 focused captions/cleanup/main files> --reporter=dot
node_modules/.bin/vitest run --exclude test/e2e.spec.ts --reporter=dot
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'route-aware audio transcription renders usable fields and reauthorizes consumed input files' --reporter=dot
node_modules/.bin/vitest run test/e2e.spec.ts -t 'route-aware realtime captions expose only usable controls' --reporter=dot
git diff --check
ps -axo pid,ppid,command | rg '<FusionKit Vite/Electron patterns>'
```

结果：

- focused ASR/capability：10 files / 138 tests 通过。
- focused captions/cleanup/main：7 files / 136 tests 通过。
- 全量非 Electron：87 files / 788 tests 通过。
- TypeScript、四语言 i18n、`git diff --check` 通过；四语言各 1514 keys，audio 各 390。
- renderer/main/preload test build 通过，仅有既有 dynamic-import/chunk-size warnings。
- 聚焦 Electron E2E 1 test 通过；实际覆盖零配置、GPT/Whisper/MiMo 字段、双击防重、
  文件二次授权、RadioGroup 键盘链路、两次 provider 请求。
- 实时字幕聚焦 Electron E2E 1 test 通过；覆盖 none/OpenAI/MiMo 三态、精确 deep link、
  字段 DOM 显隐、MiMo 语言集合、RadioGroup 键盘链路、store v4 envelope 与宽窄布局。
- 审查 `fe-r03-transcriber-1280x800.png` 与 `fe-r03-transcriber-786x540.png`：loading
  已退出，无横向溢出或固定底栏遮挡，宽窄截图目标不同。
- 审查 `fe-r03-captions-mimo-1280x800.png`、`fe-r03-captions-openai-786x540.png` 与
  `fe-r03-captions-workspace-786x540.png`：loading 已退出，条件字段、分块提示、长格式
  label 与单列工作区无横向溢出。
- 未运行 pnpm，`package.json`、`pnpm-lock.yaml` 未修改；Electron/fake server 已关闭，
  最终进程检查为空。

## 未完成事项

- 双向语音与 legacy facade cleanup 已由后续 FE-R03 记录完成。
- `I18N-R01` source-usage checker、`TEST-R01` 完整组件矩阵、`QA-R01/QA-R02` 保持独立。

## 下一步建议

- FE-R03 后续见 `2026-07-14_FE-R03_route-aware-realtime-voice.md` 与
  `2026-07-14_FE-R03_legacy-audio-facade-cleanup.md`；当前下一工作包为 `I18N-R01`。
