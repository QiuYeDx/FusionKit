# 工作包 BE-002：Batch Runtime Pin

## 基本信息

- 日期：2026-07-22
- 状态：已完成（unit/contract 范围；BE-002 总工作包仍进行中）
- 对应执行计划工作包：`BE-002`
- 目标平台/硬件：跨平台 Electron main / Node production contract；未启用真实 native server、FFmpeg、PRE-006 模型或 Electron UI

## 本次认领边界

- 包含：queue admission execution wave、Job Manager opaque runtime slice、Production Executor lazy pin、Supervisor exact-load-identity pin/pinned task lease、active-pin idle guard，以及 cancel/failure/retry/owner/shutdown/reentrancy 生命周期。
- 不包含：source output/多父目录、LRC/多格式、CUDA/Metal、VAD、translate、translation handoff、renderer UI、真实 native/packaged E2E。
- 保持上一份 `2026-07-22_BE-002_multi-file-batch-runtime-reuse.md` 为历史 checkpoint；本记录只描述其后的 batch pin 增量。

## 本次实现内容

- Job Manager 为每个 enqueue/retry 生成独立 admission sequence。同一 batch、同一 admission 中连续执行的 task 共享一个 main-only opaque runtime slice；slice 不能跨 retry admission 或其他 batch/owner 泄漏。
- slice 在 task 真正 dequeue、capability/model revalidation 成功后创建。Production Executor 继续先规范化当前媒体并逐 task 重验 server runtime，只有这些步骤成功后才向 Supervisor lazy acquire batch pin；queued task、失败后的长期 retry authority和 pending retry preflight 不占用模型。
- shared pin acquisition 由 slice signal 驱动；当前 task signal 只中止该 task 对共享 operation 的等待，不能撤销 sibling 仍持有的 acquisition，也不能清空已经冻结的 exact identity。
- Supervisor pin 绑定 owner、batchId 和完整 exact load identity，而不只绑定 runtime generation 或 artifact ID。identity 覆盖 runtime root/generation/target、server artifact path/hash/version/signature、managed model identity、backend 和 process options；每个 task 只能从该 pin 获取短生命周期 task lease。
- active pin 阻止 model load smoke、不兼容 load identity 和 idle callback 驱逐。task lease release 只结束当前 task 的调用 authority，不结束同一 execution wave 的 batch authority。
- task 普通失败、当前 task cancel、task-scope `cleanup_failed` 或 `cancel_failed` 后，只要同 admission 仍有 queued sibling 就保留 pin。取消超时可为安全退役 process epoch，但 pin 仍限制下一 sibling 只能恢复同一 exact load identity。
- batch/session scope failure 先 fence queued sibling，再关闭 slice。failed terminal 可继续持有 input/output retry capability lease，但不持有 runtime pin；显式 retry 使用新 admission，并在实际执行时重新 lazy acquire。
- terminal publication 后重新读取当前 task/run/queue 状态再决定是否关闭，覆盖同步 listener 内的 cancel/remove/retry/releaseOwner 重入。slice close 先从 Job Manager 当前状态中摘除并保持幂等，避免双重 close 或跨 admission 复用。
- owner release 和 app shutdown 先 fence admission/run、abort active acquisition/execution，再关闭匹配 slice并等待 operation 收敛。Supervisor owner release/shutdown 对已撤销 pin 和 task lease保持幂等；后续 cleanup phase 不因前序失败被短路。
- Supervisor 在进入 `ensureEpoch` 和不兼容旧 epoch 退役前即登记覆盖完整 acquire/finally 的 authoritative start operation；旧 epoch 退役后和创建新 private session 前再次校验 lease/signal，避免 shutdown 返回后出现 late session。
- 最后 pin 释放后，Supervisor 仍可按既有 warm idle policy 暂存 compatible zero-lease epoch。batch pin 保证 execution wave 内 identity 不被任意替换，不伪称取消超时或 runtime crash 时绝不发生安全重启。

## Pin 生命周期矩阵

| 场景 | Pin 行为 |
| --- | --- |
| 首个 task media/runtime preflight 尚未完成 | 不获取 |
| 同 admission 有 `running` 或 queued sibling | 保持 |
| 当前 task 普通失败、取消或 task-scope cleanup failure，仍有 sibling | 保持 |
| batch/session failure 已 fence sibling | 关闭一次 |
| 最后 runnable task terminal/cancelled | 关闭一次 |
| failed terminal 只保留 retry capability authority | 关闭 |
| 显式 retry | 新 admission；实际 dequeue 后重新 lazy acquire |
| owner release / app shutdown | fence/abort 后幂等关闭并等待收敛 |

## 修改文件

- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `electron/main/local-subtitle/server-supervisor.ts`
- `test/local-subtitle/jobManager.test.ts`
- `test/local-subtitle/jobManagerIpc.test.ts`
- `test/local-subtitle/productionExecutor.test.ts`
- `test/local-subtitle/serverSupervisor.test.ts`
- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- `.agents/skills/fusionkit-pitfall-guard/references/bind-batch-runtime-pins-to-queue-admission-slices.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- 本实施记录

## 接口或数据结构变化

- `LocalSubtitleJobTaskExecutor` 增加 batch slice 生命周期；`LocalSubtitleJobTaskExecutionContext` 携带 opaque `batchRuntime`，task 无法自行构造有效 runtime authority。
- `TaskRun` 携带 admission sequence；Job Manager 的 active slice 由 batch identity + admission sequence共同限定。
- Production Executor 私有记录绑定 owner、batch、immutable config/managed model、admitted runtime generation、exact runtime proof、pin acquisition 和 close 状态。
- Supervisor 增加 opaque `LocalSubtitleServerRuntimePin`、batch pin acquire/release 和 pinned task lease acquire；snapshot 增加 `runtimePinCount`，idle retirement同时检查 active request、runtime pin、process epoch 与 timer token。
- renderer DTO、public IPC channel 和持久化 schema不暴露 pin、load identity或绝对路径。

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
node scripts/local-subtitle/runtime/validate-runtime-staging.mjs
git diff --check
```

结果：

- 聚焦 Job Manager / Production Executor / Supervisor（含 real gate）：3 passed + 1 skipped files / 125 passed + 1 skipped tests。
- local-subtitle：33 passed + 2 skipped files / 654 passed + 2 skipped tests。
- 全量 Vitest：134 passed + 2 skipped files / 1606 passed + 2 skipped tests。
- TypeScript、renderer/main/preload 三段 Vite test build、PRE manifest 0 error / 0 warning、validator 17/17 与 diff check 通过。Vite 只有既有 dynamic-import/chunk-size warning。
- 覆盖健康多文件单 pin、task cancel/task-scope cleanup 后继续 sibling、task cancel 只退出 pending shared acquire waiter、retry 新 admission、pending acquire/close、incompatible epoch retirement 期间 owner release/shutdown settle 顺序、exact load proof drift、child lease/request 撤权、active pin 阻止 smoke/identity switch/idle callback，以及安全 epoch restart 后仍受 pin identity约束。
- 额外运行 canonical runtime staging gate，因 Git 忽略的 native runtime staging 目录不存在而按合同 fail closed；该结果与 2 个真实 native server tests 保持 skipped 一致，不是本轮 TypeScript/contract 回归。
- 本轮没有真实 FFmpeg + official server + PRE-006 模型、target hardware 或 packaged runtime E2E 证据。
- 未改依赖或 `pnpm-lock.yaml`，未运行 `pnpm`。

## 未完成事项

- source output/多父目录、LRC/多格式及 partial output组合、CUDA/Metal、VAD、translate、translation handoff、FE 和 native/packaged E2E 仍未完成。
- canonical native runtime staging 资源不在当前工作区；真实 runtime/模型/目标硬件矩阵仍由 `NATIVE-002` / QA 提供。
- 安全取消、runtime crash 或 unresponsive recovery 允许 process epoch重启；后续真实 native E2E需要验证重启后只恢复 pin 绑定的 exact identity。

## 下一步建议

- 继续 `BE-002` 的可信 source output/多父目录解析，再扩展 LRC/多格式与 partial output组合。
- 在 `NATIVE-002` / QA 阶段补真实 official server、多文件同模型、取消后安全重启和 packaged idle/owner cleanup 证据。
