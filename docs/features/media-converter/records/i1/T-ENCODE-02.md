# 实施记录：T-ENCODE-02

| 字段 | 值 |
| --- | --- |
| 任务 | T-ENCODE-02 |
| 日期 | 2026-10-26 |
| 验证版本 | snapshot-sha256:6f79b2d5a82acad0248f85ab4bb88fc72928e92b2c0ba8ec50c35c14c6047f86（基线 a742ec76 + 未提交工作树）。批次 B 修正评审（2026-10-28）后取得：在评审的最后一次代码修改、受影响检查的重跑与证据文件写入之后，更新本记录及同批的 T-ENGINE-01、T-ENCODE-01～04 记录之前；这些记录文件的这次改动未计入。工作树中另有协调者对 spec 文档的未提交纠正（design、requirements、tasks、spec.json、changes/），以及其他任务的未提交文件。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；随附 ffmpeg/ffprobe n8.1.2-21-gce3c09c101-20260630（BtbN，LGPL），经 `verifyLocalSubtitleRuntimeBundle` 校验；NVIDIA RTX 4070 Ti SUPER（NVENC 与 NVIDIA 的 MF 硬件 MFT）。测试中的 ffmpeg 一律以 IDLE（`PRIORITY_LOW`）运行，并使用运行时的精简环境；ffprobe 经 `MediaRuntime` 以 BELOW_NORMAL 运行。素材都由 lavfi 在测试时生成：2 s、640×360 的 testsrc2 加时间噪声，另有一段 12 s、160×120 的小样，只用于检查 GOP；评审新增的尺寸范围用例只编码 2 帧黑场，最大到 8192 宽（检查需要）。素材放在 `test-results/media-converter/encode-*` 运行目录中，测试结束后删除。临时实测用 `start /low` 或 PowerShell `Start-Process` 后设 Idle 启动，素材放在 scratchpad 中。 |
| 任务指纹 | 7328313fcd2790b9759a5f88089bce3adf6f09ea01b8ac3546abb9239b0a5114 |

## 实际结果

本任务没有界面部分，不涉及截图。

**新增与修改的文件（均在写集内）**

- `electron/main/media-converter/plan/video.ts`（新增）：
  - **参数表**：集中在常量模块 `VIDEO_TABLE` 中，整体深度冻结，供 T-ENCODE-05 校准。
    - `parameters`：design §3 每一行的原文，例如 `-b:v 0 -profile:v main10`。占位符 `{Q}`/`{G}`/`{P}`/`{B}` 分别表示档位质量值、GOP、kvazaar 的 period、openh264 的码率。解析时去掉名称中的 `:v`，由 args.ts 统一加 `:v:0`。
    - `svtCrf`：SVT 按输出短边分 5 档的 CRF 表。
    - `quality`：其他编码器的三档值。
    - 硬件编码器按分辨率的 ±2 调整、openh264 的 bpp、0.7 系数与下限、5 s GOP、kvazaar period 取 16 的倍数、未知帧率时按 30 fps 计、低占用参数 `-svtav1-params lp=1`。
  - **三条降级链** `VIDEO_CHAINS`：
    - AV1：只用 libsvtav1。打开「使用显卡加速」时依次为 av1_nvenc → qsv → amf → libsvtav1。
    - HEVC：nvenc → qsv → amf → mf（硬件）→ libkvazaar。
    - H.264：nvenc → qsv → amf → mf（硬件）→ mf（软件）→ libopenh264。
    - 同一编码器内，10-bit 优先于 8-bit，uhq 优先于 hq。
  - **前置条件**：
    - 变体实测可用，且本会话未降级。随附的 CPU 编码器不参与能力探测，视为可用，除非能力表把它标为 `false` 或它已降级。
    - NVENC 的输出尺寸不小于 `caps.nvencMin`。
    - kvazaar 的宽高能向下取整到 8 的倍数。
    - HDR 源先在整条链上找 10-bit 配置，找不到再按普通顺序选择（色调映射由 T-ENCODE-03 负责）。
  - **提示**：落到 libkvazaar、MF 软件编码或 libopenh264 时，附 `cpu_weak_encoder`。要求显卡加速却没有可用的 AV1 硬件编码器时，附 `encoder_fallback`，`to` 为 libsvtav1。没有可用编码器时，返回 `no_encoder_available`，并列出可行的其他编码。
  - **分辨率**：`outputSize` 按旋转后的短边应用上限，长边按比例计算，取最近的偶数，且不超过源的边长。任何情况下都不放大。奇数宽高向下取偶数，kvazaar 向下取 8 的倍数。尺寸变化时才加 `scale=w=W:h=H:flags=lanczos+accurate_rnd+full_chroma_int`。
  - **像素格式**：滤镜链末尾一律为 `format=<像素格式>`，像素格式取自参数表中的 `-pix_fmt`。
  - **取值规则**：
    - GOP 为 `round(5 × fps)`；kvazaar 的 period 取最接近 5 × fps 的 16 的倍数；SVT 不设 GOP。
    - openh264 的码率 B = min(bpp × 宽 × 高 × fps, 0.7 × 源视频码率)。源视频码率取流码率；没有时，用容器码率减去已知的音轨码率。
  - **对外函数**：`defaultCompressCodec(caps)`（纯函数）、`planVideoEncode`、`probeEncodeSpec`，以及 `PROBE_PICTURE`（1280×720，30 fps）。
- `plan/args.ts`：
  - `FfmpegIo.lowUsage`：低占用模式在运行时由 engine 传入，为 libsvtav1 追加 `-svtav1-params:v:0 lp=1`。
  - 字幕编码器 id `srt` 写进参数时改为 ffmpeg 的 `subrip`。
  - `probeArgs(encoder, variant)`：生成 probe 画面在均衡档下的生产参数。它与 `toFfmpegArgs` 使用同一份参数表和同一个 `codecArgs` 渲染函数；参数表中没有的组合会抛出 TypeError。
- `plan/stream-plan.ts`：
  - 删除视频占位实现，改为调用 `planVideoEncode`。压缩任务使用设置中的编码、档位、分辨率上限与显卡加速选项。转换任务按目标容器选编码（`CONVERT_VIDEO_CODEC`），档位同名同值，不缩放，也不用显卡编码 AV1。
  - 新增 `expectedFrom`：期望时长来自主流时为 `stream`，否则为 `container`。
- `plan/types.ts`：
  - `PlannedOutput.expectedFrom: 'stream' | 'container'`。
  - 注释写明 CPU 编码器的可用规则，以及 `EncodeSpec.variant` 的含义：视频时为编码配置，音频和字幕时为 null。
- 测试：
  - `test/media-converter/plan/video.test.ts`（新增，60 项）。
  - `test/media-converter/plan/stream-plan.test.ts`：68 项。新增 `subrip` 与 `expectedFrom` 的用例。两张快照按预期更新：视频编码现在带真实参数与 `format` 滤镜，CPU 档附 `cpu_weak_encoder`。更新前后的差异已逐行核对，只有这两类变化。
  - `test/media-converter/encode-real.test.ts`（新增，15 项）。

**用真实 ffmpeg 核对的事实**（随附 n8.1.2，IDLE 优先级）

- SVT-AV1 v4.1.0 默认 keyint 为 161 帧（30 fps 时为 5.37 s），在 5 s ± 1 s 内。`lp=1` 被接受，日志为「Level of Parallelism: 1」，没有警告。
- hevc_nvenc 的 `-tune uhq` 加 `-bf 3` 时，驱动报 `InitializeEncoder failed: invalid param (8)`；不设 `-bf` 时正常。
- h264_mf 加 `-profile:v 100` 输出 High；去掉后输出 Constrained Baseline（见变异 M2r）。
- kvazaar 参数用冒号分隔时，日志出现 `Invalid option`，kvazaar 报「unknown preset」（见变异 M3r）。
- `srt` 与 `subrip` 两个编码器都存在，且都不产生警告；参数中统一写 `subrip`。
- 这个 ffmpeg 构建中，h264_nvenc 的 `-tune` 只有 hq/ll/ull/lossless，没有 uhq，所以 h264_nvenc 只有一种配置。hevc_nvenc 与 av1_nvenc 有 uhq。
- ffprobe 以 CSV 输出关键帧时，第一帧所在行后面可能多出一个空的 side-data 字段，所以只取第一列（测试中已处理）。

**V-ENCODE-02-2 实测结果**（2 s、640×360、30 fps 小样；单位为字节；13 种配置全部执行，没有跳过）

| 配置（编码器/变体） | 画质优先 | 均衡 | 体积优先 | 关键帧（12 s 小样，秒） |
| --- | --- | --- | --- | --- |
| libsvtav1/10bit | 419286 | 249293 | 172678 | 0, 5.37, 10.73 |
| av1_nvenc/10bit_uhq | 300445 | 222126 | 157892 | 0, 5, 10 |
| av1_nvenc/10bit（hq） | 373812 | 238625 | 172725 | 0, 5, 10 |
| hevc_nvenc/10bit_uhq | 651217 | 329986 | 259466 | 0, 5, 10 |
| hevc_nvenc/10bit（hq） | 579636 | 313488 | 205112 | 0, 5, 10 |
| hevc_nvenc/8bit_uhq | 651649 | 332597 | 259706 | 0, 5, 10 |
| hevc_nvenc/8bit（hq） | 580667 | 334001 | 207159 | 0, 5, 10 |
| h264_nvenc/8bit | 893603 | 508654 | 297495 | 0, 5, 10 |
| h264_mf/8bit（硬件） | 2726099 | 567915 | 292829 | 0, 5, 10 |
| h264_mf/8bit_sw（软件） | 2700062 | 1429456 | 433989 | 0, 5, 10 |
| hevc_mf/8bit（硬件） | 2081069 | 945310 | 361268 | 0, 5, 10 |
| libkvazaar/8bit | 871672 | 364554 | 205382 | 0, 4.8, 9.6 |
| libopenh264/8bit | 208832 | 156662 | 113698 | 0, 5, 10 |

每个输出都经过以下检查：

- 先断言规划器选中的正是该编码器与变体，然后按规划器生成的参数编码。
- ffprobe `-count_frames` 解码全部 60 帧，没有错误输出。
- codec、profile、像素格式符合预期：
  - AV1 为 Main、yuv420p10le；
  - HEVC 10-bit 为 Main 10、yuv420p10le，8-bit（NVENC 8-bit、hevc_mf、kvazaar）为 Main、yuv420p；
  - H.264（包括 MF 的硬件与软件编码）为 High、yuv420p；
  - 尺寸为 640×360。
- HEVC 的 `codec_tag` 为 hvc1。
- MP4 的顶层盒中 `moov` 在 `mdat` 之前（faststart）。
- `level+warning` 日志中没有 `Invalid option`、`Error parsing option`、`auto-selecting format`、`only the last`。
- 低占用的 SVT 编码另测一项：参数含 `-svtav1-params:v:0 lp=1`，日志中没有任何 warning 或 error。

日志中唯一的 warning 来自 libopenh264：「bitrate can't be controlled … without enabling skip frame」，见风险部分。

**防止空跑**：测试不依赖能力探测，直接尝试每个编码器。只有 stderr 显示设备或运行库缺失（`no_device` / `runtime_missing`）时才记为跳过，并写明原因。系统目录中有 `nvcuda.dll`（已装 NVIDIA 驱动）时，NVENC 配置是必需项，跳过即失败。设 `FUSIONKIT_MEDIA_REQUIRE_ENCODERS=all` 时，所有配置都是必需项。本机 13 种配置全部实际编码，没有跳过。

**变异检查**（每次只改 plan 中的一个文件，运行相关测试后还原；运行前后 4 个 plan 文件的 sha256 一致）。证据：file:records/i1/T-ENCODE-02-mutations.txt

| 变异 | 结果 |
| --- | --- |
| M1 hevc_nvenc uhq 加 `-bf 3` | 单元 4 项失败；真实编码（M1r）失败：驱动 `InitializeEncoder failed: invalid param` |
| M2 h264_mf 去掉 `-profile:v 100` | 单元 4 项失败；真实编码（M2r）失败：profile 为 Constrained Baseline |
| M3 kvazaar 参数改用冒号 | 单元 6 项失败；真实编码（M3r）失败：日志出现 `Invalid option` |
| M4 HEVC 链中 amf 排在 qsv 前 | 2 项失败 |
| M5 去掉 NVENC 尺寸前置条件 | 3 项失败 |
| M6 放大到上限 | 1 项失败 |
| M7 默认编码忽略降级 | 1 项失败 |
| M8 硬件调整不区分方向 | 2 项失败 |
| M9 GOP 改为 3 s | 单元 26 项失败；真实编码（M9r）失败：关键帧间隔为 3 s |
| M10 去掉像素格式滤镜 | 31 项失败 |
| M11 HDR 不先找 10-bit | 1 项失败 |
| M12 CPU 编码器也要求实测结果 | 60 项失败 |
| M13 字幕仍写 `srt` | 1 项失败 |
| M14 `expectedFrom` 恒为 stream | 1 项失败 |
| M15 忽略低占用模式 | 1 项失败 |
| M16 MF 软件编码不提示 `cpu_weak_encoder` | 2 项失败 |
| M17 不附 `encoder_fallback` | 2 项失败 |
| M18 openh264 码率不受源码率约束 | 4 项失败 |
| M19 kvazaar 只取偶数 | 2 项失败 |
| M20 忽略旋转 | 1 项失败 |

**评审与修复**（独立评审，2026-10-26）

评审逐行核对了写集内全部代码与测试。核对结论如下：

- **参数表核对**：design §3 的 21 行与 `VIDEO_TABLE.parameters` 逐字一致。另用随附 ffmpeg 的 `-h encoder=` 核对了每个选项名、命名常量与数值范围，包括本机无设备、无法实测的 QSV/AMF，全部存在（证据：file:records/i1/T-ENCODE-02-review-sizes.txt 第 1 节）。
- **AC 核对**：降级链顺序、10-bit 回退、HDR 先找 10-bit、旋转后短边、只缩不放、kvazaar 取 8 的倍数、GOP、openh264 码率、转换任务选编码、`probeArgs` 与 `toFfmpegArgs` 一致，都与 AC 及 design 相符。测试不是空跑。

发现与处理：

1. **主要问题（已修复）：尺寸前置条件与真实硬件不符，会让编码器在本会话被降级。**
   - design 与原实现只要求 NVENC 宽 ≥ 144、高 ≥ 120（取自能力表 `caps.nvencMin`），也没有上限。
   - 本机实测（证据：file:records/i1/T-ENCODE-02-review-sizes.txt 第 2、3 节）：
     - h264_nvenc 要求宽 ≥ 145、高 ≥ 49，hevc_nvenc 要求 129×33 以上，av1_nvenc 要求 129×65 以上（按偶数边即 146×50、130×34、130×66）。
     - 上限方面，H.264 每边 ≤ 4096，HEVC/AV1 每边 ≤ 8192。
     - 所以 144×120 的 H.264 会被拒绝（「Frame Dimension less than the minimum」）。
     - 超过 4096 宽的 H.264（例如 5.3K 运动相机素材）不但被拒绝，ffmpeg 还会报「No capable devices found」。
   - NVIDIA 显卡上的 MF 硬件编码器就是 NVENC，拒绝的尺寸完全相同。原实现给 108×192 选的 `hevc_mf`/`h264_mf` 硬件，实测打不开。
   - 按 AC-ENGINE-03-3，硬件编码器在首帧前失败，无论原因，都会被标记为本会话降级。所以一个尺寸特殊的文件，就会让该编码器在之后所有任务中都不可用。
   - 修复：
     - `VIDEO_TABLE.hardwareFrame` 记录按编码分开的实测尺寸范围，`openh264MaxPixels` 记录 openh264 的面积上限（9437184，即 4096×2304）。
     - 新增 `takesSize`：
       - NVENC 同时满足该范围与 `caps.nvencMin`，所以 design 的 144×120 下限仍然有效，并且更严格；
       - MF 硬件模式按该范围；
       - kvazaar 仍要求能取 8 的倍数；
       - openh264 按面积上限，例如 5.3K 的 H.264 在只有 CPU 时返回 `no_encoder_available`，并建议 av1/hevc；
       - QSV/AMF 没有实测，保持 design 的行为，不加限制。
   - 测试：
     - `video.test.ts` 新增 2 项，覆盖上下边界、`caps.nvencMin` 叠加、MF 范围、大尺寸与 openh264 面积。
     - 原「108×192」用例改为实测结论：NVENC 与 MF 硬件都跳过，HEVC 落到 kvazaar，H.264 落到 MF 软件编码。
     - `encode-real.test.ts` 新增 1 项，用 `probeArgs` 对 5 个硬件配置在范围两端各编码 2 帧，必须能打开；NVENC 在范围外一步必须被拒绝，且 stderr 为尺寸原因。本机 5 个配置全部符合，见 V-ENCODE-02-2 证据。
2. **次要问题（已修复）：`defaultCompressCodec` 计入了降级链不会选的配置。**
   - 例如能力表中的 `hevc_mf` 10bit 或 `hevc_qsv` 8bit_uhq 会让默认编码成为 HEVC，但 HEVC 链随后只会落到 kvazaar。
   - 修复：改为只统计 HEVC 链中的硬件配置，并补充测试。
3. **类型注释**：`types.ts` 中 `PlannerCapabilities.nvencMin` 的注释写明，规划器在它之外还会叠加按编码分开的实测范围。
4. **评审变异检查**：共 7 项（6 项单元、1 项真实编码），全部被测试发现，`video.ts` 还原后 sha256 一致。证据：file:records/i1/T-ENCODE-02-review-mutations.txt。
5. **未修复、超出写集的问题**：见「风险与未执行项」中的评审新增项，包括旋转标签与 ffmpeg 不一致、超大尺寸被识别为 `no_device`、输出上限与 MF 画质值。

**批次 B 修正（2026-10-28）**

依据 changes/2026-10-26-batch-b-spec-corrections.md 与 design §7b「尺寸范围」，AC-ENCODE-02-2 已纠正：

- `plan/video.ts`：
  - `VIDEO_TABLE.hardwareFrame` 改为 AC 写明的实测范围本身：H.264 宽 145–4096、高 ≥ 49；HEVC 宽 ≥ 129、高 ≥ 33；AV1 宽 ≥ 129、高 ≥ 65；HEVC/AV1 每边 ≤ 8192，H.264 每边 ≤ 4096。原表写的是对应的偶数（146×50、130×34、130×66）。规划器输出的边长总是偶数（kvazaar 为 8 的倍数），所以选择结果与原表相同，只是表值现在与 AC 逐字一致。
  - 抽出两个纯函数：`hardwareFrameFits(codec, size, floor)`（NVENC 另叠加 `caps.nvencMin`，MF 硬件用同一范围、不叠加）与 `openh264Fits(size)`（面积 ≤ 4096×2304），`takesSize` 改为调用它们。kvazaar 仍由 `outputSize` 向下取 8 的倍数，尺寸未知时不选。核对结论：video.ts 实施的条件与 AC-ENCODE-02-2 一致，没有其他不符。
- `test/media-converter/plan/video.test.ts`：
  - F1：原有 30 项失败，原因只是 T-ENCODE-03 在每条视频滤镜链末尾加了 `setparams`。本文件的夹具都标为 BT.709，探测画面 1280×720 未标记、按新规则也推定为 BT.709，所以按源逐项把期望改为 `format=<像素格式>,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`：design 参数行、MF、kvazaar、HEVC 8-bit 回退、尺寸未知、转换档位、低占用 `lp=1`。三张内联快照用脚本在每个 `-filter:v:0 format=X` 后补上同一个 setparams，没有用 `-u`；补完后三张快照即通过，说明差异只有 setparams。没有放宽任何断言。
  - F2：新增「AC-ENCODE-02-2 实测范围逐边界」用例：
    - 表值与 AC 逐字相同。
    - 直接测 `hardwareFrameFits`：三种编码各自的下限与上限，内侧一点、外侧一步（如 145/144、49/48、4096/4097）；叠加 `caps.nvencMin`。
    - openh264：4096×2304、2304×4096、3072×3072 在内，4097×2304、4096×2305、3072×3073 在外。
    - 经规划器测偶数边长（NVENC 的 nvencMin 降低后由编码自身的范围决定）：H.264 146×50 可用，144×50、146×48、4098×50、146×4098 不可用；HEVC 130×34 / 128×34 / 130×32 / 8194×34 / 130×8194，AV1 同理；MF 硬件同一范围；只有 CPU 时 4098×2304 没有 H.264 编码器；kvazaar 15×15 取 8×8，7×7 没有编码器。
  - 两处输出上限的期望改为 design §7b 的新公式（见 T-ENCODE-01 记录）。
- `test/media-converter/encode-real.test.ts`：尺寸范围用例改为先把表中的最小值向上取偶数再测（146×50 等），因为表值现在是 AC 的奇数下限，而规划器只给偶数边长。实测结果与修正前相同，见 V-ENCODE-02-2。另新增 V-ENCODE-03-2 的未标记色彩实测，见 T-ENCODE-03 记录。
- `plan/types.ts`：`nvencMin` 的注释改为「H.264 需 145 宽，偶数边长为 146」。
- 风险中评审列出的两项写集外问题已由同批修正处理：「旋转标签与 ffmpeg 不一致」（T-ENGINE-01），「输出上限」（T-ENCODE-01，改为 1.0 bpp 与源体积 × 4）。「超大尺寸被识别为 no_device」属于 T-ENGINE-03/07，未在本次处理。
- 变异检查（file:records/i1/T-ENCODE-02-batchb-mutations.txt）：H.264 下限改为 147、HEVC/AV1 上限用 `<`、openh264 面积用 `<`，各使 video.test.ts 2 项失败；写回后 sha256 一致。
- 回归：test/media-converter 下全部 14 个测试文件，581 项通过（file:records/i1/T-ENCODE-01-batchb-full.txt）。

**批次 B 修正评审（2026-10-28）**

独立评审逐项核对了上面的修正与 AC-ENCODE-02-2，发现并修复 1 个问题：

- **NVENC 仍叠加旧下限，实施的范围比 AC 窄（已修复）。**
  - `takesSize` 对 NVENC 仍取 `VIDEO_TABLE.hardwareFrame` 与 `caps.nvencMin` 中更严的一个。能力表的 `nvencMin` 按 engine design §3 是 144×120，正是 AC 纠正前的旧写法。
  - 所以在生产能力表下，NVENC 的 H.264 实际要求高 ≥ 120（AC 为 ≥ 49），HEVC/AV1 要求 144×120 以上（AC 为 129×33、129×65）。例如 1280×100 的 H.264、142×120 的 HEVC 都会跳过 NVENC，而 V-ENCODE-02-2 已实测这类尺寸可以打开。
  - 原测试把 `nvencMin` 降到 2×2 或 16×16 来展示 AC 范围，正好掩盖了这一点；「142×120、144×118 的 HEVC 落到 kvazaar」的断言验证的也是旧规则。
  - 修复：`video.ts` 的 `hardwareFrameFits(codec, size)` 去掉 `floor` 参数，NVENC 与 MF 硬件编码只按 `VIDEO_TABLE.hardwareFrame` 判定，`takesSize` 不再读取能力表。`types.ts` 中 `nvencMin` 的注释改为：规划器不读取它，它已被按编码分开的实测范围取代。字段本身保留，因为其他任务的测试与能力快照仍在使用，是否删除留给 T-ENGINE-03（见风险）。
  - 测试（`video.test.ts`）：
    - 原「`caps.nvencMin` 叠加」用例改为：能力表仍为 144×120 时，142×120、144×118、130×34 的 HEVC，146×50、1280×100 的 H.264，130×66 的 AV1 都选 NVENC；144×120 的 H.264 仍因宽 < 145 被拒绝。
    - `nvencMin` 取 2×2、144×120、4096×4096 时，H.264/HEVC/AV1 在 11 个边界尺寸上的选择完全相同。
    - 范围下方一步仍跳过 NVENC；NVENC 降级时，MF 硬件编码按同一范围接手。
    - 「逐边界」用例改为直接使用 144×120 的能力表，并补充 `hardwareFrameFits` 在旧下限以内（143×119、144×120）的结果。
  - 变异：把旧下限加回 `takesSize`，video.test.ts 2 项失败；写回后 sha256 一致（file:records/i1/T-ENCODE-02-batchb-review-mutations.txt，R1）。
- 其余核对无问题：
  - 表值与 AC 逐字一致；H.264 的 4096 上限对宽高都生效（实测 1088×4112 被拒绝）；MF 硬件编码用同一范围；libopenh264 面积上限为 9437184；kvazaar 向下取 8 的倍数。
  - F1 的期望逐项核对：本文件的夹具都标为 BT.709，所以每条链都以 BT.709 的 setparams 结尾，这是源的正确值，不是放宽断言；三张内联快照只多了 setparams；测试数 63 = 原 62 + 新增 1，没有删减。未标记源的推定由 video-correctness.test.ts 覆盖（T-ENCODE-03）。
  - 尺寸未知时，MF 硬件编码仍可选用（NVENC 不可选）。这是 T-ENCODE-02 原有的取舍，本次未改，测试中已注明。
- 重跑：V-ENCODE-02-1 63 passed；V-ENCODE-02-2 26 passed，没有跳过；V-ENCODE-02-3 两项 tsc 都没有诊断；test/media-converter 全目录 582 passed。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ENCODE-02-1 | 通过 | file:records/i1/T-ENCODE-02-video.txt |
| V-ENCODE-02-2 | 通过 | file:records/i1/T-ENCODE-02-encode-real.txt |
| V-ENCODE-02-3 | 通过 | file:records/i1/T-ENCODE-02-tsc.txt |

- **V-ENCODE-02-1**（批次 B 修正评审后重跑，证据已覆盖：63 passed，exit 0；批次 B 修正前因 T-ENCODE-03 的 setparams 为 30 failed / 32 passed），覆盖：
  - 参数快照：「AV1 / AV1 显卡 / HEVC / H.264 × 三档 × 全 NVENC / 仅 CPU / 仅 QSV / 仅 AMF / NVENC 降级」，共 60 行；
  - design §3 全部 21 行，在测试中独立转写，与生成参数逐档比较；
  - hevc_nvenc 选 uhq 时不出现 `-bf`，hq 为 `-bf 3`；
  - MF 参数含 nv12 与 profile 100；kvazaar 参数用逗号分隔；
  - 三条降级链的完整顺序（逐个淘汰后的选择序列）与降级集；
  - 10-bit 不可用时，HEVC 回退为 8-bit（Main、yuv420p 或 nv12）；
  - HDR 源优先选 10-bit；
  - 108×192 跳过 NVENC（评审后：同时跳过 MF 硬件编码）；能力表的 `caps.nvencMin`（144×120）不再收窄范围（评审后）；按编码分开的实测范围（H.264 146×50 起、HEVC 130×34 起、AV1 130×66 起；H.264 每边 ≤ 4096、HEVC/AV1 ≤ 8192）及 MF 硬件编码的同一范围；批次 B 后表值为 AC 的 145×49、129×33、129×65，逐边界内外各测一点；openh264 面积上限与超出时的 `no_encoder_available`；
  - kvazaar：854×480 → 848×480，1920×804 → 1920×800；
  - 竖屏 1080×1920（含旋转 90°/270° 的存储方式）在 720p 上限下为 720×1280；
  - 不放大、奇数宽高修正，以及缩放后边长不超过源、为对应倍数的性质检查；
  - 尺寸未知时的处理；
  - SVT CRF 按输出短边取值；硬件 ±2 调整，含 MF 的方向；
  - GOP 与 kvazaar period；openh264 码率的两个分支与下限；
  - 转换为 MP4/MOV/WebM/MKV（含重新编码）时的编码选择，以及每种容器的快照；
  - `cpu_weak_encoder`、`encoder_fallback`、`no_encoder_available` 及其替代建议；
  - `defaultCompressCodec` 的各种取值；
  - `probeArgs` 与 `toFfmpegArgs` 一致，含快照；低占用 `lp=1`；`hvc1` 与 faststart。
- **V-ENCODE-02-2**（批次 B 修正评审后重跑，证据已覆盖：26 passed，没有跳过，exit 0。其中 10 项是 V-ENCODE-03-2 的正确性用例，本文件现共 26 项）：
  - 13 种配置 × 三档全部通过，体积严格递减，编码、位深、profile、GOP、hvc1 与 faststart 符合。T-ENCODE-03 加上 setparams 后，每个文件比上方实测表多约 20 字节（VUI 色彩描述）。
  - 尺寸范围用例（批次 B 后把表中的奇数下限向上取偶数再测）：h264_nvenc、hevc_nvenc、av1_nvenc、h264_mf、hevc_mf 在范围两端（如 146×50 与 4096×1088）都能打开。
  - 范围外一步（如 144×50、146×48、4112×1088、1088×4112）全部被拒绝。NVENC 的 stderr 为尺寸原因。
  - 运行后 `test-results/media-converter` 中没有遗留的 `encode-*` 运行目录。
- **V-ENCODE-02-3**：批次 B 修正评审后重跑，`pnpm exec tsc --noEmit -p tsconfig.json` 没有诊断，exit 0。测试文件不在 tsconfig 的 include 中，另用继承该配置的临时配置检查了 test/media-converter 下的全部测试文件，同样没有诊断。
- **补充回归**（评审复跑）：stream-plan、naming、remux-real 共 88 passed，exit 0。证据：file:records/i1/T-ENCODE-02-stream-plan.txt（批次 B 前的结果，未覆盖）。批次 B 修正评审后：test/media-converter 全目录 582 项通过（file:records/i1/T-ENCODE-01-batchb-full.txt）。实现时另跑过其他任务的 queue.test.ts，评审没有再跑。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ENCODE-02-1 | 通过 | V-ENCODE-02-1, V-ENCODE-02-2 |
| AC-ENCODE-02-2 | 通过 | V-ENCODE-02-1, V-ENCODE-02-2 |
| AC-ENCODE-02-3 | 通过 | V-ENCODE-02-1 |
| AC-ENCODE-02-4 | 通过 | V-ENCODE-02-2 |
| AC-ENCODE-02-5 | 通过 | V-ENCODE-02-1, V-ENCODE-02-2 |
| AC-ENCODE-02-7 | 通过 | V-ENCODE-02-1 |
| AC-ENCODE-01-7 | 通过 | V-ENCODE-02-1 |

- **AC-ENCODE-02-2**：
  - 批次 B 纠正后，AC 写明了按编码分开的实测范围（NVENC、MF 硬件、libopenh264、libkvazaar）。video.ts 的表值与之逐字一致，逐边界的单元测试与真实编码（V-ENCODE-02-2 的尺寸范围用例）都通过。
  - 评审后，NVENC 只按该范围判定。能力表的 `caps.nvencMin`（engine design §3 的旧值 144×120）不再收窄它，否则 H.264 高 49～119、HEVC/AV1 宽 129～143 或高低于 120 的画面会被错误地跳过。
  - QSV/AMF 没有实测范围，不加限制（风险中已列出）。
- **AC-ENCODE-02-5**：本机实测可用的编码器全部按三档编码。QSV 与 AMF 在本机没有设备，属于「非实测可用」，只有参数快照，见风险部分。
- **AC-ENCODE-02-7**：`defaultCompressCodec(caps)` 已实现并导出，是纯函数，测试覆盖各种取值。「主进程通过快照提供给界面」属于 engine/workbench 的接线，不在本任务写集内。
- **AC-ENCODE-01-7**：视频编码的选择已完成。WebM/MKV 重新编码时的音频选用 Opus，目前仍是 T-ENCODE-01 的占位（ffmpeg 默认参数），音频参数表由 T-ENCODE-04 补全。

## 风险与未执行项

**与设计的差异，以及设计未写明处采用的做法**（未修改设计文档）

1. **字幕编码器 id 改名。** design §7a 要求把 `srt` 改为 `subrip`。但这个 id 定义在 `contract.ts`（`SUBTITLE_ENCODERS`），并被 `matrix.ts` 使用（`subtitleHandling`、`ENCODER_CODEC`），这两个文件都不在本任务写集内。所以协议中的 id 仍为 `srt`（界面会映射成友好名称），由 `args.ts` 的 `ffmpegEncoderName` 在生成参数时写成 ffmpeg 的 `subrip`。实际传给 ffmpeg 的已是 `subrip`，有测试与变异 M13 证明。如果要在协议层也改名，需要由写集包含 contract.ts 与 matrix.ts 的任务处理。
2. **`expectedFrom` 的取值与 engine 不一致。** 按 design §7a 与任务说明，取值为 `'stream' | 'container'`；没有任何时长时取 `container`。但已实现的 `engine/process.ts` 中，`EncodeOutputCheck.expectedFrom` 的类型是 `'main_stream' | 'container'`。T-ENGINE-07 接线时需要把 `stream` 映射为 `main_stream`，或统一改名。
3. **硬件编码器按分辨率调整的方向。** design 写的是「≤720 减 2，>1440 加 2」，这是针对「数值越小画质越高」的 CQ 类参数写的。MF 的 quality 是数值越大画质越高，所以按「画质方向」处理：方向由该行自己的三档顺序判定（画质优先的值即更好的方向），MF 在 ≤720 时加 2。这项调整只用于硬件编码，不用于 MF 软件编码与 kvazaar。AMF 的方向 design 写明待确认，目前沿用参数表的方向。
4. **HEVC 8-bit 参数行。** design 只写了 Main10 的参数行，并注明「否则 8-bit + yuv420p/nv12」。8-bit 行按此写成 `-profile:v main`，像素格式按 §4 的表取：NVENC 为 yuv420p，QSV/AMF 为 nv12。
5. **像素格式。** 参数表中的 `-pix_fmt`（§3）与滤镜链末尾的 `format=`（§4）两处都写，二者取自同一个值。
6. **CPU 编码器的可用规则。** 能力探测不测试 libsvtav1、libkvazaar、libopenh264，所以只要能力表没有把它们标为 `false`、本会话也没有降级，就视为可用。这条规则已写入 `PlannerCapabilities` 的注释。T-ENGINE-03 如果根据 `-encoders` 发现缺失，应把对应变体标为 `false`。
7. **`defaultCompressCodec` 不计已降级的编码器。** 这与降级链的「本会话未降级」一致。`*_mf` 的 `8bit_sw` 不算硬件编码。
8. **显卡 AV1 回退的提示。** 用 `encoder_fallback`，带 `to: 'libsvtav1'`，不带 `from`，因为没有编码器失败，只是没有可用的。界面的 i18n 需要处理缺少 `from` 的情况。
9. **HDR 的 10-bit 前置条件。** HDR 源分两轮选择：先只考虑 10-bit 配置，找不到再按普通顺序。色调映射、`hdr_tonemapped`、杜比视界的拒绝与去 RPU 都属于 T-ENCODE-03；在那之前，HDR 源落到 8-bit 编码器时还不会做色调映射。
10. **设计未写明的取值。**
    - openh264 码率有下限 32 kbit/s，避免源码率极低时请求过低的码率。
    - 尺寸未知时，openh264 按 1920×1080 计算码率。
    - 帧率未知时，GOP 与 openh264 码率按 30 fps 计算，但 `EncodeSpec.frame.fps` 保持 null，让输出上限沿用 caps.ts 中更宽松的 60 fps。
    - 尺寸未知（0×0）时不缩放，并跳过需要尺寸的 NVENC 与 kvazaar。
11. **低占用模式。** 这是运行时的队列选项，所以放在 `FfmpegIo.lowUsage` 中，由 `videoArgs` 追加参数。T-ENGINE-07 需要在 io 中传入它。
12. **`probeArgs` 的约定。** 使用 `PROBE_PICTURE`（1280×720、30 fps）和均衡档；参数带流说明符 `:v:0`，并包含 `-filter:v:0 format=<像素格式>`。T-ENGINE-03 的 lavfi 输入应使用 `PROBE_PICTURE`，候选配置用 `encoderVariants()` 枚举。

**风险**

- **openh264 的档位可能并档。** 源视频码率较低时，0.7 × 源码率会同时卡住画质与均衡两档。例如 1080p30、6 Mbit/s 的源，三档码率为 4.2M、4.2M、4.04M，「严格递减」无法成立。V-ENCODE-02-2 用的是高码率的 lavfi 源，不会触发这种情况。这是 design 公式本身的问题，建议在 T-ENCODE-05 校准时处理，例如按档位使用不同系数。
- **openh264 的码率控制不精确。** 每次 openh264 编码都会在 `level+warning` 日志中输出「bitrate can't be controlled … without enabling skip frame」。这不是禁止出现的模式。没有加 `-allow_skip_frames`，因为跳帧会丢帧，影响时长与帧数判定。
- **MF 的 quality 刻度非线性。** 2 s 小样中，h264_mf 硬件编码画质档（82）为 2.73 MB，均衡档（72）为 0.57 MB，相差约 4.8 倍；软件编码均衡档为 1.43 MB。需要在 T-ENCODE-05 用真实样片校准。
- **QSV/AMF 无法在本机验证。** 本机没有这些设备，它们的参数只有快照测试。能力探测会用这些生产参数实测，参数被拒绝的编码器会被跳过（engine design §3）。
- **真实编码测试的「必需」判定。** 测试把「存在 nvcuda.dll」视为 NVENC 必需。如果某台机器装有 NVIDIA 驱动，但显卡不支持 NVENC，测试会失败而不是跳过。设 `FUSIONKIT_MEDIA_REQUIRE_ENCODERS=all` 时，所有配置都是必需项。
- **回归运行了其他任务的测试文件。** 补充回归中运行了 queue.test.ts（属于其他任务，正在并行开发）。它按自己的策略清理过期的 `queue-*` 运行目录：不清理一小时内的目录，并保留最新的一个。本任务没有删除 `test-results` 下的其他任何内容。

**评审新增：与设计的差异**（未修改设计文档）

13. **硬件编码器的尺寸范围。**
    - design §3 与 AC-ENCODE-02-2 只写了「NVENC 宽 ≥ 144、高 ≥ 120」，engine design §3 称其为实测值。
    - 但本机实测 h264_nvenc 的下限是 145×49，144 宽打不开；NVENC 还有上限：H.264 每边 4096，HEVC/AV1 每边 8192。
    - 现在的规则：
      - NVENC 只按每种编码的实测范围判定（批次 B 修正评审后不再叠加 `caps.nvencMin`）；
      - MF 硬件模式按同一范围。NVIDIA 显卡上 MF 就是 NVENC，实测拒绝的尺寸完全一致；其他厂商的 MF 未实测，这样做偏保守，结果只是把极小或极大的画面交给 CPU 编码器；
      - openh264 加面积上限。
    - QSV/AMF 未实测，不加限制。
    - 建议：design §3 与 engine design §3 改写为按编码分开的范围；T-ENGINE-03 产出 `nvencMin` 时以此为准。

**评审新增：超出写集、未修复的问题**

- **旋转标签与 ffmpeg 不一致（建议 T-ENGINE-01/T-ENCODE-03 处理）。**
  - `engine/probe.ts` 的 `rotationOf` 在没有 Display Matrix 时，读取 `rotate` 标签，且不区分大小写，所以 Matroska 的 `ROTATE` 也会被读到。
  - 但 ffmpeg 8 的 autorotate 只认 Display Matrix。本机实测：带 `ROTATE=90` 标签的 MKV 重新编码后仍是 64×32，没有旋转。
  - 规划器因此会按转置后的宽高缩放：只要有分辨率上限或需要取整，就会加上 `scale`，输出被拉伸变形。
  - V-ENCODE-03-2 的旋转实测应包含「只有标签」的情况。
- **超大尺寸被误判为无设备（建议 T-ENGINE-03/07 注意）。**
  - NVENC 遇到超过上限的画面时，stderr 是「Width N exceeds 4096」，后接「No capable devices found」。
  - engine design §3 的分类表会把后者判为 `no_device`。
  - 规划器现在已经不会给出这种尺寸，但能力探测或执行器的分类仍应先识别尺寸原因。
- **输出上限与 MF 画质值（建议 T-ENCODE-04/05 处理）。**
  - `caps.ts` 对重新编码的视频按 0.15 bpp 估算上限，下限为源体积。
  - MF 在画质档（≤720 时为 82）的码率非常高：2 s、360p 的噪声小样达到 10.9 Mbit/s，约 1.6 bpp。
  - 转换任务（`output_cap_exceeded` 语义）遇到高度压缩的源时，可能触顶失败。需要在校准时一并评估。
- **`PlannerCapabilities.nvencMin` 已不再使用（批次 B 修正评审，建议 T-ENGINE-03 与 engine design 处理）。**
  - engine design §3 仍写「NVENC 最小宽高 144×120」，并要求能力探测产出它。规划器按 AC-ENCODE-02-2 只用 `VIDEO_TABLE.hardwareFrame`。
  - 建议 engine design §3 改为引用该表，T-ENGINE-03 不再产出这个字段，或删除它。删除需要同时修改 queue.test.ts、remux-real.test.ts 等其他任务的测试，不在本任务写集内。
- **QSV/AMF 的尺寸范围未知。** 遇到极小或极大的画面时，这两类编码器仍可能打不开，并在本会话被降级，需要在对应设备上实测。

**未执行**：

- 没有启动 Electron。
- 没有运行全量测试。
- 校准（A-07 样片）属于 T-ENCODE-05。
