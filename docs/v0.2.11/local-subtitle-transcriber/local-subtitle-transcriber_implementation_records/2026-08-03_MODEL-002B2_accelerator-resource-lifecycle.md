# 工作包 MODEL-002B2：CUDA accelerator resource lifecycle

## 基本信息

- 日期：2026-08-03
- 状态：已完成（顶层`MODEL-002`继续进行中）
- 对应执行计划工作包：`MODEL-002`
- 目标平台/硬件：Windows x64代码合同；未执行真实Windows CUDA archive、executable或目标GPU验收

## 本次认领边界

- 包含：CUDA pack ResourceJob/list/install/delete、private roots、下载与磁盘预检、B1解包接线、PE x64/full-hash复核、bounded identity probe、versioned atomic publication、失败回滚、旧known pack延迟清理、取消与shutdown。
- 不包含：VAD manifest/install、启动孤儿`.part`/staging扫描、真实678 MB archive与约1.2 GB展开、CUDA backend/GPU memory产品验收、FE-002、NVIDIA许可closure。

## 本次实现内容

- 新增Windows x64限定的`LocalSubtitleAcceleratorManager`；macOS/非x64不创建manager，也不会在managed-resource列表暴露Windows CUDA pack。
- 复用既有`LocalSubtitleResourceJobManager`与session revision registry，通过固定`listManagedResources`、`startResourceInstall`、`deleteManagedResource` API提供accelerator生命周期，不新增IPC channel或renderer路径/URL参数。
- 使用独立`accelerator-downloads`、`accelerator-staging`、`accelerators` private roots；安装前预检archive、完整展开pack和manifest所需磁盘空间。
- 复用MODEL-002A allowlisted resumable downloader与MODEL-002B1 guarded archive extraction；解包后验证exact tree、manifest bytes和20个PE x64 artifact，probe前后复核静态身份，提交后执行不可取消的全量hash验证。
- 以最小Windows环境、受控短`System32` cwd、`shell:false`、固定`--help`、15秒timeout和1 MiB输出上限执行`whisper-server.exe` identity probe；探测前不把staging加入系统或应用全局DLL search path。
- pack以versioned no-clobber目录原子发布；post-commit验证失败只移除新pack并保留旧known version，新pack验证成功后才隔离旧版本。旧版本已隔离但删除失败时保留identity-bound receipt供`waitForIdle`/shutdown重试。
- 同一CUDA pack family的不同版本也使用同步跨owner claim，避免两个并发更新互相删除；commit前取消清理transaction，commit边界后的取消继续完成验证和清理。shutdown Promise在abort前缓存并等待ResourceJob、verification、delete和cleanup收敛。
- manifest contract将MODEL-002 resource lifecycle标记为已实现，同时保留`target_gpu_backend_verification`与`license_closure`门禁；`targetSmokeStatus`继续为`pending`，`artifactSharingAllowed`不变。

## 修改文件

- `electron/main/local-subtitle/accelerator-manager.ts`
- `electron/main/local-subtitle/model-manager.ts`
- `resources/local-subtitle/manifests/local-subtitle-windows-cuda-pack.v1.json`
- `scripts/local-subtitle/runtime/windows-cuda-pack-contract.mjs`
- `scripts/local-subtitle/runtime/windows-cuda-pack-contract.test.mjs`
- `test/local-subtitle/acceleratorManager.test.ts`
- Final Design、Execution Plan与本实施记录

## 接口、状态或数据结构变化

- 既有managed-resource API现在可返回`resourceType: "accelerator"`的Windows CUDA pack，并复用既有ResourceJob状态与revision event。
- `LocalSubtitleModelManager`在Windows x64组合accelerator manager；其他平台保持原模型列表与行为。
- CUDA manifest的`acceptance.model002`改为`resourceJobLifecycleImplemented: true`，记录download/install/update/rollback/delete实现与剩余target GPU/license gates。
- 没有新增public IPC channel、preload方法、持久化字段或renderer可控URL/path/executable参数。

## 安全、隐私与许可证检查

- 路径/capability：所有下载、staging、最终目录和probe参数由main从冻结manifest构造；root/tree/file identity、containment、PE x64、size/SHA在关键边界复核。
- 日志/持久化：resource event只暴露既有脱敏summary；archive URL、绝对路径、DLL search path、stdout/stderr原文不进入renderer Store或持久化。
- 第三方来源与许可：继续固定whisper.cpp v1.9.1/f049fff与CUDA 12.4 archive；本轮没有改变unsigned personal distribution，也没有解除`QA-005`的NVIDIA DLL/notice复核与禁止分享门禁。
- 依赖/锁文件：没有新增依赖，没有执行pnpm，没有修改`package.json`或`pnpm-lock.yaml`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/acceleratorManager.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/runtime/windows-cuda-pack-contract.test.mjs scripts/local-subtitle/runtime/runtime-manifest.test.mjs
git diff --check
```

结果：

- accelerator manager 13/13通过，覆盖API路由、install/list、同/跨版本跨owner claim、磁盘不足、取消、shutdown、busy delete、cache drift、commit边界取消、post-commit失败回滚、旧版本成功清理与隔离后重试。
- local-subtitle 46 passed + 2 skipped files / 995 passed + 2 skipped tests；2个skip仍是默认未启用的真实native server测试。
- TypeScript与renderer/main/preload三段Vite test build通过；Vite仅有既有dynamic-import/chunk-size warning。
- manifest validator为0 error / 0 warning；runtime Node为25 passed / 1 skipped，skip是非Windows host预期项；`git diff --check`通过。
- 未启动Vite dev server、Electron、official server或其他长期服务。

## 产生的证据

- 合成pack测试覆盖完整ResourceJob与版本切换状态机，但不冒充真实678 MB archive、Windows PE执行、CUDA backend或GPU memory证据。
- production manifest继续保留`targetSmokeStatus: pending`、target GPU和license gates，避免静态hash/`--help`探测被误写为CUDA可用证明。

## 未完成事项与风险

- `MODEL-002`顶层仍未完成：VAD manifest/install和启动受控root的孤儿`.part`/staging清理尚未实现。
- 尚未执行真实公网678 MB CUDA archive下载、约1.2 GB展开、Windows `whisper-server.exe --help`、真实CUDA backend或显存验证。
- 当前旧pack清理只处理catalog中仍有精确manifest/hash的known version；未知历史目录不能在没有可信身份合同的情况下自动删除，应由后续启动孤儿清理按独立保守规则处理。
- NVIDIA精确DLL再分发与notice仍由`QA-005`闭环，当前candidate不可分享。

## 下一步建议

- 继续`MODEL-002`的VAD manifest/install，复用相同ResourceJob、下载器和managed-resource API。
- 随后实现启动时受控root的`.part`、download metadata和staging孤儿清理，再进入`FE-002`资源管理UI。
