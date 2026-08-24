# NATIVE-002 / FS-TXN-001 / BE-002：Production overwrite 接线与顶层包结项

## 基本信息

- 日期：2026-08-03
- 状态：已完成
- 对应执行计划工作包：`NATIVE-002`、`FS-TXN-001`、`BE-002`
- 目标环境：Electron main / Node 合同；本轮未启动 Electron、Vite dev server、official server 或 FFmpeg

## 本次认领边界

本轮在既有 `NATIVE-002A`～`NATIVE-002D`、`FS-TXN-001A`～`FS-TXN-001J` 和 `BE-002` Job Manager / Production Executor 证据之上，完成 production overwrite 的最后一段条件化接线，并按顶层工作包的实际职责结项。

顶层包结项不代表发布候选已经完成：

- Windows NSIS 安装、卸载、更新、用户数据保留和非 ASCII / 空格安装路径仍由 `QA-003` 做真实生命周期验收。
- CUDA pack 下载、安装、更新和回滚仍属于 `MODEL-002`，分发许可复核仍属于 `QA-005`。
- VAD、translate、translation handoff 和 renderer UI 分别保留在后续 MODEL/LINK/FE 工作包。
- 完整 renderer → main → packaged runtime 产品 E2E 和发布声明仍由 FE/QA 里程碑验收。

## 实现内容

- `LocalSubtitleExporter.supportsConflictPolicy()` 将 output conflict policy 变成可查询能力：`index` 始终支持；`overwrite` 只有在 verified native transaction 或显式 test adapter 存在时才支持。
- `LocalSubtitleProductionExecutor.supportsOutputConflictPolicy()` 透传 Exporter 的真实提交能力，`beginBatchSlice()` 和直接 `execute()` 使用同一判断，避免批次 admission 与 task execution 漂移。
- `LocalSubtitleJobManager` 在解析并消费 draft capability 前查询 Executor 的 conflict-policy 能力。packaged native runtime 缺失、损坏或 recovery blocked 时仍 fail closed，不会先消费 input/output draft。
- native runtime ready 时，custom 与 source output 的 overwrite 都复用 `electron/main/index.ts` 已组成的同 generation transaction / recovery owner；没有增加 path fallback 或 renderer authority。
- public batch/task result 继续不包含 file token、目录 capability 或 raw path。

## 修改文件

- `electron/main/local-subtitle/subtitle-exporter.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `test/local-subtitle/subtitleExporter.test.ts`
- `test/local-subtitle/productionExecutor.test.ts`
- `test/local-subtitle/jobManager.test.ts`
- `test/local-subtitle/jobManagerIpc.test.ts`
- 本主题 Final Design、Execution Plan 与 v0.2.11 入口台账

## 验证结果

执行：

```text
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vitest run test/local-subtitle/subtitleExporter.test.ts test/local-subtitle/productionExecutor.test.ts test/local-subtitle/jobManager.test.ts test/local-subtitle/jobManagerIpc.test.ts
git diff --check
```

结果：

- TypeScript 通过。
- 聚焦回归 4 files / 174 tests 全部通过。
- 覆盖 Exporter overwrite authority、Executor custom/source overwrite、Job Manager capability-consumption-before-failure、IPC source overwrite admission 和公开结果无 token/raw path。
- `git diff --check` 通过。
- 未运行 NSIS 生命周期、非 ASCII 安装路径或完整 Electron 产品 E2E；这些未执行项没有被记为通过。

## 结项说明

- `NATIVE-002`：三类 official runtime artifact、两平台 canonical staging/target smoke、macOS `.app` 与 Windows app/NSIS packaged component consumption 已完成。发行生命周期验收转由 `QA-003`，不再重复阻塞 artifact/build 工作包。
- `FS-TXN-001`：两平台 protocol v4 / journal v3、durable recovery、verified addon staging/load、production main composition、reauthorization 和真实 Windows packaged NTFS 回归已完成；本轮补齐 production admission。
- `BE-002`：Job Manager、最多 100 文件批次、失败隔离、runtime pin、custom/source、SRT/LRC、index/conditional-overwrite 与 session cleanup 职责已完成。VAD、translate、handoff、UI 和 crash-startup recovery 不属于本包。

M2 仍等待 `FE-001`，M3 仍等待 `MODEL-002`、`BE-003` 与 `FE-002`～`FE-004`；三个顶层包结项不会提前推进里程碑。

## 下一步

优先认领 `FE-001`，形成用户可见的最小纵向切片；`MODEL-002` 可独立推进模型和 CUDA pack 生命周期。Windows installer 手工矩阵留到 `QA-003`，在具备稳定 UI 候选后一次性验收。
