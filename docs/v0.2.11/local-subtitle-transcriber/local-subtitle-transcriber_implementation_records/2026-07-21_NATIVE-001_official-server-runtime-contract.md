# 工作包 NATIVE-001：Official Server Runtime Contract

## 基本信息

- 日期：2026-07-21
- 状态：已完成
- 对应执行计划工作包：`NATIVE-001`
- 目标：把 PRE-002/006 official `whisper-server` PoC 收敛为 strict、可测、无自写 C++ bridge 的 production contract

## 本次认领边界

- 包含：pinned upstream request/response schema、explicit `node:http` transport、process descriptor、load reuse identity、minimal environment、bounded diagnostics 和 env-gated real smoke。
- 不包含：child handle、端口 reservation、process epoch、restart/kill、session filesystem 创建/删除、owner/app cleanup、窗口调度、模型管理、媒体规范化、字幕后处理或 IPC handler。
- `BE-001` 独占 Supervisor 生命周期；`MEDIA-001` 独占受信 PCM16 window 生成与 branded identity。

## 本次实现内容

- 新增 v1.9.1 HTTP policy，固定 `127.0.0.1`、24-byte private path、`/health`、`/inference`、`window.wav`、15 分钟 inference budget、1 MiB upload、64 MiB response 与 diagnostics limits。
- 冻结 multipart fields：`verbose_json`、language、translate、VAD、beam、temperature、`temperature_inc=0.2`、VAD silence；始终 `token_timestamps=false`、`no_timestamps=false`，formatter 的 cue/line 参数不发送为 upstream `max_len`。
- 把支持的 BCP-47 primary language/legacy alias 映射到 pinned Whisper 100-code set；strict schema 校验 task/language/duration/text/segment/word 上限和有限数值，立即转整数毫秒，VAD words 标为 discarded compressed timeline。
- 使用 `node:http` 而非 global `fetch`。文件以 `O_NOFOLLOW` 打开，持有同一 FileHandle 并在 upload 后复核 dev/inode/size/mtime/ctime；multipart、early response、Content-Type/Encoding/Length、UTF-8、JSON 和 body size 都有门禁。
- startup `probeReadiness()` 允许 starting 阶段的 transport/timeout/503 由 Supervisor 重试；ready-state `health()` 任一失败都 taint generation。readiness/health/inference 在首个 `await` 前同步领取同一 single-active ticket，成功返回前复核 ticket/disposition。
- inference budget 从 open 前起算并包含 HTTP exchange 与 bounded FileHandle close；pre-request abort 保持 reusable，request 已开始后的 abort/timeout/HTTP/schema/transport/close failure 标记 `restart_required`，旧 client 拒绝继续调用。
- CORE-002 verified bundle 增加 module-private、non-enumerable opaque proof；process descriptor 只接受 verifier 原对象 + artifact ID，拒绝 structural copy，并校验 generation/profile/evidence/target/artifact membership。load identity 覆盖 runtime/artifact/backend/model/VAD/process flags，CPU 明确加 `--no-gpu`。
- exact argv 固定 `--processors 1`、private request path、空 public/tmp、managed model/VAD；禁止 `--convert`、`/load`、human progress parsing。child environment 只保留 server/System32/TEMP 和 C locale，不继承 PATH、proxy、API key、Node/Electron secret。
- diagnostics 只接受 stdout/stderr，覆盖 exact private value 的 raw/escaped/URI 变体，并脱敏 path/endpoint/port/credential/prompt/body/transcript 后按 line/count/final UTF-8 bytes 保留最近内容。
- real smoke 默认 skip；显式 fixture 下启动 exact official server，同一 PID 连续执行两次 product-default CPU request，随后等待 child `close`/stdio drain 并删除 session。

## 修改文件

- `electron/main/local-subtitle/server-contract.ts`
- `electron/main/local-subtitle/server-http-client.ts`
- `electron/main/local-subtitle/server-process-contract.ts`
- `electron/main/local-subtitle/server-diagnostics.ts`
- `test/local-subtitle/serverContract.test.ts`
- `test/local-subtitle/serverHttpClient.test.ts`
- `test/local-subtitle/serverProcessContract.test.ts`
- `test/local-subtitle/serverDiagnostics.test.ts`
- `test/local-subtitle/serverContract.real.test.ts`
- Final Design、主题/版本执行计划、v0.2.11 README、ownership fix doc 与 `FK-PIT-0038`

## 接口或数据结构变化

- 新增 `LocalSubtitleServerHttpClient`：`probeReadiness()`、`health()`、`inference()`、`sessionDisposition`。
- 新增 `LocalSubtitleServerInferenceRequest/Result/Response`、strict error code/disposition 和 `LOCAL_SUBTITLE_SERVER_HTTP_POLICY`。
- 新增 `createLocalSubtitleServerEndpoint()`、`createLocalSubtitleServerProcessDescriptor()`、`createLocalSubtitleServerLoadIdentity()` 与 reuse comparison。
- descriptor input 从可拼装 selection 收紧为完整 `LocalSubtitleVerifiedRuntimeBundle + serverArtifactId`。
- 新增 `LocalSubtitleServerDiagnosticCollector`，输出继续服从共享 `LocalSubtitleDiagnostics` schema。

## 安全与隐私检查

- endpoint 固定 loopback + 192-bit private path；private path/port 不进入 renderer、Store 或 diagnostics。
- 不使用 global fetch、shell、PATH fallback、proxy、API key、authorization、Electron/Node secret、任意 executable/args 或 upstream media conversion。
- multipart 不泄漏源文件 basename；prompt/response body/transcript 不进入 error message，diagnostics 对 prompt/body/transcript 标签和 exact private values 先脱敏。
- 没有提交 binary、model、VAD、media、真实机器路径或 API Key；没有新增依赖或修改 package/lockfile；没有执行裸 `pnpm`。
- descriptor 的 session/public/tmp 仅是词法合同；`BE-001` 必须以 no-follow/realpath/empty/permission/identity 复核建立真实 filesystem boundary。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/serverContract.test.ts test/local-subtitle/serverHttpClient.test.ts test/local-subtitle/serverProcessContract.test.ts test/local-subtitle/serverDiagnostics.test.ts
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
FUSIONKIT_NATIVE001_REAL_SERVER=<ignored fixture> FUSIONKIT_NATIVE001_REAL_MODEL=<ignored fixture> FUSIONKIT_NATIVE001_REAL_VAD=<ignored fixture> FUSIONKIT_NATIVE001_REAL_WINDOW=<ignored fixture> FUSIONKIT_NATIVE001_REAL_BACKEND=cpu node_modules/.bin/vitest run test/local-subtitle/serverContract.real.test.ts
git diff --check
```

结果：

- NATIVE contract/transport/process/diagnostics：4 files / 75 tests 全部通过。
- 全量 Vitest：113 passed + 1 skipped files / 1109 passed + 1 skipped tests；TypeScript 通过。
- Vite test build 的 renderer/main/preload 三段通过；PRE manifest 0 error / 0 warning，validator 17/17。
- 默认 real test：1 skipped；无 fixture 环境变量时不 spawn。
- exact v1.9.1 CPU real smoke：1/1，通过同一 official server PID 的两次默认参数 request；最终 process/session 清理为空。
- Metal 本轮在模型请求前因当前宿主无法再分配 7.33 MiB Metal buffer 退出；PRE-004 已有完整 Metal/CPU production evidence，本记录不把临时资源不足标为合同回归或成功复验。
- 未启动 Vite dev server或 Electron；结束前无 Vitest/tsc/whisper-server 长期进程。

## 未完成事项与风险

- `BE-001` 仍需实现真实 0700 session、no-follow/realpath/empty/identity 复核、child/port/process epoch、readiness→ready、模型驻留、restart/kill、late response 与 owner/app cleanup。
- `MEDIA-001` 仍需产出 main-only branded PCM window identity并验证 RIFF/WAVE、16 kHz mono PCM16、frame/size/duration；HTTP regular/non-empty identity gate不替代媒体语义验证。
- `NATIVE-002` 仍需生成/接线三类正式 artifact、runtime manifest、builder gate 与 packaged smoke。
- 当前 Metal host resource failure 应在正常宿主空闲状态重跑，但不阻塞已由 PRE-004 完成的技术选择。

## 下一步建议

- 认领 `BE-001`，只消费本包 descriptor/client，不复制 PoC Supervisor；先闭环 session filesystem + fake child/process epoch，再接真实 CPU smoke。
- starting 只调用 `probeReadiness()`，ready 后 `health()` 任一失败重启；取消后即使 `/health=ok` 也必须进入新 process epoch。
