# 工作包 CORE-001：Domain、状态机、事件、错误与 Runtime Schema

## 基本信息

- 日期：2026-07-21
- 状态：已完成
- 对应执行计划工作包：`CORE-001`
- 目标平台/硬件：跨平台纯 TypeScript 合同；本次验证主机为 macOS arm64，不包含 native runtime、目标 GPU 或 packaged app 验收

## 本次认领边界

- 包含：PRE-006 production pin/version 常量、v1 limits、immutable batch snapshot、任务/批次/resource/post-action domain、状态机、逐格式 completion reducer、error manifest、canonical transcript、task/resource event、session snapshot、strict renderer/main request/result runtime schema 与合同测试。
- 不包含：preload/channel/owner capability（`CORE-003`）、renderer Store/reducer（`CORE-004`）、official server HTTP response parser/process lifecycle（`NATIVE-001`）、resource manifest/resolver/staging（`CORE-002`）、Job Manager、媒体处理、字幕 formatter/exporter、翻译交接实现或 UI/i18n。

## 本次实现内容

- 新增独立 `localSubtitle` type family，未导入或扩展远程 Audio profile、route、assignment、IPC 或 runtime。
- 从 PRE-006 冻结 `whisper.cpp v1.9.1 / f049fff`、server HTTP contract v1、model manifest v1、`large-v3-q5_0`、Silero v6.2.0、30 秒窗口/5 秒 overlap、raw quality gate 与 CPU/CUDA/Metal v1 backend；未发布 Vulkan 被 runtime schema 拒绝。
- 冻结 v1 frame/content limits：普通 request/event 256 KiB、session snapshot 4 MiB、单批 100 文件、媒体 64 GiB、PCM guard 12 GiB、artifact 16 MiB / 200,000 cues、canonical 200,000 segments / 1,000,000 words、diagnostics 64 KiB 等。
- 实现完整 10×10 task transition matrix。retry/restart 使用新 task generation；窗口拆短重试保留为 main-private `windowAttempt` / `retryDepth`，不污染公开 generation。
- 实现逐格式 completion reducer：全部 commit 为 `completed + full`，部分 commit 为 `completed + partial`，无 commit 且失败为 `failed`，首个 commit 前取消为 `cancelled`；commit 后取消必须保留产物并追加唯一 `cancelled_after_partial_commit` warning。
- 修复 reducer 初版深冻结会连带冻结调用方 artifact 输入的问题：先深拷贝结果/错误再冻结返回值，保持纯函数。
- 事件分类明确 revision/generation：重复/倒序 revision 丢弃；旧 generation late event 只推进 session revision 水位、不修改 task；revision gap 要求 snapshot resync。
- 建立单一版本化 error manifest，补齐 PRE-006 的 `backend_unverified` 与 handoff 的 `profile_unavailable` / `unsupported_format`，并区分 runner `runtime_*` 与 batch-commit 前阻断的三类 bundled media runtime 错误。
- runtime schema 对每层 object 使用 strict 校验，先按 UTF-8 计算序列化 frame，再校验 safe integer、数组上限、时间关系、discriminant 与状态互斥；拒绝 unknown field、raw path、model hash、resolved backend、executable、args 和 backend flags 注入。

## 修改文件

- `src/type/localSubtitle.ts`
- `src/type/localSubtitleIpc.ts`
- `src/type/localSubtitle.test.ts`
- `src/type/localSubtitleIpc.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_implementation_records/2026-07-21_CORE-001_domain-state-schema.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口、状态或数据结构变化

- 新增 domain/server HTTP/runtime manifest/resource manifest/model manifest version 常量与集中 limits。
- 新增 immutable `LocalSubtitleBatchConfigSnapshot`、`LocalSubtitleTaskSummary`、`LocalSubtitleBatchSummary`、`LocalSubtitleResourceJobSummary`、`LocalSubtitleSessionSnapshot`、canonical transcript 与独立 post-action 状态。
- 新增 `LocalSubtitleIpcResult<T>`、strict enqueue/control/event/snapshot/transcript schema 与 validator；本包未冻结实际 IPC channel 名。
- task status 统一为 `queued → preparing_media → loading_model? → transcribing → post_processing → exporting → completed`，取消走 `cancelling`；`cancelling → failed` 只用于无 commit 的结构化取消失败。
- `LocalSubtitleCompletionResult.warnings` 在 v1 只允许 `cancelled_after_partial_commit`，逐格式 failure 只保留在 `artifacts[]`，避免双来源漂移。

## 安全、隐私与许可证检查

- 路径/capability：renderer request 只允许 opaque file/output token 与产品字段；session/event/transcript 不接受 raw path、目录 capability、one-shot import token、prompt 或任意 executable/args。有效 session `artifactRef` 仍可出现在完成摘要。
- 日志/持久化：本包没有日志或持久化实现；diagnostics 使用固定 metadata allowlist、UTF-8 byte/line/field 上限，不允许 `path` metadata key。测试 fixture 不含真实用户路径、媒体、模型、字幕正文、Key 或 header。
- 第三方来源与许可：没有新增依赖、二进制、模型或许可材料；production pin 仅与已提交 PRE-006 record 做 drift 测试。未执行 `pnpm`，`package.json` / `pnpm-lock.yaml` 未变化。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts src/type/audioIpc.test.ts
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
rg -n '[[:blank:]]+$' src/type/localSubtitle.ts src/type/localSubtitleIpc.ts src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_implementation_records/2026-07-21_CORE-001_domain-state-schema.md docs/v0.2.11/README.md docs/v0.2.11/v0.2.11_iteration_execution_plan.md || true
```

结果：

- 通过：定向 Vitest 3 files / 75 tests，其中 CORE-001 2 files / 57 tests、既有 Audio IPC 18 tests；全量 Vitest 95 files / 876 tests；TypeScript 通过；manifest validation 0 error / 0 warning；PRE manifest validator 17/17；diff/trailing-whitespace 检查通过。
- 基线审计：实现前额外运行 `node --test scripts/local-subtitle/benchmark/*.test.mjs scripts/local-subtitle/whisper-server/*.test.mjs scripts/local-subtitle/runtime/*.test.mjs`，结果 86 tests / 84 pass / 1 fail / 1 skip。唯一失败是既有 `run-pre005-smoke.test.mjs` 在 macOS 用 host `path` 解释伪造 Windows PATH fixture，命中已有 `FK-PIT-0030`；测试前后 worktree clean，本包未改该 PRE-005 文件，也未把红灯误记为 CORE-001 回归。
- 未运行及原因：未运行 i18n（无用户可见文案/locale key）；未运行 Vite/Electron、真实 server、FFmpeg、模型、GPU 或 packaged smoke，它们不属于纯 shared contract 工作包，不能用 mock 代替后续 owner 包验收。
- 真实硬件/packaged 范围：无新增声明；沿用 PRE-003～PRE-006 已冻结证据。

## 产生的证据

- 合同/边界证据：`src/type/localSubtitle.test.ts`、`src/type/localSubtitleIpc.test.ts`。
- PRE-006 drift 证据：domain test 直接读取 `poc/pre006-production-decision.json`，锁定 engine/model/VAD/window/HTTP contract 关键值。
- 不应提交的本地产物位置与清理结果：未生成 model、native binary、media、temp WAV、download cache、`.partial` 或 packaged app；只运行瞬时 Node/Vitest/tsc 进程，未启动 Vite/Electron/frontend service。

## 未完成事项与风险

- PRE-005 跨平台 PATH fixture 的现有红灯需单独 fix 工作包收口；生产 Windows runtime 行为未由该 macOS fixture 失败证明有误，修复不能 platform-skip 或弱化断言。
- CORE-003 仍需把 schema 接入 fixed preload API、ownerSession/capability/TTL/lease 与 exact channel allowlist；本包只有可组合 shared contract，不宣称 IPC 安全链路已完成。
- NATIVE-001、CORE-002 仍需分别消费 HTTP/resource version 和 limits，避免在 main/runtime 另建漂移常量。

## 下一步建议

- 优先认领 `CORE-002`，复用/提炼现有 `scripts/local-subtitle/runtime/runtime-manifest.mjs` 的 strict manifest/containment/hash/license/no-PATH 合同，建立 production TS resolver 与 staging contract；正式 `extraResources` 接线仍留 `NATIVE-002`。
- 也可单独认领 PRE-005 跨平台 PATH fixture fix，使用 host-native temp executable/PATH fixture并复跑完整 86 项 Node suite，不改变生产语义。
