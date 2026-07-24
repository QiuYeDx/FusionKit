# 工作包 FS-TXN-001D：Windows x64 Native Overwrite Component

## 基本信息

- 日期：2026-07-24
- 状态：已完成（Windows component checkpoint；`FS-TXN-001` 总包仍进行中）
- 对应执行计划工作包：`FS-TXN-001` 的 component checkpoint `FS-TXN-001D`
- 目标平台：Windows x64 developer component

## 本次认领边界

- 包含：win32/x64 protocol v3 / journal v2 parity、directory HANDLE 与
  `RootDirectory`-relative child operations、reparse/no-follow、lossless
  volume/FileId identity、existing/absent victim、terminal retry、exact
  rollback recovery、fresh-process fault/crash 与真实 Node load。
- 不包含：durable prepared preclaim、finalize-crash durable decision、
  resource staging/builder、production main injection、reauthorization
  IPC/UI、production gate 放行、签名或 packaged validation。

## 本次实现内容

- 新增 `addon-win32.cc`：只支持 Windows x64，production surface 与 macOS
  保持 exact `protocolVersion/platform/architecture/begin/recover` 五个
  export；protocol 固定 3，journal 固定 2。
- 输出目录用 `CreateFileW(FILE_FLAG_OPEN_REPARSE_POINT)` 打开并校验一次；
  所有 child lookup 使用 `NtCreateFile` 的 `RootDirectory` +
  `OBJ_DONT_REPARSE`，rename/link/disposition 分别使用
  `FileRenameInformationEx`、`FileLinkInformation` 和
  `FileDispositionInformationEx`。
- existing victim 先创建 exact hard-link backup，再以 POSIX replace 语义
  安装 partial；rollback 把 backup 重新命名到 final。absent victim 使用
  no-replace rename；rollback 通过 exact installed HANDLE 删除。
- Windows identity 固定为
  `{ volumeSerialHex: 8 lowercase hex, fileIdHex: 32 lowercase hex }`，直接
  来自 `FILE_ID_INFO`；不经 JavaScript safe-number `dev/ino`，也不使用
  creation/birth time。真实 NTFS 测试证明 replace/restore 可能触发
  creation-time tunneling，因此新增 `FK-PIT-0063`。
- rollback 恢复同时接受“刚进入 rollback intent 的 installed layout”和
  “namespace 已恢复、只剩 cleanup”的幂等 layout；POSIX deletion 后以
  retained HANDLE 的 link count 归零证明删除完成，避免对 delete-pending
  同名 leaf 再打开时收到 Windows access denied。
- test-only error fault 由 native UCRT 一次性清除环境开关，保证同一个
  receipt 的 terminal retry 真正重新执行；crash fault 仍以 fresh child
  `ExitProcess(86)` 证明。
- 新增 Windows production/test build recipe、production integration、
  recovery child/matrix 与 Node test。构建要求显式 portable LLVM-MinGW、
  当前 Node exact headers 和 x64 `node.lib`，命令 `shell:false`、环境最小
  化、产物必须为单一 x64 PE，发布 no-clobber，receipt 不保存私有路径。
- TypeScript overwrite identity 扩为 POSIX/Windows 联合类型；directory
  mutex key 和 equality 支持 lossless Windows identity。Exporter 在
  Registry 尚未支持 Windows identity 时明确 rollback 并 fail closed，
  所以本 checkpoint 没有跨边界开启 production。

## 构建证据

- Node：`24.14.0`；Node-API：8。
- LLVM-MinGW：`20260407` UCRT x86_64 portable release。
- LLVM-MinGW archive SHA-256：
  `3fc6e54b5f1102089d4d37095ba49f7b24e22290da78178b514a86b3126c6d9e`。
- Node headers archive SHA-256：
  `bc1505c8e2b2b1f7b7cf3808bf53691e5d110c816d1bc1a48075195c5dcafe05`。
- x64 `node.lib` SHA-256：
  `35fcdd35d3d22e283c0e2e095cc43ef676301bb85f950c344a73d59231bd7e61`。
- production proof：824,832 bytes，SHA-256
  `d9ebc114fc337bcf8d93ccfa7b020e58e162ee01822464a8b4714157f7044de1`。
- test-only proof：827,392 bytes，SHA-256
  `906818844b7200e5a27e12de506795beed582645fe0e7e7ef28246ec5fe8cf66`。

以上两个 `.node` 只用于本地 developer evidence，没有提交、staging、
签名、打包或写入 release manifest。

## 验证结果

执行命令：

```text
node --test scripts/local-subtitle/overwrite-native/build-addon-windows-x64.test.mjs
node scripts/local-subtitle/overwrite-native/run-addon-windows-integration.mjs --addon <absolute-production-addon.node>
node scripts/local-subtitle/overwrite-native/run-addon-windows-recovery-integration.mjs --addon <absolute-test-addon.node>
node node_modules/vitest/vitest.mjs run test/local-subtitle/overwriteTransaction.test.ts test/local-subtitle/overwriteDirectoryCoordinator.test.ts test/local-subtitle/overwriteNativeBackend.test.ts
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/vite/bin/vite.js build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- Windows native Node tests：6/6 passed，包含真实 compile/load/integration。
- production integration：4 terminal、5 recovery 与 6 rejection cases 全部
  passed。
- fresh-process recovery：3 begin crashes、14 rollback crashes、14 rollback
  error/retries、5 finalize error/retries、2 个显式 finalize-crash boundary
  cases 全部 passed。
- TypeScript identity/loader focused Vitest：3 files / 147 passed。
- TypeScript、renderer/main/preload 三段 Vite test build、manifest 0 error /
  0 warning、validator 17/17 与 diff check 通过；Vite 只有既有
  dynamic-import/chunk-size warning。
- 未运行 pnpm，未修改 `pnpm-lock.yaml`，未启动 Vite dev server、Electron
  或 native server。
- 便携工具链、headers、import library 与所有 developer proof artifacts
  已从系统临时目录删除；仓库未留下 native binary。

## Windows 组合层现状

仓库既有 Artifact Registry / authorization / Exporter 文件系统身份仍使用
POSIX 形状 `{ dev, ino, birthtimeMs }`。Windows 临时目录的真实 NTFS
FileId 可超过 JavaScript safe-integer，因此这些既有 filesystem-heavy
Vitest 在 Windows 上会按原合同 fail closed；这不是 001D native component
可以安全绕过的验证红灯。本 checkpoint 只把 lossless Windows identity
贯通到 native protocol、strict adapter 与 directory coordinator，并在
尚未组合的 Registry 边界回滚。完整迁移必须作为下一跨平台 composition
工作继续，不能在本包中通过放宽 safe-integer 校验伪造身份。

## 安全、隐私与声明边界

- journal 只接受 exact transaction ID 派生的 `.open/.rollback/.victim`
  leaves；不扫描目录，不接受 caller rollback metadata。
- reparse leaf、hard link partial、identity/size mismatch、expanded request
  与大小写 leaf collision 均稳定拒绝。
- production main、staging contract、builder 和双重 `index-only` gate 均未
  改变。
- 不声明 finalize-crash recovery、power-loss safety、signed/staged/
  packaged runtime 或产品 E2E。

## 下一步建议（可在 Mac 继续）

Windows-only `FS-TXN-001D` 已没有待开发项。下一步回到跨平台 composition：

1. 在 native begin 前建立 durable prepared preclaim，并冻结 open/finalize
   的 durable decision 与 abandoned receipt discovery。
2. 将 Artifact Registry、authorization 和 recovery selection 组合到
   POSIX/Windows exact identity 联合类型；Mac 可通过 strict fixtures
   完成 TypeScript 主体，Windows 只需后续 packaged smoke 复核。
3. 增加 generation-bound resource staging/load、builder、production main
   与 reauthorization IPC/UI injection。
4. 两平台 packaged validation 通过后，才评估解除 Job Manager /
   Production Executor 的双重 `index-only` gate。
