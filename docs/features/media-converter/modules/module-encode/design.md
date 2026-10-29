# encode 设计

§1–§7 是当前增量 I1 的详细设计。§8–§10 是 I2/I3 的设计草案：给出方法与参数方向，进入对应批次前要复核，并补齐 AC 与任务。

参数表中的数值都是**初值**，来源有两类：

- 公开资料：HandBrake 内置预设、SVT-AV1 文档、ab-av1、ffmpeg wiki；
- 本机实测：合成素材实验与评审时的逐项验证（见 [discovery.md](../../discovery.md) 与 [records/spec-review-2026-10-26.md](../../records/spec-review-2026-10-26.md)）。

T-ENCODE-05 会用真实样片校准这些值。

## 现状与约束

**可用的编码器。** 只能使用随附的 Windows LGPL ffmpeg 8.1.2 中**实测可用**的编码器：

- 没有 x264、x265、fdk-aac；
- `libkvazaar` 只支持 8-bit，宽高必须是 8 的倍数，参数用逗号分隔；
- `libopenh264` 没有 CRF，也没有 10-bit；
- SVT-AV1 为 v4.1.0。

**本机实测得到的约束：**

- SVT-AV1 preset 6 是速度与压缩率的拐点。
- CRF 的效果随 preset 变化。
- 10-bit 输出比 8-bit 更小。
- SVT 只能通过 `-pass 1/2` 做 2-pass，误差约 ±5%。
- SVT 在随机访问模式下不支持 CBR。
- NVENC 在 CQ 模式下开 AQ，码率会膨胀。
- `-color_*` 输出参数会被 libsvtav1 丢弃，必须用 `setparams`。
- HDR10 静态元数据在重新编码时会被编码器自动保留。
- hevc_nvenc 的 `-tune uhq` 只接受不设 `-bf`、`-bf 4` 或 `-bf 5`。
- MF 硬件编码器只接受 nv12 输入。h264_mf 默认输出 Constrained Baseline，用 `-profile:v 100` 才能得到 High（命名形式 `high` 不被接受）。
- NVENC 的最小宽约 144。
- 只有每条流使用自己的 `-filter:a:N` 时，每条音轨才能有独立的滤镜链。

**输入与输出：**

- 输入：`MediaInfo`（来自 engine，定义在 `src/media-converter/contract.ts`）、`ConversionSettings`（来自 workbench）、`PlannerCapabilities`（本模块在 `plan/types.ts` 中定义，由 engine 产出）。
- 输出：`ConversionPlan`。

## 方案与取舍

### 1. 数据模型

```ts
type ConversionSettings =
  | { task: 'compress'; tier: Tier; codec: 'av1'|'hevc'|'h264'; container: 'auto'|'mp4'|'mkv';
      maxShortSide: null|2160|1440|1080|720|480; useGpuForAv1: boolean; discardIfNotSmaller: boolean }
  | { task: 'convert'; target: VideoContainer|AudioFormat; preferRemux: boolean; tier: Tier }
  | { task: 'extract-audio'; format: 'copy'|AudioFormat; tier: Tier; allTracks: boolean };
// 默认值：compress = {balanced, defaultCompressCodec(caps), auto, null, false, true}；convert = {mp4, true, balanced}；extract = {copy, balanced, false}
// defaultCompressCodec(caps)：有任一可用的 HEVC 硬件编码器（nvenc/qsv/amf/mf 硬件）→ 'hevc'；否则 → 'h264'（Q-01 选项 B）

type PlannerCapabilities = {
  encoders: Record<EncoderId, { variants: Record<VariantKey, boolean>; uhq?: boolean }>;
  degraded: EncoderId[]; nvencMin: { width: 144; height: 120 };
};

type ConversionPlan = {
  outputs: PlannedOutput[];          // 通常 1 个；「全部音轨」时每条音轨 1 个
  summary: PlanSummary;              // 编码器友好名、流处理方式、丢失内容、警告、是否需要确认
  isRemuxOnly: boolean;
};
type PlannedOutput = {
  streams: StreamDecision[];         // copy | encode{encoder, variant, params} | drop{reason}
  container: { muxer, extension, baseName, faststart };
  capBytes: number; capSemantics: 'not_smaller'|'output_cap_exceeded';
  expectedDurationUs: number|null;   // 成功判定用，取主流时长
};
```

- `buildPlan(media, settings, caps)`、`toFfmpegArgs(output, io)`、`probeArgs(encoder, variant)` 都是纯函数，后两者共用同一份参数表。`io = {inputPath, demuxer, partialPath, passLogPrefix?}` 由 engine 在运行时提供。
- 原因码在 `contract.ts` 中是封闭枚举，由 T-ENCODE-01 一次定义：
  - 警告：`cpu_weak_encoder`、`hdr_tonemapped`、`dolby_vision_rpu_dropped`、`chroma_subsampled`、`cover_dropped`、`downmixed_to_stereo`、`subtitle_styling_lost`、`subtitle_dropped`、`attachment_dropped`、`mp4_default_subtitle_forced`、`encoder_fallback`、`output_name_collision`、`duration_unverified`
  - 跳过：`already_target`、`not_smaller`
  - 不适用：`task_not_applicable`、`no_audio_stream`、`no_video_stream`
  - 错误：`no_encoder_available`、`dolby_vision_p5_unsupported`
  - 需确认：`lossy_to_lossless`

### 2. 兼容矩阵与任务矩阵（R-ENCODE-01）

**兼容矩阵**

| 目标容器 | muxer | 视频允许复制 | 音频允许复制 | 字幕 | 其他 |
| --- | --- | --- | --- | --- | --- |
| MP4 | `mp4` | h264、hevc（改为 `hvc1`）、av1 | aac、mp3、ac3、eac3、alac | 文本→`mov_text`；图形→丢弃 | `+faststart`；附件丢弃 |
| MOV | `mov` | h264、hevc（`hvc1`）、prores | aac、alac、pcm_s16le/s24le、ac3、mp3 | 文本→`mov_text`；图形→丢弃 | `+faststart` |
| MKV | `matroska` | 全部 | 全部 | 复制；`mov_text`/`eia_608` 等→`srt` | 附件保留（`-map 0:t?`） |
| WebM | `webm` | vp8、vp9、av1 | opus、vorbis | 文本→`webvtt`；其他→丢弃 | — |

MP4 有意不复制 mpeg4 part 2、mpeg2、vc1、wmv、vp9，这些会转为 H.264。

**源容器标识**（用于判断 `already_target`）由 engine 提供，规则是：

- `major_brand` 为 `qt  ` → mov；
- `isom`、`iso2`、`mp41`、`mp42`、`avc1` → mp4；
- `M4A `、`M4B ` → m4a；
- Matroska 按 DocType 区分 webm 与 matroska；
- 都不满足时，按扩展名判断。

**「转换格式」需要重新编码时的编码选择**（AC-ENCODE-01-7）

| 目标 | 视频 | 音频 |
| --- | --- | --- |
| MP4 | §3 H.264 降级链 | AAC |
| MOV | §3 H.264 降级链；ProRes 可复制 | AAC |
| WebM | libsvtav1 10-bit（§3 AV1 参数表） | Opus |
| MKV | 默认复制；必须重新编码时用 §3 AV1 降级链 | 复制，或 Opus |

**「压缩视频」的容器选择「自动」**：源有带样式、定位或重叠事件的 ASS/SSA，或有图形字幕，或有附件时，选 MKV；否则选 MP4。

**任务矩阵**

见 AC-ENCODE-01-6。「转换为音频格式」作用于视频时，取默认音轨并按 §5 编码；源没有音轨时返回 `no_audio_stream`。

**映射**

```
-map 0:V:0?  -map 0:a:<i>...  -map 0:s:<允许的序号>...  [-map 0:t? 仅 MKV]
-map_metadata 0  -map_chapters 0  -max_muxing_queue_size 4096
```

- 字幕逐条映射，不使用 `0:s?`。
- 处置标记逐流写入：`-disposition:a:N`、`-disposition:s:N`。
- MP4/MOV 的标题写为 `-metadata:s:<type>:<n> handler_name=<title>`。源没有默认字幕时，附 `mp4_default_subtitle_forced`。

**只换封装**

所有流都复制时，`isRemuxOnly=true`，并加 `-avoid_negative_ts make_zero`；源为 AVI 或裸流时，再加 `-fflags +genpts`。

### 3. 视频压缩参数表（R-ENCODE-02，初值）

**通用规则**

- 「分辨率」指输出的短边。
- 软件 AV1 的 CRF 按输出短边分档。硬件编码器以 1080p 的值为基准，输出短边 ≤ 720 时减 2，> 1440 时加 2。
- 每个档位格写三个数，依次对应「画质优先 / 均衡 / 体积优先」。
- GOP：SVT 保持默认 keyint（约 5 s）。其他编码器显式设置 `-g round(5 × fps)`；kvazaar 的 `period` 取最接近 5 × fps 的 16 的倍数。

**AV1：libsvtav1**

```
-c:v libsvtav1 -preset 6 -crf {C} -pix_fmt yuv420p10le [-svtav1-params lp=1  （仅低占用模式）]
```

| 档位 | ≤480 | ≤720 | ≤1080 | ≤1440 | >1440 |
| --- | --- | --- | --- | --- | --- |
| 画质优先 | 24 | 26 | 28 | 29 | 30 |
| 均衡 | 28 | 30 | 32 | 33 | 34 |
| 体积优先 | 34 | 36 | 38 | 39 | 40 |

tune 保持默认（1 = PSNR）。本机实验中 `tune=0` 没有提高 VMAF，校准时再做 A/B 对比。

**AV1：硬件编码器**（需打开「使用显卡加速」）

| 编码器 | 参数 | 画质 / 均衡 / 体积 |
| --- | --- | --- |
| av1_nvenc | `-preset p7 -tune {uhq\|hq} -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -g {G} -pix_fmt p010le`（不开 AQ；10-bit 输入，不用 `-highbitdepth`） | 30 / 34 / 38 |
| av1_qsv | `-preset veryslow -global_quality {Q} -extbrc 1 -look_ahead_depth 40 -g {G} -pix_fmt p010le` | 暂定 26 / 30 / 34（待 Intel 校准） |
| av1_amf | `-usage high_quality -quality quality -rc qvbr -qvbr_quality_level {Q} -preanalysis 1 -align 1080p -g {G} -pix_fmt p010le` | 暂定 22 / 26 / 30（数值越低画质越高，待 AMD 设备确认方向） |

**HEVC**（输出带 `-tag:v hvc1`；10-bit 实测可用时为 Main10 + p010le，否则 8-bit + yuv420p/nv12）

| 编码器 | 参数 | 画质 / 均衡 / 体积 |
| --- | --- | --- |
| hevc_nvenc（uhq） | `-preset p7 -tune uhq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -b_ref_mode middle -g {G} -profile:v main10 -pix_fmt p010le`（**不设 `-bf`**） | 24 / 27 / 30 |
| hevc_nvenc（hq） | `-preset p7 -tune hq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -bf 3 -b_ref_mode middle -g {G} -profile:v main10 -pix_fmt p010le` | 24 / 27 / 30 |
| hevc_qsv | `-preset veryslow -global_quality {Q} -extbrc 1 -look_ahead_depth 40 -g {G} -profile:v main10 -pix_fmt p010le` | 暂定 23 / 26 / 29（待 Intel 校准） |
| hevc_amf | `-usage high_quality -quality quality -rc qvbr -qvbr_quality_level {Q} -preanalysis 1 -g {G} -profile:v main10 -pix_fmt p010le` | 暂定 20 / 23 / 26（方向待 AMD 设备确认） |
| hevc_mf（硬件） | `-hw_encoding 1 -rate_control quality -quality {Q} -g {G} -pix_fmt nv12`（8-bit） | 80 / 70 / 60 |
| libkvazaar | `-kvazaar-params preset=medium,qp={Q},period={P} -pix_fmt yuv420p`（逗号分隔；宽高为 8 的倍数） | 20 / 23 / 26 |

`uhq` 是否可用以能力表为准，可用就选 uhq 行，否则选 hq 行。

**H.264**（8-bit，High profile）

| 编码器 | 参数 | 画质 / 均衡 / 体积 |
| --- | --- | --- |
| h264_nvenc | `-preset p7 -tune hq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -bf 3 -b_ref_mode middle -g {G} -profile:v high -pix_fmt yuv420p` | 21 / 24 / 27 |
| h264_qsv | `-preset veryslow -global_quality {Q} -look_ahead 1 -look_ahead_depth 40 -g {G} -profile:v high -pix_fmt nv12` | 暂定 21 / 24 / 27（待 Intel 校准） |
| h264_amf | `-usage high_quality -quality quality -rc qvbr -qvbr_quality_level {Q} -preanalysis 1 -g {G} -profile:v high -pix_fmt nv12` | 暂定 20 / 23 / 26（方向待 AMD 设备确认） |
| h264_mf（硬件） | `-hw_encoding 1 -rate_control quality -quality {Q} -profile:v 100 -g {G} -pix_fmt nv12` | 80 / 70 / 60 |
| h264_mf（软件） | `-rate_control quality -quality {Q} -profile:v 100 -g {G} -pix_fmt nv12` | 80 / 70 / 60 |
| libopenh264 | `-profile:v high -coder cabac -rc_mode bitrate -b:v {B} -g {G} -pix_fmt yuv420p` | B = min(bpp × 宽 × 高 × fps, 0.7 × 源视频码率)，bpp 为 0.12 / 0.09 / 0.065 |

**默认编码（Q-01 选项 B，2026-10-26 用户决定）**

「压缩视频」默认用 HEVC。前提是本机有可用的 HEVC 硬件编码器，这时编码快，苹果设备都能播放，体积约为 H.264 的 60%–70%。没有 HEVC 硬件编码器时默认用 H.264。AV1 体积最小，作为「最小体积」选项，由用户主动选择。规则见 AC-ENCODE-02-7。

**降级链**

- AV1：关闭显卡加速时用 libsvtav1。打开时依次尝试 av1_nvenc → av1_qsv → av1_amf，都不可用则回到 libsvtav1，并附提示。
- HEVC：hevc_nvenc → hevc_qsv → hevc_amf → hevc_mf（硬件）→ libkvazaar。
- H.264：h264_nvenc → h264_qsv → h264_amf → h264_mf（硬件）→ h264_mf（软件）→ libopenh264。

链上的编码器还要同时满足：

- 能力表中该编码器的对应变体可用（例如 HEVC 10-bit），且未被降级；
- 满足尺寸前置条件：NVENC 宽 ≥ 144、高 ≥ 120；kvazaar 宽高能向下取整到 8 的倍数，且损失不超过 7 px；
- 需要保留 HDR 时，10-bit 变体可用。不满足则改为色调映射（见 §4）。

落到 libkvazaar、mf（软件）、libopenh264 时，附 `cpu_weak_encoder`。

**取舍**

- H.264/HEVC 以硬件编码为主：没有 x264/x265 时，CPU 上的这两种编码明显不如 SVT-AV1。
- AV1 默认用软件编码：NVENC AV1 要达到同等 VMAF，约需 2 倍码率。
- QSV/AMF 的参数无法在本机验证。但能力探测用的就是这些生产参数，参数被拒的编码器会被跳过，所以不会导致任务失败。

### 4. 视频滤镜与正确性（R-ENCODE-02/03）

**滤镜链顺序**（只加需要的部分）：

```
[bwdif=mode=send_frame:parity=auto:deint=interlaced]                    ← 场序为 tt/bb/tb/bt
→ [HDR→SDR：zscale=t=linear:npl=100{:tin/pin/min 缺标记时显式给出},format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv]
→ [scale=w={W}:h={H}:flags=lanczos+accurate_rnd+full_chroma_int{:in_range=pc:out_range=tv}]   ← 缩放、奇数宽高修正，或源为 pc
→ format={按编码器的像素格式表}
→ setparams=color_primaries={p}:color_trc={t}:colorspace={m}:range=tv
```

**编码器 → 链末像素格式**

| 编码器 | 8-bit | 10-bit |
| --- | --- | --- |
| libsvtav1 | — | yuv420p10le |
| nvenc / qsv / amf | yuv420p 或 nv12（见参数表） | p010le |
| *_mf | nv12 | 不使用（10-bit 判为 `params_rejected`） |
| libkvazaar、libopenh264 | yuv420p | — |

**规则**

- **全范围源**：源为 `pc` 或 `yuvj*` 时，无论是否缩放，都加 `scale=in_range=pc:out_range=tv`。有缩放时合并到同一个 scale。
- **旋转**：ffmpeg 默认开启 autorotate，软件解码时自动转置并去掉显示矩阵。规划器只用旋转角计算缩放后的宽高。只换封装时保留显示矩阵。
- **色彩标记**：源有标记就照抄；没有时，短边 < 720 用 `smpte170m`，否则用 `bt709`。HDR 色调映射时，若源缺少标记，zscale 要显式给出 `tin/pin/min`。
- **HDR 判定**

  | 源 | 目标 | 处理 |
  | --- | --- | --- |
  | HDR10 / HLG | AV1，或 HEVC 10-bit 可用 | 保留：10-bit 链，BT.2020 + PQ/HLG 标记；MDCV/CLL 由编码器自动写入 |
  | HDR10 / HLG | H.264，或 HEVC 只能 8-bit | 色调映射为 SDR BT.709，附 `hdr_tonemapped` |
  | 杜比视界 P5，或兼容 id 为 0 | 任意重新编码 | 拒绝：`dolby_vision_p5_unsupported` |
  | 杜比视界 P7/P8 | 任意重新编码 | 按基础层处理；libsvtav1 加 `-dolbyvision 0`；附 `dolby_vision_rpu_dropped` |

- **VFR**：`isVfr` 为真时加 `-fps_mode passthrough`。
- **4:2:2 / 4:4:4**：由 `format` 转为 4:2:0，附 `chroma_subsampled`。
- **奇数宽高**：用 `scale=trunc(iw/2)*2:trunc(ih/2)*2` 修正；kvazaar 用 `/8`。

### 5. 音频（R-ENCODE-04/05）

**纯音频输出**

档位依次为「高 / 标准 / 小」，括号内是单声道取值。

| 格式 | 编码与参数 | 高 | 标准 | 小 | muxer | 扩展名 |
| --- | --- | --- | --- | --- | --- | --- |
| MP3 | `libmp3lame -q:a {V} -id3v2_version 3 -write_id3v1 0` | V0 | V2 | V5 | `mp3` | .mp3 |
| M4A（AAC） | `aac -b:a {B}` | 256k（128k） | 192k（96k） | 128k（64k） | `ipod` | .m4a |
| Opus | `libopus -b:a {B} -vbr on -compression_level 10` | 160k（96k） | 128k（64k） | 96k（48k） | `opus` | .opus |
| FLAC | `flac -compression_level {L}` | 5 | 5 | 8 | `flac` | .flac |
| WAV | `pcm_s16le/s24le/s32le/f32le`（按源位深） | — | — | — | `wav`（`-rf64 auto`） | .wav |
| ALAC | `alac`（按源位深） | — | — | — | `ipod` | .m4a |

- **封面**：MP3、M4A、FLAC 的源有 `attached_pic` 时，加 `-map 0:v:{封面序号} -c:v copy -disposition:v attached_pic`。Opus/OGG 在 I1 不写封面，附 `cover_dropped`。
- **标签**：标签型输出（MP3、FLAC、Opus）加 `-metadata major_brand= -metadata minor_version= -metadata compatible_brands=`，避免把源容器的品牌标签复制进去。M4A 只保证用户标签与封面；它自身的 ftyp 品牌是正常的。不设置 `encoder` 标签，接受封装器写入的默认值。
- **声道（libopus 标准布局表）**

  | 声道数 | 标准布局 | 需要处理的源布局 |
  | --- | --- | --- |
  | 1 | mono | — |
  | 2 | stereo | — |
  | 3 | 3.0 | 2.1 → 用 `aformat=channel_layouts=3.0` 重混 |
  | 4 | quad | quad(side)、4.0 → 重混 |
  | 5 | 5.0 | 5.0(side) → `channelmap` 改标签 |
  | 6 | 5.1 | 5.1(side) → `channelmap` 改标签 |
  | 7 | 6.1 | 6.1(back/front) → 重混 |
  | 8 | 7.1 | 7.1(wide) 等 → 重混 |
  | > 8 | — | 下混到 7.1 |

  AAC 不改布局。MP3 输出加 `-ac 2`，附 `downmixed_to_stereo`。
- **采样率**：Opus 用 `aresample=48000`。AAC 的源高于 48 kHz 时，用 `aresample=resampler=soxr:precision=28:osr=48000`。
- **滤镜链**：每条输出音轨有自己的 `-filter:a:<n> <a>,<b>,...`，不用 `-af`。
- **位深**：WAV/ALAC/FLAC 按源的 `sample_fmt` 与 `bits_per_raw_sample` 选择，不降位深。

**提取音频**

- `format=copy` 时，按 AC-ENCODE-04-2 的映射表选择 `-c:a copy` 或无损转换；大端 PCM 用 `aiff` 封装。
- 选择「全部音轨」时，每条音轨生成一个 `PlannedOutput`，基础名为 `{原名}.track{n}[.{lang}]`。
- 其他输出格式（MP3/M4A/Opus/FLAC/WAV/ALAC）按上面的纯音频表处理。

**视频内音频**

| 容器 | 编码 | 立体声 画质/均衡/体积 | 5.1 | 单声道 |
| --- | --- | --- | --- | --- |
| MP4、MOV | `aac` | 192k / 160k / 128k | 384k / 320k / 256k | 立体声的一半 |
| MKV、WebM | `libopus` | 128k / 96k / 80k | 320k / 256k / 192k | 立体声的一半 |

- **直通条件**：转换任务只看编码是否兼容；压缩任务还要求「码率（流码率 → `tags.BPS`）≤ 档位码率 × 1.25」，码率未知视为不满足。
- **总是重新编码**：压缩任务中的 FLAC、PCM、TrueHD、DTS。

**取舍**：简单模式下，MP4 中的音频一律用 AAC（A-06）。Opus 只用在 MKV/WebM 中，或由用户在高级设置中选择。

### 6. 输出命名

| 任务 | 基础名 | 扩展名 |
| --- | --- | --- |
| 压缩视频 | `{原名}-compressed` | 由容器决定（.mp4 / .mkv） |
| 转换格式 | `{原名}`；输出到源文件旁且扩展名与源相同时为 `{原名}-converted` | 目标格式 |
| 提取音频 | `{原名}`；全部音轨时为 `{原名}.track{n}[.{lang}]` | 见 §5 |

**清洗规则**

- 去掉 Windows 非法字符，以及末尾的点和空格；
- 去掉双向控制字符（U+200E/F、U+202A–E、U+2066–9）；
- 主名是保留设备名（CON、NUL、COM1 等）时加前缀 `_`；
- `{lang}` 只接受 `^[a-z]{2,3}$`，否则省略；
- 按码点截断，使完整路径不超过 240 字符；如果目录本身已使截断后的名称少于 16 字符，返回 `output_path_too_long`。

**冲突编号**由 engine 处理，形如 `名称 (n).ext`。

### 7. 「不变大」、无意义转换与输出上限（R-ENCODE-06）

**压缩任务（开启不变大保护）**

- `capBytes` 为源体积 × 0.98，`capSemantics` 为 `not_smaller`。
- engine 在触顶，或完成后体积达到上限时，记为 `skipped{not_smaller}`。

**转换任务**

- 满足 AC-ENCODE-06-2 的两个条件时，`buildPlan` 直接返回 `skip{already_target}`。
- 音频转换同理：编码与封装都相同时跳过；只有封装不同时只换封装。

**其他情况的 `capBytes`**（`capSemantics` 为 `output_cap_exceeded`）

| 情况 | 上限 |
| --- | --- |
| 只换封装 | 源体积 × 1.05 + 16 MB |
| 重新编码的视频 | max(源体积, (bpp 0.15 × 像素速率 + 音频码率) × 时长 × 1.05) |
| 有损音频 | 码率上限 × 时长 × 1.2 |
| WAV | 采样率 × 声道 × 字节数 × 时长 × 1.01 |
| FLAC | 同上 × 0.85 |
| ALAC | 同上 × 0.9 |

时长未知时，用源体积 × 4 作为宽松上限，并附 `duration_unverified`。

### 7a. 实施中确认的调整（I1 批次 A，2026-10-26）

本节记录 T-ENCODE-01 实现时对设计的调整，依据见 `records/i1/T-ENCODE-01.md`。

**流映射与标记**

- 流按绝对序号映射（`-map 0:<index>`），主视频取 `MediaInfo.primaryVideoIndex`，不用 `0:V:0`。这样可以避开排在主视频前面、帧率为 0/0 的静态图片流。
- 处置标记写成相对源的增减，例如 `+default-forced`，避免抹掉 commentary、visual_impaired、original 等探测没有报告的标记。

**新增原因码**

- `mp4_default_audio_forced`：源没有默认音轨时，MP4 会自动启用第一条音轨，与字幕的处理方式相同。
- `chapters_dropped`：用于 AC-ENCODE-04-3 的开始前提示。

**视频输出的封面与附带流**

- 视频输出一律丢弃封面，并附 `cover_dropped`。matroska 会把 `attached_pic` 写成一帧的视频轨，所以不保留。
- 数据流和非主视频流直接丢弃，不加警告。MP4 的章节轨、iPhone 的 mebx 轨很常见，如果加警告，几乎每个文件都会触发开始前确认。

**输出上限**

- 所有 `output_cap_exceeded` 公式都附加 16 MiB 余量，用于容纳封面、字体和标签。
- 复制的纯音频输出，按 32 位 PCM 估算上限，且不超过源体积 × 1.05。
- 封面按 宽 × 高 × 8 字节估算。

**命名与跳过判定**

- 提取音频的输出名如果与源文件同名，追加 `-converted`。
- `already_target` 额外要求源文件与目标的扩展名相同，因此 .m4v、.m4b 不会被跳过。只要有任何一条流需要编码（包括字幕格式转换），就不跳过。
- `isRemuxOnly` 表示没有音频、视频或封面需要编码；文本字幕的格式转换仍算作重封装。

**由 T-ENCODE-02 及之后的任务处理**

- 字幕编码器 id 由 `srt` 改为 `subrip`（`srt` 是已弃用的别名）。
- 在 `PlannedOutput` 上记录 `expectedFrom`（取值为 stream 或 container），供 executor 判定时长。
- 视频与音频的编码参数目前是占位，由 T-ENCODE-02 到 T-ENCODE-04 补全。
- 判断 VFR 时，若场序为隔行，且 r_frame_rate 约等于 avg_frame_rate 的 2 倍，视为恒定帧率，不加 passthrough，也不在摘要中写 VFR（由 T-ENCODE-03 在规划端判定）。

### 7b. 批次 B 的实测纠正（2026-10-26）

详见 [changes/2026-10-26-batch-b-spec-corrections.md](../../changes/2026-10-26-batch-b-spec-corrections.md)。

**尺寸范围**

表中的 NVENC 尺寸范围替代 §3 中「宽 ≥ 144、高 ≥ 120」的写法：

| 编码器 | 宽 | 高 | 每边上限 |
| --- | --- | --- | --- |
| H.264 | 145–4096 | ≥ 49 | 4096 |
| HEVC | ≥ 129 | ≥ 33 | 8192 |
| AV1 | ≥ 129 | ≥ 65 | 8192 |

MF 硬件编码器沿用 NVENC 的范围；libopenh264 的画面面积不超过 4096×2304。上述范围以 `VIDEO_TABLE.hardwareFrame` 为准，由能力探测提供 `nvencMin`。

NVENC 因尺寸超限拒绝编码时，stderr 同样输出「No capable devices found」。T-ENGINE-03 与 T-ENGINE-07 应先检查尺寸相关的原因（`exceeds`、`less than the minimum`），再将其归类为 `no_device`。

**色彩推定**

源未标记色彩时：宽 ≥ 1280 或高 > 576 推定为 BT.709，否则推定为 BT.601。

**输出上限**

重新编码视频时，上限为 max(源体积 × 4, 1.0 bpp × 像素速率 × 时长) × 1.05 + 16 MiB。

**同编码转换**

只有目标码率不低于源码率时才直接复制；低于源码率时重新编码。

**声道布局**

- ALAC 不支持的布局，重混到最接近的 ALAC 布局。
- Opus 的 7.1(wide) 用 channelmap 改标签。
- AAC 遇到 5.0(side)、5.1(side)、7.1(wide) 时改标签为标准布局，样本本身不重混。

**MKV**

matroska 封装器拒收的音频编码：转换时转为 Opus，提取时解码为 WAV。

**位深**

FLAC 和 ALAC 不使用实验性选项时，位深最高 24 bit。32 位整数源与浮点源因此会输出为 24 bit。

**修正中确认的解释（2026-10-28）**

- **同编码转换的码率比较。** 源码率依次取流码率、`tags.BPS`；只有当文件里只有这一条音轨、且没有封面时，才取容器总码率。比较时乘以 1.05 的测量余量（`AUDIO_TABLE.sameCodecMargin`），因为实测码率通常比标称值高 0.03%–2%。MP3 的标称码率取 LAME 的平均值 245 / 190 / 130 kbit/s。源码率完全未知时直接复制。内容相关的 VBR 漂移不在覆盖范围内：例如平均 200–220 kbit/s 的 V2 文件转「标准」档，仍会重新编码，体积相近。
- **ALAC 最近布局。** 取能容纳所有源声道的最小 ALAC 布局，因此声道数可能增加：quad→5.0、2.1→5.1、4.1→6.1(back)。没有合适布局时（7.1、7.0、含高度声道、超过 8 声道），用声道数相同的 ALAC 布局，由 swresample 混音。
- **高度声道。** swresample 没有顶部后置声道（TBL/TBR）的混音规则，所以 5.1.4、7.1.4 下混或重混时这两个声道会丢失；顶部前置声道以 0.707 并入 FL/FR。I1 接受这个限制；以后如需保留，再生成 pan 矩阵。
- **输出上限的视频项。** 在像素项上再加音频码率，只会放宽上限。MF 编码器在「画质优先」档实测约 1.6 bpp，超过 1.0 bpp 的像素项；高压缩源由「源体积 × 4」兜底，T-ENCODE-05 再校准。
- **`PlannerCapabilities.nvencMin`。** 规划器已不再读取，尺寸范围以 `VIDEO_TABLE.hardwareFrame` 为准。
- **BT.601 推定。** 一律写 smpte170m。mpv 对 576/288 行的画面推定为 bt470bg 原色，两者矩阵相同。I1 不区分，留给 T-ENCODE-05 用真实样片评估。

**执行器容忍的警告**

以下警告不视为失败，T-ENGINE-07 应予容忍：

- yuvj 的 `deprecated pixel format`；
- ipod 封装器对 .partial 扩展名的提示；
- aac 的 `Too many bits … clamping`；
- `Guessed Channel Layout`。

**批次 C 修正（2026-10-28）**

- **裸 H.264/HEVC 不再只换封装，改为重新编码。** 这条修正替代 §2「只换封装」中「源为裸流时加 `-fflags +genpts`」的写法。
  - 现象：随附 ffmpeg 8.1.2 读取裸 H.264/HEVC（解复用器 `h264`、`hevc`）时，数据包没有任何时间戳，复制后无法补齐。MP4 会写入猜测的时间戳并发出警告，有 B 帧时没有显示时间；Matroska 直接拒收（`Can't write packet with unknown timestamp`）。进度中的 `out_time` 一直是 `N/A`，执行器因此判为 `encode_failed`。
  - 已实测无效的做法：`-fflags +genpts`；在输入前加 `-r` 或 `-framerate`；`setts` 码流过滤器（只会产生不单调的时间戳）。
  - 现在的规划：源的解复用器为 `h264` 或 `hevc` 时，视频一律重新编码。即使开启「优先只换封装」也是如此，编码选择按 §2 的转换表（MP4/MOV 用 H.264 降级链，MKV/WebM 用 AV1）。解码会给每帧时间：H.264 没有 VUI 计时信息时按 25 fps，有时按 VUI 的帧率。实测转为 MP4、MKV 以及压缩时，帧数与时长都与源一致，含 B 帧重排的 kvazaar HEVC。
  - `-fflags +genpts` 只保留给 AVI 与裸 MPEG-1/2（`mpegvideo`）。后者的解析器会给出 dts，+genpts 再补齐 B 帧的 pts；实测复制到 MKV 后逐帧一致。MPEG-2 不能复制进 MP4，本来就会重新编码。
  - 其他裸视频流的解复用器（`m4v`、`obu`、`vvc`）不在探测白名单中，这类文件在探测阶段就被拒绝，代码为 `container_not_allowed`。
  - 依据见 `records/i1/T-ENCODE-01.md` 的「批次 C 修正」。

### 8. I2 设计草案：画质目标搜索（R-ENCODE-08/09）

本方案参照 ab-av1 的 `crf-search` 与 Av1an 的 target quality，并结合本机实测的开销做了调整。

**采样**

- 片段长度 L = 8 s，片段数 n = clamp(ceil(时长 × 4% ÷ L), 3, 12)。
- n × L ≥ 时长的 50% 时，不切片，直接用整个文件。
- 片段均匀分布在 5%–95% 区间。
- 用 `-ss T -i src -t L -map 0:V:0 -c copy -an -sn` 无损切成 MKV，起点落在关键帧。参考与压缩都基于这份切片。
- 切片和压缩后的样片都保留，供 I2 的「播放样片对比」使用。

**评分（单点 S(q)）**

1. 用与正式编码相同的编码器、preset 与滤镜，以参数 q 编码每个片段。
2. 参考路径先套用与编码相同的非压缩性处理（bwdif、裁剪、色调映射）。
3. 确定评分分辨率：参考短边 ≥ 1080 时，用参考自身分辨率；否则两路都用 bicubic 升到 1080p。压缩路径缩放到评分分辨率。
4. 两路都加 `format=yuv420p10le,setpts=PTS-STARTPTS`。
5. 按评分分辨率选模型：短边 ≤ 1440 用 `vmaf_v0.6.1`，否则用 `vmaf_4k_v0.6.1`。参数：`n_threads=min(8, 核数)`，`n_subsample=5`。
6. 多输入滤镜图通过带标签的 `-/filter_complex` 文件传入。
7. 每段取均值与第 5 百分位（p5）。总分为按时长加权的均值。
8. 保护：任一片段的 p5 < 目标 − 5 时，判为不达标。

**目标分数（初值）**

| 档位 | 目标 |
| --- | --- |
| 画质优先 | 96 |
| 均衡 | 94 |
| 体积优先 | 91 |

高级设置中可调，范围 80–99。

**搜索**

- 在参数区间内，找满足 S(q) ≥ 目标的最大 q。区间：SVT 的 CRF 为 18–50，NVENC 的 CQ 为 18–42。
- 起点是档位初值。
- 只有一侧边界时，步长 ±6；有两侧边界时，按 VMAF 线性插值。
- 最多 6 次。分数落在 [目标, 目标 + 0.5] 内，或区间宽度 ≤ 1 时停止。
- 都不达标时取下限，附 `target_unreachable`。

**何时运行（I2 待确认）**

- 「按画质」时，软件 AV1 路径默认启用智能画质搜索，预计多花约 20%–25% 的时间（推断，I2 实测）。
- 硬件路径默认用 §3 的表；用户可以点「试算」。
- HDR 内容回退到 §3，附 `vmaf_not_applicable_hdr`。

**预估与缓存**

- 视频码率 = Σ 片段字节 ÷ Σ 片段时长。
- 体积 = 视频码率 × 时长 + 音频 + 1%，按 ±15% 的范围显示，校准后收窄。
- 预测体积 ≥ 源的 90% 时，建议只换封装或跳过。
- 缓存键：`(输入身份, 编码器, preset, 滤镜签名, 目标)`。

### 9. I2 设计草案：目标大小（R-ENCODE-07）

**预设与单位**

- 预设以精确字节数保存，带来源与 `lastVerified`：
  - 微信（文件、视频）、QQ、QQ 邮箱：数值在 I2 时实测核实；
  - 邮件附件：20 MiB；
  - Discord 免费：20 MB（2026-08-13 核实）与 10 MB；
  - 自定义：MB；
  - 原大小的百分比。
- 界面统一按 1024 进制显示，单位标「MB」，与 Windows 资源管理器一致。

**码率计算**

- 预算为 B 字节。可用码率 R = (B − 安全边际 1%) × (1 − 封装开销 2%) × 8 ÷ 时长。
- 音频码率 a = clamp(R × 10%, 64k, 160k)。R < 300 kbps 时，提示可以去掉音频，或改用 MKV + Opus。
- 视频码率 v = R − a。

**降分辨率**

每像素比特（bpp）低于下限时（初值：AV1 0.025、HEVC 0.04、H.264 0.06），按 1080 → 720 → 540 → 480 → 360 逐级降低短边；必要时把 60 fps 降到 30 fps。降级时说明原因。

**编码**

- 默认用 SVT-AV1 两遍：第一遍 `-b:v v -pass 1 -passlogfile <work>/p -f null NUL`，第二遍 `-pass 2`。
- 要求 H.264 兼容时：
  - 硬件编码器用 `-rc vbr -b:v v -maxrate 1.5v -bufsize 2v -multipass fullres`；
  - libopenh264 用 `rc_mode bitrate`。

**修正**

- 结果 > B，或 < 0.85B 时，按 v × B ÷ 实际值 × 0.97 重新编码，最多 2 次。
- 仍超标时，以 v × 0.9 再编一次。
- 始终 **不发布超过 B 的文件**。最终仍超标时，任务失败 `target_size_unreachable`，保留最接近的结果，由用户决定是否保留。

### 10. I3 设计草案：高级设置（R-ENCODE-10/11/12）

**码控模式**（按编码器能力显示）

| 模式 | libsvtav1 | NVENC | QSV | AMF | openh264 | kvazaar |
| --- | --- | --- | --- | --- | --- | --- |
| 恒定质量（CRF/CQ/ICQ/QVBR） | ✓ | ✓ | ✓ | ✓ | – | QP |
| 带上限的恒定质量（maxrate/bufsize） | ✓ | ✓ | ✓ | ✓ | – | – |
| VBR 1-pass | ✓（不准） | ✓ | ✓ | ✓ | ✓ | ✓ |
| VBR 2-pass | ✓（`-pass`） | multipass | LA | preanalysis | – | – |
| CBR | ✗（随机访问模式不支持） | ✓ | ✓ | ✓ | ✓ | ✓ |

**编码参数**

- preset/速度；
- tune：SVT 可选 0/1/2，不提供 5；
- GOP（秒或帧）；
- 位深；
- 胶片颗粒：`film-grain=4..15` 与 `film-grain-denoise=0|1`，速度约降为 1/7，界面要提示；
- `enable-variance-boost`；
- SVT 参数文本框：只接受白名单中的键；运行时日志为 `level+warning`，出现 `Error parsing option` 即判为失败；
- NVENC：AQ、lookahead、multipass、b_ref。uhq 与 `-bf` 的组合由能力探测核实。
- QSV/AMF 的常用参数。

**滤镜**

- 分辨率与帧率上限；
- 去隔行：自动（用 idet 检测 3 段 × 200 帧）、开、关；
- HDR 转 SDR：zscale；或 libplacebo（需要 Vulkan）；
- 裁剪：手动；或自动，取 10 个采样帧的 `bbox` 中位数，对齐到 2；
- 降噪：`atadenoise` / `nlmeans` 的轻、中两档。

**音频**

- 编码、码率或 VBR 质量；
- 采样率：soxr precision 28 + `triangular_hp` 抖动；
- 声道与下混；
- 响度标准化：两遍 loudnorm，第二遍 `linear=true` 并补 `aresample`；预设 −14、−16、−23 LUFS；显示 `normalization_type`；
- 音轨与字幕选择；
- 元数据与封面控制，包括写入 Opus 封面：自行写 `METADATA_BLOCK_PICTURE`。

**实用输出**

- GIF：`fps,scale,split,palettegen=stats_mode=diff,paletteuse=dither=bayer`。
- WebP：`libwebp_anim -q:v 75 -compression_level 6 -loop 0`。
- 无损裁剪时长：说明起点落在关键帧。

**合法性与命令预览**

- `validateSettings(settings, caps)` 返回逐项错误，不合法时不能开始。
- 命令预览显示 `toFfmpegArgs` 的结果，路径用占位符代替，只读。

## 代码落点

| 路径 | 作用 |
| --- | --- |
| `electron/main/media-converter/plan/types.ts` | `ConversionPlan`、`PlannedOutput`、`StreamDecision`、`PlannerCapabilities` |
| `electron/main/media-converter/plan/matrix.ts` | 兼容矩阵、任务矩阵、muxer、容器标识比较 |
| `electron/main/media-converter/plan/stream-plan.ts` | `buildPlan`：流规划、跳过与不适用判定、容器「自动」、摘要 |
| `electron/main/media-converter/plan/video.ts` | 编码器降级链、参数表、尺寸前置条件、滤镜链、像素格式表、HDR/色彩/旋转 |
| `electron/main/media-converter/plan/audio.ts` | 音频参数表、直通判定、Opus 布局表、采样率、封面与标签、提取映射 |
| `electron/main/media-converter/plan/naming.ts` | 基础名、扩展名与清洗 |
| `electron/main/media-converter/plan/args.ts` | `toFfmpegArgs`、`probeArgs`，组合 `videoArgs()` 与 `audioArgs()` |
| `electron/main/media-converter/plan/caps.ts` | `outputCapBytes`（输出上限） |
| `src/media-converter/contract.ts` | `ConversionSettings`、`PlanSummary` schema 与原因码枚举（与 engine 共用） |
| `test/media-converter/plan/` | 快照测试与夹具组合 |
| `test/media-converter/encode-real.test.ts`、`test/media-converter/encode-audio-real.test.ts` | 本机真实小样编码 |
| `scripts/media-converter/calibrate.mjs` | 校准脚本 |

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-ENCODE-01 | §1 数据模型与纯函数、原因码枚举；§2 兼容矩阵、容器标识、转换时的编码选择、容器「自动」、任务矩阵、映射与处置、只换封装 |
| R-ENCODE-02 | §3 参数表（含 uhq/hq 分行、MF nv12 与 profile 100、kvazaar 逗号与 8 的倍数、GOP、openh264 码率上限）、降级链与前置条件；§4 缩放 |
| R-ENCODE-03 | §4 滤镜顺序、像素格式表、全范围转换、旋转、色彩、HDR 判定、VFR、去隔行、色度 |
| R-ENCODE-04 | §5 纯音频表、封面、标签、Opus 布局表、采样率、逐流滤镜、位深、提取映射 |
| R-ENCODE-05 | §5 视频内音频表与直通条件（区分转换与压缩） |
| R-ENCODE-06 | §7 不变大上限、`already_target`、输出上限；§6 命名 |
| R-ENCODE-07 | §9（草案） |
| R-ENCODE-08 | §8（草案） |
| R-ENCODE-09 | §8 预估与缓存（草案） |
| R-ENCODE-10 | §10（草案） |
| R-ENCODE-11 | §10（草案） |
| R-ENCODE-12 | §10（草案） |

## 验证与风险

**验证**

- **快照测试**
  - 夹具：竖屏、HDR10、HLG、DV5（传递特性未知）、DV8、VFR、隔行、4:2:2、奇数宽高、854×480 与 1920×804（kvazaar 用）、108×192（NVENC 不满足尺寸前置条件）、封面音频、多音轨多字幕（文本、带样式的 ASS、图形）、MP4 的 mov_text 转 MKV、5.1(side) / 2.1 / 5.0(side)、TS 偏移、MOV/MP4/M4A brand、无码率的 MKV AAC。
  - 组合：3 种任务 × 3 档 × 3 种编码 × 5 种能力组合（全 NVENC / 仅 CPU / 仅 QSV / 仅 AMF / NVENC 降级），外加任务矩阵的 16 个格子。
- **本机真实编码**（lavfi 生成 2 s 小样，低优先级，日志级别 `level+warning`）
  - 每个可用编码器 × 三档：检查体积递减、编码、位深、profile（包括 h264_mf 为 High）、GOP、hvc1、faststart。
  - 正确性：旋转、HDR10 标记与 MDCV/CLL、全范围转换后的像素范围、VFR 时长。
  - 音频：标签与封面、章节、Opus 各种布局、双音轨分别使用自己的滤镜、大端 PCM 提取。
- **校准（T-ENCODE-05）**：需要用户提供的真实样片（A-07），按 AC-ENCODE-02-6 判定。

**风险**

- **参数初值**：来自合成素材，真实素材下档位间距可能不合理。缓解：AC-ENCODE-02-6 的校准；I2 的 VMAF 目标模式会进一步抹平内容差异。
- **QSV/AMF**：本机没有这两类设备，参数和数值方向都无法验证。缓解：能力探测用生产参数测试，不能用的会被跳过；校准要在对应设备上做。
- **AQ**：本机实测 NVENC 在 CQ 模式下开 AQ 会膨胀码率，因此默认不开；真实素材下的表现待校准。
- **CPU 上的 H.264**：没有 x264，CPU 机器上的 H.264 输出偏大。缓解：附 `cpu_weak_encoder`，引导改用 AV1；以后是否引入 GPL 扩展包见 Q-03。
- **专利**：libopenh264 与 libkvazaar 位于降级链末端，涉及编解码专利问题（Q-04）。
- **HEVC 在 Windows 上的播放**：需要付费扩展，选项说明中写明。
