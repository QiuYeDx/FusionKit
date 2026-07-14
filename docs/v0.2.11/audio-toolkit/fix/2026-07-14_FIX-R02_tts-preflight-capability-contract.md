# FIX-R02：TTS 预检、Capability 与约束合同终审修复

- 日期：2026-07-14
- 状态：已完成
- 对应：`audio-toolkit-config-ux-refactor / FE-R02`

## 背景与现象

FE-R02 终审发现四类边界：voice clone 可被同步双击复用一次性 token；重新授权期间
切换 mode 会让旧 constraints 提交到新 UI；撤销 `{ ok: false }` 被当成成功并在 SPA
离页后丢失 handle；320px 侧栏中的横向 dropzone 会裁切英文按钮。另有 MiMo 页面未
限制 4096 字符、public IPC 才拒绝的前后端合同漂移，以及 v4 hydration/实际生成矩阵
覆盖不足。最终代码终审还发现生成中离页只失效 request id、没有退出
`running/streaming` 状态，返回页面后会永久锁住生成操作。

## 根因

- task 状态到 `beginTask` 才建立，授权预检前没有同步互斥与配置快照。
- cleanup 只捕获 rejected Promise，没有检查 discriminated `AudioIpcResult.ok`；React
  unmount 不等于 Electron webContents owner release。
- speech 长度上限分别存在于 public validator 和部分 provider constraints。
- 通用 dropzone 只提供横向布局，FE-R02 截图没有停留在 clone 模式。
- cleanup 清空 `activeRequestId` 后，迟到响应会被正确忽略，但 Store 任务状态没有同步
  结束；持久 Store 在组件重新挂载后仍报告任务运行中。

## 修复后行为

- 提交入口以 ref 同步互斥，预检/授权/运行期间锁定配置；授权返回后校验
  profile/provider/route/mode/sourceFile，失效任务撤销 token 后静默退出。
- token 在清 UI 前进入 renderer 级撤销队列；resolved failure 与 rejection 均保留并
  退避重试，`{ ok: true, revoked: false }` 按幂等成功清队列。
- input/instructions 使用共享 4096 常量；所有 speech route、renderer、public IPC 和
  main route validator 使用同一合同。
- clone dropzone 使用 stacked 布局；E2E 验证其在固定侧栏内不溢出并保存专用截图。
- `invalidateTask` 在 request id 匹配时原子清空活动请求并将运行态转为 `cancelled`；
  不清用户偏好、已有结果或输出目录授权，stale cleanup 也不会取消更新的请求。

## 影响文件

- `src/pages/Tools/Audio/SpeechSynthesizer/index.tsx`
- `src/pages/Tools/_shared/ui/ToolFileDropZone.tsx`
- `src/services/audio/audioRuntimeConfigService.ts`
- `src/store/tools/audio/speechSynthesizerConfig.ts`
- `src/store/tools/audio/useSpeechSynthesizerStore.ts`
- `src/lib/audio-provider-registry.ts`
- `src/type/audio.ts`、`src/type/audioIpc.ts`
- `electron/main/audio/ipc.ts`
- speech/registry/IPC/service tests 与 `test/e2e.spec.ts`

## 验证结果

```text
node_modules/.bin/vitest run src/store/tools/audio/useSpeechSynthesizerStore.test.ts src/lib/audio-provider-registry.test.ts src/type/audioIpc.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts test/audio/audioIpcService.test.ts src/services/audio/audioServices.test.ts --reporter=dot
node_modules/.bin/vitest run --exclude test/e2e.spec.ts --reporter=dot
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts --reporter=dot
git diff --check
```

- 定向 6 files / 113 tests、全量非 Electron 85 files / 727 tests 通过；Store 回归覆盖
  非流式/流式离页 cleanup 后重新提交，以及 stale cleanup 不影响新请求。
- Electron 1 file / 4 tests 通过；OpenAI 实际生成与 MiMo 三模式 × stream on/off
  全部到达 fake provider，双击只产生一个请求，四语言无 raw key。
- TypeScript、四语言各 1514 keys、renderer/main/preload build 与 diff check 通过。
- 4 张 FE-R02 截图已审查；Electron/Vite/fake server 最终进程表为空。

## 后续

`FE-R03` 的 ASR 文件授权应复用撤销队列与一次性 token 重新授权模型；实时字幕和双向
语音在 assignment/profile 变化时继续使用 generation + teardown，不能只依赖 UI 禁用。
