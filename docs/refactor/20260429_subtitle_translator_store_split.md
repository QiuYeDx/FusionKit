# Q-05：`useSubtitleTranslatorStore` 拆分评估与实施方案

## 背景

`TODO.md` 的 Q-05 记录了“拆分 `useSubtitleTranslatorStore.ts`（18KB），抽离任务执行逻辑到独立 service 层”。当前文件实际约 623 行，已经不是单纯的 store：

- 维护翻译器配置：`sliceType`、`sliceLengthMap`、`outputURL`
- 维护 5 个任务队列：`notStartedTaskQueue`、`waitingTaskQueue`、`pendingTaskQueue`、`resolvedTaskQueue`、`failedTaskQueue`
- 实现并发调度：最多 5 个任务并发，超出进入 waiting
- 直接调用 IPC：`translate-subtitle`、`cancel-translation`
- 处理主进程事件回写：进度、失败、完成输出路径
- 触发 UI 反馈：`showToast`、i18n 文案
- 处理持久化迁移：`fusionkit-subtitle-translator`

该 store 目前被以下入口直接使用：

- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`：页面读取队列和触发任务动作
- `src/renderer/subtitle.ts`：接收 IPC 事件后更新队列
- `src/agent/tool-executor.ts`：Agent 工具入队翻译任务
- `src/store/agent/useAgentStore.ts`：统一执行 Agent 入队任务

## 结论

建议做 Q-05，但应按“稳定外部 API、抽离队列状态机和 IPC 执行副作用”的方式渐进拆分，而不是一次性重写字幕翻译页面。

合理性：

1. 当前 store 同时包含状态、调度算法、IPC 副作用、Toast，职责边界过宽。
2. 队列调度是业务规则，适合抽成可测试的 service / domain 函数。
3. 完成与失败路径存在重复调度逻辑，继续堆在 store 里会放大维护成本。
4. 直接在 Zustand `set()` 回调中执行 IPC，使逻辑难以单元测试，也增加状态变化和副作用交织的风险。

不建议做成“大重构”：

- 不改页面组件的使用方式，先保留 `useSubtitleTranslatorStore()` 对外字段和方法名。
- 不动主进程 `electron/main/translation/translation-service.ts`，Q-05 只处理 renderer 侧队列和执行入口。
- 不把 converter/extractor 一起重构进来，最多后续复用 queue service 的模式。

## 目前值得顺手修的风险

1. `addFailedTask` 的等待队列拉起条件使用了失败任务移除前的 `pendingTaskQueue.length < MAX_CONCURRENCY`。当 pending 正好等于并发上限时，一个任务失败后理论上有空位，但当前逻辑不会拉起 waiting 里的下一个任务。
2. `updateProgress` 在 `resolvedFragments === totalFragments` 时会把任务移到 resolved；`task-resolved` 又会调用 `markTaskResolved`。目前靠合并逻辑兼容事件先后，但完成调度逻辑重复，后续容易产生双启动 waiting 任务的风险。
3. `startTask`、`startAllTasks`、`updateProgress`、`addFailedTask`、`cancelTask`、`markTaskResolved` 都有“更新队列 + 启动下一个任务”的相似分支，缺少统一入口。
4. `window.ipcRenderer` 直接散落在 store 中，Vitest 中需要 mock 浏览器全局才能覆盖队列逻辑。

## 推荐目标结构

建议新增 renderer 侧 service 目录，明确它和主进程 `TranslationService` 不是同一个层级：

```text
src/services/subtitle/
  translatorQueueService.ts        # 纯队列状态机：输入旧 state，输出新 state 和待执行副作用
  translatorExecutionService.ts    # IPC 适配：start/cancel 翻译任务

src/store/tools/subtitle/
  useSubtitleTranslatorStore.ts    # Zustand facade：配置持久化 + 调 service + 保持旧 API
```

如果暂时不想新增 `src/services`，也可以把两个 service 文件放在 `src/store/tools/subtitle/services/`。但从命名上看，Q-05 的目标是抽离 service 层，放到 `src/services/subtitle/` 更清晰。

## 职责边界

### `translatorQueueService.ts`

只处理纯数据，不 import React、Zustand、i18n、toast、`window.ipcRenderer`。

建议导出：

```ts
export interface TranslatorQueueState {
  notStartedTaskQueue: SubtitleTranslatorTask[];
  waitingTaskQueue: SubtitleTranslatorTask[];
  pendingTaskQueue: SubtitleTranslatorTask[];
  resolvedTaskQueue: SubtitleTranslatorTask[];
  failedTaskQueue: SubtitleTranslatorTask[];
}

export type TranslatorQueueEffect =
  | { type: "start"; task: SubtitleTranslatorTask }
  | { type: "cancel"; fileName: string };

export interface TranslatorQueueResult {
  state: TranslatorQueueState;
  effects: TranslatorQueueEffect[];
}
```

核心函数：

- `addTask(state, task)`
- `updateTaskCostEstimate(state, fileName, costEstimate)`
- `startTask(state, fileName, maxConcurrency)`
- `startAllTasks(state, maxConcurrency)`
- `retryTask(state, fileName)`
- `completeTaskProgress(state, payload, maxConcurrency)`
- `resolveTask(state, fileName, outputFilePath, maxConcurrency)`
- `failTask(state, errorData, maxConcurrency)`
- `cancelTask(state, fileName, maxConcurrency)`
- `deleteTask(state, fileName)`
- `clearTasks(state)`
- `removeAllResolvedTasks(state)`

其中“拉起 waiting 中下一个任务”应统一放在一个内部 helper，例如 `promoteWaitingTaskIfSlotAvailable()`。

### `translatorExecutionService.ts`

只做 renderer 到 main 的 IPC 适配，集中管理 channel 字符串：

```ts
export function startSubtitleTranslation(task: SubtitleTranslatorTask) {
  return window.ipcRenderer.invoke("translate-subtitle", task);
}

export function cancelSubtitleTranslation(fileName: string) {
  window.ipcRenderer.send("cancel-translation", fileName);
}
```

后续如果做 A-02 IPC 类型安全，可以优先从这里替换 channel 契约，不需要再搜索 store 内的字符串。

### `useSubtitleTranslatorStore.ts`

保留现有对外 API：

- 队列字段名不变，避免改页面和 Agent 调用方。
- `startTask`、`startAllTasks`、`cancelTask` 等方法名不变。
- `persist` 配置不变，仍只持久化 `outputURL`。
- Toast 可以暂时留在 store facade，避免把 i18n/UI 反馈混入纯队列 service。

store action 的推荐流程：

1. 从当前 store 中取出 `TranslatorQueueState`
2. 调用 queue service 得到 `{ state, effects }`
3. `set(state)`
4. 统一执行 effects：`startSubtitleTranslation()` / `cancelSubtitleTranslation()`
5. 必要时在 facade 中显示 Toast

## 实施步骤

### 第一步：抽纯队列 service

新增 `src/services/subtitle/translatorQueueService.ts`，先迁移不依赖 IPC 的函数：

- `addTask`
- `updateTaskCostEstimate`
- `retryTask`
- `updateTask`
- `deleteTask`
- `removeAllResolvedTasks`
- `clearTasks` 的纯队列清理部分

这一步不改变行为，只减少 store 内代码量。

### 第二步：抽执行 service

新增 `src/services/subtitle/translatorExecutionService.ts`，把以下调用集中：

- `window.ipcRenderer.invoke("translate-subtitle", task)`
- `window.ipcRenderer.send("cancel-translation", fileName)`

store 中不再直接出现 IPC channel 字符串。

### 第三步：统一调度状态机

把以下逻辑迁移到 queue service：

- `startTask`
- `startAllTasks`
- `updateProgress`
- `addFailedTask`
- `cancelTask`
- `markTaskResolved`

同时消除重复的“完成/失败/取消后拉起 waiting 任务”分支。这里应修正失败时不拉起 waiting 的问题：先从 pending 中移除失败任务，再判断剩余 pending 是否小于并发上限。

### 第四步：补单元测试

建议新增 Vitest 测试，优先覆盖纯队列 service：

```text
src/services/subtitle/translatorQueueService.test.ts
```

最低覆盖用例：

- 添加重复文件时不改变队列，并返回 duplicate 标记
- pending 未满时 `startTask` 进入 pending 并返回 start effect
- pending 已满时 `startTask` 进入 waiting
- `startAllTasks` 只启动剩余并发额度内的任务，其余进入 waiting
- `completeTaskProgress` 完成任务后能拉起 waiting 中第一个任务
- `resolveTask` 在 progress 先完成、`task-resolved` 后到达时只补充 `outputFilePath`
- `failTask` 在 pending 满载时失败一个任务后能拉起 waiting
- `cancelTask` 发送 cancel effect，并把任务转 failed
- `clearTasks` 对每个 pending 任务返回 cancel effect

### 第五步：回归验证

至少执行：

```bash
pnpm test
pnpm build
```

手工回归建议：

1. 添加 6 个以上字幕翻译任务，确认前 5 个 pending，第 6 个 waiting。
2. 任意完成/失败/取消一个 pending，确认 waiting 自动补位。
3. 任务完成后能打开输出文件位置，`outputFilePath` 没丢。
4. 清空任务会取消所有 pending，不会留下等待队列。
5. Agent 入队后 `auto_execute` / `ask_before_execute` / `queue_only` 行为不变。

## 验收标准

- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`、`src/agent/tool-executor.ts`、`src/store/agent/useAgentStore.ts` 的调用方式不需要改，或只做非常薄的 import/命名调整。
- `useSubtitleTranslatorStore.ts` 中不再直接写 IPC channel 字符串。
- 队列状态变化主要由 `translatorQueueService.ts` 覆盖，service 不依赖 DOM、Zustand、i18n。
- 完成、失败、取消三条路径共用同一个 waiting 补位逻辑。
- `persist.partialize` 仍只持久化 `outputURL`，任务队列不持久化。
- 单元测试覆盖关键队列状态转移，`pnpm build` 通过。

## 优先级建议

Q-05 值得做，优先级应高于继续给字幕翻译器叠新功能，但低于会影响用户当前流程的 bug 修复。推荐在下一次修改字幕翻译执行链路前先完成，否则后续每加一个状态或事件都要继续扩大这个 store。
