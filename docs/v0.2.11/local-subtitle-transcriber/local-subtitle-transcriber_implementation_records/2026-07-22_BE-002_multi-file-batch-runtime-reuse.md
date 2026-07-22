# 工作包 BE-002：多文件批次与 Runtime 复用 Checkpoint

## 基本信息

- 日期：2026-07-22
- 状态：进行中
- 对应执行计划工作包：`BE-002`
- 目标平台/硬件：跨平台 Electron main / Node production contract；未启用真实 native server、FFmpeg 或 Electron UI

## 本次认领边界

- 包含：最多 100 文件的 custom CPU/transcribe/no-VAD/SRT/export-only 批次、原子 admission/publication、app-global FIFO、逐文件失败隔离、owner 分区 capability renewal、admitted runtime generation、compatible server warm epoch 与生命周期回归。
- 不包含：严格 batch runtime pin、source output、多格式、CUDA/Metal、VAD、translate、translation handoff、renderer UI、真实 FFmpeg + official server + PRE-006 模型 native E2E 或 packaged 验收。

## 本次实现内容

- Job Manager 从单文件限制扩展到 domain schema 的 100 文件上限。整批 input/output capability 使用一个 reservation transaction；所有 task 与 batch authoritative state 先 commit，再以连续 revision 一次性发布，任一 commit 前失败都释放 ID reservation、回滚 capability 和 registry state。
- 每个 enqueue/retry 在首个异步预检前领取 app-global admission ticket并预留 batch/task ID。一个 batch 的 task 按输入顺序进入 FIFO；较早 admission 即使预检较慢也不会被后来的 owner 超车。owner release 可同步跳过 pending/ready admission，不让已释放 owner 阻塞后续工作。
- 同批 input token 在 commit 前按 exact filesystem identity 去重。每个 task 独立持有 input lease，共享一个 batch output lease；output 只有在最后一个仍需 retry/执行 authority 的 sibling 结束、失败 authority 被撤销或任务被移除后才释放。
- task scope error 只结算当前文件并继续 sibling；batch/session scope error 在首个失败发布前把 queued sibling fence 为 terminal 并从队列移除，随后按输入顺序发布同一稳定错误。同步 listener 的 cancel/remove/retry/owner release 不能在半结算状态插入新的执行。
- capability operation tail、计数和 renewal timer 按 owner 分区；每个 timer 只重挂自己的 owner。一个 owner 的 pending renewal/retry 不会阻塞其他 owner 的 admission、execution 或下一轮 TTL renewal。shutdown 尝试取消全部 timer并保留首错，失败的 cancel handle 留给后续 shutdown 重试。
- enqueue admission 冻结 main-only `runtimeGeneration` 并随 immutable batch 保存；Production Executor 同时比较 admitted、normalized 与当前 server runtime generation，在启动 Supervisor 前拒绝漂移。
- Supervisor 在最后 task lease release 后保留 compatible `ready/leaseCount=0` process epoch 到 idle timeout。matching inference lease 复用 PID/model；不兼容 identity 先 retire。resident owner 只登记当前 inference epoch，model smoke 不登记；epoch 成功 finalize 后清空，并在活动 lease 重启新 epoch 时重建所有 compatible owner。
- idle timer 使用 captured epoch + token 双重 guard，同 epoch reacquire 或重新 arm 后的旧 callback 无效。background idle cleanup failure 锁存 `faulted`，下一 acquire 明确失败，shutdown 可重试；它不追溯改变已完成 task。真实 Supervisor contract test 已改为先验证 warm ready，再通过 owner release 验证 private session 清理。

## 修改文件

- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `electron/main/local-subtitle/server-supervisor.ts`
- `test/local-subtitle/{jobManager,productionExecutor,serverSupervisor,serverSupervisor.real}.test.ts`
- `.agents/skills/fusionkit-pitfall-guard/references/{index,partition-owner-admission-and-lease-renewal,bind-warm-process-epochs-to-owners-and-timer-tokens}.md`
- Final Design、Execution Plan 与本实施记录

## 接口或数据结构变化

- `LocalSubtitleJobTaskExecutionContext` 新增 main-only `admittedRuntimeGeneration`，renderer/IPC schema 不暴露该字段。
- Job Manager 的 queue admission 从单个 `run` 扩展为同批有序 `runs`，但公开 batch/task DTO 与 IPC channel 不变。
- Supervisor 的 `release(lease)` 只释放调用 authority；最后 lease 后 `state: ready, leaseCount: 0` 是合法 warm 状态。`releaseOwner()`、不兼容 acquire、idle timeout 和 app shutdown 仍可退役 epoch。
- 当前 warm epoch 是性能复用策略，不是 batch ownership lock；不能据此宣称严格“同批模型只加载一次”。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/jobManager.test.ts test/local-subtitle/productionExecutor.test.ts test/local-subtitle/serverSupervisor.test.ts test/local-subtitle/serverSupervisor.real.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- 聚焦 Job Manager / Production Executor / Supervisor：3 passed + 1 skipped files，101 passed + 1 skipped tests。
- local-subtitle：33 passed + 2 skipped files，630 passed + 2 skipped tests。
- 全量 Vitest：134 passed + 2 skipped files，1582 passed + 2 skipped tests。
- TypeScript、renderer/main/preload 三段 Vite test build、manifest 0 error / 0 warning、validator 17/17 与 diff check 通过。
- Vite 只有既有 dynamic-import/chunk-size warning；未改依赖或 `pnpm-lock.yaml`，未运行 `pnpm`。
- 2 个 skip 是未启用的真实 native server tests，不代表 native/packaged E2E 已通过。
- 本轮未启动 Vite dev server、Electron、official server、FFmpeg 或下载任务。

## 未完成事项

- Production Executor 仍逐 task acquire/release Supervisor lease。warm epoch 可覆盖无干扰 FIFO 快路径，但 sibling 之间仍可能被 Model Manager smoke、不兼容 acquire 或超过 idle timeout 的慢 export 驱逐；严格同批一次模型加载尚未闭环。
- source output/多父目录、LRC/多格式与 partial output 组合、CUDA/Metal、VAD、translate 和 translation handoff 尚未实现。
- 当前证据是 unit/contract harness；真实 FFmpeg + official server + PRE-006 模型、target hardware 与 packaged runtime 留给 `NATIVE-002` / QA。

## 下一步建议

- 继续 `BE-002`，先设计并实现 main-only batch pin/shared admission：pin 必须绑定 batch/owner/load identity，允许同批 task 间复用并阻止 smoke/不兼容 load/idle timeout 驱逐，同时不能让失败 task 的长期 retry authority永久占用 server。
- 为 sibling 间插入 model smoke、不兼容 load、cancel/owner release、cleanup failure 和超时补集成回归；闭环后再实现可信 source output resolver。
