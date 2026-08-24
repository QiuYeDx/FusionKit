# 工作包 MODEL-002A：Allowlisted 模型下载、续传与删除 checkpoint

## 基本信息

- 日期：2026-08-03
- 状态：部分完成
- 对应执行计划工作包：`MODEL-002`
- 目标平台/硬件：跨平台 Electron main / Node 合同；未执行真实 1.08 GB 公网下载、真实 packaged app 或目标 GPU 验收

## 本次认领边界

- 包含：首发 allowlisted 模型的 HTTPS 下载、redirect host 门禁、Range 续传、no-Range/validator 变化重启、`.part` 元数据、磁盘预检、ResourceJob/IPC 接线、跨 owner 并发锁、取消清理和 busy delete。
- 不包含：VAD manifest/安装、Windows CUDA accelerator archive 安全解包与 probe、模型/pack 更新和旧版本回滚、启动孤儿扫描、FE-002 模型管理 UI、真实公网/packaged/目标硬件验收。

## 本次实现内容

### HTTPS 下载与续传

- 新增 main-only `resource-download.ts`，只接受 manifest 固定的 HTTPS source URL、host allowlist、期望大小和 main 生成的受控下载/目标路径。
- redirect 每跳重新校验 HTTPS、host、port、credentials、fragment、URL 长度和最大次数；请求只携带固定 `Accept`、`Accept-Encoding`、`User-Agent`、`Range`、`If-Range`，不转发 renderer header、cookie、authorization 或其他敏感值。
- `.part` 与 strict JSON 元数据绑定 source URL、effective URL、expected bytes、ETag/Last-Modified 和已同步字节；part 与 metadata 不一致、零字节、非法类型或 validator 缺失时安全丢弃。
- Range 响应严格验证 `206`、`Content-Range` 起点/终点/总量、可选 `Content-Length` 和 validator；服务端返回 `200`/`416`、validator 变化或范围不一致时只允许一次清理后从零重启。
- 下载流按 manifest byte 上限写入、周期性 fsync part 后原子发布元数据；取消清理 part/metadata，网络失败在有 validator 时保留一致的续传状态。
- 完成文件通过 hard-link no-clobber 进入 managed staging，删除原 part 后再冻结最终单链接 identity，避免把临时 hard-link unlink 的 ctime 变化当成最终文件身份。

### ModelManager、ResourceJob 与 IPC

- 模型 manifest v1 新增 exact `allowedDownloadHosts`，首发仍只有 PRE-006 的 `large-v3-q5_0`；catalog 深校验 source host、host 重复和 wildcard 语义。
- `LocalSubtitleModelManager.startResourceInstall()` 复用既有 per-owner ResourceJob/revision，不建立第二套下载状态机；流程为 `acquiring -> verifying -> load_smoke -> committing -> completed`。
- 下载完成后继续复用 MODEL-001 的 GGML header/size/SHA verifier、CPU/no-VAD load smoke、hard-link no-clobber managed commit、verified cache 和 identity-bound cleanup。
- 同一 modelId 在首个 await 前取得 app-scoped claim；其他 owner 只得到稳定 `resource_busy`，不会看到对方 jobId、URL、路径或进度。
- fixed `startResourceInstall` / `deleteManagedResource` public handlers 已接入现有 preload API；renderer 仍只能提交 `resourceId`。

### Busy delete 与生命周期

- `JobManager.isManagedModelBusy()` 覆盖 pending enqueue 和未终态 task；production bootstrap 同时检查 JobManager 与 Supervisor resident model snapshot。
- 删除在 claim 后复核 task/server busy，验证 managed model identity，再把目录原子移入 private staging quarantine；Windows recursive cleanup 使用有界 `maxRetries/retryDelay`。
- 删除清理失败保留 pending receipt 并让 list 返回 invalid，而不是静默显示已删除；后续 `waitForIdle()` / shutdown 可重试 cleanup。
- 非 ResourceJob 的删除操作也进入 ModelManager 活动操作集合，app quit/update 不会越过目录 mutation 提前完成 shutdown。

## 修改文件

- `resources/local-subtitle/manifests/local-subtitle-models.v1.json`
- `electron/main/local-subtitle/resource-download.ts`
- `electron/main/local-subtitle/{model-manifest,model-manager,model-ipc,job-manager}.ts`
- `electron/main/index.ts`
- `test/local-subtitle/{resourceDownload,modelManifest,modelManager,modelManagerIpc,jobManager}.test.ts`
- Final Design、Execution Plan、v0.2.11 README/iteration ledger 与本实施记录

## 接口、状态或数据结构变化

- model manifest entry 新增 `allowedDownloadHosts: string[]`，用于固定初始 source 与可信 redirect host family。
- `LocalSubtitleModelManager` 新增 `startResourceInstall(owner, resourceId)` 和 `deleteManagedResource(owner, resourceId)`；现有 preload renderer API/type 无变化。
- `LocalSubtitleJobManager` 新增 main-only `isManagedModelBusy(modelId)`，不进入 IPC 或 renderer。
- managed root 新增 private `downloads/`，保存 `<modelId>.part` 与 `<modelId>.part.json`；模型字节、URL、validator 和绝对路径均不进入 renderer Store/session event。

## 安全、隐私与许可证检查

- renderer 仍只提交 allowlisted `resourceId`；URL、redirect、download headers、part/staging/managed path 和 executable 参数全部留在 main。
- 没有新增依赖，没有修改 `package.json` 或 `pnpm-lock.yaml`，没有执行裸 `pnpm`。
- 下载器不继承 proxy credential、API Key、authorization/cookie 或 Electron/Agent secret；当前 production model 来源和 MIT 口径仍沿用 PRE-006 pin。
- 本 checkpoint 不宣称 NVIDIA CUDA pack 可分发；精确 DLL/notice 仍由 `QA-005` 复核。

## 验证结果

执行命令：

```text
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vitest run test/local-subtitle/resourceDownload.test.ts test/local-subtitle/modelManifest.test.ts test/local-subtitle/modelManager.test.ts test/local-subtitle/modelManagerIpc.test.ts test/local-subtitle/jobManager.test.ts test/local-subtitle/mainRuntime.test.ts test/local-subtitle/sessionLifecycle.test.ts
node_modules/.bin/vitest run test/local-subtitle
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- 聚焦：7 files / 145 tests 全部通过。
- local-subtitle：43 passed + 2 skipped files / 968 passed + 2 skipped tests；2 个 skip 仍是默认未启用的真实 native server tests。
- TypeScript 通过；PRE manifest 为 0 error / 0 warning；validator tests 17/17 通过。
- 未启动 Vite dev server、Electron、official server、FFmpeg 或真实下载任务。
- 未执行真实 Hugging Face 1.08 GB 下载、断网恢复、packaged app 或目标硬件矩阵；fake transport/小 GGML fixture 不能替代这些证据。

## 产生的证据

- 下载测试覆盖冷下载、真实 part/meta 续传、Range/If-Range、no-Range 重启、validator 变化、恶意 redirect、redirect loop 和取消清理。
- Manager/IPC 测试覆盖 allowlisted install、ResourceJob snapshot/progress、跨 owner synchronous claim、路径脱敏、busy delete、idle delete 和 fixed public handlers。
- JobManager 测试覆盖 pending enqueue 与 queued task 对删除 guard 的可见性；session/main lifecycle 回归保持通过。

## 未完成事项与风险

- `MODEL-002` 顶层包继续为 `进行中`；VAD、accelerator pack、update/rollback、启动孤儿 `.part` 清理及 FE-002 UI 尚未实现。
- 当前下载后若完整 GGML 校验或 load smoke 失败，ResourceJob 可重试但不会把资源标记 ready；真实 1.08 GB 字节保留/重试体验仍需在后续 checkpoint 与产品 E2E 中复核。
- production default transport 已实现显式 HTTPS 流和无默认长任务 header timeout依赖，但本轮没有访问外网验证 Hugging Face 当前 redirect/CDN 行为。

## 下一步建议

- 继续 `MODEL-002B`：冻结 VAD manifest/安装，或优先实现 Windows CUDA accelerator archive 的可信下载、安全解包、probe、版本目录提交与旧 pack 回滚。
- `MODEL-002` 完成后接 `FE-002`，展示 model/resource job 的安装、取消、删除、错误和重同步状态。
