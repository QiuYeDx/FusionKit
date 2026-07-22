# 工作包 FS-TXN-001：Overwrite Transaction 合同与 Exporter 接入

## 基本信息

- 日期：2026-07-22
- 状态：进行中（同步 receipt 合同与 Exporter 组件接入已完成；native backend 与 packaged 验收未完成）
- 对应执行计划工作包：`FS-TXN-001`
- 目标平台/硬件：跨平台 Electron main / Node contract；未构建或加载 macOS arm64 / Windows x64 native filesystem backend

## 本次认领边界

- 包含：overwrite transaction 的 strict synchronous coordinator/receipt、Exporter 编排、fail-closed、Registry revoke/rollback、partial cleanup 与 cancellation error semantics。
- 包含：component、真实 Artifact Registry 与 Production Executor 组合故障回归。
- 不包含：native syscall 实现、main 注入、Job Manager/Executor overwrite 放行、hostile parent replacement、crash recovery、resource staging/builder、target packaged validation。

## 本次实现内容

- 新增 `overwrite-transaction.ts`，request 只包含目录路径/identity、partial/final leaf、partial identity 与 byte size；exact-key 校验后向 backend 传 detached deep-frozen snapshot。
- Coordinator 使用 WeakSet 与 exact prototype 品牌，Exporter 不接受结构对象、原型伪造或 subclass。backend/receipt 方法在验证后捕获并保留 receiver，后续对象 mutation 不能改写调用目标。
- `begin/finalize/rollback` 必须同步；pending/resolved/rejected thenable 立即以 `invalid_receipt` 拒绝并吸收晚 rejection。receipt 状态为 `open/finalized/rolled_back`，terminal 同方法/跨方法重入被 fencing，失败保持 open，成功幂等且不能跨终态。
- Exporter 无 backend 时在任何目录解析、partial ID/写入和 reservation 前返回逐格式 `output_write_failed`；legacy `commitOverwrite` 必须显式注入且不能与 transaction 并存。
- transaction 成功顺序固定为 `begin → Artifact Registry activate → finalize`，中间没有 await 或 cancellation check。activation 失败 rollback；finalize 失败先 revoke active ref，再尝试 rollback，两阶段都必须执行。
- revoke/rollback/partial cleanup 全部完成时，finalize failure 使用普通 `output_write_failed`；只有 required cleanup 未可靠收敛才使用 `cleanup_failed`，存在取消证据时使用 `cancel_failed`。rollback 恢复的 partial 仍由 Exporter 以原 identity 清理。
- 测试覆盖 existing/absent victim、victim 恢复/absence 恢复、真实 Registry 连续 read、begin/activate/finalize/revoke/rollback 顺序和故障、late cancel、thenable/reentrancy/mutation，以及已提交 SRT 后 LRC commit 与 cleanup 同时失败时的 artifact 保留。
- 新增 `FK-PIT-0057`，固定 branded Coordinator、同步 Registry activation 边界、terminal reentry fence、begin failure atomicity 与 rollback recovery ownership。

## 修改文件

- `electron/main/local-subtitle/overwrite-transaction.ts`
- `electron/main/local-subtitle/subtitle-exporter.ts`
- `test/local-subtitle/overwriteTransaction.test.ts`
- `test/local-subtitle/subtitleExporter.test.ts`
- `test/local-subtitle/productionExecutor.test.ts`
- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- `.agents/skills/fusionkit-pitfall-guard/references/brand-and-fence-synchronous-native-transaction-receipts.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- 本实施记录

## 接口或状态变化

- 新增 `LocalSubtitleOverwriteTransactionCoordinator`、`LocalSubtitleOverwriteTransactionReceipt`、backend/request/identity/state/error 类型和 factory/brand guard。
- `LocalSubtitleExporterDependencies.overwriteTransaction` 只接受已验证的 nominal coordinator；`commitOverwrite` 降为显式 legacy/test adapter，不再默认 fallback 到 path-based rename。
- Artifact Registry collaborator 增加 `revokeArtifact(owner, artifactRef)`，用于 activation 后 finalize failure 的同步撤销。
- shared renderer DTO、IPC channel、持久化 key 与 conflict policy schema 未变化；main 未注入 transaction，production 仍只允许 `index`。

## 安全与恢复合同

- native `begin` 必须打开并验证一个目录 object handle，所有 child lookup/backup/rename/unlink 都相对该 handle 且 no-follow；绝对路径只能用于取得初始目录 handle，不能用于后续 child authority。
- `begin` 返回前必须已建立 final 与可恢复 receipt；若抛错或返回非法值，必须先恢复 victim/partial 并释放所有 handle/backup。
- `rollback` 必须恢复 victim 或原先不存在，并把 exact new inode 恢复到 partial leaf；`finalize` 只能在相同 handle/object proof 下释放 victim。terminal 失败必须保留可重试 recovery authority。
- 当前 JS/path-based test backend 不证明上述 native 语义。rollback failure 后的持久/重试 receipt、process crash、Windows exact FileId 表示与 orphan backup cleanup 仍需后续冻结。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/overwriteTransaction.test.ts test/local-subtitle/subtitleExporter.test.ts test/local-subtitle/productionExecutor.test.ts
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

- 聚焦 transaction/exporter/production composition：3 files / 138 passed。
- local-subtitle：34 passed + 2 skipped files / 768 passed + 2 skipped tests。
- 全量 Vitest：135 passed + 2 skipped files / 1721 passed + 2 skipped tests；2 个 skip 仍是未启用的真实 native server tests。
- TypeScript、renderer/main/preload 三段 Vite test build、manifest 0 errors / 0 warnings、validator 17/17 与 diff check 通过。Vite 仅有既有 dynamic-import/chunk-size warning。
- canonical runtime staging 因 Git 忽略的 canonical path 缺失而按合同 fail closed，未取得 native/packaged 证据。
- 未修改依赖或 `pnpm-lock.yaml`，未运行 `pnpm`，未启动常驻前端/Electron/native 服务。

## 未完成事项与风险

- macOS arm64 native backend 未完成。
- Windows x64 native backend 未完成；现有 number 型 `dev/ino/birthtimeMs` 对 Windows 64/128-bit FileId 的无损性尚未证明。
- hostile parent replacement、existing/absent victim 的 native fault matrix与 rollback failure recovery 未完成。
- native addon manifest/loader、resource staging、nested signing/hash、builder `extraResources` 与两平台 packaged validation 未完成。
- native backend、main injection 和上述证据完成前，`FS-TXN-001` 与 `BE-002` 保持进行中，Job Manager/Executor 的 index-only 双重 gate 不得解除。

## 下一步建议

- 采用 in-process plain Node-API addon，在 Registry activation 前后持续持有同一 dirfd/HANDLE；macOS 使用 dirfd-relative `openat/fstatat/renameatx_np/unlinkat`，Windows 使用 directory HANDLE + RootDirectory-relative NT open/rename/disposition primitives。
- 先闭环 addon source/build/loader 和 macOS arm64 / Windows x64 native integration fault matrix，仍不解除 production gate；随后扩展 resource manifest、正式 builder/staging、签名/hash 与两平台 packaged load/E2E。
- 在 native 接线前冻结 rollback failure 的 recovery receipt/重试/崩溃策略和 Windows exact file identity codec。
