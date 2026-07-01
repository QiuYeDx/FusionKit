# FIX: 长文本翻译工具 — 事件订阅级联风暴与批量翻译缺陷

- **日期**: 2026-06-24
- **分类**: fix
- **严重程度**: Critical
- **状态**: 已完成
- **涉及文件**:
  - `src/pages/Tools/Text/TextTranslator/index.tsx`
  - `src/store/tools/text/useTextTranslatorStore.ts`
  - `src/utils/toast.ts`
  - `src/type/textTranslationIpc.ts`
  - `electron/main/text-translation/text-translation-service.ts`
  - `test/text-translation/service/textTranslationService.e2e.test.ts`

---

## 问题现象

用户选择两个文件（`.md` + `.txt`）进行独立文件批量翻译后，点击"开始翻译":

1. **页面闪烁**: 两个任务的选中态（高亮）在任务队列列表中频繁来回切换
2. **无限循环弹出错误**: 右上角不断弹出 `"All text translation segments failed."` 的错误通知，根本停不下来
3. **主线程卡顿**: 整个应用变得极度卡顿，几乎无法响应用户操作

---

## 根因分析

共定位 **6 个缺陷**，它们相互叠加形成恶性循环。

### BUG-001: 事件订阅 useEffect 级联重订阅 [Critical]

**位置**: `index.tsx` L304-357

```tsx
useEffect(() => {
  return subscribeTextTranslationEvents({
    progress: (event) => {
      // 读取闭包中的 task 和 queuedTasks
      setTask({ ...task, progress: event.progress, ... });
      upsertQueuedTask({ ...queuedTask, ... });
    },
    // ...
  });
}, [activeTaskId, queuedTasks, /* ... */ task, upsertQueuedTask]);
//                ^^^^^^^^^^^^              ^^^^
//   这两个变量在事件处理器内被修改 → 依赖变化 → effect 重跑
```

**级联过程**:

1. 主进程 emit `progress` 事件
2. 事件处理器调用 `setTask()` / `upsertQueuedTask()` → Zustand store 更新
3. `task` 或 `queuedTasks` 引用变化 → useEffect 依赖不等 → cleanup（取消旧订阅）→ setup（创建新订阅）
4. 新订阅用新闭包，但如果此刻又有事件到达 → 回到步骤 2

**在并行翻译（3 并发分片）时**:
每秒可能有数十个 progress 事件。每个事件都触发一次完整的 unsubscribe+subscribe 循环（6 个 IPC 通道的 on/off），同时触发 React re-render。这直接导致:
- 主线程被大量 listener 注册/注销 + 渲染占满 → **UI 卡顿**
- 每次 re-subscribe 的 task/queuedTasks 闭包可能含上一轮的过期值 → **闪烁**

### BUG-002: 闭包过期数据覆写 [High]

**位置**: `index.tsx` L311-329 (progress handler)

```tsx
progress: (event) => {
  const queuedTask = queuedTasks.find(item => item.taskId === event.taskId);
  if (queuedTask) {
    upsertQueuedTask({ ...queuedTask, progress: event.progress, ... });
    //                  ^^^^^^^^^^^^ 闭包中的旧值
  }
  if (!task || event.taskId !== task.taskId) return;
  setTask({ ...task, progress: event.progress, ... });
  //         ^^^^  闭包中的旧值
},
```

`task` 和 `queuedTasks` 是 effect 闭包捕获的快照。在 rapid progress 事件场景下：

- 事件 A 到达 → `setTask({...task_v0, progress: A})`
- 事件 B 到达（effect 还没 re-run）→ `setTask({...task_v0, progress: B})` — 覆盖了 A 的其他字段
- effect re-run → 新闭包 task_vB → 但其他字段可能丢了 A 的更新

这造成 UI 上的 task 详情"跳变"，加剧闪烁。

### BUG-003: 重复错误 Toast [Medium-High]

**位置**: 
- `index.tsx` L338-342 (taskFailed 事件处理器)
- `index.tsx` L552-554 (handleStart 中 IPC 返回路径)

当任务失败时，错误通知被触发**两次**:

1. **事件路径**: 主进程 `emitTaskFailed()` → IPC 事件到达 → `taskFailed` handler → `showToast(error.message, "error")`
2. **返回路径**: `startTextTranslationTask()` Promise 解析 → `handleIpcError()` → `showToast(error.message, "error")`

结合 BUG-001 的级联重订阅，在 cleanup/re-subscribe 间隙可能出现事件重复投递到新 handler，使 toast 数量进一步翻倍。

### BUG-004: taskFailed 事件处理器未更新队列 [Medium]

**位置**: `index.tsx` L338-342

```tsx
taskFailed: (event) => {
  if (activeTaskId && event.taskId !== activeTaskId) return;
  setLastError(toUiError(event.error, task?.phase));
  showToast(event.error.message, "error");
  // ❌ 缺少: upsertQueuedTask — 队列列表不会显示 "失败" 状态
},
```

队列中的任务 badge 不会更新为 "失败"，用户看不到哪个任务出了问题。

### BUG-005: 批量启动首个失败即终止 [Medium-High]

**位置**: `index.tsx` L548-556

```tsx
for (const queuedTask of tasksToStart) {
  const started = await startTextTranslationTask({ taskId: queuedTask.taskId });
  if (!started.ok) {
    handleIpcError(started.error, queuedTask.phase);
    return;  // ❌ 第一个失败就退出循环，后续任务不会被尝试
  }
  // ...
}
```

当第一个文件翻译失败时（例如 API 不可用），第二个文件根本不会被启动。用户期望所有文件都被尝试。

### BUG-006: Toast 无去重/限流 [Medium]

**位置**: `src/utils/toast.ts`

Sonner toast 默认对相同消息不做去重。结合 BUG-001 的级联 + BUG-003 的双触发，大量相同消息的 toast 堆叠，进一步加重渲染负担和视觉混乱。

### BUG-007: 启动失败阶段使用启动前快照 [High]

**位置**: `index.tsx` `handleStart()`

独立批量任务启动时，`startTextTranslationTask()` 失败后原逻辑调用：

```tsx
handleIpcError(started.error, queuedTask.phase);
```

`queuedTask.phase` 是启动前的 `waiting/estimating` 快照，而主进程实际已经进入 `translating`。因此用户看到的错误阶段被误报为“估算”，即截图中的：

```text
All text translation segments failed.
阶段：估算
```

### BUG-008: 后台任务失败污染当前任务详情 [High]

独立文件批量任务共享一个 `lastError`。某个后台任务失败后，旧逻辑会无条件把错误写入全局 `lastError`；当另一个任务仍在运行时，详情区可能显示前一个任务的错误，造成“当前运行任务也失败”的错觉。

### BUG-009: 全分片失败缺少可诊断摘要 [Medium]

主进程把所有分片失败统一压缩成：

```text
All text translation segments failed.
```

没有返回阶段、首个分片错误码或首个分片错误消息。真实失败可能是模型 API 401/429/5xx、网络超时、Markdown 协议解析失败、placeholder mismatch 或模型输出被截断；旧消息无法帮助用户或开发者判断下一步。

---

## 修复方案

### FIX-001: 事件订阅 useEffect 解耦状态依赖

将 `task` 和 `queuedTasks` 从 effect 依赖中移除。事件处理器内改用 `useTextTranslatorStore.getState()` 读取最新值:

```tsx
useEffect(() => {
  return subscribeTextTranslationEvents({
    taskUpdated: (event) => {
      const { activeTaskId } = useTextTranslatorStore.getState();
      upsertQueuedTask(event.task);
      if (activeTaskId && event.taskId !== activeTaskId) return;
      setTask(event.task);
    },
    progress: (event) => {
      const { task: currentTask, queuedTasks: currentQueue } = useTextTranslatorStore.getState();
      const queuedTask = currentQueue.find(item => item.taskId === event.taskId);
      if (queuedTask) {
        upsertQueuedTask({ ...queuedTask, phase: event.progress.phase, progress: event.progress, updatedAt: event.occurredAt });
      }
      if (!currentTask || event.taskId !== currentTask.taskId) return;
      setTask({ ...currentTask, phase: event.progress.phase, progress: event.progress, updatedAt: event.occurredAt });
    },
    taskCompleted: (event) => {
      const { activeTaskId } = useTextTranslatorStore.getState();
      upsertQueuedTask(event.task);
      if (activeTaskId && event.taskId !== activeTaskId) return;
      setTask(event.task);
      setOutputPaths(event.outputPaths);
      showToast(t("translator.messages.completed"), "success");
    },
    taskFailed: (event) => {
      const { activeTaskId, task: currentTask, queuedTasks: currentQueue } = useTextTranslatorStore.getState();
      // 更新队列中的失败任务
      const queuedTask = currentQueue.find(item => item.taskId === event.taskId);
      if (queuedTask) {
        upsertQueuedTask({ ...queuedTask, status: "failed" });
      }
      if (activeTaskId && event.taskId !== activeTaskId) return;
      setLastError(toUiError(event.error, currentTask?.phase));
      // 不在这里 showToast — 由 IPC 返回路径统一处理
    },
    fileCompleted: (event) => {
      const { activeTaskId } = useTextTranslatorStore.getState();
      if (activeTaskId && event.taskId !== activeTaskId) return;
      setOutputPaths([event.outputPath]);
    },
  });
  // 依赖列表中只保留稳定引用
}, [setLastError, setOutputPaths, setTask, t, upsertQueuedTask]);
```

### FIX-002: 批量启动 — 不因单个失败中止

```tsx
const handleStart = async () => {
  // ...
  try {
    let hasError = false;
    for (const queuedTask of tasksToStart) {
      const started = await startTextTranslationTask({ taskId: queuedTask.taskId });
      if (!started.ok) {
        handleIpcError(started.error, queuedTask.phase);
        hasError = true;
        continue;  // ✅ 继续下一个任务
      }
      // ...
    }
  } finally {
    setIsStarting(false);
  }
};
```

### FIX-003: Toast 去重

在 `showToast` 中添加消息+类型去重机制（1 秒内相同消息只弹一次）。

### FIX-004: 失败事件携带任务快照和错误阶段

`TextTranslationTaskFailedEvent` 新增失败后的 `task` 快照；`TextTranslationIpcError` 新增可选 `phase` 字段。主进程在全分片失败时返回：

- `error.phase = "translating"`
- `error.details.failedSegments`
- `error.details.firstFailure`
- `event.task.status = "failed"`
- `event.task.phase = "translating"`

Renderer 优先使用事件和错误里的阶段，不再从启动前队列快照推断。

### FIX-005: `lastError` 绑定 `taskId`

`TextTranslatorUiError` 新增 `taskId`。详情页只展示当前选中任务对应的错误：

```tsx
const visibleLastError =
  lastError && (!lastError.taskId || lastError.taskId === task?.taskId)
    ? lastError
    : null;
```

后台任务失败仍会更新队列状态和 toast，但不会污染正在查看或正在运行的其它任务详情。

### FIX-006: 批量启动失败后拉取最新任务状态

`handleStart()` 遇到单任务启动失败时，会调用 `getTextTranslationTaskDetail()` 获取主进程最新任务快照并更新队列，再使用 `failedTask.phase ?? started.error.phase ?? "translating"` 记录错误阶段。之后继续启动后续等待任务。

### FIX-007: 聚合错误包含首个失败摘要

主进程全分片失败时，错误消息补充首个失败摘要：

```text
All text translation segments failed. First failure: <sanitized summary>
```

同时在 `details.firstFailure` 中返回 `segmentId`、`errorCode` 和截断后的短消息。该摘要不包含源正文或完整模型返回。

---

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts
pnpm exec vitest run src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts src/type/textTranslation.test.ts
pnpm exec vitest run test/text-translation
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

结果：

- Service E2E 通过：1 个文件 / 14 个测试，其中新增覆盖“全分片失败时 phase=translating、task-failed 带任务快照和首个失败详情”。
- 共享类型/IPC 回归通过：3 个文件 / 15 个测试。
- 完整 text-translation 回归通过：16 个文件 / 135 个测试。
- `pnpm exec tsc --noEmit` 通过。
- `pnpm run i18n:check` 通过，8 个 namespace、四语言各 926 个 key。
- `pnpm build` 通过；仅保留既有动态/静态 import、chunk size、package description、macOS signing identity 与 APFS DMG 提示。
- `git diff --check` 通过。

---

## 验收清单

- [x] 事件订阅不再依赖 `task` / `queuedTasks` 闭包，不会因 progress 事件级联重订阅
- [x] 即使 API 不可用导致全部分片失败，错误 toast 有去重
- [x] 第一个文件失败后，第二个文件仍会被尝试翻译
- [x] 任务失败后队列列表中对应任务显示“失败”状态
- [x] 全分片失败返回 `phase=translating`，不再误报为“估算”
- [x] 后台任务错误按 `taskId` 过滤，不污染当前任务详情
- [ ] 真实 UI 点击/拖拽和真实模型手工验证仍需在 `QA-MD-001` 或后续手工验收中覆盖
