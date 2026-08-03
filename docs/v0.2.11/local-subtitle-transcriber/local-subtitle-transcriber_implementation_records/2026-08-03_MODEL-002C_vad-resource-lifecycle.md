# 工作包 MODEL-002C：VAD resource lifecycle

## 基本信息

- 日期：2026-08-03
- 状态：已完成（顶层`MODEL-002`继续进行中）
- 对应执行计划工作包：`MODEL-002`
- 目标平台/硬件：macOS arm64与Windows x64共享代码合同；未执行真实公网VAD下载或native server load smoke

## 本次认领边界

- 包含：VAD manifest、managed-resource list/install/delete/resolve、private roots、下载/磁盘预检、exact tree与size/SHA、CPU VAD load smoke、原子提交、失败回滚、busy delete、取消与shutdown、ModelManager/main聚合接线。
- 不包含：production `vadEnabled=true`、JobManager/FE配置放开、启动孤儿`.part`/staging扫描、真实模型/VAD/native smoke、FE-002与目标机产品验收。

## 本次实现内容

- 新增strict/deep-frozen `local-subtitle-vad.v1.json`与parser，固定Silero VAD v6.2.0 GGML、whisper.cpp exact revision、allowlisted HTTPS URL、885,098 bytes、SHA-256、MIT、`bundledInInstaller=false`、`tokenTimestampsAllowed=false`与`mapped_segment_timestamps_only`。
- 新增独立`LocalSubtitleVadManager`，复用共享`LocalSubtitleResourceJobManager`、session revision registry和allowlisted resumable downloader；renderer仍只提交manifest `resourceId`，不新增IPC channel或URL/path参数。
- 使用private `vad`、`vad-staging`和共享`downloads` roots；安装前确认ready managed首发模型并预检空间，下载后固定写入VAD文件与冻结`manifest.json`，对exact two-file tree执行no-follow size/SHA和前后file identity复核。
- `vad_load_smoke`只允许verified CPU-capable official server、`managed`主模型和`managed_staging` pinned VAD；descriptor固定追加`--vad-model`与`--no-gpu`，readiness成功后立即retire/cleanup，不执行inference。
- smoke前再次解析主模型，缺少ready主模型时下载前失败且job可重试；VAD smoke前后均复核staging内容。
- VAD目录no-clobber原子发布，提交后执行不可取消的全量复验；失败时把最终目录按identity receipt隔离到staging并重试清理，不发布半成品。
- install/delete使用同步跨owner claim；删除前后检查busy，目录先隔离再递归删除。Windows递归删除使用有界`maxRetries/retryDelay`；shutdown Promise在abort前缓存并等待ResourceJob、verification、delete和cleanup收敛。
- `LocalSubtitleModelManager`经既有list/install/delete/resolve API聚合VAD；生产main busy guard同时检查JobManager、Supervisor `modelId`和`vadModelId`。旧测试只注入`smokeModelLoad`时不创建VAD manager，保持既有边界。

## 修改文件

- `resources/local-subtitle/manifests/local-subtitle-vad.v1.json`
- `electron/main/local-subtitle/vad-manifest.ts`
- `electron/main/local-subtitle/vad-manager.ts`
- `electron/main/local-subtitle/server-process-contract.ts`
- `electron/main/local-subtitle/server-supervisor.ts`
- `electron/main/local-subtitle/model-manager.ts`
- `electron/main/index.ts`
- `src/type/localSubtitle.ts`
- `test/local-subtitle/vadManifest.test.ts`
- `test/local-subtitle/vadManager.test.ts`
- `test/local-subtitle/serverProcessContract.test.ts`
- `test/local-subtitle/serverSupervisor.test.ts`
- Final Design、Execution Plan与本实施记录

## 接口、状态或数据结构变化

- server purpose新增`vad_load_smoke`；其load identity同时绑定exact runtime/server、managed主模型与staged VAD identity。
- Supervisor新增`smokeVadLoad()`，snapshot/ready summary可暴露`vadModelId`；所有非inference purpose都在ready后立即退役且不能发起inference。
- managed-resource API现在可返回`resourceType: "vad"`并复用既有ResourceJob状态、revision event与delete endpoint。
- `LocalSubtitleModelManager`新增main-only `resolveManagedVad()`；本包不把它接入JobManager/ProductionExecutor，因此用户任务仍固定`vadEnabled=false`。

## 安全、隐私与许可证检查

- VAD URL、hash、文件名、最终路径和server flags全部由main从冻结manifest构造；renderer不能覆盖。
- root、directory、file identity与containment在关键边界重验；exact tree拒绝symlink、额外文件、缺失文件、size/hash drift与提交后替换。
- resource event只暴露既有脱敏summary；绝对路径、下载URL、模型内容与server输出不进入renderer Store或持久化。
- 来源固定whisper.cpp v1.9.1 exact revision，VAD manifest记录MIT；未新增依赖、未执行pnpm、未修改lockfile。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/vadManager.test.ts
node_modules/.bin/vitest run test/local-subtitle/serverProcessContract.test.ts test/local-subtitle/serverSupervisor.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/tsc --noEmit
node scripts/local-subtitle/benchmark/validate-manifests.mjs
git diff --check
```

结果：

- VAD manager 7/7通过，覆盖完整install/list/resolve/delete、同步claim、无ready主模型失败后重试、wrong hash、busy delete及post-commit复验失败回滚。
- server process/supervisor 71/71通过，覆盖exact purpose/storage、`--vad-model --no-gpu`、snapshot VAD identity、无inference与ready后退出清理。
- local-subtitle 48 passed + 2 skipped files / 1008 passed + 2 skipped tests；2个skip仍是默认未启用的真实native server测试。
- TypeScript、manifest validator 0 error / 0 warning与`git diff --check`通过。
- 仓库没有本地ESLint可执行文件，本轮未安装依赖；未运行真实网络VAD下载、native server smoke或Vite build。
- 未启动Vite dev server、Electron、official server或其他长期服务。

## 未完成事项与风险

- 顶层`MODEL-002`仍未完成：受控root启动时孤儿`.part`、download metadata与staging cleanup尚未实现。
- 尚未执行真实公网885 KB VAD下载、PRE-006 production模型配套native load smoke、packaged app或目标机产品验收。
- 本包只证明VAD资源可被安全安装和official server加载，不开放production inference；时间轴仍固定`token_timestamps=false`与`mapped_segment_timestamps_only`。
- 主模型在下载前和smoke前各复验一次，smoke期间由Supervisor resident identity进入busy guard；未来放开production VAD时仍需JobManager batch pin同时绑定managed VAD identity。

## 下一步建议

- 继续`MODEL-002`启动期受控root orphan cleanup：只清理可证明归属的`.part`/metadata/staging，不凭前缀删除未知目录。
- orphan cleanup完成后进入`FE-002`资源管理UI；真实下载/native smoke与packaged/目标机验收继续按QA边界记录。
