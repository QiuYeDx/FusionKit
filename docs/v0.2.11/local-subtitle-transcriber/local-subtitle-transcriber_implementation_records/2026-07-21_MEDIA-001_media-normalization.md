# 工作包 MEDIA-001：FFprobe/FFmpeg 媒体规范化

## 基本信息

- 日期：2026-07-21
- 状态：已完成
- 对应执行计划工作包：`MEDIA-001`
- 目标：把授权音视频以 bundled FFprobe/FFmpeg 单次规范化为可验证的 16 kHz mono PCM16，并签发 main-only exact-frame window proof
- 验证状态：已完成提交级聚焦/全量测试、TypeScript、renderer/main/preload 三段 Vite test build、manifest/validator 与 diff 门禁

## 本次认领边界

- 包含：shell-free native media process、bundled FFmpeg/ffprobe exact version attestation、媒体 probe/音轨选择、授权输入 snapshot、单次 decode、decode-time 资源上限、RIFF/RF64 PCM 检查、exact-frame window、SHA-256/WeakMap proof、本进程 owner fault/release/shutdown cleanup，以及 IPC/main lifecycle 接线。
- 不包含：目标平台 final FFmpeg/ffprobe bytes、正式 `extraResources`、builder/signing 和 packaged no-PATH smoke，这些仍属于 `NATIVE-002`。
- 不包含：PCM brand 与 structural window/`windowAttempt`/Supervisor epoch/request-response generation/response 的原子 execution binding，该职责仍属于 `BE-002`。
- 不包含：应用重启时扫描历史 media/server temp、`.partial` 等 orphan，该职责仍属于 `BE-003`；MEDIA-001 只删除当前进程持有 opaque identity/proof 的资源。
- 职责修正记录：`fix/2026-07-21_local-subtitle-transcriber_split-media-service-and-packaged-runtime-ownership.md`。

## 本次实现内容

### Shell-free native process 与真实 close 边界

- 新增统一 native media process runner，只接受绝对规范化 command/cwd、bounded args 和受控 environment，固定 `shell:false`、隐藏 Windows console、关闭 stdin 并使用显式 pipe；不继承用户 PATH、代理、token 或其他环境变量。
- macOS 环境只保留 bundled media directory、locale 与 private temp；Windows 只补充受控 system root/System32 和固定 `PATHEXT`，不接受 executable picker 或 PATH fallback。
- abort/timeout/output/callback failure 统一请求终止，执行 terminate grace 后 force-kill；`kill()`、`exit` 或异步 spawn error 都不伪造 close，只有真实 child `close` 才兑现 `closeConfirmed`。
- 业务结果与 close-gated cleanup 拆开：spawn/stdio/timeout 等业务失败可以及时返回，owner/session cleanup 继续等待同一真实 close；close 未确认时同 owner 的后续 operation fail closed，close 到达后才恢复。
- stdout 分为 bounded `capture` 与零保留 `stream`。FFmpeg machine progress 逐 chunk 进入 bounded line parser，不按任务总时长累计；stderr 继续限长保留为受控 diagnostics。
- 同步 stdout callback 的 throw 和返回 thenable 都立即映射 `STDOUT_CALLBACK_FAILED` 并停止 child；thenable 的后续 rejection 被吸收，不能形成 `unhandledRejection`，也不能让 child close race 把操作误记为成功。

### Bundled runtime、输入 snapshot 与 stream identity

- `LocalSubtitleMediaNormalizer` 只消费 CORE-002 真实 verifier 返回且由 module-private `WeakSet` 证明的完整 runtime bundle；structural copy、伪造 symbol 或脱离 artifact map 的路径不能成为 runtime authority。
- 固定 macOS FFmpeg/ffprobe `8.1.2` 与 Windows `n8.1.2-21-gce3c09c101-20260630`，按 ffmpeg→ffprobe 串行执行 exact `-version` probe；前后重新验证 bundle generation，任一 version/artifact/generation 漂移都在媒体操作前失败。
- probe 只返回去控制字符、single-line、字段/总量有界的音轨摘要。`streamId` 绑定 owner、file token/identity、runtime generation、duration 和完整 track-table signature；伪造、过期、跨 owner、源文件替换或音轨表变化都在 decode 前拒绝。
- `auto` 选择仍把 task lease 与 expected file token 原子复核，不能用文件 A 的 token 消费文件 B 的 task lease。IPC 和 normalizer 复用同一 app-scoped `LocalSubtitleInputAuthorizationRegistry`。
- 规范化先以 no-follow held handle 冻结授权输入 identity，再在 mode `0700` 的 task-private session 中创建 mode `0600` 的单份 `source.snapshot`；snapshot copy、ffprobe 和 FFmpeg 前后均复核同一 file identity，原始输入和 snapshot 的 TOCTOU replacement 都 fail closed。
- 每个媒体任务只 decode 整段源一次。后续 root/retry window 都从同一 verified normalized PCM 延迟物化，不重新读取或重新解码原始媒体。

### Decode 上限、timeline 与 progress

- FFprobe duration 只作为不可信估计。trusted decode boundary 为报告时长加 2 秒版本化 tolerance，并受共享最大媒体时长约束；FFmpeg `-t`/`-fs` 使用该 boundary 再加 1 秒 sentinel 的 process cap，磁盘预检也按 enforced byte cap 加 reserve 计算。
- decode 完成后再次检查真实 PCM frame duration 和文件大小：达到 trusted duration boundary、达到 byte cap 或超过共享全局上限都拒绝 branding。这样 exact 合法边界可以完成，而伪短 duration 不能靠 FFmpeg 干净截断产出“合法”短 WAV。
- FFmpeg argv 固定 `-copyts -start_at_zero` 与 `aresample=async=1000:first_pts=0`，保留 delayed audio track 的前导静音；固定 map 单一所选音轨并移除 video/subtitle/data、metadata 和 chapters。
- progress parser 支持跨 chunk CRLF、单个大 chunk 中的多条合法短行，并只限制单行/unfinished line；优先消费 `out_time_us`，其长期为 0 时以 `total_size` 推进，百分比保持单调、去重且完成前不超过 99。
- progress observer 的同步异常与 async rejection 都被显式隔离；observer 不能改变 native lifecycle，也不会形成 Electron main 的 `unhandledRejection`。

### RIFF/RF64、exact-frame window 与 main-only proof

- 新增 strict RIFF/RF64 PCM16 parser，验证 chunk 边界、`fmt`、`data`、RF64 `ds64` 64-bit size/sample count、block align、byte rate、实际文件 identity/size 和共享 duration/PCM byte limits；支持超过 4 GiB 的 sparse RF64，并覆盖接近 100 小时的精确 frame 边界。
- frame 是唯一切窗事实。window writer 重新解析 held normalized source，不信任复制的 offset/metadata；以 half-open `[startFrame,endFrame)` 复制 exact PCM bytes，使用独占 no-follow mode `0600` 输出 canonical RIFF header，并在 close 后 parse-back。
- 每个 window 计算真实 SHA-256，绑定 normalized proof、task/generation、完整 structural descriptor、frame count/duration/size 和 file identity。odd half-millisecond descriptor 仍以 frame count 决定 duration，不做毫秒反推。
- normalized PCM 与 window facade 分别由 module-private `WeakMap` 持有 authority；冻结的普通对象、spread clone、路径字符串、旧 owner/generation proof 都不能通过 predicate 或 resolve。
- resolve 时重新检查 header、file identity、descriptor、size 与 SHA。normalized PCM 或 window 一旦发生内容/header/identity fault，相关 proof 永久锁存 `faulted`；即使恢复原字节，旧 facade 也不会复活。

### Owner fault、release/shutdown 与 IPC/main lifecycle

- 每个 owner 同时最多一个 media operation。owner fault 会撤销 probe record、abort 活动 operation 并永久失效其 normalized/window proof；未知 cleanup 状态不能继续创建新 session。
- private media base/session 逐级 no-follow 检查、POSIX mode `0700`、realpath containment 和 dev/inode/birthtime identity 复核；不对既有未知目录提前 chmod。cleanup 先 quarantine rename，再以目录对象 identity 加新路径 containment 复核后删除，不能按旧 realpath 或 leaf prefix 猜测所有权。
- `releaseOwner()` 同步 fence owner 与 late result，并在后台等待 operation settlement、真实 process close 和 identity-bound cleanup；只删除该 owner 的 session，不影响其他 owner。
- terminal `shutdown()` 共享同一 operation，对所有 owner 使用 all-settled cleanup；一个 owner 连续 cleanup failure 不阻止其他 owner 完成清理，失败可由显式后续 shutdown 重试。
- owner session registry 为每个 document 提供私有 `AbortSignal`，reload/navigation/render-process-gone/destroy 时先 abort；late success/rejection 优先稳定映射 `owner_released`。Media/Resource error 只返回稳定 code/stage，不泄露路径、argv 或底层 diagnostics。
- 正式 `probeMedia` handler 已连接 app-scoped normalizer；`LocalSubtitleMainRuntime` 将 media 与 server owner release/shutdown 合成同一生命周期，并接入既有 `before-quit` 与 update install 门禁。同步 release 即使一侧抛错也 fence 另一侧；shutdown 用 `Promise.allSettled` 启动两侧 cleanup。

## 项目避坑固化

- `FK-PIT-0040`：machine progress 必须使用 stream/line bound，不能把长媒体 lifetime stdout 当 bounded diagnostics capture。
- `FK-PIT-0041`：quarantine rename 后比较 dev/inode/birthtime 目录对象 identity，并单独检查新路径 containment，不能要求新旧 realpath 相等。
- `FK-PIT-0042`：probe duration 不可信；必须在 decode 前同时下发 `-t`/`-fs`，保留 tolerance/sentinel，并在完成后拒绝达到 trusted cap 的输出。
- `FK-PIT-0043`：TypeScript `void` callback 仍可能返回 Promise/thenable；process contract 必须立即拒绝 thenable 并吸收其后续 rejection。
- 新增职责边界 fix：`docs/v0.2.11/local-subtitle-transcriber/fix/2026-07-21_local-subtitle-transcriber_split-media-service-and-packaged-runtime-ownership.md`，防止 MEDIA service proof 被误写为 NATIVE packaged 证据，或把 BE-002/BE-003 责任回填到 MEDIA。

## 修改文件

核心实现：

- `electron/main/local-subtitle/media-process.ts`
- `electron/main/local-subtitle/pcm-window.ts`
- `electron/main/local-subtitle/media-normalizer.ts`
- `electron/main/local-subtitle/main-runtime.ts`
- `electron/main/local-subtitle/resource-path.ts`
- `electron/main/local-subtitle/authorizations.ts`
- `electron/main/local-subtitle/ipc-security.ts`
- `electron/main/local-subtitle/ipc.ts`
- `electron/main/index.ts`
- `src/type/localSubtitleIpc.ts`

测试：

- `test/local-subtitle/mediaProcess.test.ts`
- `test/local-subtitle/pcmWindow.test.ts`
- `test/local-subtitle/mediaNormalizer.test.ts`
- `test/local-subtitle/mainRuntime.test.ts`
- `test/local-subtitle/resourcePath.test.ts`
- `test/local-subtitle/ipcSecurity.test.ts`
- `test/local-subtitle/ipc.test.ts`
- `src/type/localSubtitleIpc.test.ts`

避坑与职责记录：

- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- `.agents/skills/fusionkit-pitfall-guard/references/stream-native-progress-without-capture-overflow.md`
- `.agents/skills/fusionkit-pitfall-guard/references/compare-directory-object-identity-after-quarantine-rename.md`
- `.agents/skills/fusionkit-pitfall-guard/references/bound-native-decode-output-before-post-validation.md`
- `.agents/skills/fusionkit-pitfall-guard/references/reject-thenables-in-synchronous-process-callbacks.md`
- `docs/v0.2.11/local-subtitle-transcriber/fix/2026-07-21_local-subtitle-transcriber_split-media-service-and-packaged-runtime-ownership.md`
- 本实施记录

## 接口、状态或数据结构变化

- 新增 `LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY`、`buildLocalSubtitleMediaEnvironment()` 与 `runLocalSubtitleMediaProcess()`，process result 显式区分 `closed` / `spawn_error` / `close_unconfirmed` 并携带真实 `closeConfirmed`。
- 新增 `inspectLocalSubtitlePcm16Wav()`、`createLocalSubtitlePcm16WavHeader()` 与 `writeLocalSubtitlePcmWindow()`，公开数据只含受控 PCM metadata/file identity/hash，不把 opaque authority 编码进普通结构。
- 新增 `LOCAL_SUBTITLE_MEDIA_POLICY` 与 `LocalSubtitleMediaNormalizer` 的 `probeDraft()`、`normalizeTask()`、`materializeWindow()`、`resolveWindow()`、`disposeWindow()`、`disposeNormalized()`、`releaseOwner()`、`shutdown()` 合同，以及 normalized/window predicate。
- `resolveTaskLease()` 增加可选 expected file token，并在异步 identity 校验前后原子复核 token/version，关闭 auto-stream 跨文件 lease 混用。
- owner IPC authorization/context 增加私有 `AbortSignal`；`probeMedia` 由真实 app-scoped handler 提供。public channel/request/result shape 未扩张，媒体 metadata schema 进一步拒绝首尾空白和 tab/newline/U+2028/U+2029。
- CORE-002 verified runtime bundle 在原 non-enumerable symbol 外增加 module-private `WeakSet` proof；artifact resolver 拒绝结构 clone。
- 新增 media/server composite `LocalSubtitleMainRuntime`；既有 server app lifecycle 只消费统一 release/shutdown target，不复制 quit/update 状态机。

## 安全、隐私与许可证检查

- renderer 只持有 file token、streamId 与受控 probe summary；源路径、snapshot/PCM/window path、runtime absolute path、environment、argv、SHA proof record 和 cleanup identity 保持 main-only。
- native error 经 stable error code/stage 映射，不返回输入路径、临时目录、command line、stderr、token、capability 或底层 filesystem error。
- 所有源/PCM/window open/copy/write/resolve/cleanup 都以 no-follow、held handle/file identity 或 directory object identity 为权限边界；普通 path/descriptor 不能推导删除或媒体 authority。
- 没有新增依赖，没有修改 `package.json` / `pnpm-lock.yaml`，没有执行裸 `pnpm`。
- FFmpeg/ffprobe final bytes、license/source-offer、`extraResources` 与 signing profile 未在本包改写或宣称完成；仍由 `NATIVE-002`/发布 QA 按 PRE-006 决策验收。

## 验证结果

最终收口命令：

```text
node_modules/.bin/vitest run test/local-subtitle/mediaProcess.test.ts test/local-subtitle/pcmWindow.test.ts test/local-subtitle/mediaNormalizer.test.ts test/local-subtitle/mainRuntime.test.ts
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- 聚焦 Vitest：4 files / 84 tests 全部通过（mediaProcess 20、pcmWindow 21、mediaNormalizer 38、mainRuntime 5）。
- 聚焦覆盖：minimal environment/shell-free spawn、capture/stream、thenable/abort/timeout/TERM→KILL/late close、exact bundle/version、input snapshot/stream binding、2 秒 tolerance + 1 秒 sentinel 的 `-t`/`-fs`、RIFF/RF64/100 小时 frame boundary、SHA/WeakMap proof、corruption fault latch、owner release/fault/shutdown、IPC late owner result 与 composite lifecycle。
- 全量 Vitest：121 passed + 2 skipped files / 1312 passed + 2 skipped tests（123 files / 1314 tests）。
- TypeScript、renderer/main/preload 三段 Vite test build、manifest 0 error / 0 warning、validator 17/17 与 `git diff --check` 通过。

开发态补充证据：

- 本机 exact FFmpeg/ffprobe 8.1.2 生成 video 从 0 秒、audio 从 2 秒开始的临时 MKV；production decode argv 得到 3.000 秒 WAV，`silencedetect` 记录 `silence_start: 0`、`silence_end: 2.000062`，证明 delayed track 前导静音被保留。
- 同一真实命令的 progress 在结束前可持续报告 `out_time_us=0`，因此 `total_size` fallback 不是仅为 fake test 添加；临时 fixture 已删除。
- 以上只是当前 macOS 开发机上的 argv/timeline 证据，不是 `extraResources`、签名或 packaged no-PATH 证据。本轮没有在 Windows 真实执行 FFmpeg/ffprobe；Windows 结论仅限 fixed contract 与自动化 fault coverage，不能外推为目标机或安装包验收。

## 未完成事项与风险

- `NATIVE-002` 仍须交付两平台 final FFmpeg/ffprobe/server bytes、正式 runtime manifest、`extraResources`/`beforePack`、nested/outer signing 与真实 packaged no-PATH smoke；MEDIA-001 的 verifier、unit tests 和开发态 8.1.2 证据不能替代这些门禁。
- `BE-002` 尚未把 immutable window proof、exact structural descriptor、`windowAttempt`、Supervisor `processEpoch`、dispatch/response generation 和 response 绑定为单一 execution record；只传 WAV path + response 仍会留下 swap/reuse/stale race。
- `BE-003` 尚未实现应用启动时对历史 media/server temp、`.partial` 和其他 orphan 的受控扫描；MEDIA-001 没有权限在当前进程 cleanup 中猜测并删除无 proof 的历史目录。
- `SUB-002`、`MODEL-001` 与完整 Job Manager 依赖仍未齐；PCM window 完成不代表用户已能导出 SRT/LRC 或形成端到端 M2。
- 自动化覆盖 exact frame/identity/cap，但真实长媒体、目标平台 filesystem 差异、磁盘压力和安装包内 runtime 仍需后续集成/packaged QA。

## 下一步建议

- 可并行推进 `NATIVE-002` final artifact/builder 和 `SUB-002` 标准字幕产物；不要把本包开发态 runtime 证据复制成 packaged 完成状态。
- `BE-002` 开始接线时，把 MEDIA-001 proof 的单次消费与 SUB-001 attempt graph、Supervisor generation/response 原子绑定，并覆盖 swap/reuse/restart/late response fault matrix。
- `BE-003` 等待 Job Manager/temp 目录合同稳定后实现启动 orphan scan；正常 owner/app shutdown 继续复用 MEDIA-001 当前进程 cleanup，不建立第二套活动目录删除逻辑。
