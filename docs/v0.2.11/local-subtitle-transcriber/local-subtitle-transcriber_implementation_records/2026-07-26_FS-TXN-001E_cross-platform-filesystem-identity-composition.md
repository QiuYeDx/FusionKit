# 工作包 FS-TXN-001E：跨平台 Filesystem Identity Composition

## 基本信息

- 日期：2026-07-26
- 状态：已完成（cross-platform composition checkpoint；`FS-TXN-001` 总包仍进行中）
- 对应执行计划工作包：`FS-TXN-001` 的 component checkpoint `FS-TXN-001E`
- 验证主机：Windows x64

## 本次认领边界

- 包含：POSIX/Windows exact filesystem object identity 的统一采集、输出目录
  authorization、Artifact Registry activation/read validation、Exporter partial/
  overwrite activation、recovery selection 与 Production Executor directory proof。
- 不包含：input/media/runtime/model 等既有 POSIX-only 文件身份迁移、durable
  prepared preclaim/open/finalize decision、resource staging/builder、production main
  injection、reauthorization IPC/UI、overwrite gate 放行或 packaged validation。

## 本次实现内容

- 新增 `filesystem-object-identity.ts`，集中提供：
  - POSIX `{ dev, ino, birthtimeMs }` exact snapshot；
  - Windows bigint stats 到
    `{ volumeSerialHex: 8 lowercase hex, fileIdHex: 32 lowercase hex }` 的
    lossless 固定宽度转换；
  - path、同步 path 与已打开 `FileHandle` 的平台化采集；
  - strict snapshot 与跨 identity arm equality。
- Windows identity 只从 `lstat(..., { bigint: true })` /
  `FileHandle.stat({ bigint: true })` 产生；负数、超宽值、大小写或扩展字段
  均 fail closed，不把 `FileId` 经 JavaScript `number` 往返。
- 输出目录 authorization、source parent proof、Exporter directory mutex 前后
  校验和 Production Executor proof 比较全部改用同一 exact identity union。
- Artifact Registry 除原有 size/mtime/ctime 内容快照外，新增独立
  `fileObjectIdentity`。activation、path read、held handle read、read-after 与
  directory proof 都要求 exact object identity 与内容快照同时匹配。
- Exporter 的 partial create/read/cleanup、indexed rollback 与 overwrite
  activation 使用 exact identity；移除 001D 的 Windows Registry 边界回滚，
  允许 Windows native receipt 进入 Registry。recovery selection 同时接受
  strict POSIX 与 Windows directory identity。
- Job Manager 与 Production Executor 的双重 `index-only` gate、production
  main composition和 native resource staging均未改变。
- Windows 无法创建换行叶名的两个 authorization 断言改为只在支持该叶名的
  平台执行；其余测试语义保持不变。

## 验证结果

执行命令：

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/vitest/vitest.mjs run test/local-subtitle/filesystemObjectIdentity.test.ts test/local-subtitle/authorizations.test.ts test/local-subtitle/subtitleArtifactRegistry.test.ts test/local-subtitle/subtitleExporter.test.ts test/local-subtitle/overwriteRecoveryOwner.test.ts
node node_modules/vitest/vitest.mjs run test/local-subtitle/productionExecutor.test.ts test/local-subtitle/overwriteTransaction.test.ts test/local-subtitle/overwriteNativeBackend.test.ts test/local-subtitle/overwriteDirectoryCoordinator.test.ts
node node_modules/vitest/vitest.mjs run test/local-subtitle/ipc.test.ts
node node_modules/vite/bin/vite.js build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- focused identity/authorization/Registry/Exporter/recovery：5 files / 126 passed。
- Executor/overwrite regression：4 files / 192 passed。
- IPC direct consumer：1 file / 12 passed。
- 合计定向：10 files / 330 passed。
- TypeScript、renderer/main/preload 三段 Vite test build、manifest 0 error /
  0 warning、validator 17/17 通过；Vite 只有既有 dynamic-import/chunk-size
  warning。
- 完整 `test/local-subtitle` 在本 Windows 主机另行实跑为 28 passed、2
  skipped、10 failed files；727 passed、109 skipped、67 failed tests。
  红灯集中于未纳入本 checkpoint 的 input/media/resource/server/PCM 等
  POSIX-only identity/permission fixtures，并包含 001D 已记录的 Windows
  fail-closed 基线。本次直接消费者 IPC 的旧 identity fixture 已修正并
  12/12 通过；没有把完整套件误记为通过。
- 未运行 pnpm，未启动 Vite dev server、Electron、native server 或其他
  常驻前端服务。

## 安全与声明边界

- 本 checkpoint 关闭 001D 留下的 Registry/authorization/recovery selection
  Windows exact identity 组合红灯，但不等于 production overwrite 可用。
- durable prepared/finalize decision、generation-bound staging/load、
  production main/IPC/UI injection 和两平台 packaged validation仍未完成。
- `FS-TXN-001` 与 `BE-002` 继续为进行中；Job Manager / Production Executor
  继续只接受 `index`。
- 沿用 `FK-PIT-0063`：Windows object identity 必须来自 bigint stats /
  native `FILE_ID_INFO`，不得用 birth time 或 JS safe-number inode 代替。

## 下一步建议

1. 建立 durable prepared preclaim、open decision 与 finalize-crash decision。
2. 完成 generation-bound native staging/load 与 builder 校验。
3. 注入 production main、repository/owner 和 reauthorization IPC/UI。
4. 两平台 packaged validation完整后，再评估解除双重 `index-only` gate。
