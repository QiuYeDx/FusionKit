# 工作包 CORE-004：Renderer Store、Session Runtime 与 Cleanup Retry

## 基本信息

- 日期：2026-07-21
- 状态：已完成
- 对应执行计划工作包：`CORE-004`
- 目标：只持久化安全偏好，并在页面组件之外可靠维护 session snapshot/event 状态与 draft capability 清理

## 本次认领边界

- 包含：本地字幕偏好配置与 Store、session reducer、renderer runtime singleton、draft capability cleanup retry、batch status 派生与 VAD request/summary 合同。
- 不包含：应用入口 eager startup、main 权威 Job Manager/session handler、official server、媒体规范化、模型管理、artifact 导出、翻译交接或页面 UI。
- runtime singleton 只在首个 subscriber 或 Store cleanup 操作时按需取得 preload API；真实 handler 完成前不把 unavailable transport 当作可用业务状态。

## 本次实现内容

- 新增 `fusionkit-local-subtitle-transcriber` v1 Store。persist/migrate/merge 只保留经过逐字段 sanitize 的模型 ID、设备、语言、VAD、质量、beam/temperature、VAD silence、cue/line shaping、输出格式/模式和安全目录显示名。
- 默认值冻结为 beam `5`、temperature `0`、VAD silence `500 ms`、最大 cue `7000 ms / 84 chars`、最大行 `42 chars`；非法 ID、语言、范围、格式和目录 label 分字段回退。
- draft 中的 File metadata/capability、custom output token、prompt、task mode、conflict policy、post-action 和 handoff format 均只留内存；脏 persisted envelope 不能恢复 task、artifact、正文、路径、诊断或 revision state。
- Store 替换、移除、截断或 reset draft 前把未消费 capability 交给 runtime cleanup queue；batch commit 后只清空 renderer draft 引用，不撤销已转为 task lease 的 capability。
- 从 Audio 模块提炼无业务语义的 `BoundedCleanupRetryQueue` 到 `src/services/shared/`，原 Audio 路径保持 re-export 兼容。共享队列增加参数门禁、可注入时钟、remaining-TTL attempt bound 和 `earliest/latest` expiry policy。
- Local cleanup 使用 capability 的权威最早 expiry；rejected Promise、`ok:false` 与 timeout 重试，`ok:true`（包括 `revoked:false`）、`owner_released` 和 `authorization_expired` 视为幂等完成。
- 新增 task/resource 共用 revision cursor 的 session reducer。它派生 batch status，拒绝 duplicate/stale revision、旧 generation、task/resource tombstone resurrection，并在 gap/未知 batch 时要求 snapshot。
- 新增 renderer runtime singleton：先注册 task/resource listener，再读取 snapshot；snapshot 同步为 single-flight，缓冲并按 revision replay 事件，处理 retry floor、buffer overflow、dirty resync、epoch invalidation 和 observer exception isolation。
- subscribe-before-snapshot overlap 额外保留 task 的 `batchId/taskId/generation/firstRevision/removedRevision` 与 resource 的 `jobId/firstRevision/removedRevision`。只有 snapshot 已覆盖的缺失实体才建立 tombstone，snapshot 后首次出现的实体继续 replay；该经验沉淀为 `FK-PIT-0037`。
- enqueue config 与 batch config summary 强制显式携带 `vadEnabled`；`LocalSubtitleBatchSummary.status` 统一由共享 `deriveLocalSubtitleBatchStatus()` 从 task summaries 派生，snapshot schema 拒绝不一致状态。

## 修改文件

- `src/store/tools/subtitle/localSubtitleTranscriberConfig.ts` 及测试
- `src/store/tools/subtitle/useLocalSubtitleTranscriberStore.ts` 及测试
- `src/services/local-subtitle/localSubtitleCapabilityCleanupService.ts` 及测试
- `src/services/local-subtitle/localSubtitleSessionReducer.ts` 及测试
- `src/services/local-subtitle/localSubtitleRuntimeService.ts` 及测试
- `src/services/shared/boundedCleanupRetryQueue.ts` 及测试
- `src/services/audio/boundedCleanupRetryQueue.ts`
- `src/type/localSubtitle.ts`、`src/type/localSubtitleIpc.ts` 及测试
- `test/local-subtitle/preloadApi.test.ts`
- Final Design、主题/版本执行计划、v0.2.11 README 与 `FK-PIT-0037`

## 接口或数据结构变化

- `LocalSubtitleBatchConfigSummary` 与 `enqueueLocalSubtitleBatchRequest.config` 新增 required `vadEnabled: boolean`。
- 新增 `deriveLocalSubtitleBatchStatus(tasks)`，reducer 与 IPC snapshot schema 共用同一 batch aggregate 规则。
- 新增 `LocalSubtitleTranscriberPreferences`、默认配置、sanitize/migrate 合同和 `LocalSubtitleTranscriberStore` draft 操作。
- 新增 `LocalSubtitleSessionReducerState`、snapshot merge/event reduce 合同，以及只暴露脱敏 summary 的 `LocalSubtitleRuntimeState`。
- shared cleanup queue 新增 `expiryPolicy`、`now`、`size` 和配置校验；Audio import 路径不变。

## 安全与隐私检查

- localStorage 不包含 prompt、post-action、File、token/capability、task/batch/resource、artifact、字幕正文、路径、stderr/diagnostics 或 revision/tombstone。
- Store 只保存目录 leaf display label；含 `/`、`\\`、`.`、`..`、控制字符、空白或超长 label 被清除。
- cleanup 先保留撤销句柄再清除 UI state；SPA unmount 不销毁 singleton 或丢失 pending revoke。
- task/resource event 使用同一权威 revision；buffer compaction 不丢失 covered entity identity/generation 证据，避免 late event 复活已删除实体。
- 未新增依赖、未修改 package/lockfile、未提交模型/二进制/媒体/真实路径/API Key，未执行裸 `pnpm`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/services/shared/boundedCleanupRetryQueue.test.ts src/services/local-subtitle/localSubtitleCapabilityCleanupService.test.ts src/services/local-subtitle/localSubtitleSessionReducer.test.ts src/services/local-subtitle/localSubtitleRuntimeService.test.ts src/store/tools/subtitle/localSubtitleTranscriberConfig.test.ts src/store/tools/subtitle/useLocalSubtitleTranscriberStore.test.ts src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts test/local-subtitle/preloadApi.test.ts
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- CORE-004 + touched domain/preload：9 files / 132 tests 全部通过。
- 全量 Vitest：109 files / 1034 tests 全部通过；TypeScript 通过。
- Vite test build 的 renderer/main/preload 三段通过；只有既有 chunk-size 与 dynamic/static import warning。
- PRE manifest validation：0 error / 0 warning；validator 17/17。
- 未启动 Vite dev server、Electron、runner、FFmpeg、下载任务或其他长期前端/原生进程。

## 未完成事项与风险

- `BE-002` 仍需提供 main 权威 snapshot/event handler，并把真实 enqueue commit 接到 CORE-003 lease coordinator；当前 reducer/runtime 测试使用 strict fake API。
- runtime singleton 暂不在 app startup eager start。`FE-001/FE-003` 订阅后会按需启动；若未来要求全局通知，应在真实 handler 完成后增加明确 bootstrap owner。
- Store 记录 custom 目录显示名只是 UX 偏好，不是授权；新会话必须重新选择目录并取得 capability。
- 正式 native server、模型、媒体、artifact 与翻译 handoff 仍由各自 owner 包完成。

## 下一步建议

- 认领 `NATIVE-001`，把 PRE-002/006 official server PoC 收敛为 production HTTP/process contract，完成 M1 并解锁 `NATIVE-002` 与 `BE-001`。
- 不从 PATH、renderer executable 参数或上游人类日志补实现；固定 release/endpoint/schema/timeout/diagnostic bounds，并以 fake server + real smoke 验证。
