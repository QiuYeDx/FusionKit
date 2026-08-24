# 工作包 BE-002：LRC、多格式与 Partial Output

## 基本信息

- 日期：2026-07-22
- 状态：已完成（unit/contract 范围；BE-002 总工作包仍进行中）
- 对应执行计划工作包：`BE-002`
- 目标平台/硬件：跨平台 Electron main / Node contract；未启用真实 native server、FFmpeg、PRE-006 模型或 Electron UI

## 本次认领边界

- 包含：CPU/transcribe/no-VAD、custom/source、index-only、export-only production 路径的 LRC-only、SRT-only、保序双格式、full/partial/none-success 与 commit 后取消结算。
- 包含：多格式 cleanup/cancel failure 优先级、Job Manager/Session Registry/IPC schema 的一致取消证据，以及 late cancel/lease renewal abort 后的 artifact 保留。
- 不包含：production overwrite、CUDA/Metal、VAD、translate、translation handoff、renderer UI、真实 native/packaged E2E。

## 本次实现内容

- Job Manager 与 Production Executor 的 production gate 放行 `[SRT]`、`[LRC]`、`[SRT,LRC]`、`[LRC,SRT]`，拒绝空数组、重复格式及既有非 production 配置；格式顺序保持请求顺序，不做 canonicalize。
- Production Executor 复用 SUB-002 exporter 的逐格式独立事务。custom/source 均可完整导出双格式；第二格式 reserve 或目录重新解析失败时保留第一格式 committed artifact，并以普通无 warning partial 结束。
- 首格式 commit 后取消会保留已提交 artifact，后续格式以 `cancelled_after_partial_commit` 跳过，并形成唯一 cancellation warning。全格式已提交后的晚取消仍保持 full。
- `mapExportResult()` 逐个规范化 failed artifact 的 cleanup code；all-failed 中任意 `cleanup_failed` / `cancel_failed` 高于普通 write failure，避免格式顺序隐藏 required cleanup failure。
- 共享状态机新增可选 `cancellationRequested` override，并提炼 `hasLocalSubtitleArtifactCancellationEvidence()`；Job Manager、Session Registry 与 IPC schema 使用同一 artifact evidence 语义。普通 partial 即使当前状态已被晚 cancel 推到 `cancelling`，也不会被改写为 cancelled。
- Job Manager 的 failed transition 使用 manager-owned cancelling/cancelRequested/leaseFailure/AbortSignal 证据。lease renewal abort 后 executor 返回的双格式 `cancel_failed` 结果不会再走 fallback 清空；invalid cancellation fallback 按全部 `requestedFormats` 生成失败结果，不再硬编码 SRT。

## 修改文件

- `src/type/localSubtitle.ts`
- `src/type/localSubtitle.test.ts`
- `src/type/localSubtitleIpc.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `electron/main/local-subtitle/session-registry.ts`
- `test/local-subtitle/jobManager.test.ts`
- `test/local-subtitle/productionExecutor.test.ts`
- `test/local-subtitle/sessionRegistry.test.ts`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- 本实施记录

## 接口或数据结构变化

- `transitionLocalSubtitleTaskState()` 的 context 新增可选 `cancellationRequested`；未传时保持从当前 `cancelling` 状态推导的兼容行为。
- 新增共享函数 `hasLocalSubtitleArtifactCancellationEvidence()`，统一识别 failed `cancel_failed` 与 skipped `cancelled_after_partial_commit`。
- renderer DTO、IPC channel、持久化 key 与 output conflict policy 未变化；production 仍只允许 `index`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/productionExecutor.test.ts test/local-subtitle/jobManager.test.ts test/local-subtitle/sessionRegistry.test.ts src/type/localSubtitle.test.ts
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

- 聚焦 Production Executor / Job Manager / Session Registry / shared state：4 files / 176 passed。
- local-subtitle：33 passed + 2 skipped files / 700 passed + 2 skipped tests。
- 全量 Vitest：134 passed + 2 skipped files / 1653 passed + 2 skipped tests；2 个 skip 仍是未启用的真实 native server tests。
- TypeScript 通过；renderer/main/preload 三段 Vite test build 通过，仅有既有 dynamic-import/chunk-size warning；PRE manifest 0 errors / 0 warnings；validator 17/17；diff check 通过。
- canonical runtime staging 因 Git 忽略的 canonical runtime path 缺失而按合同 fail closed；未取得真实 native/packaged E2E 结论。
- 未改依赖或 `pnpm-lock.yaml`，未运行 `pnpm`，未启动常驻前端/Electron 服务。

## 未完成事项

- Production overwrite 仍需目录句柄相对的目标校验、victim 备份、原子替换、activation 与 identity-bound rollback 事务；当前 path-based standalone overwrite 不构成 production 支持。
- CUDA/Metal、VAD、translate、非 export-only、translation handoff、FE 和 native/packaged E2E 仍未完成。
- 可追加真实 exporter 的“首格式 committed、第二格式 cleanup_failed/cancel_failed”production 回归；现有 exporter component tests与 production all-failed/partial tests已覆盖各自合同，该项不是本次阻塞项。

## 下一步建议

- 优先设计并实现 production overwrite 的跨平台目录句柄相对 native transaction；在该事务完成前保持 Job Manager/Executor 的 index-only 双重 gate。
- `NATIVE-002` / `MODEL-002` 资源依赖就绪后，再接 CUDA/Metal 与 VAD/translate production 路径；translation handoff、FE 与 packaged/native E2E 按各自工作包闭环。
