# 实施记录：T-ENGINE-07

| 字段 | 值 |
| --- | --- |
| 任务 | T-ENGINE-07 |
| 日期 | 2026-10-28 |
| 验证版本 | snapshot-sha256:c2d906fc4c29918290e68a0c2aa3d33d18fbc21831470145fb220aeba77f42a3（基线 a742ec76 + 未提交工作树）。批次 C 修正的独立评审与修复（2026-10-28）后取得：在最后一次代码修改（`engine/executor.ts`、`executor.test.ts`）与 engine design §11 的修改、全部检查的重跑与证据写入之后，更新 T-ENGINE-05、T-ENGINE-06、T-ENGINE-07、T-ENCODE-01 四份记录并写入 FIXUP-C-check-spec.txt 之前；这些文件的这次改动未计入。工作树中还有其他任务的文件，快照包含它们。此时的文件 sha256 前 12 位：`engine/executor.ts` 7dfb9f0b1a3b，`executor.test.ts` 411a7588fa6e，engine design.md 681c032ce2a4；其余批次 C 修正改过的源文件与下述批次 C 修正时相同（`contract.ts` f088a18910e4，`queue/queue.ts` c62fc626049d，`queue/types.ts` e2d75d204f5f，`ipc.ts` 1345ed1d1f70，`plan/stream-plan.ts` 8b491a782e0b，`plan/types.ts` d1ee7cfded4c）。评审之前的验证版本与说明：snapshot-sha256:2f201d53b059332cb0e6f9dc79dd3d6616d307b1086a3746b5ff9dd816aea715（基线 a742ec76 + 未提交工作树）。批次 C 修正（2026-10-28）后取得：在最后一次代码修改、受影响检查的重跑与证据文件写入之后，更新 T-ENGINE-05、T-ENGINE-06、T-ENGINE-07、T-ENCODE-01 四份记录并写入 FIXUP-C-check-spec.txt 之前；这些文件的这次改动未计入。工作树中还有其他任务的文件，快照包含它们。此时批次 C 修正改过的文件 sha256 前 12 位：`contract.ts` f088a18910e4，`queue/queue.ts` c62fc626049d，`queue/types.ts` e2d75d204f5f，`engine/executor.ts` 7bbc95cfd44d，`ipc.ts` 1345ed1d1f70，`plan/stream-plan.ts` 8b491a782e0b，`plan/types.ts` d1ee7cfded4c，`queue.test.ts` 3804c62b1a5a，`executor.test.ts` 0961d9822a8e，`ipc.test.ts` 96a24113d1c4，`plan/stream-plan.test.ts` cafa28d8d09e，engine design.md dca0ac38db09，encode design.md 3e39a493f5dd。批次 C 修正之前的验证版本与说明：snapshot-sha256:b24ed35617b2b615a67d9b7bea46e457e4d91fa4ebe566d09b3c19e0ee08173a（基线 a742ec76 + 未提交工作树）。独立评审修复后取得：在最后一次代码修改、全部验证与证据文件写入之后、本记录更新之前；本记录文件的更新未计入。此时 `engine/executor.ts` 的 sha256 为 0aa2b582…，`test-hooks.ts` 为 7a83b4b6…（评审未改动），`executor.test.ts` 为 203b433f…。工作树中还有其他任务的智能体正在修改的文件，快照包含它们。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；随附 ffmpeg/ffprobe n8.1.2-21-gce3c09c101-20260630（BtbN，LGPL），经 `verifyLocalSubtitleRuntimeBundle` 校验；RTX 4070 Ti SUPER（每次测试运行只有一次 2 s、320×180 的 NVENC 编码）。测试中所有 ffmpeg 都以 IDLE 优先级运行（夹具生成与执行器的运行），ffprobe 经 `MediaRuntime` 以 BELOW_NORMAL 运行；素材都是测试时生成的 lavfi 小样（≤ 2 s，≤ 640×360），放在 test-results/media-converter/executor-* 运行目录中，测试结束后删除。测试文件位于 NTFS 卷 C:。 |
| 任务指纹 | 18b1f31300fe8337b9a3b0b36cb70ec006b0171158e2999ce79f190888fed626 |

## 实际结果

本任务没有界面部分，不涉及截图。

**新增与修改的文件（均在写集内）**

- `electron/main/media-converter/engine/executor.ts`（新增）：`MediaConversionExecutor` 实现 `queue/types.ts` 的 `MediaExecutor`，每个应用一个实例。依赖全部通过接口注入：`runtime`（`MediaRuntime.acquire`）、`inputs`（`InputRegistry.verify`）、`outputs`（`MediaOutputs` 的 preflight / createPartial / discardPartial / publish / release / endBatch / 工作目录）、`prober`（`MediaProber.probe`）、`capabilities`（`planner()` 与 `markDegraded()`）、`planner`（默认 `buildPlan`）、`process`（默认 `runEncodeProcess` 及其依赖：spawn、优先级、亲和性、停滞阈值、时钟）、`failure`（`FUSIONKIT_TEST_MEDIA_FAIL`）。模块不 import electron。一个条目的流程：
  1. **运行时与输入。** `acquire()` 失败时按运行时原因码失败；ffmpeg 无法启动（`spawn_error`）时，按 design §1 让运行时重新校验一次再重试（评审时补充，见下文「评审与修复」）。之后再用 `InputRegistry.verify` 核对一次输入（队列在运行前已核对，运行时校验可能又用了约 1 s），得到 `input_missing` 或 `input_changed`。`ExecutionJob.targets` 与计划的输出数量或扩展名不一致时，以 `encode_failed` 拒绝。
  2. **前置检查。** 在运行任何 ffmpeg 之前，对计划中的每个输出调用 `MediaOutputs.preflight`：目录可写、路径长度、`output_is_input`、FAT32 的 4 GiB、按卷汇总的空间预留，并在批内认领目标名。目标名直接取 `ExecutionJob.targets`，不另算。`owner` 为「条目 id#输出序号」。任何一项不通过，条目在开始前失败，不创建临时文件。`disk_space_low` 把所需与可用字节数写进日志（contract 中没有对应字段，见风险第 1 条）。
  3. **每个输出。**
     - `createPartial`：先写 partials.json，再以 `wx` 创建临时文件并记录身份；
     - 参数只来自 `toFfmpegArgs(output, {inputPath, demuxer: 探测得到的解复用器, partialPath, lowUsage})`。`-fs` 与 `-t` 只由它生成，不再追加 `outputLimitArgs`；
     - 交给 `runEncodeProcess` 运行，带上 `lowUsage`、预期时长、上限与临时文件路径，以及脱敏路径（输入、最终名与输出目录、临时文件、工作目录）；
     - 先等进程关闭（最多 10 s），再处理任何文件；
     - `runFailure` 判定。触顶时按计划的 `capSemantics` 处理：`not_smaller` 为跳过，其他为 `output_cap_exceeded`；
     - 用 `MediaProber` 重新探测临时文件，交给 `judgeEncode` 判定（计划的 `expectedFrom:'stream'` 映射为 `main_stream`，并传入源的容器时长）；
     - 压缩任务的输出体积 ≥ 上限（源的 98%）时同样记为 `skipped{not_smaller}`；
     - 发布。覆盖策略下，只有目标名（Windows 下不区分大小写）在 `confirmedReplace` 中时才按 `overwrite` 发布，否则改为自动编号（design §10）；
     - 未交给 `publish` 的临时文件，在 `finally` 中按身份删除并移除记录。
  4. **原因码。** 进程的 `unknown` 记为 `encode_failed`。发布失败记为 `output_publish_failed`；但 `output_is_input`、`output_path_too_long`、`overwrite_trash_failed` 这三种在发布时会再检查一次，保留原码。创建临时文件失败记为 `output_dir_unwritable`。失败日志是进程脱敏后的 stderr 末尾，再加一行原因说明，例如 `[media-converter] The output lacks a planned stream.`。
  5. **硬件降级（AC-ENGINE-03-3）。** 判定为编码器失败的原因有：退出码非 0、没有 progress=end、停滞、输出无法读回、缺流、时长不符、没有处理任何内容。当输出的主视频由硬件配置编码（按 `isHardwareConfiguration`，`h264_mf` 的 `8bit_sw` 不算硬件），且进程报告 `firstFrameSeen === false` 时：
     - 调用 `markDegraded(编码器)`；
     - 用条目冻结的 `settings` 与 `capabilities.planner()` 给出的当前能力表，重新 `buildPlan` 一次；
     - 新计划的输出必须与 targets 一致，并换了编码器；上限变化时重新做该输出的前置检查；
     - 按新计划重试一次。摘要换成新计划的摘要，并追加 `{code:'encoder_fallback', streams:[主视频序号], count:1, from, to}`；结果警告中也加入 `encoder_fallback`。

     重试只有一次（每个条目一次）。重试的硬件编码器在首帧前再次失败时，同样标记降级，但不再重试。磁盘写满、无法打开输出、触顶、启动失败不是编码器的问题，不降级，也不重试。首帧之后的失败直接失败。
  6. **多输出（提取全部音轨）。** 每个输出单独发布，发布后释放它的空间预留。某个输出自身编码失败时（上面列出的编码器失败原因，加上触顶），继续写下一个输出；全局性的失败（磁盘写满、无法打开输出、发布失败、无法创建临时文件、进程无法启动）立即停止。只要有失败，结果就是 `failed`，并带已发布的输出（部分完成）。
  7. **取消与清理（AC-ENGINE-04-3）。** 取消信号在每个等待点检查。ffmpeg 被终止后，先等 `closed`，再删除临时文件与记录；最后在 `finally` 中释放所有 owner 的空间预留与未发布的名称认领，并删除 `work/<8 位 hex>`（其中的 2-pass 日志随之删除）。结果为 `{status:'cancelled'}`。
  8. **阶段与进度。** 第一次运行开始时报 `encoding`。最后一个输出的处理时长达到预期时长 − 1 s，或其进程结束后（探测与发布期间），报 `finalizing`；同一阶段不重复上报，多输出时不会每个输出各报一次。每个进度块经 `ProgressTracker`（每个输出一个等权阶段）换算为 `ItemProgress`，越界值置为 null，保证通过 contract 校验。节流由队列负责。
  9. **警告。** 任何警告都不会让运行失败，成功判定只看 AC-ENGINE-04-5 的条件。`TOLERATED_WARNINGS` 中的警告不记录；成功的运行中出现其他 warning/error 行时，最多记 8 行日志，便于排查。容忍清单包括 module-encode design §7b 列出的 4 条（yuvj、ipod 的 .partial 扩展名、aac Too many bits、Guessed Channel Layout），另加 1 条本机实测得到的（见风险第 2 条）。
  10. `endBatch()` 调用 `MediaOutputs.endBatch()`。
- `electron/main/media-converter/test-hooks.ts`（修改）：
  - 新增 `FUSIONKIT_TEST_MEDIA_FAIL=<code>:first_attempt`，`code` 只接受一次运行可能出现的 9 种：`driver_too_old`、`no_device`、`session_limit`、`params_rejected`、`unknown`、`encoder_stalled`、`disk_full`、`output_open_failed`、`encode_failed`；
  - 新增 `FUSIONKIT_TEST_MEDIA_REVEAL=record`；
  - `resolveMediaTestHooks` 返回 `{caps, fail, reveal}`，门控与 `FUSIONKIT_TEST_MEDIA_CAPS` 相同（NODE_ENV=test 且未打包）；
  - 环境参数的类型由 `NodeJS.ProcessEnv` 放宽为 `MediaTestEnvironment`（只读的字符串记录），`process.env` 照常可传。

  执行器对每个条目 id 的第一次运行注入失败：不启动 ffmpeg，返回一个首帧前结束的运行结果，附合成的 stderr 尾部。这些行取自 `test/media-converter/fixtures/capabilities` 的真实格式，不含路径，最后一行注明是注入的。之后的处理与真实失败相同：硬件计划会降级重试，`disk_full` 直接失败。
- `test/media-converter/executor.test.ts`（新增）：24 个用例（实现时 22 个，评审补充 2 个）。
  - 3 个不需要 ffmpeg：两个新开关的解析与门控、容忍清单。
  - 21 个使用真实 ffmpeg：按 harness 注入真实的 `MediaOutputs`、`InputRegistry`、`MediaProber`、`MediaRuntime`、`MediaCapabilities`（「仅 CPU」或测试开关的 `nvenc`），或一张固定的能力表。
  - 优先级设置被替换为「记录请求的优先级，实际设为 IDLE」；亲和性只记录掩码，不启动 PowerShell。
  - 需要在中途取消或终止的运行，由 spawn 包装在输入前插入 `-readrate 0.5`。
  - 要求真实失败的地方，在参数中插入一个不存在的码流过滤器（`-bsf:a:0`/`-bsf:v:0 fusionkit_injected_failure`），让 ffmpeg 在打开输出时真实报错。

**评审与修复（独立对抗性评审，2026-10-28）**

评审逐条对照了 AC-ENGINE-03-3、04-3、04-5、06-1、06-4 与 design §5/§7/§10，并检查了以下方面：取消与关闭等待、临时文件与工作目录清理、owner 预留与认领的释放、多输出的部分完成、降级重试只发生一次、原因码映射、脱敏路径、`-fs`/`-t` 只出现一次、输入固定解复用器与 `file:` 前缀，以及测试开关的门控。另外核对了 contract 中的进度 schema，并确认各个输出封装都能经探测白名单读回。没有发现阻断或重大问题，只发现两处小问题，均已在写集内修复：

1. **ffmpeg 无法启动时，没有按 design §1 重新校验运行时（次要）。** design §1 第 4 步要求「出现 spawn_error 时也重新校验一次再重试」。原实现中，编码进程的 `spawn_error` 直接记为 `runtime_spawn_failed`，运行时缓存不失效，所以引擎状态仍显示就绪。
   - 修复：`#attempt` 在进程关闭后发现 `spawn_error` 时，先调用 `runtime.invalidate()`，再 `acquire()` 重新校验：
     - 校验失败时，按运行时原因码（如 `runtime_missing`）失败，不再启动；
     - 校验通过时，用新取得的工具，对同一个临时文件重试一次。ffmpeg 没有启动过，临时文件仍是创建时的空文件；
     - 重试仍无法启动时，记为 `runtime_spawn_failed`，并再次 invalidate，让下一个条目先校验。
   - 执行器的 `runtime` 依赖类型改为 `ExecutorRuntime`，即 `acquire` 加可选的 `invalidate`。T-ENGINE-06 传入真实的 `MediaRuntime` 即可。
   - 新增用例「verifies the runtime again when ffmpeg cannot be started」，用脚本化运行时让 ffmpeg 真实启动失败（ENOENT），覆盖三种情况：
     - 第一次校验给出不存在的 ffmpeg，重新校验后改用真实工具并发布；
     - 两次都无法启动，结果为 runtime_spawn_failed，invalidate 2 次；
     - 重新校验失败，结果为 runtime_missing，只启动 1 次。

     三种情况都没有残留。
2. **「首包后失败不重试」只在有 NVIDIA 驱动的机器上验证（次要，测试）。** 原用例 `it.skipIf(!NVIDIA_DRIVER)`，在没有 NVENC 的机器上会静默跳过，V-ENGINE-07-1 的这一项就没有证据。
   - 修复：新增「judges a hardware plan by its first frame on any machine」，任何机器上都能运行。计划与执行器认为编码器是 h264_nvenc；第一个进程改用同一输出的 CPU 计划参数（libopenh264，同一个临时文件、同样的 `-fs`/`-t`），让真实编码器产出真实帧。分两种情况：
     - 在第一个 frame>0 的进度块后终止：失败，不降级，不重试；
     - 一启动就终止：没有帧，h264_nvenc 被降级，计划重新生成一次，改用 libopenh264 发布，摘要中有 `encoder_fallback`。
   - 原 NVENC 用例保留。

评审变异检查（file:records/i1/T-ENGINE-07-review-mutations.txt）：对修复部分与首帧判定做 5 个变异，全部被检出。其中「重新校验后仍用旧工具」在第一版新用例中存活，于是把新用例改为「第一次校验给出不存在的 ffmpeg」，之后被检出。实现时的变异记录（T-ENGINE-07-mutations.txt）针对评审前的源码，保留作为历史证据。

评审确认、无需修改的点（保留实现者的做法）：

- 「无论原因类别」只包括编码器可能造成的失败；
- 多输出时，单个输出自身失败后继续写下一个输出；
- 覆盖的二次确认按文件名进行；
- `disk_space_low` 的字节数写进日志；
- 容忍警告多 1 条 openh264 提示。

这些都有理由，并已在下文差异中说明。已知的风险也补充到「风险与未执行项」，例如多输出取消后，已发布的输出不在结果中。

**批次 C 修正（2026-10-28）**

修正了原记录风险中的两项（disk_space_low 的数字、多输出条目中途取消），并补了裸视频流的端到端证据。本任务写集内只改了 `engine/executor.ts` 与 `executor.test.ts`；契约与队列的部分见 T-ENGINE-05 记录，设计回写见 engine design §11。

- **`disk_space_low` 的数字（F1）。**
  - `#preflight` 遇到 `OutputError('disk_space_low')` 时，把 `error.space` 中的两个字节数随失败结果交出；回退前重做的前置检查也一样。`#failed` 只在 `disk_space_low` 时带 `space`。日志中的文字说明保留。
  - FAT32 的 `file_too_large_for_volume` 不带这个字段：4 GiB 是单个文件的大小上限，不是空间不足；而且 `OutputError` 没有对应的数字（output.ts 不在写集内）。
  - 原记录风险第 1 条由此解决。
- **取消时已发布的输出（F2）。**
  - 多输出条目已经发布一部分后被取消时，`#cancelled` 返回 `{status: 'cancelled', outputs, warnings, summary?}`。没有发布任何输出时，仍返回原来的 `{status: 'cancelled'}`。
  - 临时文件、记录与工作目录照常清理。
  - 原记录「多输出条目中途取消」的已知限制由此解决。
- **裸 H.264（F6）。**
  - 原记录「测试中发现、在写集外的问题」中的裸 H.264 重封装，由规划器修正解决：这类源的视频一律重新编码（见 T-ENCODE-01 记录与 encode design §7b）。
  - 本文件新增了真实 ffmpeg 的端到端用例。
- **测试。** executor.test.ts 修改 2 个用例，新增 4 个用例，共 28 项通过（原 24 项）：
  - `disk_space_low` 用例：断言 outcome 的 `space`。单独运行时为 {512 MB + 上限, 512 MB}；两个条目并行时为 {两者上限之和 + 512 MB, 当时的可用空间}。
  - FAT32 用例：断言结果中没有 `space`。
  - 新增「提取全部音轨时在第 2 条运行中取消」。第 2 次运行以 `-readrate 0.5` 减速，在第一个处理时长大于 0 的进度时取消。结果为 cancelled，outputs 只有已发布的第 1 条：可以探测，体积一致。目录中只有这一个文件，没有临时文件、记录或工作目录残留。
  - 新增「裸 H.264/HEVC 重新编码」。两个源：
    - raw.h264：openh264 编码，没有 VUI 计时信息，25 帧；
    - reordered.hevc：kvazaar 编码，分层 B 帧，VUI 为 30 fps，60 帧。

    分别转为 MP4（libopenh264）、转为 MKV（libsvtav1），并按 HEVC 压缩（libkvazaar），共 5 次，都发布成功：
    - 计划不是只换封装，参数中没有 `-fflags`；
    - 进度不再是 `N/A`；
    - 输出解码出的帧数与源相同，时长分别为 1.0 s 与 2.0 s（±0.1 s）；
    - 结果附 `duration_unverified`。
  - 新增「探测不接受的裸流」：MPEG-4 Part 2（m4v）与 AV1（obu）都返回 `container_not_allowed`。
  - 新增「裸 MPEG-2 加 +genpts 复制进 MKV」：参数中输入前是 `-fflags +genpts -f mpegvideo`，视频为 copy；60 帧的逐帧哈希与源相同，时长 2.0 s。
- 真实 ffmpeg 一律以 IDLE 运行，素材为测试时生成的 lavfi 小样（≤ 2 s，≤ 640×360），运行目录在测试结束后删除。
- **变异。** M1、M4、M12 都被本文件的用例发现（file:records/i1/FIXUP-C-mutations.txt）。

**评审与修复（批次 C 修正的独立评审，2026-10-28）**

独立评审逐项复核了 F1–F7 的代码、测试、设计回写与记录。F1–F6 都已达成，撤销任何一项修正都会让测试失败。发现的问题与处理如下。

- **回退重新规划期间收到取消，条目记为失败（次要，已修复）。**
  - 现象：硬件编码器在首帧前失败后，`#fallBack` 先读取能力表，再重新规划。这期间收到取消时，它返回 `{ok: false}`，不带原因码，于是原来的失败结果被保留。最后一个（或唯一一个）输出因此以 `failed` 结束（例如注入的 `no_device`），而不是 `cancelled`。多输出条目的其他输出却在下一轮按取消结束，两者不一致。
  - 修复：`#execute` 在回退重新规划之后检查取消信号。已取消时按取消结束，并像 F2 一样列出已发布的输出。失败的编码器仍保持降级。
  - 测试：executor.test.ts 新增「回退重新规划期间收到取消时按取消结束」。能力表的第 2 次读取（即回退时的读取）触发取消，断言：
    - 结果为 `{status: 'cancelled'}`；
    - h264_nvenc 已降级；
    - 没有启动 ffmpeg，也没有残留。

    撤销修正后该用例失败（file:records/i1/FIXUP-C-mutations.txt 的 R1），修正后通过。
  - 设计：engine design §11「执行器」的硬件回退条目补了这一条。
- **design §11 的分类描述不准确（文档，已修正）。** 原文写的是「逐行取第一条命中的原因」「由它前面的原因行决定」。`classifyEncoderFailure` 实际按固定的优先顺序检查各类原因，取整段 stderr 中第一个出现的类别，与行的先后无关。已改写，并补充：会话表已满（`OpenEncodeSessionEx failed: out of memory`）同样归为 `session_limit`。
- **带 B 帧的裸 H.264（复核，无需修改）。**
  - 批次 C 修正的用例只覆盖两种裸流：没有 B 帧的 openh264 H.264，以及 kvazaar HEVC。
  - 评审另用 h264_nvenc 生成带 B 帧的裸 H.264（VUI 为 30 fps），经真实的探测、规划器与执行器处理：转为 MP4、转为 MKV、按 HEVC 压缩。
  - 三种都发布了，各 60 帧、2.0 s（file:records/i1/FIXUP-C-raw-streams.txt 末尾）。
- **复核后确认无误的部分：**
  - F1：`disk_space_low` 只来自 preflight（output.ts 中唯一的来源），回退时重做的检查同样带 `space`；
  - F2：两种取消时机都列出已发布的输出：发布之后、下一个输出开始之前；以及下一个输出运行中。单输出条目不受影响；
  - `ExecutionOutcome` 的形状与 queue/types.ts 一致。
- 评审后 executor.test.ts 共 29 项通过（原 28 项）；全部非 Electron 的 media-converter 测试共 692 项通过。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ENGINE-07-1 | 通过 | file:records/i1/T-ENGINE-07-executor.txt |
| V-ENGINE-07-2 | 通过 | file:records/i1/T-ENGINE-07-tsc.txt |

- V-ENGINE-07-1：评审修复后重跑，24 passed，无跳过，用时约 11 s，exit 0。本机有 NVIDIA 驱动，所以真实 NVENC 的「首帧后失败」用例实际运行；另有任何机器都能运行的替身用例。结束后 test-results/media-converter 下没有残留的 executor-* 目录。验证计划各项与用例的对应：
  - **压缩、转换、提取都能发布并重新探测。**
    - 压缩：640×360 MPEG-4+FLAC 压缩为 `rich-compressed.mp4`。重新探测为 h264+aac，时长差 ≤ 0.1 s，体积小于上限。参数中 `-fs` 与 `-t` 各只出现一次，值分别为计划的上限与 `durationLimitUs`。输入固定为 `-f matroska -protocol_whitelist file -i file:<输入>`，输出为 `-f mp4 -y file:<.fusionkit-media-xxxxxxxx.partial>`。spawn 时临时文件已存在，partials.json 中已有带身份的记录。工作目录为 `work/<8 hex>`。请求的优先级为 BELOW_NORMAL。阶段为 encoding→finalizing。进度全部通过 `itemProgressSchema`，比例单调，最后为 1。结束后没有临时文件、记录或工作目录残留，日志中只有容忍的警告。
    - 转换：MKV 重封装为 MP4（`-c:v:0 copy`）。重新探测为 mov/h264/aac。`lowUsage` 时请求 IDLE 优先级，并请求一次亲和性设置。
    - 提取：两条 AAC 音轨分别发布为 `tracks.track1.eng.m4a`、`tracks.track2.jpn.m4a`，各自探测到 1 条 aac 音轨，时长正确。两次运行的真实日志中都有 ipod 的「extension is not .m4a nor .m4v」，被容忍。进度带 `outputIndex` 0/2、1/2。
  - **静态画面源提前触顶，状态为 skipped{not_smaller}，不残留 .partial。** 源是一帧细节画面保持 2 s 的 AV1（CRF 50，约 12 KB），按 HEVC（libkvazaar）「画质优先」压缩。结果为 `{status:'skipped', reason:'not_smaller'}`；`capHit` 为 true，输出体积 ≥ 上限 − 余量，处理时长 < 1.5 s（提前停止）；输出目录为空，没有记录与工作目录残留。另一用例覆盖「完成后体积达到上限」：未触顶，但读回的体积为源的 98%，同样跳过。
  - **取消后临时文件、日志与工作目录都被删除。** 运行减速后，在第一个处理时长 > 0 的进度时取消。取消时临时文件与工作目录中的模拟 2-pass 日志都存在；ffmpeg 在 3 s 内退出；结果为 `cancelled`。之后临时文件、日志、工作目录与 partials.json 的记录都已删除，输出目录为空。
  - **注入 NVENC 首包前失败后，改用下一个编码器重试一次，并附 encoder_fallback。** 环境变量为 `FUSIONKIT_TEST_MEDIA_CAPS=nvenc`、`FUSIONKIT_TEST_MEDIA_FAIL=no_device:first_attempt`，经 `resolveMediaTestHooks` 解析，使用真实的 `MediaCapabilities`。
    - 计划原为 h264_nvenc。注入的失败没有启动 ffmpeg，唯一一次真实运行是 libopenh264 的重试，编码成功并发布。
    - `markDegraded` 只收到 h264_nvenc，`MediaCapabilities.status()` 的 degraded 为 `['h264_nvenc']`。
    - 摘要通过 `planSummarySchema`，encoders 为 libopenh264，warnings 中有 `{encoder_fallback, streams:[主视频], count:1, from:'h264_nvenc', to:'libopenh264'}`；结果警告为 `['encoder_fallback']`。
    - 「只重试一次」：能力表中 h264_nvenc 与 h264_mf 都可用。nvenc 被注入 `session_limit`；重试的 h264_mf 在打开输出时真实失败（首帧前）。h264_mf 也被标记降级，但不再重试：只有 1 次真实运行，结果为 failed{encode_failed}，摘要中有 nvenc→mf 的 encoder_fallback。
  - **首包后失败时不重试。**
    - 真实 NVENC：h264_nvenc 编码 120 帧小样，在第一个 frame>0 且 progress=continue 的进度块出现时终止进程。结果为 failed{encode_failed}：没有摘要，只运行了 1 次，`firstFrameSeen` 为 true，没有降级，没有残留。
    - 任何机器（评审补充）：计划为 h264_nvenc，进程由 libopenh264 替身运行。在首帧后终止时失败，不降级，不重试；一启动就终止时，h264_nvenc 被降级，重试一次后发布，摘要中有 nvenc→libopenh264 的 `encoder_fallback`。
  - **statfs 注入空间不足时报 disk_space_low。**
    - 只有 512 MB 可用时，在开始前失败，日志中有所需（512 MB + 上限）与可用的字节数，没有启动 ffmpeg，也没有残留；
    - 可用空间为两条目上限之和 + 512 MB − 1 时，A 运行期间 B 报 disk_space_low，所需为两者之和 + 512 MB；A 结束后 B 可以运行；
    - 一个运行中因触顶失败的条目，结束后也会归还空间，之后 B 仍能运行。
  - **提取 2 条音轨时第 2 条注入失败，结果为部分完成，第 1 条已发布。** 结果为 failed{encode_failed}，outputs 只有 index 0（`tracks.track1.eng.m4a`，可探测）；日志含「Bitstream filter not found」与原因行，没有任何盘符路径；目录中只有第 1 条；没有残留。另一用例中第 1 条失败时第 2 条照常发布，outputs 只有 index 1。
  - **验证计划之外补充的用例（同一测试文件，同一证据）：**
    - 成功判定接线：读回时缺少音轨，或时长为 10 s，都判为 encode_failed，并附对应原因行，不发布；
    - 时长未知（裸 H.264 压缩）：成功，附 `duration_unverified`，参数中没有 `-t`；
    - 注入只影响每个条目的第一次运行；CPU 编码器被注入 `no_device` 时为 encode_failed，日志经 `classifyEncoderFailure` 归类为 no_device，第二次运行是真实运行且成功；
    - 硬件计划被注入 `disk_full`：结果为 disk_full，不降级，不重试；
    - 编辑过的输入为 input_changed，删除的输入为 input_missing，都不启动 ffmpeg；
    - FAT32 上 5 GiB 上限报 file_too_large_for_volume；
    - 队列中另一个输入恰好是目标文件（路径大小写不同）时报 output_is_input，该文件不变；
    - 转换任务触顶报 output_cap_exceeded，参数中 `-fs` 为 20000；
    - 批内同名：另一条目已发布 `clip.mp4` 时，即使选择覆盖并确认了 `clip.mp4`，也改为 `clip (1).mp4` 并附 output_name_collision，不进回收站；新批次不再附该警告；
    - 覆盖策略：未确认的同名文件不移走，输出改为 `clip (1).mp4`；确认 `CLIP.mp4` 后，旧文件经 trashItem 移走，输出为 `clip.mp4`，`replaced:true`；
    - 链接与重命名都失败时报 output_publish_failed，没有临时文件或占位文件残留；
    - ffmpeg 无法启动时，运行时重新校验一次再重试（评审补充，design §1）。三种情况：恢复后发布；两次都无法启动，结果为 runtime_spawn_failed；校验失败，结果为 runtime_missing。
- V-ENGINE-07-2：评审修复后重跑 `pnpm exec tsc --noEmit -p tsconfig.json`，无诊断，exit 0。
- 额外检查（不属于验证计划）：
  - 评审变异检查（file:records/i1/T-ENGINE-07-review-mutations.txt）：5 个变异全部被检出，见上文「评审与修复」。
  - 实现时的变异检查（file:records/i1/T-ENGINE-07-mutations.txt，针对评审前的源码）：对 executor.ts 做 20 个变异，每个变异后运行 executor.test.ts，19 个被检出。存活的 M3（去掉「每个条目只重试一次」的标志）是等价变异：重试本身只是一次 `if`，不是循环；该标志只在多个输出都有硬件视频编码时才起作用，而 I1 没有这样的计划。每次变异后都按 sha256 确认源文件已还原。
  - 测试文件类型检查（file:records/i1/T-ENGINE-07-tsc-tests.txt，评审后重跑）：用继承 tsconfig.json、加入 test/media-converter 的临时配置检查。executor.test.ts 无诊断。唯一的诊断在 `test-hooks.test.ts:17`，是它自己的返回类型注解 `NodeJS.ProcessEnv`（该项目的 ProcessEnv 要求 APP_ROOT、VITE_PUBLIC），本任务开始前就存在，且该文件不在写集内。本任务放宽 test-hooks.ts 的参数类型后，这个文件的同类诊断从多处减少到这 1 处。批次 C 集成检查把该文件 `testEnv` 的返回类型改为 `MediaTestEnvironment`，重跑后无诊断，exit 0（追加在同一证据文件末尾）。
  - 回归（file:records/i1/T-ENGINE-07-regression.txt，评审后重跑）：`test-hooks.test.ts` 7 passed，exit 0。仓库中只有 executor.test.ts import 执行器，所以执行器的改动没有其他回归面。
- 批次 C 修正（2026-10-28）后，两项检查都已重跑，新输出追加在证据文件末尾，原内容保留：
  - V-ENGINE-07-1：28 passed，没有跳过，exit 0。新增用例见实际结果「批次 C 修正」。本机有 NVIDIA 驱动，所以真实 NVENC 用例也运行了；结束后 test-results/media-converter 为空。
  - V-ENGINE-07-2：tsc 没有诊断；测试文件另用临时配置检查，同样没有诊断。
  - 全部非 Electron 的 media-converter 测试 691 项通过（file:records/i1/FIXUP-C-vitest.txt）。
- 评审与修复（2026-10-28，批次 C 修正的独立评审）后，两项检查都已重跑，新输出追加在证据文件末尾：
  - V-ENGINE-07-1：29 passed（新增「回退重新规划期间收到取消时按取消结束」），没有跳过，exit 0；结束后 test-results/media-converter 为空；
  - V-ENGINE-07-2：tsc 没有诊断，测试文件的临时配置检查同样没有诊断；
  - 全部非 Electron 的 media-converter 测试 692 项通过（file:records/i1/FIXUP-C-vitest.txt 末尾）。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ENGINE-03-3 | 通过 | V-ENGINE-07-1, V-ENGINE-07-2 |
| AC-ENGINE-04-3 | 通过 | V-ENGINE-07-1, V-ENGINE-07-2 |
| AC-ENGINE-04-5 | 通过 | V-ENGINE-07-1, V-ENGINE-07-2 |
| AC-ENGINE-06-1 | 通过 | V-ENGINE-07-1, V-ENGINE-07-2 |
| AC-ENGINE-06-4 | 通过 | V-ENGINE-07-1, V-ENGINE-07-2 |

- AC-ENGINE-03-3：
  - 首帧前的硬件失败，用三种方式证明：注入（测试开关）、真实的参数失败（h264_mf）、真实进程一启动就被终止（libopenh264 替身）；
  - 首帧后的失败，用真实的 NVENC 证明，并用任何机器都能运行的 libopenh264 替身再证明一次。「处理计划摘要」由执行器经 `ExecutionOutcome.summary` 交给队列，队列按 schema 采用并推送（T-ENGINE-05 已验证）；界面显示由 workbench 完成。
- AC-ENGINE-04-3：本任务证明执行器一侧：3 s 内退出、确认关闭后删除临时文件、2-pass 日志与工作目录，并返回 cancelled。「任务状态为已取消」由队列映射（T-ENGINE-05）。进程的 3 s 退出由 T-ENGINE-02 的 process.test.ts 另行覆盖。
- AC-ENGINE-04-5：判定逻辑本身（`judgeEncode`/`runFailure`）由 T-ENGINE-02 实现并测试；本任务证明执行器把真实的重新探测结果、计划的流数量、预期时长与来源接进判定，判定失败时不发布，并附脱敏日志。
- AC-ENGINE-06-1：发布与删除前的身份核对由 `MediaOutputs` 完成（T-ENGINE-04 已测试）；本任务证明顺序（先记录、再 `wx` 创建、再运行，最后才发布），以及失败、取消、跳过时临时文件与记录都被清除。
- AC-ENGINE-06-4：「编码中磁盘写满」用测试开关注入的 `disk_full` 证明，原因码映射与不降级、不重试已验证；真实的磁盘写满没有制造。FAT32 的卷类型是注入的（真实的 `Get-Volume` 查询由 T-ENGINE-04 测试）。
- 批次 C 修正后的 AC-ENGINE-06-4：「显示所需与可用空间」现在有契约字段。执行器交出 `space`，队列写入条目状态并持久化，界面可以直接显示这两个数字（显示由 workbench 完成）。

## 风险与未执行项

**与设计的差异，以及在设计未明确处采用的做法**（均未修改设计文档）

1. **disk_space_low 的数字。** AC-ENGINE-06-4 要求显示所需与可用空间，但 contract 的失败状态只有 `{code, partial}`。执行器把这两个字节数写进条目日志（界面可以显示日志）。如果界面要单独显示数字，需要在 contract 中加字段（T-ENGINE-05/06 与 workbench 决定）。
2. **容忍的警告多了 1 条。** 真实运行发现，libopenh264 每次都会输出「bEnableFrameSkip = 0, bitrate can't be controlled … without enabling skip frame」。这正是规划选择的码率模式（不丢帧）。因此在 design §7b 的 4 条之外，把它也列为容忍。容忍清单只决定成功运行后是否记录日志，任何警告都不会让运行失败。
3. **多输出的失败处理。** design 没有规定某条音轨失败后是否继续。实现为：该输出自身的编码失败时继续写下一个输出，全局性失败时停止。条目的失败码取第一个失败。
4. **硬件降级的范围。** 「无论原因类别」解释为：编码器可能造成的失败原因都算，磁盘写满、无法打开输出、触顶、进程未启动不算。第二个硬件编码器在首帧前失败时也标记降级，以免后续条目再试它，但不再重试。
5. **覆盖的二次确认。** 按目标名比较（Windows 下不区分大小写）。文件身份没有被记录，所以如果确认之后同名文件被换成了另一个文件，仍会被移入回收站（不会被永久删除）。
6. **阶段上报。** 多输出时不为每个输出单独上报 encoding/finalizing，只上报整个条目的两次变化，以免超过每秒 4 次（T-ENGINE-05 评审备注）。
7. **test-hooks.ts 的参数类型** 放宽为只读字符串记录（见上文），行为不变。
8. **ffmpeg 无法启动时的重试（评审补充）。** 每个输出的运行最多重新校验并重试一次，与 `MediaRuntime.run` 对 ffprobe 的处理一致。`spawn_error` 不是编码器的问题，不降级，也不继续写多输出条目的下一个输出。

**评审中确认、未修改的已知限制**

- **多输出条目中途取消。** 已发布的输出（例如第 1 条音轨）留在磁盘上，但 `ExecutionOutcome` 的 `cancelled` 没有 outputs 字段，所以结果中不列出它们，界面无法「在文件夹中显示」。这需要在 queue/types.ts 与 contract 中补字段（T-ENGINE-05/06 或 workbench 决定）。临时文件、记录与工作目录照常清理。
- **降级重试前读取能力表。** `capabilities.planner()` 在有检测进行时会等待它结束，这段等待不响应取消。按 AC-ENGINE-03-2，有硬件编码任务运行时不能重新检测，所以正常情况下不会等待。

**由后续任务接线的部分**

- T-ENGINE-06：在注册时构造 `MediaConversionExecutor`，传入真实的 `MediaRuntime`（需要它的 `invalidate`，供启动失败时重新校验）、`InputRegistry`、`MediaOutputs`（`shell.trashItem`）、`MediaProber`、`MediaCapabilities`，以及 `resolveMediaTestHooks(process.env, {packaged: app.isPackaged}).fail`。`reveal: 'record'` 由 `reveal-output` 的实现读取。

**测试中发现、在写集外的问题**

- **裸 H.264（.h264）重封装为 MP4。** ffmpeg 输出「Timestamps are unset in a packet for stream 0」，处理时长始终为 N/A。执行器按「没有处理任何内容」判为 encode_failed，不发布。规划对裸流使用 `-fflags +genpts`，但它对 h264 解复用器不起作用。这属于 T-ENCODE-01 的规划问题，应在那里复核（例如裸流改为重新编码，或加 `-r`/`setts`）。时长未知的用例因此改用压缩（重新编码）。
- **NVENC 的首帧时间。** NVENC 的 `-rc-lookahead 32 -bf 3` 会让 ≤ 2 s、25 fps 的短片在结束时才写出第一帧。所以短片在编码中途出现的 NVENC 失败，也会被视为「首帧前」失败而降级重试。这符合 AC 的字面定义；「首帧后失败」的用例因此改用 60 fps 小样。
- **时长容差。** max(2 s, 1%) 的容差对 2 s 小样无法发现「输出过短」，所以时长用例用 10 s 读回值。

**未验证的部分**

- QSV、AMF 的真实失败，真实的 NVENC 首帧前失败（本机 NVENC 可用；只用了注入，以及 libopenh264 替身被立即终止），真实的磁盘写满，真实的 FAT32、exFAT 与网络盘，真实的回收站（测试中 trashItem 是移动到测试目录）。
- 低占用模式的真实亲和性设置（由 T-ENGINE-02 测试），以及 SVT-AV1 在低占用模式下的 `lp=1`（参数由 toFfmpegArgs 生成，本任务只证明 lowUsage 被传入）。
- 没有运行全量测试，没有启动 Electron。真实 ffmpeg 只处理测试时生成的小样（≤ 2 s，≤ 640×360），夹具生成与执行器的运行都是 IDLE 优先级，ffprobe 为 BELOW_NORMAL。本任务没有修改 test-results 下的其他内容。
- 本记录在验证版本快照之后更新，会改变工作树哈希。
- 未验证（评审）：真实运行时被杀毒软件拦截等「文件未变但无法启动」的场景。用例用不存在的路径制造 ENOENT 代替。

**批次 C 修正后的说明（2026-10-28）**

- 上文「与设计的差异」第 1 条、「评审中确认、未修改的已知限制」中的「多输出条目中途取消」，以及「测试中发现、在写集外的问题」中的「裸 H.264」，都已由批次 C 修正解决（见实际结果）。
- 取消多输出条目时，已发布的输出留在磁盘上，并列在结果中，这是有意的。界面如何表示「已取消但有部分输出」由 workbench 决定。

**评审后的说明（2026-10-28）**

- 回退重新规划期间的取消现在按取消结束。重新规划之后、第二次运行开始之前收到的取消，由 `#attempt` 开头的检查处理，结果同样是取消。
- 没有修改 output.ts：`file_too_large_for_volume` 仍不带 `space`，理由见批次 C 修正。
