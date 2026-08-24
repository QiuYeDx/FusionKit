# 工作包 BE-001：Server Supervisor

## 基本信息

- 日期：2026-07-21
- 状态：已完成
- 对应执行计划工作包：`BE-001`
- 目标：把 NATIVE-001 的 official server descriptor/client 接入真实 private session、child/process epoch、backend attestation 与 owner/app/update 生命周期

## 本次认领边界

- 包含：session filesystem、loopback port、child handle、Supervisor state/process epoch、owner/load lease、single-active inference ticket、startup/runtime health、fresh startup retry、cancel/kill/close、backend attestation、idle/owner/app/update cleanup。
- 不包含：媒体规范化和 PCM window、raw transcript quality/retry、task/window 调度与批量 Job Manager、历史 orphan startup scan、模型下载/导入、字幕导出或 renderer 业务 handler。
- 职责归属保持为：PCM window=`MEDIA-001`，raw quality/retry=`SUB-001`，Job Manager=`BE-002`，startup orphan scan/session summary=`BE-003`。

## 本次实现内容

### Private session filesystem

- 新增 `<managedResourceRoot>/temp/server-*` opaque session；managed root、temp root、session root、`public`、`tmp` 都使用 no-follow `lstat`，拒绝 symlink/非目录，POSIX 权限固定为 `0700`。
- identity 同时绑定 `realpath`、device、inode、birthtime 和 mode；launch 前复核 containment、session root 只含 `public/tmp` 且两者为空。结构复制不能伪造 module-private proof。
- cleanup 只处理当前 proof 持有的 root：复核 identity 后在同一 private base 内 rename 为随机 quarantine path，再次复核后递归删除。quarantine remove 失败可由同一 proof 按 exact root identity 重试；原 root 未知消失时 fail-closed，只有 WeakSet 已记录同一 proof 成功删除后才幂等返回 `removed:false`。路径替换、权限漂移、symlink 或同前缀不同 identity 均不会取得删除权限。

### Supervisor state、epoch 与 lease

- 新增 `unloaded / starting / ready / stopping / faulted / disposed` 状态和只读脱敏 snapshot；snapshot 不含 endpoint、port、private path、argv、environment 或文件路径。
- opaque lease 绑定 owner 与完整 load identity。相同 verified runtime/server artifact/model/VAD/backend/process flags 可跨 owner 复用同一 PID；任一 lease 活跃时，不同 identity 返回 `resource_busy`。
- process epoch 与 task generation / HTTP `requestGeneration` 分离；每次真实 launch attempt 使用递增 epoch。load options 与 inference request 在首个 `await` 前做 immutable snapshot，调用方后续 mutation 不改变已接受操作。
- `beginInference()` 同步领取唯一 Supervisor request ticket；busy 调用在发出 health/inference HTTP 前失败。request 在成功返回前复核 active ticket、lease、epoch、child state 和 NATIVE client disposition，旧 epoch late result 被丢弃。

### Readiness、runtime health 与 fresh retry

- 每个 launch attempt 重新创建 session、loopback reservation、192-bit private path、descriptor、HTTP client 和 process epoch；port reservation 在 spawn 前释放，并再次复核 empty session。
- starting 只调用 `probeReadiness()`：connect/timeout/503 等 `reusable` 错误在共同 startup deadline 内轮询，schema/合同错误 fail-fast。
- pre-readiness child close 可在同一 deadline 内以 fresh session/endpoint/epoch 重试一次，不会错误 abort owning request；每个失败 epoch 先完成 close/finalization。
- ready epoch 在 inference 复用前调用 runtime `health()`；任一 timeout/transport/HTTP/schema failure taint 并 retire 当前 epoch，后续请求由仍有效 lease 启动新 epoch。startup 和 runtime health 不共享“可继续复用”的判断。

### Backend attestation

- CPU 只在 descriptor/load identity 声明 `noGpu` 且 argv 中恰有一个 `--no-gpu` 时标记 verified。
- Metal/CUDA 必须注入 main-only verifier，并在 startup deadline 内返回 exact `processEpoch + processId + backend + runtimeGeneration + serverArtifactId`、无额外字段的证明。
- 缺 verifier/PID、超时、异常、shape 不完整或 epoch/PID 不一致返回 `backend_unverified`；已证明 backend/runtime/artifact 与选择不一致返回 `backend_mismatch`。Supervisor 不解析人类日志，也不静默 fallback 到 CPU。

### Cancel、kill、close 与 finalization

- mid-request cancel、owner release 和 unexpected ready close 先同步 fence epoch/late result，再 abort HTTP transport；pre-aborted、尚未发出请求的操作不污染 ready epoch。
- abort grace 内不结算则先 SIGTERM，超时再 SIGKILL；只有 child `close` 才表示 stdio 已 drain，可以 detach stream、finish bounded diagnostics 并删除 identity-bound session。
- unconfirmed close 保持 `faulted`、保留 session 且阻止 respawn；closed-session 或 pre-spawn session cleanup failure 同样锁存 startup fault，只允许显式后续 shutdown 重试已知 proof 的 cleanup。
- 主动 retire、unexpected close observer、cancel、idle、owner release 和 shutdown 共用每个 epoch 的 idempotent cleanup/finalize promise，避免重复 diagnostics finish 或递归删除；对应项目规则为 `FK-PIT-0039`。

### Owner、app 与 update lifecycle

- `releaseOwner()` 保持同步，供 `LocalSubtitleIpcService.onOwnerReleased` 直接调用；它立即撤销 owner leases、fence/abort owner request，并把异步 retire 纳入 Supervisor background cleanup。其他 owner 的匹配 lease 不被误释放。
- Electron main 在 `app.whenReady()` 创建 app-scoped Supervisor/lifecycle 单例，但不 acquire server；冷启动和只打开工具页保持 unloaded。
- `before-quit` listener 幂等安装；首次 quit 阻止默认退出，同一 in-flight shutdown 由重入事件共享。瞬时 failure 会再尝试一次再允许并重试 `app.quit()`；bounded timeout 不取消或遗失底层 cleanup，后续调用继续观察其最终结果。
- updater handler 只注册一次并跟踪 active window；`quit-and-install` 必须先等待成功的 `prepareUpdateInstall()` shutdown，随后才调用 `autoUpdater.quitAndInstall()`。瞬时 failure 不锁死 lifecycle，后续安装尝试可以重新 shutdown。

## 修改文件

- `electron/main/local-subtitle/server-session.ts`
- `electron/main/local-subtitle/server-supervisor.ts`
- `electron/main/local-subtitle/server-app-lifecycle.ts`
- `electron/main/index.ts`
- `electron/main/update.ts`
- `test/local-subtitle/serverSession.test.ts`
- `test/local-subtitle/serverSupervisor.test.ts`
- `test/local-subtitle/serverSupervisor.real.test.ts`
- `test/local-subtitle/serverAppLifecycle.test.ts`
- Final Design、主题/版本执行计划、v0.2.11 README 与本实施记录
- `.agents/skills/fusionkit-pitfall-guard/references/serialize-process-epoch-close-and-finalization.md`（`FK-PIT-0039`）及索引

## 接口或数据结构变化

- 新增 `LocalSubtitleServerSession` opaque proof，以及 `createLocalSubtitleServerSession()`、`verifyLocalSubtitleServerSession()`、`cleanupLocalSubtitleServerSession()`。
- 新增 `LocalSubtitleServerSupervisor`：`acquire()`、同步 `beginInference()`、`cancelRequest()`、`release()`、同步 `releaseOwner()`、`shutdown()`、`drainBackgroundCleanup()` 和脱敏 `snapshot`。
- 新增 opaque `LocalSubtitleServerLease` / `LocalSubtitleServerRequestTicket`、`LocalSubtitleServerReadySummary`、`LocalSubtitleServerBackendAttestation` 和稳定 Supervisor error code。
- 新增 `LocalSubtitleServerAppLifecycle`，统一 `app_quit / update / fatal` shutdown；`update()` 新增可选 `prepareQuitAndInstall` hook，并改为幂等 listener 注册。
- `LocalSubtitleIpcService.onOwnerReleased` 接到 Supervisor，同步 callback 合同未改变；没有新增 renderer IPC channel 或公开路径。

## 安全与隐私检查

- child 仍只消费 CORE-002 opaque verified bundle 和 NATIVE-001 exact descriptor，`spawn()` 使用 `shell:false`、allowlisted environment 与受控 cwd。
- session proof、endpoint、port、private path、argv、environment、model/VAD path、request body、prompt 与 transcript 均不进入 renderer、Store 或 snapshot；diagnostics 继续先脱敏再有界截断。
- cleanup 不接受 manifest/session path 字符串作为删除授权；只有当前进程内 opaque proof + identity recheck 可删除 owned session。
- 没有新增依赖、没有修改 `package.json` / `pnpm-lock.yaml`、没有执行裸 `pnpm`；没有提交 binary、model、VAD、media、真实用户路径或凭据。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/serverSession.test.ts test/local-subtitle/serverSupervisor.test.ts test/local-subtitle/serverAppLifecycle.test.ts
node_modules/.bin/vitest run test/local-subtitle/serverSupervisor.real.test.ts
FUSIONKIT_BE001_REAL_SERVER=<ignored fixture> FUSIONKIT_BE001_REAL_MODEL=<ignored fixture> FUSIONKIT_BE001_REAL_VAD=<ignored fixture> FUSIONKIT_BE001_REAL_WINDOW=<ignored fixture> node_modules/.bin/vitest run test/local-subtitle/serverSupervisor.real.test.ts
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- 聚焦 session/supervisor/lifecycle：3 files / 37 tests 全部通过（session 12、Supervisor 19、lifecycle 6）。覆盖 missing-root fail-closed、quarantine retry、mutable input snapshot、lazy load/PID reuse、identity busy、readiness polling/schema fail-fast、fresh startup retry、runtime health restart、同步 ticket、pre-abort、mid-request cancel/late result、unexpected close、SIGTERM→SIGKILL、late stderr、unconfirmed close、pre/post-spawn cleanup fault latch/retry、CPU/GPU attestation、同步 owner release、shutdown failure/timeout 重入、quit retry 和 stale idle timer。
- default real test：1 skipped；未提供 fixture 环境变量时不 spawn。
- exact v1.9.1 CPU real smoke：1/1，通过同一 official server PID 的两次 inference；release 后 `<managed>/temp` 为空。
- 全量 Vitest：116 passed + 2 skipped files / 1146 passed + 2 skipped tests（118 files / 1148 tests，总时长 14.84 s）；TypeScript 通过。
- renderer/main/preload 三段 Vite test build 通过，仅有既有 chunk warnings；manifest 0 error / 0 warning，validator 17/17，diff check 通过。
- real smoke 后进程筛选为空；未启动 Vite dev server 或 Electron，没有残留 `whisper-server`、Vitest 或其他 runner。

## 未完成事项与风险

- `MEDIA-001` 必须生成并验证 16 kHz mono PCM16、frame/size/duration 正确的 main-only branded window；Supervisor/NATIVE regular-file gate 不替代媒体语义证明。
- `SUB-001` 必须实现 raw transcript gate、overlap merge 与退化窗口有界拆短/retry；Supervisor 的 process restart 不能替代内容质量恢复。
- `BE-002` 才拥有 task/window 顺序、批量 queue、revision event、任务 cancel 编排和失败隔离；其 `MEDIA-001`、`SUB-002`、`MODEL-001` 等依赖尚未齐。
- `BE-003` 仍需实现应用启动时的受控 orphan scan、session summary、disk/OOM 水位和 crash recovery；BE-001 只清理当前进程持有 proof 的 session。
- POSIX 上 `<userData>/local-subtitle` managed root 本身也必须保持 `0700`；后续 MODEL/MEDIA/Resource Manager 创建或迁移该 root 时必须复用同一权限合同，否则 Supervisor 会 fail-closed。
- 本轮真实 Supervisor smoke 为 macOS arm64 CPU。Metal/CUDA exact attestation 的接口和 fault matrix 已自动化，最终真实 backend/packaged 证据仍由 NATIVE/MODEL/QA 依赖包完成，不能从 CPU smoke 外推。
- GPU attestation 目前是 main-only 注入 verifier 返回的 exact-shape record，而非跨不可信边界的 opaque proof；若未来允许插件/worker/IPC 提供证明，必须先增加 module-private brand/factory，不能沿用当前结构对象作为外部授权。

## 下一步建议

- 可认领 `NATIVE-002` 完成正式 artifact/builder，或并行推进 `MEDIA-001`、`SUB-001`、`LINK-001`。
- 不建议现在认领完整 `BE-002`；先补齐 `MEDIA-001`、`SUB-002` 与 `MODEL-001`，再把已冻结 Supervisor lease/inference 接入 Job Manager。
