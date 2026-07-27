# 工作包 FS-TXN-001H：production overwrite main composition

## 基本信息

- 日期：2026-07-27
- 状态：已完成（component checkpoint；顶层 `FS-TXN-001`、`BE-002` 与 `NATIVE-002` 仍为进行中）
- 对应执行计划工作包：`FS-TXN-001` 的 production main composition 子合同
- production gate：Job Manager / Production Executor 双重 `index-only` 保持，不因本 checkpoint 解除

## 范围与非目标

本 checkpoint 把 001G 冻结的 verified addon production load proof、001F 冻结的 schema-v2 durable recovery repository/composite owner 与现有 Exporter/SessionLifecycle 在 Electron main 中组成一个 fail-closed runtime。

本次不包含：

- reauthorization IPC/UI；
- Job Manager / Production Executor 的 `overwrite` policy 放行；
- 真实 Windows x64 protocol v4 compile/load/terminal/recovery/crash/acknowledgement 矩阵；
- `NATIVE-002` 的完整 official server/media artifact assembly、目标平台 launch/no-PATH 与两平台 packaged 验证；
- renderer、preload 或 public IPC 合同变化。

## 本次实现内容

### Canonical proof-only production bootstrap

- 新增独立 production runtime composition：先通过 canonical resource environment 获取 001G 的 branded、generation-bound verified addon proof，再以该 proof 创建 native transaction/recovery runtime；production 入口不接受裸 `.node` 路径、module name、developer build receipt 或 caller-injected loader。
- production module 只导出 `initializeLocalSubtitleOverwriteProductionRuntime`；dependency injection 留在独立 test-support 模块，避免测试 seam 扩张 production export surface。
- repository 固定为 versioned 路径 `<userData>/local-subtitle/recovery/overwrite-recovery.v2.json`，即 main 传入的 managed root 下 `recovery/overwrite-recovery.v2.json`；路径仍只承载 schema-v2 path-free recovery records，不持久化 output path、capability 或 token。
- bootstrap 只构造 owner，不在启动时替用户选择目录，也不自动调用 native recovery；既有 pending record 继续等待后续重新授权。

### Fail-closed startup classification

- 已知 `LocalSubtitleOverwriteNativeResourceError` 与 `LocalSubtitleOverwriteNativeBackendError` 映射为 `unavailable/native_resource_unavailable`，并且在验证/load失败时不打开或改写 recovery repository。
- 已知 `LocalSubtitleOverwriteRecoveryError` 映射为 `blocked/recovery_state_unavailable`；invalid repository 不被自动重写、丢弃或降级为空状态。
- 未知异常与无效 production composition 直接 rethrow，不能被伪装成普通 unavailable/blocked 状态而隐藏编程错误。
- unavailable/blocked runtime 在 `app_quit` 与 `fatal` 时收敛为空操作，但 `update` shutdown 继续以 `recovery_pending` fail closed，避免未确认 recovery authority 时推进更新。

### Main composition 与同一 owner 生命周期

- `electron/main/index.ts` 在 `app.whenReady()` 中，以同一个 Artifact Registry、canonical resource environment 和 managed root 初始化一次 overwrite production runtime。
- lifecycle 与 local-subtitle IPC 均在首个窗口前安装，macOS `activate` handler 只在初始化完成后注册，避免异步 addon bootstrap 期间提前创建无 owner session 的窗口或重复开窗。
- ready runtime 的同一 `transactions` / `recoveryOwner` 成对注入 `LocalSubtitleExporter`，禁止 transaction coordinator 与另一 recovery owner 混配。
- 同一个 runtime 的同一 `recoveryOwner` 同时作为 `LocalSubtitleSessionLifecycle` 的 lifecycle target；unavailable/blocked 时则传入 bootstrap 返回的 fail-closed target。
- Job Manager 与 Production Executor 的两处 `index-only` gate 均未修改，public IPC、preload 和 renderer UI 也未新增 overwrite 或 reauthorization 能力，因此该 composition 不构成 production overwrite 放行。

## 修改文件

- `electron/main/local-subtitle/overwrite-production-runtime-core.ts`
- `electron/main/local-subtitle/overwrite-production-runtime.ts`
- `electron/main/local-subtitle/overwrite-production-runtime-test-support.ts`
- `electron/main/index.ts`
- `test/local-subtitle/overwriteProductionRuntime.test.ts`
- 本实施记录及主题 Final Design / Execution Plan、v0.2.11 总台账与 README。

## 接口或数据结构变化

- 新增 `LocalSubtitleOverwriteProductionRuntime` 的 `ready | unavailable | blocked` 判别联合。
- 新增固定 repository relative path `recovery/overwrite-recovery.v2.json`。
- `ready` 分支公开同一 generation 下的 transaction coordinator、composite recovery owner 和 lifecycle target；非 ready 分支只公开 fail-closed lifecycle target。
- public IPC/schema、renderer state 与持久化 recovery schema 均未升级。

## 安全与恢复边界

- production bootstrap 只从 canonical verified proof 建立 native runtime，延续 001G 的 generation-bound/content-addressed load authority，不把绝对路径重新引入 production API。
- recovery repository 的已知解析/持久化错误必须 blocked 且保留原文件；不能把未知、损坏或未收敛状态当作无 pending recovery。
- bootstrap 不扫描 output directory、不推断 recovery directory，也不在缺少用户重新授权时执行 native recovery。
- 本 checkpoint 只完成 composition ownership，不改变既有 terminal decision、`settled` 后 acknowledgement、pending `not_found` fail-closed 与 path-free persistence 合同。

## 验证

已完成的定向验证：

- overwrite production composition 相关 11 files / 313 passed。
- TypeScript `tsc --noEmit --pretty false` 通过。
- `git diff --check` 通过。

最终主任务验证：

- focused：11 files / 313 passed。
- local-subtitle：40 passed + 2 skipped files / 931 passed + 2 skipped tests。
- 全量 Vitest：141 passed + 2 skipped files / 1884 passed + 2 skipped tests。
- overwrite-native：29 passed + 1 skipped；skip 为当前非 Windows 宿主上的真实 Windows 验证。
- manifest：0 error / 0 warning；validator：17/17。
- TypeScript、renderer/main/preload 三段 Vite test build 与 `git diff --check` 通过。

上述证据不替代真实 Windows compile/load/terminal/recovery/crash/acknowledgement 矩阵、target packaged 验证或完整 product E2E。

本次文档收尾未运行 pnpm，未启动 Vite、Electron 或其他前端服务。

## 剩余范围

1. `FS-TXN-001I` reauthorization IPC/UI；shutdown/owner-release 必须先关闭新的 reauthorization admission，再等待已有 recovery tails 收敛。
2. 真实 Windows protocol v4 compile/load/terminal/recovery/crash/acknowledgement 矩阵。
3. `NATIVE-002` 完整 official server/media artifact assembly、目标平台 launch/no-PATH。
4. macOS arm64 与 Windows x64 两平台 packaged validation。
5. 全部放行证据完成后，才评估 Job Manager / Production Executor 双重 `index-only` gate。

上述范围闭环前，`FS-TXN-001`、`BE-002` 与 `NATIVE-002` 继续保持进行中；main composition 已接通不等于 overwrite 对 public IPC/UI 或任务执行路径可用。
