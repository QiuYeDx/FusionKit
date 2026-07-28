# 工作包 NATIVE-002A1：macOS arm64 Metal production-model verification

## 基本信息

- 日期：2026-07-28
- 状态：已完成（component checkpoint；顶层 `NATIVE-002`、`FS-TXN-001` 与 `BE-002` 仍为进行中）
- 对应执行计划工作包：`NATIVE-002` 的 macOS arm64 Metal production-model target launch/backend verification 子合同
- 目标平台/硬件：macOS arm64，Apple M5，16 GB RAM
- production gate：Job Manager / Production Executor 双重 `index-only` 保持，不因本 checkpoint 解除

## 本次认领边界

本 checkpoint 收紧 `NATIVE-002A` target smoke 的Metal backend证明合同，复核production-model health失败归因，并以同一canonical runtime manifest和同一production模型在非Codex restricted sandbox的目标宿主进程环境完成hardened复验。

包含：

- 保持runtime manifest SHA-256 `19271b1fdd4b8ec9a78731893a096f329154acbaea1504be9aaf01f175d22530`、server/media/addon bytes与production模型SHA-256 `d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1`不变。
- 为target smoke增加64 KiB bounded Metal diagnostics capture；报告只保留字节计数和布尔证据，不保存原始diagnostics、模型路径或private route。
- Metal smoke要求同时观察positive initialization/device evidence、未观察failure marker且合并证据`backendVerified=true`；即使private health成功，只要缺失正向证据或出现allocation/init failure仍拒绝。
- 对照restricted sandbox与unrestricted执行结果，确认前者只能完成7.33 MiB Metal allocation并在private health前触发SIGSEGV。
- 在unrestricted环境执行hardened Metal private health/media decode/no-PATH与CPU hardened smoke，并用独立`run-backend-probe.mjs`验证实际Metal initialization、device与failure diagnostics。

不包含：

- Windows x64 CPU/CUDA official runtime、media artifact或protocol v4矩阵；
- macOS arm64或Windows x64 packaged app/installer consumption；
- Developer ID、notarization、Gatekeeper accepted或Windows Authenticode；
- production overwrite放行、双重 `index-only` gate调整、VAD、translate或完整product E2E。

## 本次实现内容

### 失败归因修正

- `NATIVE-002A` 的Metal失败不是canonical artifact、source-build receipt、runtime manifest或production模型漂移：restricted sandbox在7.33 MiB Metal allocation后、private health前触发SIGSEGV。
- 该失败继续作为受限执行环境的真实结果保留，但不再被描述为16 GB宿主的production-model资源不足，也不再作为Metal product blocker。

### Unrestricted target复验

- 复用同一canonical manifest `19271b1fdd4b8ec9a78731893a096f329154acbaea1504be9aaf01f175d22530`与production模型`d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1`，未重新构建、替换或降级runtime/model。
- Hardened Metal private health、media decode与no-PATH约8秒达到ready；CPU hardened smoke也通过。
- 独立backend probe记录model load 531～547 ms、peak RSS 1,516,158,976～1,535,049,728 bytes；healthy=true，initialization与device diagnostics均为true，failure diagnostics为false，最终 `backendVerified=true`。
- 三次独立probe在同一artifact/model下均通过；model load为531～547 ms，peak RSS为1,516,158,976～1,535,049,728 bytes，本记录按范围表达正常测量波动。
- 该结果是macOS arm64 target launch/backend evidence，不是packaged app证据，也不替代未来签名、公证或Gatekeeper验收。

### Hardened smoke合同

- `createBoundedBackendEvidenceCapture()`分别消费stdout/stderr，跨chunk解析Metal initialization/device/failure marker；每路只保留32 KiB尾窗，合计不超过64 KiB，同时累计observed/retained/truncated计数。
- `buildServerSmokeReport()`合并两路证据；Metal必须通过`assertBackendEvidence()`的正向initialization、device、无failure与verified四重门禁，CPU继续由official server `--no-gpu`路径证明。
- private health轮询现在显式拒绝health前child exit；cleanup必须确认child `close`，不能只观察signal发送。
- 新增回归覆盖缺initialization、缺device、真实upstream `ggml_metal_*: error:`、allocation failure、跨chunk evidence、bounded/redacted diagnostics、health前/后退出、late failure marker、受控close与stdio drain；smoke/parser focused集合共15项测试。

## 修改文件

- `scripts/local-subtitle/runtime/run-native002-macos-smoke.mjs`
- `scripts/local-subtitle/runtime/run-native002-macos-smoke.test.mjs`
- `scripts/local-subtitle/whisper-server/process-metrics.mjs`
- `scripts/local-subtitle/whisper-server/poc-metrics.test.mjs`
- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- `.agents/skills/fusionkit-pitfall-guard/references/validate-metal-on-an-unrestricted-target-host.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_implementation_records/2026-07-28_NATIVE-002A_macos-arm64-official-runtime-assembly.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`
- 本实施记录

## 接口或数据结构变化

- target smoke report的`server`结果新增`backendEvidence`、`backendVerified`；Metal额外返回只含布尔值的`backendEvidenceDetails`，不返回原始diagnostics。
- 新增release-script内部的bounded capture、backend evidence assertion与report builder；不进入renderer、production IPC、domain schema或session persistence。
- runtime manifest、artifact bytes、production模型、顶层工作包数量/状态、production overwrite gate和PRE-006 pins均不改变。
- 验证状态撤销Metal production-model resource blocker，同时保留restricted sandbox失败与unrestricted通过的环境边界。

## 验证结果

执行命令：

```text
node --test scripts/local-subtitle/runtime/run-native002-macos-smoke.test.mjs scripts/local-subtitle/whisper-server/poc-metrics.test.mjs
node scripts/local-subtitle/runtime/run-native002-macos-smoke.mjs <ignored canonical-runtime/production-model arguments> --backend metal
node scripts/local-subtitle/runtime/run-native002-macos-smoke.mjs <ignored canonical-runtime/production-model arguments> --backend cpu
node scripts/local-subtitle/whisper-server/run-backend-probe.mjs <ignored canonical-runtime/production-model arguments>
node scripts/local-subtitle/runtime/validate-runtime-staging.mjs --platform darwin --arch arm64
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
```

结果：

- focused Metal smoke/parser tests：15/15 passed。
- runtime + Metal parser Node tests：并行广集为79 passed / 2 failed / 1 Windows-only skipped；其中process-tree timeout用例因并行时沙箱`EPERM`失败，隔离复跑5/5通过，剩余1项仍是既有fabricated Windows `where.exe` fixture，不由本checkpoint引入。
- runtime manifest validation：0 error / 0 warning。
- TypeScript与根`vite.config.ts` renderer/main/preload三段test build通过。
- restricted sandbox：7.33 MiB Metal allocation failure，随后在private health前SIGSEGV；未达到ready。
- unrestricted hardened Metal target：约8秒private health、media decode与no-PATH通过。
- 独立backend probe三次结果：model load 531～547 ms；peak RSS 1,516,158,976～1,535,049,728 bytes；healthy=true；initialization/device=true；failure=false；`backendVerified=true`。
- canonical runtime manifest与production模型未改变；CPU hardened smoke通过。
- 未运行Windows或packaged app矩阵；未以target smoke冒充packaged evidence。

## 未完成事项

- `NATIVE-002` 仍需Windows x64 CPU/CUDA + media canonical assembly、target launch与no-PATH。
- `FS-TXN-001` 仍需真实Windows protocol v4 compile/load/terminal/recovery/crash/acknowledgement矩阵。
- macOS arm64与Windows x64仍需真实packaged `extraResources` consumption、launch/no-PATH及各自签名/更新边界验证。
- `NATIVE-002`、`FS-TXN-001`、`BE-002`与M2继续保持原状态；Job Manager / Production Executor双重 `index-only` gate不得解除。

## 下一步建议

1. 在Windows x64目标机认领 `NATIVE-002B`，完成CPU/CUDA + media artifact assembly、launch/no-PATH和真实protocol v4矩阵。
2. 再以独立packaged checkpoint完成macOS arm64与Windows x64真实bundle consumption验证。
3. 只有Windows/runtime/packaged剩余矩阵闭环后，才评估顶层工作包完成或production overwrite放行。
