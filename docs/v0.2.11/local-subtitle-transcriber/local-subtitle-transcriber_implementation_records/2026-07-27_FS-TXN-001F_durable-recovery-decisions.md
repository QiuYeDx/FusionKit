# 工作包 FS-TXN-001F：durable recovery decisions

## 基本信息

- 日期：2026-07-27
- 状态：已完成（component checkpoint；顶层 `FS-TXN-001` 仍为进行中）
- 对应执行计划工作包：`FS-TXN-001`

## 本次实现内容

- 将 macOS arm64 与 Windows x64 overwrite native surface 升级到 protocol v4 / journal v3；production exact exports 增加同步 `acknowledge(request)`。
- 在 native `begin` 前持久化 schema-v2、path-free recovery preclaim，记录 `rollback_unpublished + not_started`，关闭“namespace 已修改但 main 尚未建立 durable owner”的窗口。
- Registry activation 后持久化 `finalize_committed`；fresh-process recovery 只按 durable decision 选择 finalize 或 rollback，不再让 open journal 返回 `decision_required`。
- `finalize_committed` 持久化只允许首次写入加一次完全相同 payload 的有界重试；两次都失败时保留 receipt、Registry activation、recovery record 与 directory fence，不进入 native finalize，也不回退 rollback。
- native terminal operation 先把 `.open` 原子发布为 `.finalize` 或 `.rollback` marker，再收敛 namespace；terminal marker 在 main 持久化 `nativeState=settled` 前不会删除。
- native finalizer 对仍为 `.open` 的 receipt 保持方向中立，不自行发布 rollback/finalize；只沿已经 armed 的 terminal 方向 best-effort 续跑，pending acknowledgement 也不由 finalizer 执行 ack。
- receipt 与 fresh-process recovery 均采用 terminal marker + acknowledgement：terminal 成功进入 `*_pending_ack`，main 先持久化 settled，再调用 receipt/module `acknowledge` 删除 marker，最后删除 recovery record 并释放 directory fence。
- recovery schema 升级到 v2：durable decision 为 `rollback_unpublished | finalize_committed`，native state 为 `not_started | pending | settled | retry_failed`。`not_found` 仅在 `rollback_unpublished + not_started`（begin 未建立 journal）或已有 durable `settled` 证明后的 acknowledgement 中可视为完成；其他 pending 状态继续 fail closed。
- 持久化结果不确定时保留 record/fence 并禁止 acknowledge；`releaseAdoption` 只允许在明确尚未调用 native begin 时删除 preclaim，begin 已标记开始后 adoption 失败也必须保留 recovery ownership。

## 修改文件

- `electron/main/local-subtitle/overwrite-native-backend.ts`
- `electron/main/local-subtitle/overwrite-recovery-owner.ts`
- `electron/main/local-subtitle/overwrite-transaction.ts`
- `electron/main/local-subtitle/subtitle-exporter.ts`
- `native/local-subtitle-overwrite/README.md`
- `native/local-subtitle-overwrite/src/addon.cc`
- `native/local-subtitle-overwrite/src/addon-win32.cc`
- `scripts/local-subtitle/overwrite-native/*`
- `test/local-subtitle/overwriteNativeBackend.test.ts`
- `test/local-subtitle/overwriteRecoveryOwner.test.ts`
- `test/local-subtitle/overwriteTransaction.test.ts`
- `test/local-subtitle/subtitleExporter.test.ts`
- 本实施记录及主题 Final Design / Execution Plan、v0.2.11 总台账与 README。

## 接口或数据结构变化

- `LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION`：`3 -> 4`。
- native journal schema：`2 -> 3`；journal phase 从 open/rollback 扩展为 `.open | .finalize | .rollback`。
- production addon exact exports：`protocolVersion/platform/architecture/begin/recover/acknowledge`。
- transaction receipt 增加 `finalize_pending_ack`、`rollback_pending_ack` 与 `acknowledge()`。
- recovery request 增加 durable `decision: "finalize" | "rollback"`；recovery result为 `finalized | rolled_back | not_found`，acknowledgement result为 `acknowledged | not_found`。
- recovery repository 升级为 schema v2，只持久化 opaque ID、owner fingerprint、task/generation/format、decision、native state 与时间戳，不持久化 raw path、capability、token、leaf 或 Registry ref。

## 验证结果

执行命令：

```text
node --test scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs
node --test scripts/local-subtitle/overwrite-native/build-addon-windows-x64.test.mjs
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit --pretty false
node node_modules/vite/bin/vite.js build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- macOS arm64 native：11/11 passed。
- Windows contract：6 passed；真实 Windows compile/load/integration 1 skipped（当前非 Windows 主机），不能替代真实 Windows 矩阵。
- local-subtitle：38 passed + 2 skipped files / 914 passed + 2 skipped tests；2 个 skip 仍是未启用的真实 native server 测试。
- 全量 Vitest：139 passed + 2 skipped files / 1867 passed + 2 skipped tests。
- TypeScript、renderer/main/preload 三段 Vite test build、manifest 0 error / 0 warning、validator 17/17 与 diff check 通过；Vite 只有既有 dynamic-import/chunk-size warning。
- 回归矩阵覆盖 finalize decision 首次写入加一次同 payload retry，以及 abandoned-open receipt 在 existing/absent victim × finalize/rollback 四种 fresh-process 组合下保留 `.open`、等待 durable decision 后收敛并成功 acknowledge。
- 未启动 Vite dev server、Electron 或其他前端服务；结束前 FusionKit 定向进程检查为空。
- 本 checkpoint 不宣称 power-loss、non-cooperative writer、verified staged/builder load 或 packaged runtime safety。

## 未完成事项

- production main 尚未实例化并注入 verified overwrite native runtime、repository 与 recovery owner。
- reauthorization IPC/UI 尚未接线，Job Manager 与 Production Executor 的双重 `index-only` gate 未解除。
- generation-bound verified staging/load、builder integration 与两平台 packaged validation 未完成。
- 真实 Windows compile/load、terminal/recovery/crash/acknowledgement 矩阵仍需在 Windows x64 主机执行。
- 顶层 `FS-TXN-001` 仍为进行中；本记录只关闭 durable decision / terminal marker + ack component checkpoint。

## 下一步建议

- 下一会话优先完成 verified staging/builder 与 production main injection，再实现 reauthorization IPC/UI；随后在真实 Windows 与两平台 packaged 产物上完成矩阵，最后才评估解除双重 `index-only` gate。
