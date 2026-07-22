# 工作包 MODEL-001：Managed 模型导入与 load smoke

## 基本信息

- 日期：2026-07-22
- 状态：已完成
- 对应执行计划工作包：`MODEL-001`
- 目标平台/硬件：跨平台 Electron main / Node 合同；默认测试未启动真实 native server 或加载真实 1.08 GB 模型

## 本次认领边界

- 包含：model manifest、GGML header/size/SHA-256 verifier、managed copy/move import、ResourceJob、Session Registry、CPU load smoke、fixed model IPC、main lifecycle 接线。
- 不包含：联网下载/续传、VAD、模型删除、accelerator pack（`MODEL-002`）；final packaged native bytes/builder/signing/no-PATH（`NATIVE-002`）；批量 task pipeline（`BE-002`）；模型管理 UI（`FE-002`）。

## 本次实现内容

### Manifest 与 GGML 验证

- 新增 model manifest v1，首发只包含 PRE-006 冻结的 `large-v3-q5_0`，绑定 exact whisper.cpp revision、下载 URL、byte size、SHA-256、GGML header、语言能力、量化和 VAD 关系；deferred 型号不进入可选 catalog。
- manifest/catalog 采用 strict schema、semantic validation 和 deep freeze；model id/file name 不区分大小写去重，文件名拒绝分隔符、traversal、Windows ADS/保留名、尾点/尾空格和其他不安全叶名。注入 catalog 在构造时复制并冻结，调用方后续 mutation 不能改变路径解析。
- GGML verifier 使用 no-follow readonly handle，复核 path/handle 的 dev/inode/birthtime/size/mtime/ctime，解析固定 48-byte header，并按块执行可取消 SHA-256；返回的 model id、path、size、hash、header 与 file identity 必须精确绑定 canonical expectation。

### Managed copy/move 事务

- managed、models、model-staging 根仅在不存在时创建为 POSIX `0700`；已有非私有目录不被静默 chmod。所有关键 await 边界复核目录 dev/inode/birthtime/mode/realpath 和 containment，替换 root、symlink/junction 或逃逸路径均 fail closed。
- 导入先验证外部 regular file、GGML header、exact size 和可用空间，再进入 exclusive private staging；copy 分块报告进度并响应 abort，source/staging identity 在 verify、smoke、commit 前后持续复核。
- load smoke 固定 `purpose=model_load_smoke`、CPU、verified runtime、`managed_staging` model、无 VAD；Supervisor readiness 成功后先 retire/cleanup 才返回。smoke lease 不能执行 inference，也不能与正常 pinned-model/VAD inference 合同互换。
- commit 使用同文件系统 hard-link no-clobber，不覆盖已有 model 目录/文件；staging 与 managed reservation 都持有 identity-bound receipt。list/resolve 不凭存在性返回 ready，而是重新校验 manifest metadata、文件 identity、size/hash/header；空 model 目录稳定报告 invalid。
- copy 成功保留外部源；move 仅在 managed commit 完成后删除源。删除结果不明确时保留 source recovery receipt 和最后一份 verified managed copy；显式 shutdown 先恢复源，再回滚 managed copy。源路径被替换时不覆盖 replacement。
- quarantine rediscovery 只有当前事务已经成功记录 exact quarantine path 后才允许；`link()` 因 `EEXIST` 未建立 receipt 时，不扫描或删除 prefix 相同、same-inode 的既有隐藏硬链接。

### Session、IPC 与生命周期

- 新增 app-scoped `LocalSubtitleSessionRegistry`，为每个 owner 持有 `{ revision, batches: [], resourceJobs }`；每次 resource mutation 只增加一次共享 revision，并发布 strict、deep-frozen event/snapshot。
- 新增可复用 `LocalSubtitleResourceJobManager`，覆盖 queued/acquiring/verifying/load_smoke/committing/terminal transition、进度、取消、owner release、waitForIdle 与 reentrant shared shutdown。shutdown Promise 在 abort active job 前缓存，避免同步 abort listener 重入创建第二个 operation。
- 新增 `LocalSubtitleModelIpcBridge`，接通 fixed list/import/cancel handler 和 owner-bound resource events；不向 renderer 返回 managed/source path。app main 创建共享 registry/model manager，并将 model、media、artifact 和 Supervisor 合成统一 owner release/shutdown 生命周期。
- list/resolve 运行中的 verification 纳入 owner release 与 app shutdown；abort 后的 late result 不写 verified cache。staging/source/quarantine cleanup failure 保留 receipt，可由后续 shutdown 串行重试。

## 修改文件

- `resources/local-subtitle/manifests/local-subtitle-models.v1.json`
- `electron/main/local-subtitle/model-manifest.ts`
- `electron/main/local-subtitle/ggml-model.ts`
- `electron/main/local-subtitle/model-manager.ts`
- `electron/main/local-subtitle/model-ipc.ts`
- `electron/main/local-subtitle/resource-job.ts`
- `electron/main/local-subtitle/session-registry.ts`
- `electron/main/local-subtitle/server-process-contract.ts`
- `electron/main/local-subtitle/server-supervisor.ts`
- `electron/main/local-subtitle/main-runtime.ts`
- `electron/main/local-subtitle/ipc.ts`
- `electron/main/index.ts`
- `test/local-subtitle/{modelManifest,ggmlModel,modelManager,modelManagerIpc,resourceJob,sessionRegistry}.test.ts`
- `test/local-subtitle/{serverProcessContract,serverSupervisor,mainRuntime}.test.ts`
- `test/local-subtitle/{serverContract,serverSupervisor}.real.test.ts`
- `.agents/skills/fusionkit-pitfall-guard/references/{cache-shutdown-promise-before-aborting,retain-the-last-verified-copy-during-move-recovery,use-the-root-vite-config-for-electron-build-validation,require-creation-proof-before-quarantine-rediscovery}.md`
- Final Design、Execution Plan、v0.2.11 README 与本实施记录

## 接口、状态或数据结构变化

- 新增 strict model manifest/catalog、GGML expectation/verification 和 managed model identity。
- 新增 `LocalSubtitleModelManager` 的 import/list/resolve/cancel/release/shutdown 合同；运行时仍只消费受信 `modelId`，不接受 renderer 提交模型路径。
- 新增共享 Session Registry 与 ResourceJob primitive，供 `MODEL-002` 和 `BE-002` 扩展，不建立第二套 revision/job 状态机。
- server process contract 新增 discriminated `purpose`：正常 `inference` 继续要求 managed model + pinned VAD；`model_load_smoke` 只允许 CPU + managed staging model且无 VAD。
- `LocalSubtitleMainRuntime` 扩展为 model/media/artifact/Supervisor 的 owner release 与 app shutdown 合成器；任一子系统失败不阻止其他 cleanup 启动。

## 安全、隐私与许可证检查

- 路径/capability：renderer 只提交 File 经 preload 转换后的受控 import 请求并只看到 modelId/job summary；source、staging、managed 路径保持 main-only。所有文件和目录操作 no-follow、containment/identity-bound。
- 日志/持久化：未持久化源路径、managed path、模型字节、token 或诊断；session snapshot/event 通过既有 strict frame schema。未提交模型二进制、staging 或运行日志。
- 第三方来源与许可：manifest 只记录 PRE-006 已冻结的公开来源与 checksum；没有新增依赖，没有修改 `package.json` 或 `pnpm-lock.yaml`，没有执行裸 `pnpm`。
- 避坑记录：新增 `FK-PIT-0046`～`FK-PIT-0049`，分别固定 reentrant shutdown ordering、move 最后一份 verified copy、根 Vite 三段构建和 quarantine creation receipt 规则。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/modelManager.test.ts test/local-subtitle/ggmlModel.test.ts test/local-subtitle/modelManifest.test.ts test/local-subtitle/modelManagerIpc.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit --pretty false
rg --files -g 'vite.config*' -g 'electron.vite.config*'
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- MODEL 聚焦：4 files / 50 tests 全部通过。
- local-subtitle：29 passed + 2 skipped files / 504 passed + 2 skipped tests。
- 全量 Vitest：130 passed + 2 skipped files / 1456 passed + 2 skipped tests；既有 AI SDK warning 不影响结果。
- TypeScript 通过；仓库只有根 `vite.config.ts`，一次 test build 完整产出 renderer、main、preload。既有 dynamic-import/chunk-size warning 不影响成功结果。
- PRE manifest：0 error / 0 warning；validator tests 17/17；diff check 通过。
- 未启动 Vite dev server、Electron、official server、FFmpeg 或下载任务；收口进程检查无项目相关残留。
- 未运行默认跳过的 2 个真实 server tests，也未进行 packaged/target-hardware smoke；这些结果不作为 `NATIVE-002` 或发布证据。

## 产生的证据

- 测试覆盖 manifest drift/duplicate/traversal/Windows unsafe leaf/mutation、GGML truncation/header/size/hash/abort/path swap 和 verifier result binding。
- 测试覆盖 copy/move、progress/cancel/space、CTranslate2 directory、root permission/replacement、staging/model swap、no-clobber、empty model directory、list/resolve cache、owner release与 shutdown late result。
- move fault matrix 覆盖 no-op remover、unlink-then-reject、source replacement、restore retry、最后一份 verified copy、quarantine relocation、`EEXIST` same-inode pre-existing link 和 cleanup retry。
- server/Supervisor 测试覆盖 smoke/inference discriminant、CPU-only、managed staging、no VAD、no inference、readiness 后 retirement 和正常 inference regression。

## 未完成事项与风险

- 当前 model manifest 支持可信本地导入，不包含网络下载、VAD/accelerator pack 或删除；这些由 `MODEL-002` 完成。
- 默认 gate 使用 deterministic GGML fixtures 和 injected smoke；真实 exact model/runner、packaged bytes、签名与目标硬件仍由 `NATIVE-002`/QA 验收。
- `BE-002` 尚未把 managed model、MEDIA window proof、SUB attempt graph、Supervisor epoch/generation/response 和 exporter 绑定为真实 task execution record；MODEL-001 完成不等于端到端转写可用。

## 下一步建议

- 优先实现 `BE-002` 的单文件 CPU → SRT 纵向切片，复用本包 Session Registry/ResourceJob 与 managed model resolver，并先闭合 exact window/attempt/epoch/generation/response binding、取消、失败和 revision snapshot。
- `BE-002` 完成后由 `FE-001` 接入文件选择、managed model、开始、阶段进度、completed 与 reveal 的最小 UI；`MODEL-002`、`NATIVE-002` 和 LINK 包按独立里程碑推进。
