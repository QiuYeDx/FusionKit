# 工作包 BE-002：Job Manager 与会话生命周期基础

## 基本信息

- 日期：2026-07-22
- 状态：进行中
- 对应执行计划工作包：`BE-002`
- 目标平台/硬件：跨平台 Electron main / Node 合同；未启动真实 native server、FFmpeg 或 Electron UI

## 本次认领边界

- 包含：app-scoped FIFO Job Manager、共享 task/resource revision、原子 capability commit、任务 IPC、取消/重试/移除、owner/app shutdown fence，以及 no-VAD CPU server identity 支持。
- 不包含：真实 MEDIA window → Supervisor → raw quality/retry → SUB-001 → SRT exporter 执行器、production Job Manager 实例化、renderer UI、VAD/下载/accelerator。

## 本次实现内容

- `LocalSubtitleSessionRegistry` 扩展为 task/resource 共用 revision cursor，支持 staged batch commit/rollback/publish、更新、移除、generation tombstone、事件订阅和 owner shutdown fence；task/resource 共用 per-session FIFO delivery queue，批量 envelope 在 drain 前一次性入队，listener 同步重入不能制造倒序 revision。同 generation 必须满足共享状态迁移、进度单调性和 immutable 字段约束，只有精确 `failed N -> queued N+1` 可进入新 generation。
- `LocalSubtitleJobManager` 提供单文件 CPU/no-VAD/SRT/export-only 首切片的原子入队、跨 owner FIFO、单活动执行、阶段进度、queued/running cancel、failed retry、terminal remove、artifact revoke 和 reentrant shutdown。enqueue/retry 在首个 await 前领取 app-scoped admission ticket，异步预检乱序完成不能改变执行顺序；每个 initial/retry generation 在调用 executor 前重新解析 managed model，并精确比较 storage/id/path/size/SHA-256 与冻结快照。
- capability reservation 新增同步 `commitAndRun()`；transaction 采用明确 phase，publishing 期间公开 rollback 不能撤销 lease，发布后重新校验 input/output lease，session publication/owner release/expiry 失败时私有补偿。thenable callback 被同步拒绝并吸收晚拒绝。
- Job Manager 从 capability commit 到 queued/running/failed-retry 全生命周期定时续租，并在 dequeue 与需要保留 retry authority 的失败终态前复验 exact input/output lease；已原子 commit 的合法 completed 结果优先于晚取消或晚 lease failure，不再做无意义的 terminal renewal。显式 `cancel_failed` 优先于普通 abort，单格式晚取消保持 `completed/full`。cleanup 遇单个 revoke/release 异常仍继续 fence、abort、释放其他资源并等待 active operation，最后返回首个错误；失败的 artifact/lease-renewal cleanup 保留标记，后续 shutdown 使用新的共享 operation 重试，成功后稳定缓存 resolved operation。
- 新增 Job/Session IPC bridge；snapshot handler 先订阅 task/resource event 再读取快照，避免 bootstrap 丢事件。
- shared Session Registry 的 Model/ResourceJob ownership 与 main lifecycle 重新分层，外部注入 registry 不再被 ModelManager 提前释放。
- server process contract 与 Supervisor 支持合法 no-VAD inference，并拒绝 VAD identity 与请求不一致、epoch 错误复用和同步失败后的 idle timer 回归。

## 修改文件

- `electron/main/local-subtitle/{job-manager,job-ipc,session-ipc,session-registry}.ts`
- `electron/main/local-subtitle/{authorizations,ipc,model-ipc,model-manager,resource-job}.ts`
- `electron/main/local-subtitle/{server-process-contract,server-supervisor}.ts`
- `electron/main/index.ts`
- `test/local-subtitle/{jobManager,jobManagerIpc,sessionRegistry,authorizations}.test.ts`
- `test/local-subtitle/{modelManager,modelManagerIpc,modelManifest,resourceJob}.test.ts`
- `test/local-subtitle/{serverProcessContract,serverSupervisor,mainRuntime}.test.ts`
- `src/type/localSubtitle.ts`、`src/type/localSubtitle.test.ts`
- `.agents/skills/fusionkit-pitfall-guard/references/{index,serialize-reentrant-session-event-delivery}.md`
- Final Design、本执行计划与本实施记录

## 接口或数据结构变化

- Session Registry 的 authoritative revision 现在同时覆盖 task 和 resource channel。
- Session batch publication 现在显式分为 `prepare -> commit -> publish`；capability 后置校验失败可在任何 listener 观察前回滚 authoritative batch/revision。
- Job Manager executor context 冻结 owner/batch/task/generation/config/model identity，并只允许受控工作阶段更新。
- foundation 首切片刻意拒绝多文件、GPU、translate、VAD、LRC 和翻译后动作；注入式 executor 测试仍覆盖公开 schema 的 source/custom 配置，但尚无 production Job Manager 实例。下一阶段 production factory 必须在 capability reservation/commit 前把首个真实纵向切片限制为 custom mode；可信 source-directory resolver 落地前不得执行 source，也不得先消耗 input draft 再从 executor 返回失败。其他被拒绝的合法公开 schema 组合不会消耗 draft capability。
- Supervisor load identity 允许 no-VAD inference，但 request 必须与 exact load VAD identity 一致。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- Supervisor 独立串行门禁：1 file / 26 passed tests。
- local-subtitle：31 passed + 2 skipped files / 559 passed + 2 skipped tests。
- 全量 Vitest：132 passed + 2 skipped files / 1511 passed + 2 skipped tests。
- TypeScript、renderer/main/preload 三段 Vite test build 通过；既有 chunk-size/dynamic-import warning 不影响结果。
- manifest：0 error / 0 warning；validator tests 17/17；diff check 通过。
- 高争用并行门禁曾触发两个不同的 Supervisor deadline fixture 失败；停止并行负载后，Supervisor 独立门禁、本地字幕和全量套件均串行通过，未观察到确定性产品回归。
- 默认跳过 2 个真实 server tests；未启动或遗留 Vite dev server、Electron、official server、FFmpeg 或下载任务。

## 未完成事项

- 实现 production executor，绑定 immutable PCM brand、structural window、windowAttempt、processEpoch、requestGeneration 和 response，完成 raw quality gate、受控 retry、canonical post-processing、SRT export 与 Artifact Registry activation。
- production factory 在 capability reservation/commit 前限制首切片为 custom output；未来只有接入可信 source-output 目录解析器后才能放开 source，不能从 renderer 或 displayName 派生真实输出路径。
- 在 `electron/main/index.ts` 实例化 Job Manager/Executor 并合并 Job IPC；owner release 必须先 fence Job Manager，Session Registry 必须最后释放。
- 真实流水线、production wiring 和对应回归验证闭环前，`BE-002` 保持 `进行中`。

## 下一步建议

- 先实现单文件 CPU/no-VAD/SRT production executor 和 identity-binding tests，再接入 main lifecycle；完成后运行完整 local-subtitle、全量 Vitest、TypeScript、根 Vite build、manifest/validator 与进程清理门禁。

## 后续进展

- 本记录保留 Job Manager foundation 当时的范围、未完成项与 559/1511 历史门禁。后续单文件 production executor、main wiring 与 session lifecycle 进展见 `2026-07-22_BE-002_production-executor-slice.md`；完整 BE-002 仍保持进行中。
