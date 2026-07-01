# 批量添加大字幕文件 UI 卡顿排查与修复方案

日期：2026-04-29

## 结论

批量添加大字幕文件时的 UI 卡顿，主要由渲染线程同步执行精确 token 预估导致。当前上传流程在 React 事件处理函数内完成文件读取、精确分片模拟、`gpt-tokenizer.encode` 计算，并且对同一文件执行了两次完整预估。文件越大、批量数量越多、敏感模式分片越多，主线程被占用的时间越长，最终表现为窗口无法及时响应点击、滚动和渲染更新。

需要把 token 预估从渲染主线程移出，任务应先入队并显示“预估中”，精确预估在后台 worker 中完成后再回填队列。

## 当前调用链

入口位于 `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx` 的 `handleFileUpload`：

1. 选择文件或拖拽文件后进入 `handleFileUpload`。
2. 循环处理 `FileList`，文件之间只用 `setTimeout(0)` 让步一次。
3. `await file.text()` 读取整份字幕内容。
4. 调用 `estimateSubtitleTokensFast(...)` 生成首屏费用预估。
5. 调用 `addTask(newTask)` 把完整 `fileContent` 写入 Zustand 队列。
6. 再调用 `estimateSubtitleTokens(...).then(...)` 回填精确费用预估。

关键代码位置：

- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx:578`：逐文件循环。
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx:580`：只在文件之间让步，无法拆开单个大文件的 CPU 长任务。
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx:620`：读取完整文件内容。
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx:627`：同步调用 `estimateSubtitleTokensFast`。
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx:667`：再次调用 `estimateSubtitleTokens`。
- `src/utils/tokenEstimate.ts:50`：`estimateSubtitleTokensFast` 是同步函数。
- `src/utils/tokenEstimate.ts:72`：`estimateSubtitleTokens` 虽然声明为 `async`，但函数体内没有真正的异步边界，`buildSubtitleTokenEstimate` 会在返回 Promise 前同步执行。

## 根因分析

### 1. 精确预估在渲染线程同步执行

`estimateSubtitleTokensFast` 和 `estimateSubtitleTokens` 都会调用 `buildSubtitleTokenEstimate`。该函数内部会：

- 模拟 LRC/SRT 分片。
- 对整份字幕计算 source tokens。
- 对每个分片构造 prompt。
- 对每个 prompt 再执行 `gpt-tokenizer.encode`。

相关代码：

- `src/utils/tokenEstimate.ts:18`：`countTokens` 直接调用 `encode(text).length`。
- `src/utils/subtitleTokenEstimateCore.ts:76`：LRC 分片逐行 token 化。
- `src/utils/subtitleTokenEstimateCore.ts:121` 和 `src/utils/subtitleTokenEstimateCore.ts:133`：SRT 分片按块和候选片段重复 token 化。
- `src/utils/subtitleTokenEstimateCore.ts:281`：先分片。
- `src/utils/subtitleTokenEstimateCore.ts:287`：再统计整文 token。
- `src/utils/subtitleTokenEstimateCore.ts:288`：逐分片构造 prompt 并 token 化。

这些工作都在浏览器渲染主线程执行。`async` 包装不会自动把 CPU 计算挪到后台线程。

### 2. 同一文件被完整预估两次

上传时先执行 `estimateSubtitleTokensFast`，随后又调用 `estimateSubtitleTokens`。当前两者都使用同一套精确 tokenizer 和同一套 `buildSubtitleTokenEstimate`，因此对大文件基本是重复 CPU 开销。

这次重复调用来自之前为了统一“首屏预估”和“执行分片”口径的修复。准确性问题解决了，但上传路径的主线程成本也随之显著增加。

### 3. 文件之间让步不能解决单个大文件长任务

`if (i > 0) await new Promise((r) => setTimeout(r, 0));` 只会在两个文件之间把控制权还给事件循环。单个文件内部的分片和 token 化仍是一段不可中断的同步计算。一个大 SRT/LRC 文件就足以造成长任务。

### 4. 大字符串驻留 renderer state 是次要放大因素

`SubtitleTranslatorTask` 当前保存完整 `fileContent`，任务入队后大字符串会一直存在于 Zustand 状态中，开始翻译时还会通过 IPC 传给主进程。它不是本次卡顿的第一根因，但会放大内存占用和跨进程拷贝成本。大批量场景下也会影响后续渲染和 GC。

## 推荐修复方案

### 方案 A：使用 Web Worker 执行 token 预估，推荐

新增 renderer 侧 worker，把精确 token 预估从 UI 主线程移走。页面只负责快速校验和入队，预估结果异步回填。

建议新增文件：

```text
src/workers/subtitleTokenEstimate.worker.ts
src/services/subtitle/subtitleTokenEstimateWorkerClient.ts
```

worker 侧职责：

- import `buildSubtitleTokenEstimate` 和 `gpt-tokenizer`。
- 接收 `jobId`、文件内容、分片配置、语言、输出模式、价格配置。
- 执行精确预估。
- 返回 `{ jobId, fileName, estimate }`。
- 捕获异常并返回 `{ jobId, fileName, error }`。

client 侧职责：

- 持有单个 worker 实例。
- 维护 FIFO job 队列，默认并发 1，避免批量添加时把 CPU 打满。
- 支持取消或忽略过期 job。
- 把 worker 的结果分发给 `updateTaskCostEstimate`。

Vite 中 worker 创建方式建议放在普通 TS 模块内，使用相对路径：

```ts
const worker = new Worker(
  new URL("../../workers/subtitleTokenEstimate.worker.ts", import.meta.url),
  { type: "module" },
);
```

页面上传流程调整为：

1. 读取文件内容。
2. 构建任务，`costEstimate` 先写入 loading 状态。
3. 立即 `addTask(newTask)`，让 UI 尽快显示任务。
4. 调用 worker client 入队预估。
5. worker 返回后回填 `costEstimate`。

loading 结构可以复用现有字段：

```ts
const loadingCostEstimate = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedCost: 0,
  fragmentCount: 0,
  loading: true,
};
```

需要删除上传路径里的两处同步预估：

- 不再调用 `estimateSubtitleTokensFast(...)`。
- 不再直接调用当前 `estimateSubtitleTokens(...)`。

如果仍保留同步函数，建议重命名为 `estimateSubtitleTokensSync`，避免后续误以为 `async` 版本不会阻塞 UI。

### 方案 B：临时改用主进程 IPC 预估，只适合短期止血

项目已有 `estimate-subtitle-tokens` IPC handler。上传后可以通过 `window.ipcRenderer.invoke("estimate-subtitle-tokens", ...)` 把计算挪出 renderer，UI 卡顿会明显缓解。

但这不是推荐终态：

- CPU 计算会阻塞 Electron main process，可能影响窗口、菜单、其他 IPC 和翻译任务调度。
- 大字幕内容会通过 IPC 从 renderer 复制到 main process，增加内存峰值。
- 后续如果多个大文件同时预估，main process 仍可能变成新的瓶颈。

如果需要快速止血，可以先落地该方案，同时把 worker 方案作为正式修复。

### 方案 C：任务改为文件路径驱动，作为长期优化

更彻底的方向是让翻译任务保存文件路径和元数据，不在 renderer state 中长期保存完整 `fileContent`：

- renderer 只保存 `originFileURL`、`fileName`、大小、输出路径、配置。
- worker 或 main process 按路径读取文件并预估。
- 真正开始翻译时 main process 按路径读取文件，不再通过 IPC 传递大字符串。

这可以同时降低 renderer 内存占用、Zustand 状态体积和 IPC 拷贝成本。但改动会影响 Agent 入队、翻译执行、错误恢复和测试，建议放在 worker 修复之后单独做。

## 具体落地步骤

1. 新增 `subtitleTokenEstimate.worker.ts`，复用 `buildSubtitleTokenEstimate`，确保预估口径不变。
2. 新增 `subtitleTokenEstimateWorkerClient.ts`，封装 job 队列、`jobId`、回调、错误处理。
3. 修改 `SubtitleTranslator/index.tsx`：
   - 上传任务先入队。
   - `costEstimate` 使用 loading 状态。
   - 删除同步 `estimateSubtitleTokensFast` 调用。
   - 删除直接 `estimateSubtitleTokens(...).then(...)` 调用。
   - 改为调用 worker client。
4. 增加 stale result 防护：
   - job 中带上 `estimateKey`，由 `fileName + sliceType + customSliceLength + sourceLang + targetLang + translationOutputMode` 组成。
   - worker 返回后，只有当前任务配置仍匹配时才回填结果。
   - 用户编辑任务配置或删除任务后，旧 job 结果应被忽略。
5. 可选优化队列写入：
   - 为 store 增加 `addTasks(tasks)`，批量文件校验后一次或小批量入队，减少连续 `set` 和重复渲染。
   - 至少在上传循环中维护本批次 `seenFileNames`，避免同一批文件内重复文件名反复走 store duplicate 分支。
6. 保留主进程 `update-progress` 对 `costEstimate.fragmentCount` 的修正逻辑，作为真实执行口径的兜底。

## 验收标准

功能验收：

- 批量选择多个大 LRC/SRT 文件后，任务条目应快速出现，token 和费用区域显示“预估中”。
- 预估完成后自动更新 token、费用和分片数量。
- 用户在预估过程中仍能滚动页面、展开任务、点击按钮。
- 删除任务或编辑任务配置后，旧预估结果不会覆盖新状态。
- 开始翻译时仍使用真实分片数量，进度条和任务详情保持一致。

性能验收：

- 上传路径不再直接调用 `estimateSubtitleTokensFast` 或当前同步版 `estimateSubtitleTokens`。
- Chrome Performance 中，批量上传期间 renderer main thread 不应再出现由 token 预估造成的连续长任务。
- 以 10 个以上大字幕文件作为手工样本，上传期间 UI 不应出现秒级冻结。

测试建议：

```bash
pnpm exec vitest run src/utils/tokenEstimate.test.ts src/services/subtitle/translatorQueueService.test.ts
pnpm exec tsc --noEmit
```

如新增 worker client 的纯队列逻辑，应补充单元测试覆盖：

- job 按顺序执行。
- worker 成功结果能回填。
- worker 失败能把 loading 状态清掉或显示错误。
- stale job result 被忽略。
- 删除任务后返回结果不重新写入队列。

## 风险与注意事项

- Worker 内仍要复用 `subtitleTokenEstimateCore`，不能重新实现一套分片算法，否则会再次出现预估和执行不一致。
- 不建议在上传时恢复旧的字符启发式预估作为正式数值。可以显示 loading 或标记为粗略值，但不要把粗略分片数量当成准确结果。
- 如果 worker 和 renderer 之间传递完整字符串，仍有一次结构化克隆成本。相比主线程同步 token 化，这个成本可接受，但长期仍建议改为路径驱动。
- worker job 并发不宜过高。默认 1 个 worker 最稳，必要时再根据 CPU 核心数开放配置。
