# 工作包 FS-TXN-001B：Darwin Child-Leaf 边界与持久 Recovery Ownership

## 基本信息

- 日期：2026-07-23
- 状态：已完成（macOS arm64 developer component checkpoint）
- 对应执行计划工作包：`FS-TXN-001` 的 component checkpoint `FS-TXN-001B`
- 目标平台：macOS arm64，本机 APFS developer validation

## 本次认领边界

- 包含：Darwin child-leaf 威胁模型、exact output-directory journal、持久 rollback intent、fresh-process rollback recovery、terminal pending 状态与 test-only fault/crash harness。
- 不包含：abandoned open/finalize crash 的 durable decision、Artifact Registry/main composite owner、重新授权 wiring、Windows backend、generation-bound staging/load、builder/main injection、packaged/power-loss validation 或 production gate 放行。

## 本次实现内容

- 冻结 Darwin 公共 syscall 边界：`renameatx_np` / `unlinkat` 没有 expected-vnode CAS。保证只覆盖按 directory-object mutex 串行化、并在 terminal 窗口独占 partial/final/journal leaf 的 cooperative FusionKit writer；非协作同目录 writer完全不在保证范围。
- addon protocol 升级到 v2，production exact exports 为 `protocolVersion/platform/architecture/begin/recover`；test-only artifact 额外导出 `testFaultInjection: true`，strict production loader会拒绝它。
- `begin` 在首次 namespace mutation 前创建 addon-write-once/checksummed exact journal，并完成 `F_FULLFSYNC(journal) -> fsync(directory)`；production path在 rename成功后没有可抛步骤，避免已 mutation 但 caller收不到 receipt。test-only `begin_after_namespace` checkpoint是为 crash/error evidence保留的唯一有意例外。journal依赖 checksum、exact request与 file-identity validation检测篡改，不宣称 filesystem immutable。真实 process crash与 power loss明确分开。
- rollback 在首次 namespace mutation 前把 `.open` journal 原子改名为 `.rollback` 并同步目录；fresh process 只按 exact partial-derived leaf 恢复 existing/absent victim、清理 exact new inode并移除 journal，不扫描目录前缀。
- journal removal 支持 `named leaf absent + pinned fd nlink == 0` 的幂等续跑，覆盖 unlink 已成功但后续 directory sync/proof 抛错的同 receipt retry。
- TypeScript receipt 增加 `finalize_pending` / `rollback_pending`。backend method 真正开始后抛错只能沿同方向重试；backend 调用前的 terminal reentry rejection 不会误写 pending 状态。
- native 增加仅驻内存的 finalize intent，GC finalizer不会在 `finalize_pending` 时反向 rollback。Exporter finalize 首次失败会同 receipt 重试一次；仍失败则保留 Registry commit 方向并返回稳定 cleanup failure，等待未来 main owner接管。
- 合法且 request-matching 的 open journal recovery返回 `decision_required`；malformed、replaced、multiply linked 或 request-mismatching journal会被拒绝。本 checkpoint 不根据 leaf layout猜测 abandoned receipt 或 finalize crash 的 commit/rollback决定。
- 新增 production journal validation 和 test-only begin/rollback/finalize fault矩阵；新增 `FK-PIT-0060`、`FK-PIT-0061`，固化 terminal direction 与 post-mutation begin throw 两类教训。

## 修改文件

- `native/local-subtitle-overwrite/src/addon.cc`
- `native/local-subtitle-overwrite/README.md`
- `electron/main/local-subtitle/overwrite-transaction.ts`
- `electron/main/local-subtitle/overwrite-native-backend.ts`
- `electron/main/local-subtitle/subtitle-exporter.ts`
- `test/local-subtitle/overwriteTransaction.test.ts`
- `test/local-subtitle/overwriteNativeBackend.test.ts`
- `test/local-subtitle/subtitleExporter.test.ts`
- `scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.mjs`
- `scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs`
- `scripts/local-subtitle/overwrite-native/build-test-addon-macos-arm64.mjs`
- `scripts/local-subtitle/overwrite-native/run-addon-integration.mjs`
- `scripts/local-subtitle/overwrite-native/run-addon-recovery-child.mjs`
- `scripts/local-subtitle/overwrite-native/run-addon-recovery-integration.mjs`
- `.agents/skills/fusionkit-pitfall-guard/references/{index.md,lock-receipt-direction-after-durable-terminal-intent.md,avoid-post-mutation-begin-throws-without-recovery-handoff.md}`
- Final Design、Execution Plan、v0.2.11 README/iteration ledger与本实施记录

## 接口、状态或数据结构变化

- native protocol：`1 -> 2`，新增同步 `recover(request)`。
- recovery result：`rolled_back | decision_required | not_found`。
- receipt state：`open | finalize_pending | rollback_pending | finalized | rolled_back`。
- journal leaves：`<partialLeaf>.fusionkit-overwrite.open` 与 `<partialLeaf>.fusionkit-overwrite.rollback`。
- production loader仍只返回 branded Coordinator；recover尚未暴露给 main，防止在 composite owner完成前形成第二个非权威恢复入口。

## 安全、隐私与许可证检查

- 路径/capability：journal不保存绝对路径；main不持久化 user-output raw path/capability/token；恢复必须由同一 request和重新验证的 directory object精确寻址。
- 日志/持久化：成功 integration report只输出稳定 case id、code与布尔证据，不记录临时根、addon路径、用户名或文件内容；CLI启动/系统调用失败仍可能由 Node系统错误携带本地路径，因此该输出只用于本机 developer validation，不作为可上传的脱敏报告。
- 第三方来源与许可：无新增第三方依赖；build仍为 shell-free `xcrun clang++` + 当前 Node exact headers。
- 生产隔离：fault environment只编译进 extra-export test addon；production exact surface不含 fault control，Job Manager/Executor仍只允许 `index`。

## 验证结果

执行命令：

```text
node --test scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs
node scripts/local-subtitle/overwrite-native/run-addon-integration.mjs --addon /tmp/fusionkit-fstxn001b-release-final.node
node scripts/local-subtitle/overwrite-native/run-addon-recovery-integration.mjs --addon /tmp/fusionkit-fstxn001b-test-release-final.node
node_modules/.bin/vitest run test/local-subtitle/overwriteTransaction.test.ts test/local-subtitle/overwriteNativeBackend.test.ts test/local-subtitle/subtitleExporter.test.ts test/local-subtitle/productionExecutor.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- native Node tests：11/11 passed，0 skipped。
- production integration：existing/absent finalize/rollback 4 例、retained-parent 1 例、open decision 1 例、hard-link rollback retry 1 例、begin/leaf rejection 6 例、journal validation 8 例全部通过；64 次 begin failure fd delta为 0。
- test-only recovery integration：begin crash 2 例、rollback crash 14 例、rollback error + same-receipt retry 14 例、finalize error + same-direction retry 5 例、absent finalize checkpoint unsupported proof 1 例全部通过；报告明确 `finalizeCrashRecoveryClaimed=false`、`powerLossSafetyClaimed=false`。
- focused Vitest：4 files / 190 passed。
- local-subtitle：35 passed + 2 skipped files / 820 passed + 2 skipped tests。
- 全量 Vitest：136 passed + 2 skipped files / 1773 passed + 2 skipped tests；两个 skip仍为未启用的真实 native server tests。
- TypeScript、renderer/main/preload 三段 Vite test build、manifest 0 error / 0 warning、validator 17/17通过。Vite只有既有 dynamic-import/chunk-size warning。
- production artifact：114,720 bytes，SHA-256 `4ab530ed377b6fd7f0b8fe740f458383a43bfa92cfd86e05f5e09356ff476bb6`。
- test-only artifact：115,024 bytes，SHA-256 `a2e7a7e86e66f2f1fff38a557de9519b8854a05d5aaad272fe09516e97491505`。
- 未运行 pnpm，未修改 `pnpm-lock.yaml`，未启动 Vite dev server、Electron 或 native server。最终已删除 `/private/tmp/fusionkit-fstxn001b-*.node` 共 8 个临时 artifact，并确认 FusionKit Vite/Electron/frontend 进程为空。

## 未完成事项与风险

- open/abandoned receipt、finalize crash和 Registry activate/revoke仍没有 durable cross-process decision。合法且仍存在的 `.open` journal返回 `decision_required`；finalize crash若发生在 journal unlink后则可能返回 `not_found`，本 checkpoint明确不宣称 finalize-crash recovery，不能靠布局猜测。
- Exporter第二次 finalize failure虽保留 commit方向，但尚无 main composite owner持久保存并重试 pending receipt；production wiring前必须闭环。
- output capability reauthorization、same-directory-object lazy recovery、Windows x64 exact FileId/backend仍未实现。
- native addon尚未进入 canonical resource manifest、generation-bound verified load、nested signing/hash、builder `extraResources`、main injection或两平台 packaged validation。
- APFS developer evidence不扩张到 HFS+、可移动盘、网络文件系统、kernel panic、断电或非协作 writer。

## 下一步建议

- 下一工作包优先实现 main/Registry composite recovery owner与重新授权后的 exact lazy recovery，再实现 Windows x64 backend。
- 随后与 `NATIVE-002` 合并 generation-bound staging/load、resource builder/main injection和两平台 packaged validation；全部证据完整后才能重新审计 production overwrite gate。
- `FS-TXN-001`、`BE-002` 与 M2继续保持进行中，production继续 `index-only`。
