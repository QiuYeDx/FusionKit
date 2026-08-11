# 本地字幕转写修复：串行媒体准入、增量草稿探测与扁平任务总量限制

## 背景与现象

本地字幕转写在已有任务执行时存在两个直接影响可用性的问题：

1. 追加文件会让全部 draft task 的格式、时长、音轨等媒体信息短暂回到 loading，像是整张任务列表被重新读取。
2. 追加文件或点击“全部开始”可能让原本正在执行的任务失败，并显示 `limit_exceeded`。

进一步审计还发现，产品层已经移除“转写批次”概念，但 main session registry 仍保留最多
10 个内部 batch 的旧限制。用户多次开始少量任务后，也可能从另一个入口收到同一个
`limit_exceeded`。

## 根因

### Renderer 全量重建媒体状态

页面原先在 `selectedFiles` 每次变化时清空显式音轨选择，并为所有文件重建
`{ status: "loading" }`。即使只追加一个文件，既有文件的 ready/error 探测结果也会丢失，
随后所有文件重新进入串行 `probeMedia` 队列。

### Main 同 owner 媒体操作 fail-fast

`LocalSubtitleMediaNormalizer` 为每个 owner 只允许一个原生媒体操作，这是正确的资源边界；
但原实现遇到第二个操作时立即抛出 `limit_exceeded`。以下正常操作全部共享该门禁：

- draft `probeMedia`；
- enqueue-time `verifyRuntime`；
- committed task `normalizeTask`；
- PCM window `materializeWindow` / `resolveWindow`。

因此追加文件、开始新任务与正在执行任务的下一个 PCM window 会竞争同一 ticket。竞争失败
的一方被错误地当成“超过产品限制”，造成非确定性的任务失败。

### 遗留 batch 数量限制

扁平任务队列仍通过内部 batch 保存原子配置和授权事务，但用户不可见的
`maxSessionBatches = 10` 被继续当作产品容量。它既不符合当前 UI 语义，也会让第 11 次
小规模提交无端失败。

## 修复方案

### 1. 按 fileToken 增量维护 draft 状态

- 新增纯函数按稳定 `fileToken` reconcile 探测结果；既有 ready/error 对象保持不变，只为
  新增文件创建 loading 状态，移除文件时只裁剪对应记录。
- 显式音轨选择采用相同的增量裁剪语义，不因追加文件被清空。
- 页面只把 `addedFiles` 放入探测队列；队列执行前后都会确认 token 仍在当前草稿中，避免
  已移除文件的迟到响应复活。
- 只有最新队列链完成时才清除全局 pending 标记，避免较早 Promise 的 finally 覆盖后续
  追加操作。

### 2. 保持单原生操作并改为有界串行等待

- 继续保持 `maxConcurrentOperationsPerOwner = 1`，不通过提高 FFmpeg/文件操作并发掩盖竞态。
- 同 owner 的后续媒体操作进入最多 8 项的 abort-aware 等待队列；active operation 结束后
  依次重新竞争唯一准入位。
- owner release、owner fault 和 shutdown 会同时取消 active 与 queued operation；清理会
  等待两类 settlement，避免悬空 promise 或私有媒体会话泄漏。
- 等待队列真正饱和时返回可重试 `resource_busy`。`limit_exceeded` 仅保留给文件大小、媒体
  时长、音轨数、PCM/字幕/响应预算和安全整数等真实版本化边界。

### 3. 以总任务数限制扁平会话

- 新增 `maxSessionTasks = 1_000`，session registry 在提交时按既有任务总数校验。
- 内部 batch 上限提高到同样的防御性 1,000，使 11 次以上的小任务提交不会触发隐藏限制；
  单次仍保持最多 100 文件。
- 总任务上限 1,000 与旧的 `10 × 100` 最坏容量相同，不扩大任务资源预算。
- Artifact Registry 容量改为由 `maxSessionTasks × outputFormats` 推导，避免内部 batch 上限
  调整后把产物容量意外扩大 100 倍。

## `limit_exceeded` 审计结论

除上述两个错误入口外，其余 main 侧同名错误均对应真实边界：输入授权数量/字节、媒体
文件/PCM/RIFF大小、媒体时长/音轨数、转写响应段数/文本字节、字幕 cue/文本、产物 registry
容量、资源任务数和 revision 安全整数。没有在 renderer 增加盲目重试或全局吞错逻辑。

## 回归覆盖

- Media Normalizer：同 owner probe 串行、enqueue-time runtime verification 等待 active
  media、committed normalization 等待 draft probe、队列饱和返回 `resource_busy`、owner
  release 同时取消 active/queued；原生并发峰值始终为 1。
- Renderer model/page：追加文件保持既有 probe 对象和音轨选择，只探测新增文件，不再出现
  全量 map reset。
- Session Registry：11 次一任务提交成功；达到 1,000 个总任务后才以 `tasks` 字段拒绝真实
  overflow；Artifact Registry 既有容量回归继续通过。
- Job Manager、Production Executor、runtime IPC、session summary、TypeScript 均通过。
- 三段 Vite test build 与 sandboxed preload external-module 检查通过。
- 隔离用户目录的真实 Electron 验收：追加第二个有效 WAV 期间，MutationObserver 记录的第一
  个任务行始终保留 `WAV` 元数据，从未退回“读取信息中”；两个文件最终均完成 probe。

## 不变边界

- 不修改其他工具页及其组件。
- 不改变公开 IPC channel、owner session、task lease 或内部 batch 原子配置快照语义。
- 不提高同 owner 原生媒体并发，不把 `limit_exceeded` 改成通用可重试错误。
- 没有模型的隔离 Electron 环境不能执行真实 whisper 推理；任务执行与追加/开始竞态由
  Media Normalizer、Job Manager 和 Production Executor 的组合回归覆盖。
