# NATIVE-001 修正：拆分 Server Contract 与 Supervisor 所有权

## 背景与现象

原 Execution Plan 把 official server 的 HTTP/process contract、single-active request、
模型驻留、abort/kill、crash recovery 和 no-orphan 验收都列在 `NATIVE-001`。开始正式
实现后，这会产生两个问题：一是容易把 PRE PoC 的 `WhisperServerSupervisor` 复制进
合同层，二是纯 descriptor/HTTP client 会被迫声称自己验证了真实目录、child 和端口
生命周期。

独立审查还发现，最初的 descriptor 要求 session root 与整个 managed resource root
完全分离，但 Final Design 明确把 `models/`、`vad/` 和 `temp/` 都放在
`<userData>/local-subtitle/` 下。该约束会让正式 Supervisor 无法在受控 `temp/`
子树启动。

## 根因

“Node 管理 official server”被当成一个单一模块，而没有继续区分三类事实：

1. pinned upstream wire/process contract；
2. Electron main 持有的真实 filesystem/child/process epoch 生命周期；
3. Media Normalizer 产出的受信 PCM window 身份。

TypeScript 路径和参数对象只能表达合同，不能证明目录为空、不是 symlink、权限为
`0700`，也不能证明一个 `.wav` 路径确实是已验证的 16 kHz mono PCM16 窗口。

## 修正后的所有权

### NATIVE-001

- 固定 v1.9.1 HTTP fields、strict health/`verbose_json` schema、BCP-47 language map、
  request/response/deadline limits 和 structured error disposition。
- 使用 `node:http` 流式 multipart；startup `probeReadiness()` 与 ready-state
  `health()` 分相，readiness/health/inference 共用 single-active ticket。
- 上传持有 `O_NOFOLLOW + FileHandle/fstat` identity；response、early response、
  UTF-8、JSON、schema 和 FileHandle close 全部有界。
- process descriptor 只接受完整 CORE-002 verified bundle + artifact ID，冻结 exact
  argv、minimal environment 和 load reuse identity。
- diagnostics 只接受 stdout/stderr，先脱敏再按 UTF-8 bytes、行数和行长截断。

NATIVE-001 不持有 child handle、端口、process epoch、restart/kill、owner/app cleanup
或模型驻留队列。

### BE-001

- 只从 `verifyLocalSubtitleRuntimeBundle()` 的 artifact map 选择 server，并消费
  NATIVE-001 descriptor/client。
- 在受控 `<userData>/local-subtitle/temp` 下原子创建 per-process session/public/tmp；
  使用 mode `0700`、no-follow `lstat`、`realpath` containment、empty public 和
  identity/permission 复核，并在 spawn 前复核同一身份。
- 持有 child、reserved port、private endpoint、process epoch、readiness→ready、
  runtime health、model/backend reuse、abort→terminate→kill fallback、late response、
  child `close`/stdio drain、owner/app cleanup 和 identity-bound session deletion。
- 取消后的 `/health=ok` 不能恢复 reuse；下一任务必须进入新 process epoch。

### MEDIA-001

- 生成并验证 16 kHz mono PCM16 RIFF/WAVE 窗口，冻结 frame/size/duration 和 main-only
  branded identity。
- HTTP transport 的 regular/non-empty/file identity 检查是最后一道 descriptor 防护，
  不能替代 Media Normalizer 的 WAV 语义验证。

## 实现修正

- 删除 session 与整个 managed root 的互斥，只保留 session 与 bundled runtime、
  public/tmp 与具体 server/model/VAD 文件的隔离。
- HTTP client 拆分 readiness/runtime health，并把所有 server operation 串行化；ready
  后 health failure 与 inference mid-request/timeout/schema/cleanup failure 都要求重启。
- CORE-002 verified bundle 增加 module-private、non-enumerable opaque proof；descriptor
  拒绝 spread/structural copy，unit/real tests 都先真实调用 verifier。
- inference budget 从 open 前起算，FileHandle close 失败或超期不再被吞掉。
- real smoke 等待 child `close` 而不只等待 `exit`，并清理/unref timeout。
- diagnostics 增加 `initial_prompt` / `initialPrompt` 敏感标签。

## 验证

```text
node_modules/.bin/vitest run test/local-subtitle/serverContract.test.ts test/local-subtitle/serverHttpClient.test.ts test/local-subtitle/serverProcessContract.test.ts test/local-subtitle/serverDiagnostics.test.ts
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

- NATIVE 定向：4 files / 75 tests passed。
- 全量 Vitest：113 passed + 1 skipped files / 1109 passed + 1 skipped tests。
- exact v1.9.1 CPU real smoke：同一 PID 连续两次产品默认参数请求通过。
- real test 默认没有显式 fixture 环境变量时 skip，不会下载或 spawn。
- 当前宿主 Metal smoke 因临时无法再分配 7.33 MiB buffer 在请求前退出；PRE-004
  已保留完整 Metal/CPU 证据，本次不把资源状态伪记为协议回归或成功复验。

## 后续

`BE-001` 必须先闭环真实 session/child/process epoch，再把 Supervisor 接给更上层 Job
Manager。不得把 filesystem/lifecycle 责任回填到 NATIVE-001，也不得重新引入自写 C++
bridge、全局 `fetch`、PATH fallback 或 stderr progress parsing。
