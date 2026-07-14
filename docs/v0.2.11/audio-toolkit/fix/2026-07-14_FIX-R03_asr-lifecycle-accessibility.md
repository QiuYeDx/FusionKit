# FIX-R03：ASR capability 生命周期与 RadioGroup 可访问性收口

## 背景与现象

FE-R03 standalone ASR 竖切终审和 Electron 实测发现：

- 页面在 runtime config sync 尚未完成时已进入 running，取消可能先于 main 注册 requestId；
- route 变化或 SPA 离页会单次 fire-and-forget cancel 后丢失 active handle；
- 输入 token 撤销若被 `finally` await，IPC 悬挂会永久锁住 submission；
- 输出目录选择缺少同步锁、generation/unmount guard 和 renderer 可用的 revoke 通道；
- 用 `sr-only` Radix radio 外包可见 label 会造成文本拦截点击、roving tabindex 失效，
  Radix 默认行为也未覆盖产品要求的 Home/End。

## 根因或设计缺口

- renderer 任务服务只暴露一个最终 Promise，没有明确 sync/preflight 与 main dispatch 边界。
- SPA route unmount 不释放 webContents owner，不能把单次取消/撤销发送等同于已清理。
- output directory store 虽有 main 内部 revoke，但 preload 没有固定 internal capability 方法。
- 可见 segmented surface 和实际 Radix interactive primitive 被拆成了两个 DOM 层。

## 修复后行为

- 首轮 sync 和 stale resync 后、main dispatch 前检查 AbortSignal；未 dispatch 的取消不会
  触达 provider，已 dispatch 的显式取消使用 bounded attempt 和有限快速重试。
- route/unmount 在清 store 前把 requestId 同步交给跨路由 cancellation queue；
  `{ ok:false }`、`cancelled:false` 和单次 IPC hang 均保留 handle 重试，task settle 后清队列。
- 文件和目录 capability 先进入带 TTL/timeout 的 renderer 队列，再同步清 UI；submission
  finally 不等待 revoke。
- 输出目录选择锁住 A/B 并校验 generation、mounted、route snapshot；迟到 token 被撤销。
- RadioGroupItem 自身成为完整可见按钮；方向键由 Radix 管理，Home/End 在 group boundary
  显式实现，并验证焦点、checked state 与唯一 `tabindex="0"`。

## 影响文件和接口

- `src/services/audio/audioRuntimeConfigService.ts`
- `src/services/audio/audioTranscriptionService.ts`
- `src/pages/Tools/Audio/AudioTranscriber/index.tsx`
- `src/components/ui/radio-group.tsx`
- `src/type/audioIpc.ts`
- `electron/preload/index.ts`
- `electron/main/audio/ipc.ts`
- `electron/main/audio/audio-output-directory.ts`
- renderer/main/store/Electron tests

新增 preload-private `audio:internal:revoke-output-directory`；未加入 public audio channel
allowlist，renderer 只能通过固定 `audioApi.revokeOutputDirectory()` 使用。

## 验证命令与结果

```text
node_modules/.bin/vitest run src/services/audio/audioServices.test.ts test/audio/audioIpcService.test.ts test/audio/audioFile.test.ts test/audio/audioOutputDirectory.test.ts test/audio/audioPreloadChannelPolicy.test.ts --reporter=dot
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'route-aware audio transcription renders usable fields and reauthorizes consumed input files' --reporter=dot
git diff --check
```

- cancellation preflight/stale-resync、cancel queue、hung attempt、owner isolation、幂等 revoke、
  same-version hydration 和 consume failure replay tests 通过。
- Electron 首次暴露 pointer interception，第二次暴露 End key 缺口；修复后第三次完整通过。
- 两张宽窄截图人工审查通过，最终无 FusionKit Vite/Electron 残留进程。

## 后续建议

- 实时字幕与双向语音迁移继续复用 bounded lifecycle queue，不重新实现单次
  fire-and-forget cleanup。
- segmented Radix controls 复用 `FK-PIT-0012`：primitive 本身必须是完整交互面，不能用
  forced click 或只断言 aria state 掩盖 pointer/focus 问题。
