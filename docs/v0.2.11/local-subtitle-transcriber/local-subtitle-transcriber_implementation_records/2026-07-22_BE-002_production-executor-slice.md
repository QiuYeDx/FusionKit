# 工作包 BE-002：单文件 Production Executor 与 Session Lifecycle 接线

## 基本信息

- 日期：2026-07-22
- 状态：进行中
- 对应执行计划工作包：`BE-002`
- 目标平台/硬件：跨平台 Electron main / Node production 合同；本轮未启动真实 native server、FFmpeg 或 Electron UI

## 本次认领边界

- 包含：在既有 Job Manager foundation 上完成单文件 CPU/transcribe/no-VAD/custom/SRT/export-only production executor、入队前 bundled media runtime admission、MEDIA → Supervisor → SUB → exporter identity binding、稳定 cleanup error、main/IPC wiring 与三阶段 session lifecycle。
- 不包含：多文件批量、source output/多父目录、LRC/多格式、CUDA/Metal、VAD、translate、translation handoff、renderer UI、真实 FFmpeg + official server + PRE-006 模型 native E2E 或 packaged 验收。

## 本次实现内容

- `LocalSubtitleJobManager.enqueue()` 在 capability reservation/commit 前并行完成 managed model resolve、input draft resolve 与 owner-bound `MediaNormalizer.verifyRuntime()`。runtime admission 对 bundled media manifest 做第一次静态校验，依次启动 FFmpeg/ffprobe 精确 `-version` 探针，再做第二次静态校验并拒绝 runtime generation 漂移；失败不消耗 input/output draft。
- `LocalSubtitleProductionExecutor` 只接受单文件 CPU/transcribe/no-VAD/custom/SRT/export-only context。它一次规范化源媒体、规划 root windows、验证 server runtime generation、获取 CPU Supervisor lease，并按真实阶段发布 preparing/loading/transcribing/post-processing/exporting progress。
- 每个 inference dispatch 绑定 normalizationId、完整 structural descriptor、不可复用 branded window、task/generation、前后 resolved path/file identity/size/SHA-256、root-plan-local `windowAttempt`、Supervisor `processEpoch`、实例级单调 `requestGeneration` 与 response generation。window/normalization swap、brand reuse、file proof drift、stale/reused response 均在进入 canonical output 前拒绝。
- raw window 先通过 SUB-001 quality assessment；退化窗口只按 exact child geometry 递归拆短，预算失败保持结构化错误。成功 attempt graph 进入 canonical post-processing，不通过 formatter 或字符串去重掩盖 decoder loop。
- server inference request 新增冻结的 `expectedFileIdentity`；HTTP client 在任何网络请求前以 `open + fstat` 精确复核，并在上传期间持有同一 file handle。Model Manager 与 executor 共用 CPU server artifact selector。
- 每个 materialized window 在 finally 中 dispose。canonical transcript 形成后仍先 all-settled 地 release Supervisor lease 和 dispose normalized PCM；required cleanup 失败会阻止 export。cleanup 成功后才从 batch output lease 原子导出 SRT，output stem 同时处理 Windows `CON`/`NUL` 等保留名和 255-byte leaf 上限。
- shared error manifest 新增 `cleanup_failed`。没有取消证据的 required cleanup failure 使用 `cleanup_failed`；只有存在 abort/cancel 证据才使用 `cancel_failed`。Exporter 在真实 partial unlink、hard-link detach 与 rollback 路径直接执行该分类；executor 对上下游 cleanup code 按取消证据对称归一化；Job Manager 在普通 abort/cancel 分支前结算两类 cleanup failure，即使非法 artifact result 需要安全回退也保留 cleanup 分类、释放 lease 并拒绝同 session retry。
- `LocalSubtitleSessionLifecycle` 固定 owner release 为 Job → Media → Server → Model → Registry；app shutdown 固定 Job+Model quiesce → Media+Supervisor cleanup → Registry finalize。各阶段 all-settled，保存首错但继续后续清理。MainRuntime、SessionLifecycle 与 ServerAppLifecycle 都在调用 target 前缓存共享 Promise，避免同步 reentry 创建第二个 shutdown operation。
- `electron/main/index.ts` 已实例化 output authorization、capability lease coordinator、exporter、production executor、Job Manager 与 Session Lifecycle。Session/Model/Job public handler 由 main 显式合并一次，Session bridge 单独 attach，不再由 Model/Job bridge 重复 spread snapshot handler。

## 修改文件

- `electron/main/index.ts`
- `electron/main/local-subtitle/{production-executor,session-lifecycle,job-manager,job-ipc,main-runtime,media-normalizer,model-manager,model-ipc,resource-path}.ts`
- `electron/main/local-subtitle/{server-app-lifecycle,server-contract,server-http-client,server-supervisor,subtitle-post-processor}.ts`
- `src/type/localSubtitle.ts`、`src/type/localSubtitle.test.ts`
- `test/local-subtitle/{productionExecutor,sessionLifecycle,jobManager,jobManagerIpc,mainRuntime,mediaNormalizer}.test.ts`
- `test/local-subtitle/{modelManager,modelManagerIpc,resourcePath,serverAppLifecycle,serverContract,serverHttpClient,serverSupervisor}.test.ts` 及对应 real contract tests
- Final Design、Execution Plan、版本入口/台账与本实施记录

## 接口、状态或数据结构变化

- `LOCAL_SUBTITLE_ERROR_CODES` / manifest 新增 task-scoped、cleanup-stage、retryable 的 `cleanup_failed`。
- `LocalSubtitleServerInferenceRequest` 新增必填 `expectedFileIdentity: { dev, ino, size, mtimeMs, ctimeMs }`，Supervisor snapshot 与 HTTP transport 均保留该精确身份。
- `LocalSubtitleMediaNormalizer` 新增 owner-bound `verifyRuntime()` admission API，只返回通过完整 attestation 的 `runtimeGeneration`。
- production executor 的 `requestGeneration` 在实例生命周期内单调，不因新 task/execute 调用重置；`windowAttempt` 仍只属于当前 root plan。
- production factory 在 capability reservation 前拒绝多文件、source output、GPU、translate、VAD、LRC 和非 export-only 配置，其他合法但尚未实现的公开 schema 组合不会消耗 draft capability。

## 安全、隐私与许可证检查

- 路径/capability：renderer 未获得 input/output/model/temp raw path；custom output 只通过 main-owned batch lease 解析。window request 绑定 main-only brand 与 expected file identity，HTTP 发起前再次复核。
- 日志/持久化：未新增媒体、字幕、prompt、token、路径或完整命令行持久化；runtime admission 只使用既有有界诊断合同。
- 第三方来源与许可：未更换 PRE-006 engine/model/media pin，未新增 binary、下载 URL 或许可证；真实 packaged artifact 仍由 `NATIVE-002` / QA 验收。

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

- local-subtitle：33 passed + 2 skipped files / 602 passed + 2 skipped tests。
- 全量 Vitest：134 passed + 2 skipped files / 1554 passed + 2 skipped tests。
- TypeScript 通过。
- renderer/main/preload 三段 Vite test build 通过；只有既有 chunk-size/dynamic-import warning。
- manifest：0 errors / 0 warnings；validator tests 17/17；diff check 通过。
- 2 个 skip 均为未启用的真实 native server 测试，不代表 packaged/target-hardware 证据。
- 本轮未启动 Vite dev server、Electron、official server、FFmpeg 或下载任务，没有新增常驻服务需要清理。

## 产生的证据

- production executor 新增 19 项测试，覆盖 happy path、exact split retry、normalization/window/brand/file proof drift、stale response、runtime generation drift、取消、双向 cleanup classification、Supervisor release failure、Windows 保留名/255-byte 边界、跨 execute 单调 generation，以及跨 root/retry 的 raw segment/text 累计预算。
- session lifecycle 新增 4 项测试，覆盖 owner release 顺序、三阶段 shutdown、前序失败后继续清理和同步 reentry Promise identity。
- 其余 Job/Media/Model/Server/Main IPC 合同测试覆盖 runtime admission、expected file identity、cleanup error precedence 与 wiring 回归。
- 未产生 benchmark、截图、native binary、模型、媒体、字幕或本地路径证据。

## 未完成事项与风险

- 多文件批量、逐文件失败隔离、batch-level pause/terminate 和完整模型复用矩阵尚未实现。
- source output 仍缺可信 authorized parent-directory resolver、多父目录与单目录不可写隔离；不得从 displayName 或 renderer path 推导。
- LRC/多格式及 partial output 组合、CUDA/Metal、VAD、translate 和非 export-only path 尚未接通。
- translation handoff 属 `LINK-006`～`LINK-008`，renderer UI 属 `FE-001`～`FE-004`，startup orphan scan 属 `BE-003`，final native bytes/packaged E2E 属 `NATIVE-002` 与 QA。
- 当前验证是 production code 的 unit/contract harness，不是实际 FFmpeg + official server + PRE-006 模型的 native E2E；M2 尚未达成。

## 下一步建议

- 继续 `BE-002`：优先把当前 custom CPU/SRT executor 扩为多文件批量与逐文件失败隔离，再单独实现可信 source output/多父目录；LRC/多格式、CUDA/Metal、VAD 与 translate 按依赖逐步接入。
- 完整 BE-002 验收、FE 和真实 native E2E 闭环前，工作包和 M2 都保持进行中。
