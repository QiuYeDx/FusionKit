# 工作包 FS-TXN-001I：reauthorization IPC 与 app-scoped recovery UI

## 基本信息

- 日期：2026-07-27
- 状态：已完成（component checkpoint；顶层 `FS-TXN-001`、`BE-002` 与 `NATIVE-002` 仍为进行中）
- 对应执行计划工作包：`FS-TXN-001` 的 reauthorization IPC/UI 子合同
- production gate：Job Manager / Production Executor 双重 `index-only` 保持，不因本 checkpoint 解除

## 范围与非目标

本 checkpoint 把 001H 的 production recovery runtime/owner 通过 strict shared schema、preload API、owner-scoped main IPC 与全局 renderer prompt 接通，使用户可以查看 path-free pending recovery、重新选择原输出目录并重试既有 volatile recovery。

本次不包含：

- Job Manager / Production Executor 的 `overwrite` policy 放行；
- 真实 Windows x64 protocol v4 compile/load/terminal/recovery/crash/acknowledgement 矩阵；
- `NATIVE-002` 的完整 official server/media artifact assembly、目标平台 launch/no-PATH 与 packaged consumption；
- macOS arm64 / Windows x64 两平台 packaged validation；
- `FE-001` 独立本地字幕工具页。

## 本次实现内容

### Strict path-free IPC 与分页容量

- shared contract 新增 `listOverwriteRecoveries` 与 `recoverOverwrite`。列表为 app-scoped `ready | unavailable | blocked`，恢复结果只允许 `cancelled | recovered(finalized | rolled_back)`；request/result 继续受 owner envelope、frame budget 与 strict schema 约束。
- 列表按 `(createdAt, recoveryId)` 稳定排序和分页，单页上限为 100。renderer 最多读取 64 页，即硬上限 `64 x 100 = 6400` 项；这高于 1 MiB repository 可容纳的约 4,100 条最小记录，因此不会截断任何当前 repository 合同内的合法列表。重复 cursor 或超过 64 页仍 fail closed 为 `invalid_content`。
- owner 从 `recoveryId` 通过 domain-separated SHA-256 稳定派生 12 位大写十六进制 `displayCode`。UI 使用 `displayCode` 区分相邻记录，不展示完整 recovery ID、task ID、generation、路径、token 或 capability；renderer service 在进入 view state 前主动剥离 task/generation 等恢复执行 metadata。

### Picker admission coordinator 与锁内 TTL

- main 新增 app-scoped `LocalSubtitleOverwriteRecoveryAdmissionCoordinator`，在任何 picker `await` 前按 recovery ID 建立单飞 admission，跨窗口并发恢复同一记录返回 `resource_busy`。
- admission 分为 `selecting` 与 `recovering`。owner release/shutdown 可使仍在 picker/authorize/resolve 阶段的结果失效；进入 recovery 后不伪装可取消，而是交给 recovery owner tail 收敛。shutdown 先关闭新 admission、清理 selecting admission，再等待既有 recovery tails，失败后才重新开放 admission。
- 目录 picker 使用所属 `BrowserWindow` 且不硬编码英文 title/button label，交给操作系统本地化。所选目录只生成 owner-bound 临时 output authorization，resolve 后在 `finally` 中撤销 draft。
- owner 在同一 recovery 串行尾和同一目录 mutex/fence 内检查临时目录 authorization 的 `expiresAt`，再调用 native recovery；TTL 过期返回稳定 `authorization_expired`，不能在锁外预检后带过期权限进入 terminal 操作。
- picker 返回后会重新读取并比较完整 summary tuple，防止选择期间 record direction/state/metadata 漂移后继续执行旧动作。

### Durable recovery fail-closed 边界

- pending native recovery 返回 `not_found` 时写回 `retry_failed` 并保留 record、directory fence 与可重试入口；只有 durable `settled` proof 后的 acknowledgement `not_found` 仍可作为幂等完成。
- native begin 一旦标记开始，后续 begin throw、非法 receipt 或 adoption failure 都不能通过 `releaseAdoption()` 删除 schema-v2 preclaim。该策略避免把“journal 未找到”误判为“begin 从未修改 namespace”。
- 因 begin throw 形成的孤立 `rollback_unpublished + not_started` preclaim 目前仍必须 fail closed。未来若要清除，必须新增显式、可验证的 discard 合同；不得按年龄、`not_found`、owner release、启动扫描或 UI 操作自动删除。
- private recovery error/message 不穿过 IPC；main 只映射稳定 domain code，renderer 再映射四语言用户文案。`unavailable` 与 `blocked` 不伪装成空列表。

### App-scoped renderer recovery surface

- `App.tsx` 全局挂载恢复 prompt，不依赖尚未实现的 `FE-001` 页面。prompt 在 mount、focus/visibility 恢复、打开弹窗、recover 结束及候选 task failure event 后刷新，并在首次发现 pending 时自动打开。
- `ScrollableDialog` 固定 Header/Footer，明确聚焦 dialog title；恢复入口放在左下、底部导航上方并向上展开 tooltip，避开平台 titlebar 与右侧主题按钮。
- 列表展示 stable display code、格式、方向、状态与时间；目录选择/重试单飞，工作期间禁用其他项。查询失败、runtime unavailable、repository blocked、空态、picker cancel、recovered 与各类稳定错误均分开呈现。
- 四语言新增 recovery 文案。错误详情使用可换行 `AlertDescription`；极端但 schema-valid 的 safe-integer `createdAt` 超出 JS Date 范围时回退原始整数，不能因 `Intl.DateTimeFormat` 的 `RangeError` 使全局 App 崩溃。

## 修改文件

- `src/type/localSubtitleIpc.ts`、`src/type/localSubtitleIpc.test.ts`
- `electron/main/local-subtitle/overwrite-recovery-owner.ts`
- `electron/main/local-subtitle/overwrite-recovery-ipc.ts`
- `electron/main/local-subtitle/ipc.ts`、`electron/main/index.ts`
- `electron/preload/local-subtitle-api.ts`
- `src/services/local-subtitle/localSubtitleOverwriteRecoveryService.ts` 及测试
- `src/components/local-subtitle/LocalSubtitleOverwriteRecoveryPrompt.tsx` 及测试
- `src/App.tsx` 与 `src/locales/{en,ja,zh,zh-Hant}/subtitle.json`
- overwrite recovery/production runtime/preload/exporter 相关回归测试，以及本实施记录、Final Design / Execution Plan、v0.2.11 README / 迭代台账

## 接口或数据结构变化

- public invoke 新增 `local-subtitle:list-overwrite-recoveries`，返回 path-free paged summary 或 app-scoped unavailable/blocked 状态。
- preload-private internal invoke 新增 `local-subtitle:internal:recover-overwrite`；generic public invoke 仍不暴露 internal channel。
- recovery summary 新增稳定 `displayCode`，仍保留 main 执行所需的 recoveryId/taskId/generation，但 renderer view state 只保留最小展示字段。
- production runtime 的同一 recovery lifecycle target 现在由 admission coordinator 包裹后注入 SessionLifecycle，保证 shutdown/owner release 顺序覆盖 picker 与已开始 recovery。
- durable repository schema 仍为 v2，没有新增 raw path、directory token、capability 或 displayCode 持久化字段。

## 验证结果

最终验证：

- focused：9 files / 175 passed。
- local-subtitle：42 passed + 2 skipped files / 951 passed + 2 skipped tests。
- 全量 Vitest：145 passed + 2 skipped files / 1921 passed + 2 skipped tests。
- overwrite-native：29 passed + 1 skipped；skip 为当前非 Windows 宿主上的真实 Windows 验证。
- manifest：0 error / 0 warning；validator：17/17。
- 四语言 i18n：每种 1522 keys，source usage 通过。
- TypeScript、renderer/main/preload 三段 Vite test build 与 `git diff --check` 通过。

上述证据不替代真实 Windows protocol v4 矩阵、official server/media target artifact assembly/launch/no-PATH 或两平台 packaged validation。本次未使用未固定版本的 pnpm；视觉 QA 使用过临时 Vite，最终未保留任何 Vite、Electron 或其他前端服务进程。

## 状态与剩余范围

- `FS-TXN-001A`～`FS-TXN-001I` component checkpoints 均已完成，但不增加顶层工作包数量。
- 39 个顶层工作包仍为 16 个已完成、23 个剩余：`FS-TXN-001`、`BE-002`、`NATIVE-002` 三个进行中，`FE-001` 等 20 个未开始。
- Job Manager / Production Executor 双重 `index-only` gate 不变，production overwrite 仍不可用。
- 剩余 overwrite 范围严格收口为：真实 Windows protocol v4 矩阵；完整 official server/media artifact assembly + target launch/no-PATH；macOS arm64 / Windows x64 packaged validation。

上述范围全部闭环后，才可评估解除双重 `index-only` gate以及完成 `FS-TXN-001`、`BE-002` 或 `NATIVE-002`；`FE-001` 仍按原执行计划单独认领。
