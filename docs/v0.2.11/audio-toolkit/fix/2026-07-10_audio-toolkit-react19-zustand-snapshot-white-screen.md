# FIX-001：React 19 / Zustand selector 快照不稳定导致音频页白屏

- 日期：2026-07-10
- 严重程度：Critical
- 状态：已完成
- 影响页面：音频转文本、文本转音频、实时字幕、双向语音

## 背景和观察到的问题

进入任意一个新音频工具页后，页面立即白屏，renderer 控制台先后出现：

```text
The result of getSnapshot should be cached to avoid an infinite loop
Maximum update depth exceeded
```

四个页面自身的 Zustand selector 大多只返回 store 中已有的 primitive、对象、数组或 action 引用；共同崩溃点位于所有页面都会挂载的 `AudioToolShell`。

## 根因

修复前的共享壳层直接把派生 resolver 放进 Zustand selector：

```tsx
useModelStore((state) =>
  resolveAudioToolConfigSummary(state, assignmentKey),
);
```

`resolveAudioToolConfigSummary()` 每次调用都会创建新的 summary 对象；未配置分支还会创建新的空 `capabilities` 数组，就绪分支会创建新的 `connectionProfile` 对象。即使 Zustand state 没有变化，同一个 external-store snapshot 连续读取也得不到 `Object.is` 相等的结果。

React 19.1.1 与 Zustand 5 的 `useSyncExternalStore` 因此把同一快照识别为持续变化，先警告 selector 结果需要缓存，再不断重渲染，最终触发最大更新深度保护。持久化 rehydrate 可能出现在调用链附近，但不是根因。

## 修复后的目标行为

- 同一组 `profiles`、`audioProfiles`、`audioAssignment` 引用必须返回同一个 `AudioToolConfigSummary` 对象。
- 只有这三个相关 slice 中至少一个引用变化时，才重新计算 summary。
- 每个 `assignmentKey` 使用独立且稳定的 selector 实例。
- 四个音频路由均可在 Electron 中完成真实 React 挂载，不产生 snapshot、最大深度、`pageerror` 或 renderer console error。

## 实现摘要

1. 新增 `createAudioToolConfigSummarySelector(assignmentKey)`，按三个相关 store slice 的引用缓存最后一次 summary。
2. `AudioToolShell` 使用 `useMemo` 为当前 `assignmentKey` 创建 selector，再交给 `useModelStore` 订阅。
3. 新增 referential-stability 回归测试：同一 state、以及只替换外层 state 但保持三个 slice 引用不变时，selector 必须用 `toBe` 返回同一个对象；相关 slice 改变后才生成新对象。

仅稳定 selector 函数身份不能修复问题；单纯 shallow compare 也不足以保证 resolver 内嵌的新数组/对象稳定。

## 修改文件

- `src/pages/Tools/Audio/shared/AudioToolShell.tsx`
- `src/store/tools/audio/audioToolConfig.ts`
- `src/store/tools/audio/audioToolConfig.test.ts`
- `docs/v0.2.11/audio-toolkit/fix/2026-07-10_audio-toolkit-react19-zustand-snapshot-white-screen.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-10_FIX-001_AUDIT-001_audio-pages-stability-audit.md`

## 验证结果

执行命令：

```text
<bundled-node> node_modules/vitest/vitest.mjs run src/store/tools/audio/audioToolConfig.test.ts
<bundled-node> node_modules/typescript/bin/tsc --noEmit
<bundled-node> node_modules/vitest/vitest.mjs run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/audioTranscriberConfig.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts src/store/tools/audio/realtimeCaptionsConfig.test.ts src/store/tools/audio/realtimeVoiceConfig.test.ts
<bundled-node> scripts/check-i18n.mjs
<bundled-node> node_modules/vite/bin/vite.js build --mode=test
git diff --check
```

结果：

- selector 定向测试通过：1 file / 4 tests。
- TypeScript 检查通过。
- 音频相关完整离线回归通过：19 files / 111 tests。
- i18n 完整性检查通过：9 namespaces，四语言各 1371 keys；仅保留 5 条专名/格式名相同 warning。
- Vite test build 通过：renderer、Electron main、preload 均构建成功；仅保留既有 chunk size 和动态/静态 import warning。
- Electron 四路由 smoke 通过：等待 `.app-loading-wrap` 与 `#app-loading-style` 移除后，四个页面标题均可见，且没有 renderer console error 或 `pageerror`。
- `git diff --check` 通过。

## 未覆盖与后续

- 本次完成的是白屏根因修复，不代表四页业务链路已达到发布质量。
- 宽/窄窗口截图矩阵的第二轮 Electron 启动因本轮 GUI 审批额度耗尽未执行；首轮四路由真实挂载与控制台验证已通过。
- 四页剩余问题、优先级和后续工作包见 `fix/2026-07-10_audio-toolkit-four-page-release-audit.md`。
