# 工作包 FS-TXN-001A：macOS arm64 Native Overwrite Component 纵切

## 基本信息

- 日期：2026-07-23
- 状态：已完成 developer component checkpoint；`FS-TXN-001` 总包仍进行中
- 对应执行计划工作包：`FS-TXN-001`
- 目标平台：macOS arm64 / Node 20.19.5 / plain Node-API v8
- Production gate：未改变；Job Manager 与 Production Executor 继续只允许 `index`

## 本次认领边界

- 包含：macOS arm64 directory-fd-relative addon、严格 TypeScript loader、可复现开发构建、真实 addon load 与 filesystem integration。
- 包含：existing/absent victim 的 finalize/rollback、retained-directory parent replacement、partial identity/size/type/link-count 拒绝，以及 post-wrap begin failure 的同步 handle cleanup。
- 不包含：同目录 child-leaf 并发原子性、持久 rollback/crash recovery、Windows x64 backend、generation-bound verified loader proof、resource staging/builder、main 注入、Electron packaged validation 或 production overwrite 放行。

## 实现内容

- 新增 plain Node-API addon。`begin()` 只用绝对路径打开并验证一次 `O_NOFOLLOW` directory fd；之后的 `fstatat/openat/renameatx_np/unlinkat` 都相对 retained fd。existing victim 使用 `RENAME_SWAP`，absent victim 使用 `RENAME_EXCL`。
- receipt 跨 Registry activation 持有 directory/new-file fd。rollback 先恢复 victim/absence，再进入 retryable cleanup phase；不会重复执行已经完成的 swap/rename。
- partial 必须是 identity/size 匹配的 regular file 且 `st_nlink == 1`。rollback 删除 partial 后继续用 pinned file fd 验证 `st_nlink == 0`；partial 被并发移动或新增 hard link 时不能误报 cleanup completed。
- 修复真实 native begin failure fd 泄漏：receipt 已 `napi_wrap`、但 commit 因权限拒绝失败时，异常路径现在同步 `napi_remove_wrap`、校验 native pointer 并 delete transaction，随后才向 JavaScript 抛错。
- 新增 strict loader，只接受绝对 `.node` 路径、exact plain-object exports、protocol v1 和当前 process target；只向调用方返回 branded `LocalSubtitleOverwriteTransactionCoordinator`，不公开 raw backend loader。
- 新增 shell-free developer build：只消费当前 Node 安装的 exact-version headers，固定 N-API v8、C++17、arm64、macOS 11.0 deployment target，使用 direct `xcrun clang++`，不调用 pnpm/node-gyp。产物以 no-clobber hard link 发布，并可生成不含私有路径的 build receipt。
- 构建验证检查 thin arm64 Mach-O、minimum macOS 11.0、可重复 size/SHA、真实 `require()` 和 exact native exports。链接保留 `LC_UUID`；`dwarfdump --uuid` 与 loadability 均通过。
- integration 覆盖 existing/absent victim 的 finalize/rollback、原目录 rename 后 replacement directory 不受影响、begin 后新增 hard link 使 rollback 保持 cleanup-pending 并在移除 alias 后 retry 收敛、partial identity/size/symlink/FIFO/multiple-links 拒绝，以及 64 次 permission-denied begin failure 后 `/dev/fd` delta 为 0。

## 修改文件

- `electron/main/local-subtitle/overwrite-native-backend.ts`
- `electron/main/local-subtitle/overwrite-transaction.ts`
- `native/local-subtitle-overwrite/src/addon.cc`
- `native/local-subtitle-overwrite/README.md`
- `native/local-subtitle-overwrite/binding.gyp`
- `scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.mjs`
- `scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs`
- `scripts/local-subtitle/overwrite-native/run-addon-integration.mjs`
- `test/local-subtitle/overwriteNativeBackend.test.ts`
- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- `.agents/skills/fusionkit-pitfall-guard/references/keep-lc-uuid-in-macos-node-addons.md`
- `.agents/skills/fusionkit-pitfall-guard/references/detach-wrapped-native-state-on-begin-failure.md`
- local-subtitle Final Design、Execution Plan、v0.2.11 入口与版本台账

## 验证命令

```text
node --test scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs
node scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.mjs --output <absolute-temp-dir>/local-subtitle-overwrite.node --receipt <absolute-temp-dir>/build-receipt.json
node scripts/local-subtitle/overwrite-native/run-addon-integration.mjs --addon <absolute-temp-dir>/local-subtitle-overwrite.node --output <absolute-temp-dir>/integration-report.json
/usr/bin/file <absolute-temp-dir>/local-subtitle-overwrite.node
/usr/bin/xcrun dwarfdump --uuid <absolute-temp-dir>/local-subtitle-overwrite.node
node_modules/.bin/vitest run test/local-subtitle/overwriteNativeBackend.test.ts test/local-subtitle/overwriteTransaction.test.ts test/local-subtitle/subtitleExporter.test.ts test/local-subtitle/productionExecutor.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

## 验证结果

- native build/load/integration Node tests：9/9；其中真实 addon integration 已纳入 loadability test。
- developer artifact：Mach-O 64-bit arm64 bundle，minimum macOS 11.0.0，78,368 bytes，SHA-256 `9188f34abe984dfd9979efae31d7492e7d5b3ca1335688b4625a1dc67b914e4a`；`LC_UUID` 可读取，真实 Node `require()` 成功。
- native integration：4 个 terminal case、1 个 retained-dir parent replacement case、1 个 rollback cleanup retry case、6 个 rejection/failure-atomicity case 全部通过；64 次失败 begin 的 open fd delta 为 0，production gate flag 为 false。
- transaction/loader/exporter/production 聚焦：4 files / 188 tests passed。
- local-subtitle：35 passed + 2 skipped files / 818 passed + 2 skipped tests。
- 全量 Vitest：136 passed + 2 skipped files / 1771 passed + 2 skipped tests。两个 skip 仍是未启用的真实 native server tests。
- TypeScript、renderer/main/preload 三段 Vite test build、manifest 0 error / 0 warning、validator 17/17 通过。Vite 只有既有 dynamic-import/chunk-size warning。
- 未运行 pnpm，未修改 `pnpm-lock.yaml`，未启动 Vite dev server、Electron 或 native server。

## 未完成事项与风险

- Darwin 的 `renameatx_np` / `unlinkat` 仍按 child leaf name 操作，identity check 与 mutation 之间存在同目录并发窗口。retained directory fd 只证明 parent replacement 安全，不能宣称完整 hostile-filesystem/child-namespace 原子性。
- terminal cleanup fault injection、rollback failure 的跨调用/跨进程持久 recovery、abandoned receipt、process crash 和 orphan victim cleanup 尚未闭环。
- strict TypeScript loader 的 unit test mock 了 `createRequire`；真实 raw addon load 与 raw filesystem integration 已通过，但 verified proof 到 `dlopen` 的 replacement/cache 闭环和真实 TS adapter + Electron packaged composition 仍未完成。
- Windows x64 backend 与无损 FileId codec未实现；现有 number 型 `dev/ino/birthtimeMs` 不能作为 Windows exact identity 证据。
- addon 未进入 canonical resource manifest/staging、nested signing/hash、builder `extraResources` 或 main runtime。以上证据完成前不得解除 production index-only gate。

## 下一步

- 先冻结 child-leaf 并发与 rollback persistent recovery 方案，并建立可确定注入的 terminal fault matrix。
- 实现 Windows x64 HANDLE/RootDirectory-relative backend 与 lossless identity codec。
- 与 `NATIVE-002` 协同完成 generation-bound staging/load proof、nested signing/hash、builder 与两平台 packaged validation；最后才接入 main 并重新审计 production gate。
