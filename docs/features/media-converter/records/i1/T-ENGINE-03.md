# 实施记录：T-ENGINE-03

| 字段 | 值 |
| --- | --- |
| 任务 | T-ENGINE-03 |
| 日期 | 2026-10-28 |
| 验证版本 | snapshot-sha256:e3fd222fd544c9cdf392f7009d08f6563e89077cc64d113bc8fc5f5a0d504813（基线 a742ec76 + 未提交工作树）。2026-10-28 独立评审修复之后取得：在最后一次代码修改与全部验证重跑之后运行，之后只写了本记录与证据文件。其他任务同时在同一工作树中修改各自的文件，这个快照覆盖全部未跟踪文件，因此会随它们变化。本任务写集文件在快照时的 sha256：`engine/capabilities.ts` f6a63ab3…4e4f4b9a，`test-hooks.ts` 86643e91…cf4d00c2，`src/media-converter/contract.ts` b169d521…360ff691，`capabilities.test.ts` bdbbe93e…3748de58，`test-hooks.test.ts` b8ab00e0…3882c06（前 8 位…后 8 位）。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；随附 ffmpeg/ffprobe n8.1.2-21-gce3c09c101-20260630（BtbN，LGPL），经 `verifyLocalSubtitleRuntimeBundle({scope:'media'})` 校验；RTX 4070 Ti SUPER（无 Intel/AMD 显卡）。真实测试编码经 `MediaRuntime` 以 BELOW_NORMAL 运行（低优先级），每项为 lavfi `color` 1280×720@30 的 3 帧；实施前的手工实测以 IDLE 优先级运行，scratch 输出用后已删除。 |
| 任务指纹 | 8402e600f2336995ae49d7b8bccbe5aacdcc72fbdb533649222812cd7d2d537a |

## 实际结果

本任务没有界面，不涉及截图。

**新增与修改的文件（均在写集内）**

- `electron/main/media-converter/engine/capabilities.ts`（新增）：
  - **软件能力**：`parseEncoderList` / `parseMuxerList` / `parseFilterList` 只解析 `---` 分隔线之后的行，图例行不会被当成名称。`missingSoftware` 对照 `REQUIRED_SOFTWARE`：全部音频与字幕编码器（`srt` 按 ffmpeg 名 `subrip`）、`OUTPUT_CONTAINER_SPECS` 中每种输出的 muxer、design §4/§5 用到的滤镜（scale、format、setparams、zscale、tonemap、bwdif、sidedata、aresample、aformat、channelmap）以及探测自己的 `color`。缺任何一项时引擎为 `unavailable/runtime_invalid`，一次测试编码都不运行；列表运行超时为 `unknown`，退出码非 0 为 `runtime_invalid`。三个 CPU 视频编码器缺失时只在表中记为不可用。
  - **候选**：`capabilityCandidates()` 是固定清单，顺序同 design §3：h264_nvenc、hevc_nvenc（10/8-bit × uhq/hq）、av1_nvenc（uhq/hq），QSV 与 AMF 同样排列，然后 h264_mf、hevc_mf 硬件，hevc_mf 10-bit 核对项，最后 h264_mf 软件，共 19 项。变体来自 `encoderVariants()`，参数来自 `probeArgs()`，与 `toFfmpegArgs` 共用参数表。候选不取自 `-encoders`，所以 `*_d3d12va`、`*_vulkan`、`*_vaapi`、`av1_mf` 不可能进入。
  - **测试编码**：`-hide_banner -nostdin -nostats -loglevel level+warning -f lavfi -i color=black:s=1280x720:r=30 -frames:v 3 <probeArgs> -f matroska -y file:<work>/capabilities-<8hex>/probe-<enc>-<variant>.mkv`（画面取 `PROBE_PICTURE`）。退出码非 0，或 stderr 出现 `auto-selecting format` / `Invalid option` / `Error parsing option`（即使退出码为 0）时，按 stderr 分类。成功时用 `ffprobe -f matroska -protocol_whitelist file -select_streams v:0 -show_entries stream=codec_name,pix_fmt,profile` 读回，与 `expectedStream` 比较（8-bit 为 yuv420p，10-bit 为 yuv420p10le；H.264 High，HEVC Main/Main 10，AV1 Main），不符为 `params_rejected`，读不出为 `unknown`。
  - **失败分类**（`classifyEncoderFailure`，按以下顺序取第一条命中的行；第 2、4 条及第 3、7 条的补充来自 2026-10-28 评审修复）：
    1. `driver_too_old`：`Driver does not support the required nvenc API version`、`minimum required Nvidia driver`；最低驱动版本从 stderr 解析，没有则取 570.0；
    2. `session_limit`：`OpenEncodeSessionEx failed: out of memory|incompatible client key`，以及 CUDA 上下文 `CUDA_ERROR_OUT_OF_MEMORY`。排在 `no_device` 前面，因为 NVENC 对每个用不了的设备随后都会打印 `No capable devices found`；
    3. `params_rejected`（尺寸）：`exceeds`、`less than the minimum`、`Frame Dimension(s)`，同样排在 `no_device` 前面（module-encode §7b）；
    4. `unknown`（带该行）：除 `NO_DEVICE`、`OUT_OF_MEMORY` 以外任何 `failed -> CUDA_ERROR_*`，同样排在 `no_device` 前面，不持久化；
    5. `no_device`：`No capable devices found`、`No CUDA capable devices found`、`MFX session`、`CUDA_ERROR_NO_DEVICE`；
    6. `runtime_missing`：`amfrt64.dll`、`could not find any MFT`、`Cannot load nvcuda.dll|nvEncodeAPI`；
    7. `params_rejected`：`InitializeEncoder failed: invalid param|unsupported param`、`auto-selecting format`、`Invalid option`、`Error parsing option`、`Unrecognized option`、`Error setting option`、`Unable to parse "…" option value`、`Error applying encoder options`；
    8. 其他为 `unknown`。
  - **时间**：串行。每项的编码加核对共 15 s；所有测试编码共用 30 s 预算，每项的超时取 min(15 s, 剩余预算)，核对取 min(5 s, 本项剩余时间)。超时为 `unknown`；预算用完后剩余的候选直接记为 `unknown`（来源 `skipped`），不运行。运行时校验、三个列表和读取显卡信息不计入预算。
  - **持久化**：`userData/media-converter/capabilities.json`，经 `atomicWriteUtf8File` 写入，zod 严格校验。键为 ffmpeg 版本、运行时清单的 sha256（`generation`）和显卡列表（厂商 ID、设备 ID、驱动版本，排序去重）。只写入确定的结论（可用、`driver_too_old`、`no_device`、`runtime_missing`、`params_rejected`）；`session_limit`、`unknown`、超时、预算外的项不写入，下次启动只重测这些项。每条记录带该项生产参数的 sha256，参数表变化时只重测该项；`driver_too_old` 同时保存最低驱动版本。显卡列表取不到，或有任一显卡没有驱动版本时，记录 7 天后失效。文件损坏时重测全部并覆盖；内容不变时不写；写入失败只记日志。
  - **显卡信息**：注入 `gpuInfo`。默认的 `electronGpuInfo()` 在调用时才 `import('electron')` 并调用 `app.getGPUInfo('basic')`，模块顶层不依赖 Electron。`gpuKeyOf` 只读 `gpuDevice[]` 的 `vendorId`、`deviceId`、`driverVersion`，其余字段忽略；读取超过 5 s 或抛错时按「无显卡信息」处理。
  - **`MediaCapabilities`**：实现 `queue/types.ts` 的 `QueueCapabilities`（`planner()`、`status()`、`subscribe()`），另外提供：
    - `ensure()`：第一次需要时检测；
    - `redetect()`：有硬件编码任务运行时（注入 `isHardwareEncodeRunning`，必填，生产中接 `MediaQueue.isHardwareEncodeRunning`）返回 `{ok:false, code:'busy'}`；否则忽略缓存重测全部，并清空本会话的降级集。检测进行中时加入；若进行中的那次用了缓存，结束后再完整测一次；
    - `markDegraded(encoder)`：供执行器在首包前失败时调用（AC-ENGINE-03-3 由 T-ENGINE-07 接线）；
    - `resolvedEncoders()`、`defaults()`、`report()`、`dispose()`。
    - 构造时不运行任何东西。检测期间状态为 `detecting`，`planner()` 等它完成；多个调用共用一次检测。运行时不可用时状态为 `unavailable` 并带运行时原因码；`planner()` 不会自己重试（避免每次预览计划都重新校验约 1 s），由 `redetect()` 重试。`dispose()` 中止进行中的 ffmpeg 并等待结束，之后一律回答 `busy`。
  - **`PlannerCapabilities`**：每个候选的每个变体为 true/false。NVENC 的 `uhq` 表示任一 uhq 变体可用。三个 CPU 编码器在 `-encoders` 中列出时为 true。`degraded` 为本会话的降级集。`nvencMin` 固定为 {width:129, height:33}（`NVENC_MIN_FRAME`），即实测最小的 HEVC 下限；规划器已不再读取它（module-encode §7b 2026-10-28 说明），尺寸范围以 `VIDEO_TABLE.hardwareFrame` 为准。每次返回的都是冻结的新副本。
  - **状态**：`ready` 时给出 `hardwareEncoders`（有变体可用、未降级的硬件编码器；不含 hevc_mf 10-bit 核对项与 h264_mf 软件模式）、`degraded`、`driverUpdates`（按 nvenc/qsv/amf/mf 家族给出最低驱动版本，满足 AC-ENGINE-03-4 的提示所需）、`resolvedEncoders`（av1/hevc/h264 × 显卡开关关/开，沿规划器的降级链取第一个可用且未降级的配置，带 `hardware`、`weak` 与友好名 i18n 键）和 `defaults.compressCodec`（`defaultCompressCodec(caps)`）。降级、重新检测都会通知订阅者。
  - **测试开关**：`override` 来自 `test-hooks.ts`。`cpu_only` / `nvenc` 照常校验运行时，但不运行测试编码，也不读写 capabilities.json；`detecting_ms:<n>` 保持 `detecting` n 毫秒后按 `cpu_only` 结束；`unavailable:<code>` 不触碰运行时，代码为运行时原因码时，运行时状态也报该代码。
- `electron/main/media-converter/test-hooks.ts`（新增）：`resolveMediaTestHooks(env, {packaged})` 只在 `NODE_ENV === 'test'` 且未打包时读取 `FUSIONKIT_TEST_MEDIA_CAPS`，判定方式与 `system/index.ts` 的 `createTestSystemSetup` 相同。`parseMediaCapsOverride` 接受 `cpu_only`、`nvenc`、`unavailable:<引擎原因码>`、`detecting_ms:<0–600000>`，其他取值一律视为未设置。`FUSIONKIT_TEST_MEDIA_FAIL` / `REVEAL` 留给 T-ENGINE-07 补充。
- `src/media-converter/contract.ts`（修改）：
  - 修正 `VideoStreamInfo.rotation` 的注释：只取 Display Matrix，与 probe.ts 一致；
  - 新增 `CAPABILITY_FAILURE_CODES` / `capabilityFailureCodeSchema`、`encoderNameKey()`（`media:encoders.<id>`，h264_mf 软件模式为 `h264_mf_sw`）、`resolvedEncoderSchema` / `resolvedEncodersSchema`、`capabilityDefaultsSchema`、`HARDWARE_ENCODER_FAMILIES`；
  - `capabilityStatusSchema` 的 `ready` 增加可选字段 `degraded`、`driverUpdates`、`resolvedEncoders`、`defaults`。`MediaCapabilities` 总是填写它们；设为可选，是因为写集外的 `queue.test.ts` 的测试替身只构造 `{state:'ready', hardwareEncoders}`。
- 测试：`test/media-converter/capabilities.test.ts`（41 项，其中 1 项为真实运行时）与 `test/media-converter/test-hooks.test.ts`（7 项）。
- 夹具 `test/media-converter/fixtures/capabilities/`（文本）：
  - 本机 `-encoders` / `-muxers` / `-filters` 的输出；
  - 本机实测的 stderr，输出路径已脱敏为 `file:<work>/…`：QSV（`Error creating a MFX session: -9`）、AMF（`DLL amfrt64.dll failed to open`）、D3D12（`hevc_d3d12va` 自动选择 `d3d12` 格式后滤镜协商失败）、Vulkan、`hevc_nvenc` uhq 加 `-bf 3`（`InitializeEncoder failed: invalid param (8)`）、hevc_mf 输入 p010le 时自动替换为 nv12、NVENC 宽 4112（`Width 4112 exceeds 4096` 后接 `No capable devices found`）、HEVC 100×100 与 H.264 128×128 低于最小尺寸、非法 tune、未知选项、h264_mf 的 `-profile high`；
  - `synthetic-*`：本机无法产生的情况（驱动过旧、会话上限、无 nvcuda.dll、无 CUDA 设备、CUDA 上下文内存不足、无 MFT），按 ffmpeg 源码中的报错格式编写。

**本机实测得到的事实**（实施前以 IDLE 优先级手工实测，并由 V-ENGINE-03-2 复现）

- 19 项全部测完约 4.2 s，可用项每项 0.28–0.43 s（含核对），QSV 约 0.1 s，AMF 约 0.04 s。
- NVENC 10-bit 输出经 ffprobe 读回为 `yuv420p10le`，nv12 输入读回为 `yuv420p`。所以核对按解码后的像素格式比较，而不是按 `-pix_fmt` 的值。
- NVENC 尺寸超上限时先打印 `Width 4112 exceeds 4096`，再打印 `No capable devices found`；低于下限时为 `InitializeEncoder failed: invalid param (8): Frame dimensions are less than the minimum supported value.`（H.264 的措辞是单数 `Frame Dimension less than …`）。
- MF 硬件编码器（NVIDIA 的 MFT）运行时会在 TEMP（即工作目录）中创建 `NVIDIA Corporation\umdlogs`。本模块只删除自己的 `capabilities-*` 目录，这个目录由 T-ENGINE-04 的启动清理一并清空。
- `-tune bogus` 等错误参数使 ffmpeg 在打开输出前退出（`Error applying encoder options`），未知选项为 `Unrecognized option` / `Error splitting the argument list`；它们都归为 `params_rejected`。

**评审与修复（2026-10-28，独立对抗评审）**

评审逐项对照了 AC-ENGINE-03-1/2/4、design §3/§9 与写集内全部代码和测试，并用 `probeArgs` 实际导出了 19 个候选的参数（与生产参数表一致，核对项只把 nv12 换成 p010le）。实现整体成立：候选固定、生产参数、level+warning、MKV 加 ffprobe 核对、15 s/30 s 时限、只持久化确定结论、键含驱动、重新检测 busy 都有测试，并且原有 M1–M17 变异都能被发现。发现并修复以下问题（均在写集内）：

1. 【主要】CUDA 失败被当成 `no_device` 持久化。NVENC 对每个用不了的设备，最后都会打印 `No capable devices found`；在此之前若是 `cuCtxCreate(...) failed -> CUDA_ERROR_OUT_OF_MEMORY`（例如游戏占满显卡时），原分类按 `no_device` 写入 capabilities.json。这个结论在驱动不变时一直保留，NVENC 就一直不可用，界面上也看不出原因。修复：`CUDA_ERROR_OUT_OF_MEMORY` 归为 `session_limit`；其他 `failed -> CUDA_ERROR_*`（`NO_DEVICE` 除外）归为 `unknown` 并保留该行。两者都排在 `no_device` 之前，都不持久化，下次启动重测。`CUDA_ERROR_NO_DEVICE` 仍为 `no_device`。新增合成夹具 `synthetic-cuda-out-of-memory.txt`，按 ffmpeg `cuda_check.h` 的报错格式编写。
2. 【次要】ffmpeg 在 cuInit 成功但没有设备时打印 `No CUDA capable devices found`，原正则不认，结果为 `unknown`，每次启动都重测。已归为 `no_device`。
3. 【次要】`InitializeEncoder failed: unsupported param`（`NV_ENC_ERR_UNSUPPORTED_PARAM`，例如不支持的 tune）原来是 `unknown`。它和 `invalid param` 一样表示生产参数被驱动拒绝，已归为 `params_rejected`。
4. 【次要】缓存 schema 中的 `minimumDriver` 原为任意不超过 32 字符的字符串，而状态契约的 `driverUpdates[].minimumVersion` 只接受版本号。capabilities.json 被改坏时，`status()` 会给出不符合 `engineStatusSchema` 的就绪状态，快照或事件在 IPC 校验时就会失败。已改为同一正则，不符时整个文件按损坏处理并全部重测。
5. 【次要】`dispose()` 中止检测后，`#detectOnce` 仍会通知订阅者，`markDegraded` 也会通知，而这时队列与窗口可能已经关闭。已改为 dispose 之后不再通知。
6. 【次要】`isHardwareEncodeRunning` 原为可选，默认 `() => false`。T-ENGINE-06 组合时如果漏接，AC-ENGINE-03-2 的「有硬件任务时不可重新检测」会静默失效。已改为必填，测试相应传入。

新增测试：分类用例（CUDA 内存不足、其他 CUDA 错误、`No CUDA capable devices found`、`unsupported param`）；持久化用例中加入 CUDA 内存不足的配置，它不写入文件，下次启动重测；被改坏的 `minimumDriver` 导致全部重测，且状态仍符合 schema；dispose 之后不通知。评审变异 M18–M23 逐一撤销上述修复，全部被测试发现，源码随后逐字节还原。评审期间没有修改 contract.ts、test-hooks.ts 及其他写集外文件。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ENGINE-03-1 | 通过 | file:records/i1/T-ENGINE-03-unit.txt |
| V-ENGINE-03-2 | 通过 | file:records/i1/T-ENGINE-03-real.txt |

- V-ENGINE-03-1：2026-10-28 评审修复后重跑，两个文件共 48 项全部通过（exit 0），其中真实运行时 1 项也在这次运行中执行。按验证计划逐项对应：
  - `-encoders` / `-muxers` / `-filters` 解析：使用真实列表夹具，图例行不被解析；缺 `zscale` 或 `webm` 时能指出缺项，且缺项时不运行任何测试编码；
  - 各类 stderr 分类：12 个实测夹具与 8 个合成夹具，包括「尺寸拒绝」「会话上限」「CUDA 内存不足及其他 CUDA 失败」都先于 `No capable devices found` 的顺序；
  - CUDA 内存不足不持久化：持久化用例中该配置为 `session_limit`，下次启动与其他临时结论一起重测；
  - `auto-selecting format` 在退出码 0 时判为 `params_rejected`；ffprobe 核对不符（Constrained Baseline、10-bit 变成 8-bit）判为 `params_rejected`；读不出判为 `unknown`；
  - `session_limit`（含 CUDA 内存不足）/ `unknown` / 超时不写入文件，下次启动只重测这四项；
  - 键不变时重新启动不跑任何测试编码，文件内容不变；驱动、设备、ffmpeg 版本、运行时 generation 任一变化都重测全部 19 项；某项生产参数变化只重测该项；无驱动版本的键 6 天后仍复用、8 天后重测（三种情况：无显卡信息、缺驱动字段、读取抛错）；
  - 30 s 预算：每项 9 s 时，各项超时依次为 15 000、15 000、11 920、2 880 ms，第 4 项超时为 `unknown`，其余 15 项为 `skipped/unknown`，测试总耗时 ≤ 30 s，只写入前 3 项；单项超过 15 s 为 `unknown`，编码 12 s 后核对只剩 3 s；
  - 有硬件编码任务时 `redetect()` 返回 busy，不运行任何东西；否则忽略缓存重测全部；
  - d3d12va/vulkan/vaapi/av1_mf 虽然出现在 `-encoders` 中，但不在候选里，记录到的 ffmpeg 参数中也没有它们；
  - 打包模式下 `FUSIONKIT_TEST_MEDIA_CAPS` 被忽略：解析层面四种取值都返回 null；在 `MediaCapabilities` 中，同一环境变量在打包模式下会让真实检测照常运行（记录到三次列表调用）。
  - 另外覆盖：状态 unverified → detecting → ready 及每次通知、并发调用共用一次检测、检测中 `planner()` 等待、运行时缺失时的代码与重试、测试中途运行时无法启动、降级与重新检测清空降级、resolvedEncoders 与 defaults（含 h264_mf 软件模式的 `weak` 与 `h264_mf_sw`）、规划器用这张表对 1080p 源选出 hevc_nvenc 10bit_uhq、降级后选 hevc_mf、文件损坏与写入失败、缓存中不合格的最低驱动版本、`dispose()` 中止进行中的 ffmpeg 且之后不再通知、三种测试开关。
- V-ENGINE-03-2：2026-10-28 评审修复后在本机用随附运行时重跑，并设置 `FUSIONKIT_MEDIA_CAPS_EXPECT=nvidia-no-igpu`，让测试同时断言本机的期望结论（输出中有 `checked against the expected verdicts of nvidia-no-igpu: 19 configurations match`）。测试编码总耗时 4184 ms（加上运行时校验为 4503 ms），远低于 30 s；首次实施时为 4174 / 4480 ms。结果：
  - h264_nvenc、hevc_nvenc 8/10-bit 的 uhq 与 hq、av1_nvenc 的 uhq 与 hq 全部可用；
  - h264_mf 与 hevc_mf 硬件（nv12）可用，h264_mf 软件可用；
  - hevc_mf 10-bit 为 `params_rejected`（`auto-selecting format 'nv12'`）；
  - QSV 4 项为 `no_device`，AMF 4 项为 `runtime_missing`。
  - 引擎状态：`hardwareEncoders` 为 av1_nvenc、hevc_nvenc、hevc_mf、h264_nvenc、h264_mf；默认压缩编码为 hevc；AV1 开启显卡时为 av1_nvenc 10bit_uhq。
  - 同一键第二次启动只运行三个列表命令，没有测试编码，19 项都来自缓存且结论一致。
- 额外检查（不在验证计划中，2026-10-28 评审后重跑）：
  - `pnpm exec tsc --noEmit -p tsconfig.json` 无诊断，exit 0。tsconfig.json 只包含 src 与 electron，所以另用继承它的临时配置检查了两个测试文件，同样无诊断。见 file:records/i1/T-ENGINE-03-tsc.txt；
  - 解析契约 schema、使用规划表的相邻套件（queue、plan/*、probe、progress，共 423 项）全部通过，见 file:records/i1/T-ENGINE-03-regression.txt；
  - 评审变异 M18–M23：逐一撤销评审修复，6 处都被测试发现，源码随后逐字节还原（md5 前后一致），见 file:records/i1/T-ENGINE-03-review-mutations.txt；
  - 变异检查 M1–M17：逐一改动源码中的关键规则（尺寸先于 no_device、只持久化确定结论、30 s 预算、busy、退出码 0 时的 auto-selecting、ffprobe 核对、键含驱动、打包门控、15 s 单项上限、570.0 回退、参数摘要、重新检测忽略缓存、降级传给规划器、7 天期限、会话上限先于 no_device、d3d12va 不入候选、重新检测清空降级），每一处改动都被测试发现，源码随后还原（md5 前后一致），见 file:records/i1/T-ENGINE-03-mutations.txt。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ENGINE-03-1 | 通过 | V-ENGINE-03-1, V-ENGINE-03-2 |
| AC-ENGINE-03-2 | 通过 | V-ENGINE-03-1, V-ENGINE-03-2 |
| AC-ENGINE-03-4 | 通过 | V-ENGINE-03-1, V-ENGINE-03-2 |

- AC-ENGINE-03-1：先解析三个列表，再按顺序用生产参数测试每个候选（level+warning，3 帧，MKV，ffprobe 核对编码/像素格式/profile），15 s/30 s 时限与 6 个原因类别都已实现，并在本机真实运行。
- AC-ENGINE-03-2：引擎侧完成。「重新检测」按钮在硬件任务运行时不可用，由界面根据 `redetect()` 的 busy 结果与队列状态呈现（workbench 任务）；本任务保证引擎拒绝并返回 busy。
- AC-ENGINE-03-4：d3d12va/vulkan 不入候选；NVENC 驱动过旧时类别为 `driver_too_old`，并在状态的 `driverUpdates` 中给出最低驱动版本 570.0（会持久化）。界面文案由 workbench 任务渲染。

## 风险与未执行项

**本机无法验证**

- Intel 核显（QSV）与 AMD 显卡（AMF）的能力探测无法在本机验证（本机没有这些设备），不作为本任务的完成条件，列入 acceptance-I1 的未覆盖项。在这些设备上，QSV/AMF 的生产参数（暂定值）是否被接受、驱动过旧时的 stderr 措辞都未知；不认识的失败会归为 `unknown`，不持久化，每次启动重测，约 0.1 s 一项。
- `driver_too_old`、`session_limit`、无 CUDA、CUDA 上下文内存不足、无 MFT 只用合成 stderr 验证。文字按 ffmpeg 源码的报错格式编写，没有在真实旧驱动、会话占满或显存耗尽的机器上出现过。
- QSV 的 `Error creating a MFX session: <码>` 一律归为 `no_device`（本机为 -9，即 MFX_ERR_NOT_FOUND）。若 Intel 设备上出现内存分配（-4）、设备丢失（-13）、GPU 挂起（-21）这类临时错误码，也会被当成确定结论持久化，直到驱动或显卡列表变化，或用户点「重新检测」。没有 Intel 设备，无法验证，暂不细分错误码。
- `app.getGPUInfo('basic')` 的字段没有在 Electron 中实测（按要求不启动 Electron）。代码只读 `gpuDevice[].vendorId/deviceId/driverVersion`，取不到驱动版本时按设计改为 7 天有效期。建议 T-ENGINE-06 的组合测试或验收时确认一次实际字段。

**与设计的差异及理由**（未修改设计文档，建议回写 design §3/§9）

1. hevc_mf 10-bit 核对项：规划器的参数表没有 MF 10-bit 行，`probeArgs('hevc_mf','10bit')` 不存在。为满足 V-ENGINE-03-2「hevc_mf 10-bit 为 params_rejected」与 design §4「10-bit 判为 params_rejected」，本任务在 hevc_mf 的生产参数上把 nv12 换成 p010le 作为一项核对（`guard: true`）。它进入表中的 `hevc_mf.variants['10bit']`，但规划器的链只用 `8bit`，不受影响；它也不计入 `hardwareEncoders`。
2. `nvencMin` 固定为 {129, 33}（HEVC 下限，所有 NVIDIA 编码器中最小），不再用 design §3 的 144×120；规划器不读取它。
3. 显卡键：有设备 ID 但没有驱动版本时，键里仍保留设备 ID，并按 7 天失效。这比「键只用 ffmpeg 版本」更严格，换显卡时一定重测。键里还加入了运行时清单的 sha256。每条结论另带生产参数的 sha256，应用更新改了参数表时只重测受影响的项。
4. 分类补充：尺寸类消息归为 `params_rejected`，并排在 `no_device` 前（§7b）；会话上限也排在 `no_device` 前；`Unrecognized option`、`Error setting option`、`Unable to parse … option value`、`Error applying encoder options`、`InitializeEncoder failed: unsupported param` 归为 `params_rejected`；`Cannot load nvcuda.dll / nvEncodeAPI` 归为 `runtime_missing`；`CUDA_ERROR_NO_DEVICE` 与 `No CUDA capable devices found` 归为 `no_device`。评审补充：`CUDA_ERROR_OUT_OF_MEMORY` 归为 `session_limit`，其他 CUDA 调用失败归为 `unknown`，两者都排在 `no_device` 前，不持久化。design §3 的分类表把 `No capable devices found` 一律列为 `no_device`，未区分它前面的原因，建议回写。
5. 运行时缺少计划所需的编码器、muxer 或滤镜时，引擎为 `unavailable/runtime_invalid`；列表命令超时为 `unknown`。
6. `planner()` 在 `unavailable` 后不自动重试，由「重新检测」重试。重新检测会清空本会话的降级集，用户更新驱动后不必重启应用。
7. 测试开关的门控采用 `NODE_ENV === 'test' && !packaged`，与仓库现有的 `FUSIONKIT_TEST_*` 一致，不另外判断 `--mode=test`。`detecting_ms` 结束后按 `cpu_only` 给出结果。
8. contract 中 `ready` 状态的新字段是可选的（理由见上）。T-ENGINE-06 更新队列测试替身后，可以改为必填。

**留给后续任务接线**

- T-ENGINE-06：用 `new MediaCapabilities({runtime, root: userData/media-converter, isHardwareEncodeRunning: () => queue.isHardwareEncodeRunning(), override: resolveMediaTestHooks(process.env, {packaged: app.isPackaged}).caps})` 构造并交给队列（`isHardwareEncodeRunning` 现为必填）；第一次 `get-snapshot` 时调用 `ensure()`，并且必须在 T-ENGINE-04 的启动清理（清空 `work/`）完成之后，否则清理可能删掉正在检测的 `work/capabilities-*`；`redetect-capabilities` 调用 `redetect()`；`get-snapshot` 的 `resolvedEncoders`、`defaults` 取自 `resolvedEncoders()`、`defaults()`（`ready` 状态中也有，随 `engine` 事件更新）；关停时调用 `dispose()`。
- T-ENGINE-07：首包前硬件失败时调用 `markDegraded(encoder)`；可以复用 `classifyEncoderFailure` 记录失败类别。

**潜在风险**

- 队列在重新检测期间仍会调度已经排队、计划已冻结的条目。一个 CPU 任务运行时用户点了「重新检测」，随后排队的 NVENC 任务开始，就可能与检测争用编码会话，部分项得到 `session_limit`。这种结论不会持久化，本会话这些配置记为不可用。建议队列在 `detecting` 状态下暂停调度（属于队列任务的范围）。
- 第一次进入工具页时，检测会在 GPU 上运行约 4 s 的 NVENC/MF 编码（BELOW_NORMAL，每项 3 帧 720p）；之后每次启动只要键不变就不再运行。
- 运行时校验、三个列表命令和读取显卡信息不计入 30 s 预算，最坏情况下各有自己的超时（列表每个 15 s，显卡信息 5 s）。
- 批次 C 集成检查（2026-10-28）：T-ENGINE-07 与 T-ENGINE-06 之后又修改了 `test-hooks.ts`、`contract.ts`，集成检查修改了 `test-hooks.test.ts`（返回类型改为 `MediaTestEnvironment`）。上文记录的这些文件的哈希早于最终版本。最终代码上的结果：capabilities 41/41、test-hooks 7/7 通过，真实探测 19 项全部符合预期（测试编码 4215 ms），全部 media-converter 测试 679/679 通过。
