# 工作包 FS-TXN-001C：Composite Recovery Owner 与 Native Protocol v3

## 基本信息

- 日期：2026-07-23
- 状态：已完成（component-level checkpoint；`FS-TXN-001` 总包仍进行中）
- 对应执行计划工作包：`FS-TXN-001` 的 component checkpoint `FS-TXN-001C`
- 目标平台：macOS arm64 developer component；cross-platform main contract

## 本次认领边界

- 包含：protocol v3 / journal v2、exact transaction ID、branded recovery authority、path-free file repository、directory-object mutex/fence、main/Registry composite recovery owner、Exporter prepared handoff、owner release/shutdown retry、重新授权后的 exact lazy recovery。
- 不包含：prepared handoff durable preclaim、abandoned/open receipt discovery、finalize-crash durable decision、Windows backend、generation-bound staging/load、production main/reauthorization IPC/UI injection、production gate 放行或 packaged validation。

## 本次实现内容

- native request新增exact `transactionId`，canonical partial leaf必须为`.fusionkit-local-subtitle-${transactionId}.partial`；journal升级为version 2并保存complete validated begin snapshot。recover只接收`transactionId`、重新授权目录路径及expected directory identity，由addon派生exact journal leaves，不接受caller-supplied rollback metadata。
- native loader升级到protocol v3，一次加载后分离branded transaction Coordinator与single-claim recovery authority；拒绝Proxy、expanded/accessor payload、异步result与重复claim。
- 新增path/capability/token-free recovery file repository：0600 exclusive temp、file fsync、atomic rename、parent sync；rename后sync失败只有exact payload read-back一致才接受，不把该证据扩张为power-loss安全声明。
- 新增唯一composite owner，绑定native receipt/journal、Artifact Registry reservation/activation authority与owner/task/generation/format。terminal、Registry revoke、repository任一步失败仍保留可重试ownership；owner release、shutdown及shutdown后late adoption会继续结算。
- Exporter在native begin前执行`prepareAdoption()`，预留recovery ID/metadata并建立single-claim handoff；begin后若terminal或Registry未收敛则正式`adopt()`。handoff有明确`prepared/claimed/discarded`状态，避免begin后才因重复ID或handoff分配失败。
- directory-object mutex与recovery fence统一覆盖Exporter和owner。`decision_required`与`not_found`都保留pending record、durable recovery direction和已选目录fence，shutdown返回`recovery_pending`；只有native与Registry authority真正收敛后才删除record并释放fence。
- Session lifecycle把recovery owner放在quiesce之后、media/server cleanup之前，并保持all-settled与first-failure语义。
- 新增按`recoveryId`串行化的恢复临界区，并在锁内重新读取与校验entry，避免同一recovery通过相同或不同目录并发选择时重复调用native。若native已回滚但首次repository删除失败，排队请求只重试持久化删除，不重复执行native recovery。

## Prepared Handoff 限制

`prepareAdoption()`只写入当前进程的`WeakMap/Map`，不在native begin前创建durable composite record。因此本checkpoint只能称“component-level prepared handoff”，不能称“atomic/durable handoff”。以下窗口仍未关闭：

- native begin已修改namespace、正式`adopt()`尚未持久化时进程退出；
- abandoned/open receipt的durable discovery；
- finalize crash与Registry commit/revoke的durable cross-process decision。

这些限制不扩入001C，也不混入Windows-only 001D；由后续durable-decision与production main composition闭环。

## 修改文件

- `electron/main/local-subtitle/overwrite-{transaction,directory-coordinator,native-backend,recovery-owner}.ts`
- `electron/main/local-subtitle/{subtitle-exporter,session-lifecycle}.ts`
- `native/local-subtitle-overwrite/{README.md,src/addon.cc}`
- `scripts/local-subtitle/overwrite-native/*`
- `test/local-subtitle/overwrite{Transaction,DirectoryCoordinator,NativeBackend,RecoveryOwner}.test.ts`
- `test/local-subtitle/{subtitleExporter,sessionLifecycle,productionExecutor}.test.ts`
- Final Design、Execution Plan、v0.2.11 README/iteration ledger与本实施记录

## 接口、状态或数据结构变化

- native protocol：`2 -> 3`；journal version：`1 -> 2`。
- begin request新增`transactionId`；recover request收口为`transactionId/directoryPath/expectedDirectoryIdentity`。
- recovery result保持`rolled_back | decision_required | not_found`；后两种未收敛结果都保留directory fence。
- recovery record只持久化schema、opaque ID、owner fingerprint、task/generation/format、direction、Registry/native state与timestamps。
- main runtime factory返回分离的`transactions`与`recovery` authority；recovery authority只能claim一次。

## 安全、隐私与生产边界

- repository不保存raw path、capability、token、subtitle text或Registry reservation/ref。
- exact reauthorization仍要求task/generation/format与directory object identity全部匹配；不扫描用户目录prefix。
- production main仍使用未配置transaction/owner的`LocalSubtitleExporter`，Session lifecycle也未传入owner；Job Manager/Production Executor继续双重`index-only`。
- macOS developer evidence不覆盖non-cooperative child writer、power loss、Windows、signed/staged/packaged runtime或产品E2E。

## 验证结果

执行命令：

```text
node --test scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs
node_modules/.bin/vitest run test/local-subtitle/overwriteTransaction.test.ts test/local-subtitle/overwriteDirectoryCoordinator.test.ts test/local-subtitle/overwriteNativeBackend.test.ts test/local-subtitle/overwriteRecoveryOwner.test.ts test/local-subtitle/subtitleExporter.test.ts test/local-subtitle/sessionLifecycle.test.ts test/local-subtitle/productionExecutor.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit --pretty false
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- native Node tests：11/11 passed。
- focused Vitest：7 files / 257 passed。
- local-subtitle：37 passed + 2 skipped files / 883 passed + 2 skipped tests。
- 全量Vitest：138 passed + 2 skipped files / 1836 passed + 2 skipped tests；两个skip仍为未启用的真实native server tests。
- TypeScript、三段Vite test build、manifest 0 error / 0 warning、validator 17/17与diff check通过。
- 未运行pnpm，未修改`pnpm-lock.yaml`，未启动Vite dev server、Electron或native server。

## 总体剩余工作

Execution Plan仍为39个顶层工作包：16个已完成，23个剩余。

- 进行中：`FS-TXN-001`、`BE-002`。
- 未开始：`NATIVE-002`、`MODEL-002`、`BE-003`、`FE-001`～`FE-004`、`LINK-001`～`LINK-008`、`QA-001`～`QA-005`、`DOC-001`，共21个。

001A～001D都是`FS-TXN-001`的component checkpoints，不增加顶层工作包数量。

## 下一步建议

下一checkpoint为`FS-TXN-001D：Windows x64 Native Overwrite Component`，范围严格为：

- win32/x64 protocol v3 / journal v2 parity；
- directory HANDLE与RootDirectory-relative child operations；
- reparse/no-follow边界；
- lossless Windows volume/file identity codec，不把Windows FileId压成JS safe-number `dev/ino`；
- existing/absent victim、terminal retry、exact recovery、fresh-process fault/crash和真实Node load。

001D明确不包含prepared handoff durable preclaim、finalize-crash durable decision、resource staging/builder、production main injection/reauthorization IPC/UI、production gate放行或packaged validation。
