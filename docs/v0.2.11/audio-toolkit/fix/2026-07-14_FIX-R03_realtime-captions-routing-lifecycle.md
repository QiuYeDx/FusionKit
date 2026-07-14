# FIX-R03：实时字幕 route 与生命周期闭环

## 背景

FE-R03 将实时字幕从 legacy audio profile/context 迁移到 standalone 音频 API 时，
实现与终审发现旧页面仍按 `audioDialect + capabilities` 推导执行模式，并且存在
runtime sync、麦克风授权、route 切换和远端 stop/cancel 的生命周期空窗。

## 根因

- `realtime_transcription` 只能表达任务能力，无法区分 OpenAI 原生 WebRTC 与 MiMo
  分块 ASR，也无法决定语言、输入格式和清理策略。
- captions store 仍持久化 profile seed 标记，same-version merge 还会恢复任意 runtime
  顶层字段。
- chunk task 没把 AbortSignal 传到 runtime sync→dispatch，远端取消只有单次 best-effort。
- `getUserMedia` 悬置时 AbortSignal 无法及时结束启动；WebRTC 资源构造异常不在统一
  ownership try/catch 内。
- route/profile 改变只依赖 unmount cleanup，同一字幕 session 可能继续旧 route 或混用
  新旧 provider。

## 目标行为

- renderer 与 main 都从 `providerPreset + assignment + transport + route.model` 解析同一
  Realtime route definition；未知内置模型和 voice/caption family 交叉使用 fail closed。
- OpenAI 只展示原生 Realtime 字段；MiMo 只展示 `auto/zh/en` 与分块非 WebRTC 提示；
  永久不可用字段不进入 DOM。
- captions store v4 只持久化 sanitized preferences，所有 session/transcript/error 状态
  仅存在于当前 renderer 生命周期。
- route/profile 变化立即使旧 generation 失效并释放本地媒体；sync 后不得晚 dispatch。
- 麦克风授权可被 abort 竞速打断，迟到 stream 必须立即停止；本地媒体清理不得等待
  远端 stop/cancel IPC。
- recorded chunk cancel 与 session stop 使用不同幂等语义的 timeout/backoff/TTL 队列：
  chunk `cancelled:false` 在 task settle 前继续重试，session `stopped:false` 视为完成。

## 主要修改

- `src/lib/audio-provider-registry.ts`
- `src/store/tools/audio/realtimeCaptionsConfig.ts`
- `src/store/tools/audio/useRealtimeCaptionsStore.ts`
- `src/pages/Tools/Audio/RealtimeCaptions/index.tsx`
- `src/services/audio/audioRealtimeService.ts`
- `src/services/audio/boundedCleanupRetryQueue.ts`
- `electron/main/audio/realtime-ipc.ts`
- `test/audio/audioIpcService.test.ts`
- `test/audio/audioRealtimeSession.test.ts`
- `test/e2e.spec.ts`

## 验证

```text
node_modules/.bin/vitest run <7 focused captions/cleanup/main files> --reporter=dot
node_modules/.bin/vitest run --exclude test/e2e.spec.ts --reporter=dot
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'route-aware realtime captions expose only usable controls' --reporter=dot
git diff --check
```

结果：聚焦与全量非 Electron、TypeScript、四语言 i18n、Vite test build、Electron
交互及宽窄截图均通过；未运行 pnpm，lockfile 未修改。真实供应商/真实麦克风仍属于
`QA-R02`，不能由 fixture 或无设备 Electron 测试替代。

## 后续

双向语音迁移应复用完整 route resolver、可中断麦克风授权、generation snapshot 和
session stop queue；最后 standalone 消费者完成后再移除 legacy audio facade。
