# 实施记录：T-ENCODE-04

| 字段 | 值 |
| --- | --- |
| 任务 | T-ENCODE-04 |
| 日期 | 2026-10-26 |
| 验证版本 | snapshot-sha256:6f79b2d5a82acad0248f85ab4bb88fc72928e92b2c0ba8ec50c35c14c6047f86（基线 a742ec76 + 未提交工作树）。批次 B 修正评审（2026-10-28）后取得：在评审的最后一次代码修改、受影响检查的重跑与证据文件写入之后，更新本记录及同批的 T-ENGINE-01、T-ENCODE-01～04 记录之前；这些记录文件的这次改动未计入。工作树中另有协调者对 spec 文档的未提交纠正（design、requirements、tasks、spec.json、changes/），以及其他任务的未提交文件。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；随附 ffmpeg/ffprobe n8.1.2（BtbN，LGPL），经 `verifyLocalSubtitleRuntimeBundle` 校验；RTX 4070 Ti SUPER（本任务只有 libopenh264 的 CPU 视频编码，没有用到 GPU）。测试中的 ffmpeg 一律以 IDLE（`PRIORITY_LOW`）运行并使用运行时的精简环境，ffprobe 经 `MediaRuntime` 以 BELOW_NORMAL 运行。素材都由 lavfi 在测试时生成，时长 ≤ 2 s，视频 160×90，放在 `test-results/media-converter/encode-audio-*` 运行目录中，测试结束后删除（每次运行后核对过没有遗留目录）。临时实测用 scratchpad 中的脚本（spawn 后 `os.setPriority(PRIORITY_LOW)`），素材放在 scratchpad，结束后已删除。 |
| 任务指纹 | 8ae1db5602e61abf28319f8737ab1f9c02029857e986a19fb94f700c37ce647c |

## 实际结果

本任务没有界面部分，不涉及截图。

**修改的文件（均在写集内）**

- `electron/main/media-converter/plan/audio.ts`（新增）：按 design §5 实现音频的全部规则。
  - `AUDIO_TABLE`：纯音频参数表（MP3 V0/V2/V5；M4A 256/192/128k，单声道 128/96/64k；Opus 160/128/96k，单声道 96/64/48k；FLAC 级别 5/5/8）、视频内音频表（AAC 立体声 192/160/128k、5.1 384/320/256k；Opus 128/96/80k、320/256/192k；单声道取一半）、1.25 倍直通系数、soxr 降采样滤镜。参数文字照抄 design（`-q:a {V}`、`-b:a {B}`、`-b:a {B} -vbr on -compression_level 10`、`-compression_level {L}`），由 `parseAudioParameters` 解析，`toFfmpegArgs` 给每个选项加上 `:a:<n>`。
  - `layoutFilters`：每个编码器拿到它能接受的声道布局（见下文「布局」）。
  - `sampleRateFilters`：Opus 非 48 kHz 时 `aresample=48000`；AAC（以及 MP3）高于 48 kHz 时 `aresample=resampler=soxr:precision=28:osr=48000`；其余保持源采样率。
  - 位深：WAV 按源选 `pcm_s16le/s24le/s32le/f32le`（浮点保持 32 位浮点，整数超过 24 位用 32 位）；FLAC、ALAC 显式写出 `-sample_fmt`（16 位源为 s16/s16p，其余为 s32/s32p 加 `-bits_per_raw_sample 24`）。
  - `planAudioFormat`（转换为音频格式、提取为某种格式）：编码相同就复制；否则按格式编码；有损源写成 FLAC/WAV/ALAC 时标记 `lossy_to_lossless`；MP3 遇到多声道附 `downmixed_to_stereo`，参数加 `-ac 2`。
  - `planExtractCopy`（提取「保持原音轨」）：aac/alac → .m4a，mp3 → .mp3，opus → .opus，vorbis → .ogg，flac → .flac，小端或压扩 PCM → .wav（复制），大端 PCM → .aiff（复制），pcm_bluray、pcm_dvd 及其他 PCM → 同位深小端 PCM .wav（摘要中显示为 encode），其他 → .mka。
  - `planVideoAudio`（视频内音频）：编码在容器兼容清单中时，转换任务一律复制；压缩任务还要求码率（流码率，否则 BPS 标签；未知视为不满足）≤ 档位码率 × 1.25，且不是无损音轨或 DTS。否则 MP4/MOV 重编码为 AAC、MKV/WebM 重编码为 Opus，码率按视频内音频表与声道数选取，声道数不变（超过 8 声道下混到 7.1）。
  - 标签：`outputTagCleanup` 为 MP3、FLAC、Opus、Ogg 输出写 `-metadata major_brand= -metadata minor_version= -metadata compatible_brands=`；`trackTagCleanup` 为 Opus/Ogg 的音轨写 `-metadata:s:a:<n> handler_name= vendor_id=`。不设置 `encoder` 标签。
- `electron/main/media-converter/plan/stream-plan.ts`：删除 T-ENCODE-01 的音频占位实现，改为调用 audio.ts；`Draft` 增加 `lossyToLossless`，摘要的 `confirmations` 由它得出；音轨的 `metadata` 与输出的全局 `metadata` 加上标签清理；视频输出收集 `planVideoAudio` 的警告。
- `electron/main/media-converter/plan/args.ts`：只更新 `audioArgs` 的注释（逐轨 `-filter:a:<n>`，不用 `-af`）。原有 `codecArgs` 已按 `EncodeSpec` 写出逐轨选项与滤镜，无需改代码。
- `electron/main/media-converter/plan/types.ts`：只更新注释（音频的逐轨选项、滤镜顺序、空值删除标签）。
- `electron/main/media-converter/plan/caps.ts`：**没有修改**。现有公式已按 `EncodeSpec.maxBitRate`（AAC/Opus 为表中码率，MP3 为最大帧 320 kbit/s）与 PCM 公式计算，满足本任务的输出。
- 测试：
  - `test/media-converter/plan/audio.test.ts`（新增，实现时 88 项，评审后 94 项）。
  - `test/media-converter/plan/stream-plan.test.ts`：两张组合快照随音频规则更新；快照行增加 `confirm:lossy_to_lossless`；4 处期望值随码率表更新（摘要的编码器列表、关闭不变大时的视频上限、Opus 与「视频复制 + AAC」的上限、MP3 参数串）。快照差异逐行核对过（见下文）。
  - `test/media-converter/encode-audio-real.test.ts`（新增，实现时 18 项，评审后 19 项）。

**快照差异核对（stream-plan.test.ts）**

两张内联快照共 211 行变化，逐行做了词级对比，变化只有以下几类，都符合本任务的规则：

- 编码器后面多了参数（`-q:a:0 2`、`-b:a:0 192k`、`-b:a:0 128k -vbr:a:0 on -compression_level:a:0 10`、FLAC/ALAC 的 `-sample_fmt`）；
- MP3/FLAC/Opus 输出多了品牌标签清理，Opus 多了音轨的 handler_name/vendor_id 清理；
- AC-3 5.1(side) 重编码时多了 `-filter:a:1 channelmap=...:channel_layout=5.1`；
- 压缩任务中码率未知的 AAC 与 448k 的 AC-3 由复制改为重编码（AC-ENCODE-05-1）；
- 「全部音轨」转 MP3 时 5.1 音轨加 `-ac:a:0 2` 并附 `downmixed_to_stereo[2]`；
- 输出上限随实际码率变化（例如 Opus 由 19657216 变为 17929216，即 128k 代替占位的 320k）；
- 有损源转 FLAC/WAV/ALAC 的 12 行加 `confirm:lossy_to_lossless`，无损源（FLAC、FLAC_COVER）没有。

**用随附 ffmpeg 核对、并据此确定实现的事实**（证据：file:records/i1/T-ENCODE-04-ffmpeg-facts.txt）

1. **libopus 只接受标准布局。** 2.1、3.0(back)、4.0、quad(side)、5.0(side)、5.1(side)、6.1(back)、6.1(front)、7.1(wide)、7.1(wide-side)、hexagonal、6.0 直接送入都报错退出（`Invalid argument`），10 声道报「mapping family undefined」。按设计用 `channelmap` 或 `aformat` 处理后全部成功。
2. **重混的代价。** quad(side) → quad 用 `aformat` 重混，各声道电平与源完全相同（等于改标签）。7.1(wide) → 7.1 用 `aformat` 重混时，前两声道降 3 dB，其余降 6 dB，SL/SR 两声道为静音。5.1(side) 用 `channelmap` 改标签，6 个声道电平与源完全相同。
3. **AAC 的 PCE。** aac 编码器接受 5.1(side)，但写出的 AudioSpecificConfig 中 channelConfiguration 为 0（布局放在 PCE 中，ffprobe 读回 `unknown`）；5.0(side)、7.1(wide) 同样。改标签为 5.1/7.1 后为标准的 6/7。aac 拒绝带顶置声道的布局（3.1.2、5.1.2、5.1.2(back)、cube）和 10 声道（5.1.4）。
4. **ALAC 的布局。** 交给 ffmpeg 自动协商时，声道数会被悄悄改变：7.1 → 6.1(back)（8 → 7 声道），quad → 5.0，2.1 → 立体声，10 声道 → 5.1。FLAC 接受 8 声道以内的任何布局，超过 8 声道报错。
5. **位深。** FLAC 与 ALAC 最多写 24 位；32 位整数、浮点与有损源（解码为浮点）会被写成 24 位，并在日志中输出「encoding as 24 bits-per-sample」；24 位源转 ALAC 也会输出这条警告。显式给出 `-sample_fmt` 与 `-bits_per_raw_sample 24` 后没有警告，位深相同。
6. **采样率。** 随附构建带 soxr；96 kHz → AAC 用 soxr 后为 48 kHz，不加时保持 96 kHz。libmp3lame 最高 48 kHz，96 kHz 输入会被自动降到 48 kHz。libopus 自动转为 48 kHz。
7. **码率上限。** 2 s 白噪声（最坏情况）：Opus VBR 128k/96k/160k 实际为 121/89/150 kbit/s，5.1 480k 为 386；AAC 256k/128k 为 263/133，5.1 768k/384k 为 782/392；LAME V0 为 275、V5 为 131。都在「码率 × 1.2 + 16 MiB」的上限内。
8. **标签。** 不清理时，MP4 源的 `major_brand`、`minor_version`、`compatible_brands` 会进入 MP3 的 ID3 帧、FLAC 与 Opus 的 Vorbis 注释；MP4 音轨的 `handler_name=SoundHandler` 也会进入 Opus 注释。清理后都没有，用户标签保留。FLAC 的章节以 `CHAPTERxxx` 注释形式被 FLAC 解复用器读成章节；FLAC 封装器不写章节。
9. **其他。** `-q:a:0`、`-ac:a:0`、`-vbr:a:0`、`-compression_level:a:0`、`-sample_fmt:a:0`、`-bits_per_raw_sample:a:0` 都按每流写法被接受，没有警告。`channelmap` 的显式名映射（含 `FLC-SL`、`DL-FL`）与 `channel_layout=7.1(wide)` 都被接受。探测把没有声道掩码的布局报告为 null；Matroska 中的 PCM 不保存布局，所以测试用 AC-3 作为 5.1(side) 音轨（AC-3 5.1 解码即为 5.1(side)，与常见片源一致）。

**V-ENCODE-04-2 实测结果**（证据：file:records/i1/T-ENCODE-04-audio-real.txt）

- **FLAC → MP3**：文件头为 `ID3` 且版本字节为 3（ID3v2.3），含 `APIC` 与 `CHAP` 帧；标题、艺术家、专辑与源一致；PNG 封面为 attached_pic；2 个章节（Opening、Ending）。计划没有警告。
- **FLAC → M4A**：标签一致，PNG 封面为 attached_pic，AAC 立体声。
- **FLAC → Opus**：标签与 2 个章节保留；计划附 `cover_dropped`；48 kHz，滤镜 `aresample=48000`；输出没有视频流。
- **M4A → MP3/FLAC/Opus**：先确认源有 `major_brand` 等三项与 `handler_name`；三种输出中这三项都不存在，用户标签保留；MP3 与 FLAC 带 PNG 封面，Opus 没有封面并附 `cover_dropped`；Opus 中没有 `handler_name`；转 FLAC 的计划要求 `lossy_to_lossless` 确认。
- **提取 AAC**：MKV 中的 AAC 复制为 `.m4a`，计划为只换封装，源与输出每个包的 MD5 相同。
- **提取大端 PCM**：MOV 中的 pcm_s24be 复制为 `.aiff`，输出为 pcm_s24be、24 位，包 MD5 相同。
- **Opus 布局**：5.1(side) → 5.1（channelmap），2.1 → 3.0（aformat），5.0(side) → 5.0（channelmap），7.1(wide) → 7.1（channelmap），5.1.4（10 声道）→ 7.1（aformat），4.0 → quad（aformat），未标布局的 6 声道 → 5.1；全部 48 kHz，时长 2 s。
- **AAC/ALAC/MP3 布局**：5.1(side) → AAC 为 5.1，channelConfiguration 6（没有 PCE）；7.1 → ALAC 为 8 声道 7.1(wide)；5.1(side) → MP3 为立体声，计划附 `downmixed_to_stereo`。
- **采样率与位深**：96 kHz 24 位 FLAC → AAC 为 48 kHz；→ ALAC 为 96 kHz、24 位；→ WAV 为 pcm_s24le、96 kHz。32 位浮点 WAV → FLAC 为 24 位，日志中没有「encoding as 24 bits-per-sample」。
- **双音轨视频**（AC-3 5.1(side) 44.1 kHz + FLAC 立体声 96 kHz）：
  - 压缩为 MKV：两条都重编码为 Opus，`-filter:a:0` 为 `channelmap=...:channel_layout=5.1,aresample=48000`，`-filter:a:1` 为 `aresample=48000`；输出 5.1 + 立体声，都是 48 kHz；语言与默认标记保留；时长 2 s。
  - 压缩为 MP4：两条都重编码为 AAC，`-filter:a:0` 为 channelmap，`-filter:a:1` 为 soxr；输出 5.1（channelConfiguration 6，44.1 kHz）+ 立体声 48 kHz。
  - 参数中没有 `-af`，`-filter:a` 恰好两次。
- 所有日志都没有禁止出现的模式（`Invalid option`、`Error parsing option`、`auto-selecting format`、`only the last`），也没有「encoding as 24 bits-per-sample」、「Invalid channel layout」。日志中只出现与本任务无关的警告：M4A 输入的封面流「timescale not set」、无布局输入的「Guessed Channel Layout」、libopenh264 的「bitrate can't be controlled」。

**评审与修复（2026-10-26，独立评审）**（证据：file:records/i1/T-ENCODE-04-review.txt）

评审逐行读了写集内的全部代码与三个测试文件，逐条对照 7 条 AC 与 design §5，并用随附 ffmpeg 补测了只有单元测试的参数组合（96 kHz 5.1(side) 转 MP3 时 `-ac:a:0 2` 与 soxr 滤镜同用、quad 转 ALAC 的改标签、低采样率 AAC 的码率）。AC 的结论与实现者一致，只发现并修复了下面两处：

1. **（主要）Matroska 拒收的音频编码会让转换和提取失败。** 「转换为 MKV」按兼容矩阵「MKV 为全部」直接复制每条音轨；「提取音频·保持原音轨」把 PCM 以外、不在映射表中的编码都写进 .mka。实测 matroska 封装器拒收（报「No wav codec tag found」后退出）：pcm_bluray、pcm_dvd、pcm_f32be、pcm_f64be、pcm_s8、planar 与无符号 PCM、SMPTE 302M（s302m）、QuickTime IMA ADPCM、Nellymoser 等，评审对随附 ffmpeg 的每个音频编码器都测了一遍，清单见证据。蓝光 M2TS 的 LPCM、DVD VOB 的 LPCM、MOV 的大端浮点 PCM 都是常见片源，转 MKV 时都会失败。修复（只改 audio.ts）：
   - 新增 `matroskaTakesAudio()`，清单来自实测。
   - `planVideoAudio`：目标为 MKV 时，不在 Matroska 可存清单中的音轨按「不能直通」处理，重新编码为 Opus（与 AC-ENCODE-05-2 相同）。
   - `planExtractCopy`：s302m 按 PCM 处理，被拒收的非 PCM 编码不再写入 .mka，而是与「其他 PCM」一样无损解码为同位深的小端 PCM .wav。
   - `isLosslessAudio` 把 s302m 计为无损。
   - 测试：audio.test.ts 增加 6 个用例（提取 s302m、adpcm_ima_qt、nellymoser → .wav，mp2、amr_nb 仍为 .mka；转 MKV 时 10 种被拒收的编码重新编码，17 种可存的编码复制），现在共 94 项。encode-audio-real.test.ts 增加 1 项真实测试：MOV 中的 pcm_f32be 转 MKV（视频复制、音频为 Opus）成功；MPEG-TS 中的 s302m 提取为 pcm_s24le .wav，现在共 19 项。三种内存变异（去掉 MKV 检查、去掉 .wav 回退、s302m 不计为 PCM）都被单元测试发现，变异前后磁盘上的 audio.ts 不变。
2. **（次要）测试文件的类型检查。** 实现记录说测试文件的类型检查通过，但只要把 `electron/` 一起纳入（它的 env.d.ts 扩充了 `ProcessEnv`），encode-audio-real.test.ts 就有 11 个错误：spawn 的 `env` 传入的是 `Readonly<Record<string, string>>`。现在改为与 engine/process.ts 相同的 `{ ...tools.environment } as NodeJS.ProcessEnv`，检查通过（`T-ENCODE-04-tsc.txt`）。写集外的 encode-real.test.ts 有同样的写法，没有修改。

评审确认、未改动的点：

- 「编码相同就复制」与 design §7「音频转换同理：编码与封装都相同时跳过；只有封装不同时只换封装」一致，差异 4 的做法有设计依据。
- 采样率转换、布局滤镜、标签清理、封面与章节、逐轨 `-filter:a:<n>` 的参数，实测与单元测试一致。96 kHz 5.1(side) 转 MP3 同时用 `-ac:a:0 2` 与 soxr 滤镜，实测输出 48 kHz 立体声。
- 滤镜字符串只由常量拼成，探测得到的布局名不会进入滤镜；标题等元数据作为独立参数传入，没有注入风险。
- 真实测试的 ffmpeg 以 IDLE 优先级运行，到期后结束进程，运行目录在结束时删除（每次运行后核对过 `test-results/media-converter` 为空）。

**批次 B 修正（2026-10-28）**

依据 changes/2026-10-26-batch-b-spec-corrections.md 与 design §7b「同编码转换」「声道布局」，AC-ENCODE-04-5 已纠正：

1. **同编码转换（`planAudioFormat`，取代差异 4）。**
   - 源与目标编码相同时，无损编码（FLAC、ALAC、WAV 的 PCM）照旧直接复制。有损编码（MP3、AAC、Opus）只有在目标码率不低于源码率时才复制；目标码率低于源码率时重新编码以减小体积，例如 320k 的 MP3 转「标准」MP3。
   - 目标码率取档位的名义码率（`nominalFormatBitRate`）。AAC 与 Opus（VBR，以 `-b:a` 为目标）用表中码率，并按声道数换算。MP3 的 V0/V2/V5 用 LAME 公布的平均码率 245/190/130 kbit/s（`AUDIO_TABLE.mp3NominalBitRate`）。design §5 的表只写了 V 值，没有名义码率，这三个数需要设计确认。
   - 源码率依次取流码率、`tags.BPS`（即探测结果的 `bitRate`），再取文件总码率。文件总码率只在文件中只有这一条音轨时使用（音频文件，没有封面，没有其他音轨；stream-plan.ts 的 `soleTrackBitRate`）。否则总码率包含封面或其他音轨，会高估源码率，反而把小文件重新编码成更大的文件。三者都未知时直接复制。
   - 判为「已是目标格式」仍要求直接复制且封装相同（T-ENCODE-01 的判定，未改）。
2. **ALAC 声道布局（`alacLayout`，取代差异 6 与风险「ALAC 的改标签位置」中的做法）。**
   - ALAC 不支持的布局不再按声道数改标签，而是用 `aformat=channel_layouts=…` 重混到最接近的 ALAC 布局，由 swresample 按声道位置放置。
   - 「最接近」取能为每个源声道找到位置的最小 ALAC 布局。侧声道在源没有后置声道时占用后置位置（与 swresample 的规则一致），所以既不混合也不丢失：quad、quad(side) → 5.0（中置为空），2.1 → 5.1（保留 LFE），3.0(back) → 4.0，3.1 → 5.1，4.1、6.0、hexagonal、6.1 → 6.1(back)，6.0(front)、6.1(front)、7.0(front)、7.1(wide-side) → 7.1(wide)。
   - 没有一种 ALAC 布局能容纳全部声道时（7.1 同时有侧、后两对，带顶置声道，超过 8 声道），取声道数相同的 ALAC 布局（最多 8 声道），其余声道由 swresample 按位置混入：7.1 → 7.1(wide)（侧声道混入后置，前宽声道为空），7.0 → 6.1(back)，5.1.4 → 7.1(wide)。
   - 改标签只用于纯改名：5.0(side)、5.1(side)、downmix 用显式映射改为 ALAC 的 5.0、5.1、立体声；没有声道位置的布局（未知、只有声道数）按声道数命名为 ALAC 的布局。
   - 输出声道数可能多于源（quad 为 5 声道，2.1 为 6 声道）。`alacChannels` 给出输出声道数，caps.ts 据此计算 ALAC 的上限。
   - 实测依据（随附 ffmpeg，IDLE 优先级）：quad 改标签为 4.0 时，后左的 440 Hz 落在前中声道；重混为 4.0 时，后左、后右合并到后中，整体降 3 dB；重混为 5.0 时，四个声道各在其位，幅度不变（0.200）。
3. **测试。**
   - audio.test.ts（97 项）：
     - ALAC 用例改为逐布局的期望：自身布局不处理，纯改名 3 种，按位置放置 15 种，无法容纳的 8 种，没有位置的 3 种；断言有位置的布局从不使用纯改标签；输出声道数。
     - 同编码规则拆成三个用例。重新编码：320k MP3 转三档；190 001 bit/s 刚好高于名义码率；AAC 256k 转「小」；Opus 读 BPS 标签；视频中 320k 的 Opus 提取为 Opus。直接复制并判为已是目标格式：96k 与 190k（相等）的 MP3，128k AAC 转「高」与「小」，5.1 Opus 300k。Ogg Opus 只有文件总码率时按总码率判断；有封面、有第二条音轨或来自视频时不用总码率。
   - encode-audio-real.test.ts 新增 4 项真实测试（共 23 项）：
     - quad、2.1、7.1 的每个声道为不同频率的正弦（220、330、440 Hz……）。转为 ALAC 后解码为 32 位浮点，用 Goertzel 算法逐声道测量每个频率的幅度：quad 的 440/550 Hz 在 BL/BR（0.200），中置静音；2.1 的 LFE 在 LFE 声道，中置与后置静音；7.1 的侧声道（880/990 Hz）混入 BL/BR，前宽声道静音。任何频率都没有出现在其他声道（< 0.002）。
     - 同编码：320 kbit/s CBR 的 MP3 转「标准」MP3 被重新编码，源 82 605 B，输出 14 037 B；96k 的 MP3 判为已是目标格式。随附 ffprobe 对 Ogg Opus 不报告流码率：192k CBR Opus（总码率 194 966）转 Opus 被重新编码，96k（总码率 97 917）判为已是目标格式。
   - stream-plan.test.ts 的相应用例见 T-ENCODE-01 记录。
4. **变异检查**（file:records/i1/T-ENCODE-04-batchb-mutations.txt）：7 种变异全部被发现。
   - 同编码一律复制（批次 A 规则）：单元 3 项、真实 1 项失败。
   - 比较方向反过来（原 AC 的措辞）：单元 5 项失败。
   - 任何音频文件都用总码率：单元 1 项失败。
   - 从不用总码率：单元 2 项、真实 1 项失败。
   - ALAC 恢复按声道数改标签：单元 1 项、真实 3 项失败。
   - ALAC 重混到相同声道数（quad → 4.0）：单元 1 项、真实 2 项失败。
   - ALAC 上限按源声道数：单元 1 项失败。
   - 写回后 sha256 都与变异前一致。
5. **回归**：test/media-converter 下全部 14 个测试文件，581 项通过（file:records/i1/T-ENCODE-01-batchb-full.txt）。

**批次 B 修正评审（2026-10-28）**

独立评审逐项核对了上面的修正与 AC-ENCODE-04-5、design §7b，修复 2 个问题，另记录 1 个写集外的限制：

1. **同编码规则对实测码率没有余量，同档的输出再转同档时会以原码率重新编码（已修复）。**
   - 规则比较的是目标的名义码率与源的实测码率，而实测码率总比制作时的码率略高。随附 ffmpeg 自己的 AAC：128k 读出 128 034 bit/s，256k 读出 260 046 bit/s；CBR Opus 128k 在 Ogg 中的文件总码率为 130 535 bit/s（含 Ogg 页开销；Opus 没有流码率）。证据：file:records/i1/T-ENCODE-04-batchb-review-measure.txt。
   - 按严格的「目标码率不低于源码率」，用本程序「M4A 小」做出的文件再转「M4A 小」时，128 000 < 128 034，会以同样的码率重新编码：有代际损失，体积不减，也不判为已是目标格式。iTunes 的 256k AAC 转「M4A 高」也是如此。这违背 AC 的本意（低于源码率时重新编码，是为了减小体积），也违背 AC-ENCODE-06-2「无意义的转换直接跳过」。
   - 修复：`AUDIO_TABLE.sameCodecMargin = 1.05`。源码率不超过目标名义码率的 1.05 倍时，视为不高于目标，直接复制；超过时照常重新编码。AC 的例子（320k MP3 转三档，256k AAC 转「标准」192k）不受影响。这个余量是对 AC 的解释，需要设计确认（见风险）。
   - 测试：
     - audio.test.ts：原「190 001 bit/s 刚好高于名义码率即重新编码」改为余量两侧：V2 时 199 400 bit/s 复制、199 600 bit/s 重新编码；V0 时 257 000 复制、257 500 重新编码。AAC 128 048 与 258 807 bit/s 判为已是目标格式，134 300 复制、134 500 重新编码。Ogg Opus 总码率 130 535 只换封装，134 500 重新编码。
     - encode-audio-real.test.ts 新增 1 项真实测试（共 24 项）：CBR Opus 128k（实测总码率 130 535）转 Opus「标准」、AAC 256k（固定噪声种子，实测 260 046）转 M4A「高」，都判为已是目标格式；同一个 AAC 转「标准」仍重新编码。
   - 变异（file:records/i1/T-ENCODE-04-batchb-review-mutations.txt）：去掉余量（R2），单元 2 项、真实 1 项失败；余量放宽到 1.25（R3），单元 3 项失败。写回后 sha256 一致。
2. **ALAC 布局位置表中 5.1.2、5.1.4 写错（已改正，选择结果不变）。**
   - 随附 ffmpeg 的 `-layouts` 显示 5.1.2 与 5.1.4 是侧声道布局（FL+FR+FC+LFE+SL+SR+…），表中写成了后置声道，另外缺 5.1.2(back)。
   - 这几种布局都带顶置声道，无论哪种写法都落到声道数相同的 7.1(wide)，所以选择结果不变（变异 R4 证实没有测试能区分）。已按 ffmpeg 改正并补上 5.1.2(back)；audio.test.ts 加了 5.1.2(back) → 7.1(wide)。
3. **顶后声道会被丢弃（写集外的限制，未修复）。**
   - 逐声道实测 5.1.4 经 `aformat` 重混到 7.1(wide)：侧声道进入后置（0.200），顶前声道以 0.141 混入前左、前右，顶后声道 TBL/TBR 不出现在任何输出声道中（证据同上）。
   - 原因是 swresample 的混音矩阵没有顶后声道的规则。Opus、AAC、FLAC 超过 8 声道下混到 7.1 时同样如此。
   - `alacLayout` 的注释原写「其余声道由 swresample 按位置混入」，已改为如实说明。要保留顶后声道，需要用 `pan` 写出完整的混音矩阵，属于设计层面的决定（见风险）。

其余核对无问题：

- 同编码规则：源码率依次取流码率、BPS 标签、只有一条音轨的音频文件的总码率，未知时复制；VBR 目标（LAME V0/V2/V5、Opus）用名义码率；「已是目标格式」只在全部复制且封装相同时给出（stream-plan.ts 的判定）。
- ALAC 重混：逐个布局核对了 swresample 的规则（源没有后置声道时，侧声道 1:1 占用后置；有后置时以 0.707 混入），与 `alacPlacement` 一致。真实测试逐声道检查最响的输出声道、其他声道 < 0.002、空位静音，能区分左右互换、改标签与同声道数重混（批次 B 的变异已证实）。
- 重跑：V-ENCODE-04-1 97 passed；V-ENCODE-04-2 24 passed；V-ENCODE-04-3 两项 tsc 都没有诊断；test/media-converter 全目录 582 passed。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ENCODE-04-1 | 通过 | file:records/i1/T-ENCODE-04-audio-unit.txt |
| V-ENCODE-04-2 | 通过 | file:records/i1/T-ENCODE-04-audio-real.txt |
| V-ENCODE-04-3 | 通过 | file:records/i1/T-ENCODE-04-tsc.txt |

- **V-ENCODE-04-1**（批次 B 修正评审后重跑，证据已覆盖：97 passed，exit 0；批次 B 修正后同为 97 passed，评审修复后 94 passed，实现时 88 passed）。覆盖 tasks 要求的全部项目：
  - 六种格式 × 三档参数快照，立体声与单声道各一组（36 行，与 design §5 表逐项一致），另有表值与容器（muxer、扩展名、ID3v2.3、`-rf64 auto`）的直接断言；
  - 提取的扩展名映射：28 种情形（27 种编码，pcm_bluray 有两种位深），含 5 种大端 PCM → .aiff、pcm_bluray（16/24 位）、pcm_dvd（20 位）、planar PCM、pcm_s8 → 同位深 .wav，ac3/eac3/dts/truehd → .mka。评审后为 33 种：增加 s302m、adpcm_ima_qt、nellymoser → .wav，mp2、amr_nb → .mka；
  - 评审增加：转 MKV 时 Matroska 拒收的 10 种编码重新编码为 Opus，可存的 17 种复制；
  - 全部音轨：每条音轨一个输出，只映射自己的音轨；`eng`、`jpn`、`chi` 带入文件名，`en-us`、`EN` 省略；
  - Opus 布局：2.1/5.0(side)/5.1(side)/7.1(wide)/10 声道及其他 22 种布局的滤镜，经规划器的完整参数；
  - MP3 下混与 `downmixed_to_stereo`（单声道、立体声不下混）；
  - Opus 48 kHz；AAC（与 MP3）高于 48 kHz 用 soxr；
  - 双音轨时每条音轨独立的 `-filter:a:<n>`（压缩为 MKV、MP4，转换为 WebM），没有 `-af`；
  - 有损转无损需要确认（含 DTS 与 DTS-HD MA、全部音轨时只确认一次、视频输出不确认）；
  - 编码相同时按批次 B 的规则：目标码率不低于源码率时复制（评审后：源码率不超过名义码率的 1.05 倍即视为不高于目标），封装也相同时判为 `already_target`；低于时重新编码；源码率依次取流码率、BPS、只有一条音轨时的文件总码率；
  - 视频内音频直通：转换任务与压缩任务分开判断，压缩任务边界值（200 000 / 200 001 bit/s）、BPS 标签、码率未知、5.1、各档位、无损与 DTS 总是重编码；
  - 视频内重编码码率表（AAC/Opus × 三档 × 单声道/立体声/5.1，以及 3–10 声道）。

  另外覆盖：位深（10 种源格式 × WAV/FLAC/ALAC）、AAC 与 FLAC 的布局规则、ALAC 按位置重混到最接近的布局（批次 B）、封面、章节提示、标签清理与「任何输出都没有 encoder 标签」、音频输出上限。
- **V-ENCODE-04-2**（批次 B 修正评审后重跑，证据已覆盖：24 passed，exit 0；批次 B 修正后 23 passed，评审修复后 19 passed，实现时 18 passed）：结果见上文；评审新增的一项见「评审与修复」，批次 B 新增的 4 项见「批次 B 修正」，批次 B 修正评审新增的 1 项见「批次 B 修正评审」。
- **V-ENCODE-04-3**：批次 B 修正评审后重跑 `pnpm exec tsc --noEmit -p tsconfig.json`，没有诊断，exit 0；另用继承该配置的 scratchpad 配置检查了 test/media-converter 下的全部测试文件，没有诊断。以下为评审时的情况：测试文件不在 tsconfig 的 include 中，另用一个继承该配置的 scratchpad 配置检查了本任务的 3 个测试文件：该配置保留 src 与 electron，并加入这 3 个文件（`--listFiles` 确认已纳入）。评审修复 spawn 的 `env` 类型后没有诊断，exit 0；修复前 encode-audio-real.test.ts 有 11 个错误。
- **补充：回归**（证据：file:records/i1/T-ENCODE-04-regression.txt）：
  - stream-plan、naming、video-correctness、remux-real：117 passed。
  - 批次 B 修正评审后：test/media-converter 全目录 582 项通过（file:records/i1/T-ENCODE-01-batchb-full.txt）。以下为评审时的结果。
  - video.test.ts（T-ENCODE-02 的文件，不在本任务写集内）：30 failed / 32 passed，与 T-ENCODE-03 记录的数字相同。用 T-ENCODE-03 的内存变换配置（只去掉 `setparams`）在本任务的代码上运行，62/62 通过，说明这 30 项失败与本任务无关。
  - encode-real.test.ts 没有重跑：它的素材都没有音轨，本任务的改动不影响它的计划。
- **补充：变异检查**（证据：file:records/i1/T-ENCODE-04-mutations.txt）：
  - 33 种变异在内存中施加（vite transform），不改磁盘文件；运行前后 audio.ts 与 stream-plan.ts 的 sha256 一致。
  - 单元测试（audio.test.ts + stream-plan.test.ts）发现全部 33 种。其中「去掉 7.1(wide) 同义布局」使 audio.test.ts 在收集阶段失败（测试表引用了该项）。
  - 真实测试对 10 种可在输出上测量的变异全部失败，例如：5.1(side) 不改标签时 libopus 报错；AAC 不改标签时 channelConfiguration 为 0；ALAC 交给 ffmpeg 时只有 7 声道；FLAC/ALAC 固定 16 位时位深为 16；不清理时输出含 `major_brand`。
  - 评审修复后另做了 3 种内存变异，都被 audio.test.ts 发现（证据：file:records/i1/T-ENCODE-04-review.txt）。
- **补充：评审实测**（证据：file:records/i1/T-ENCODE-04-review.txt）：对随附 ffmpeg 的每个 PCM 与非 PCM 音频编码器，分别写入 Matroska，以确定哪些编码会被拒收；另用 M2TS、VOB、MOV、TS、3GP、FLV 真实片源测了转 MKV 与提取为 .mka；补测了只有单元测试的参数组合。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ENCODE-04-1 | 通过 | V-ENCODE-04-1 |
| AC-ENCODE-04-2 | 通过 | V-ENCODE-04-1, V-ENCODE-04-2 |
| AC-ENCODE-04-3 | 通过 | V-ENCODE-04-1, V-ENCODE-04-2 |
| AC-ENCODE-04-4 | 通过 | V-ENCODE-04-1, V-ENCODE-04-2 |
| AC-ENCODE-04-5 | 通过 | V-ENCODE-04-1, V-ENCODE-04-2 |
| AC-ENCODE-05-1 | 通过 | V-ENCODE-04-1, V-ENCODE-04-2 |
| AC-ENCODE-05-2 | 通过 | V-ENCODE-04-1, V-ENCODE-04-2 |

- **AC-ENCODE-04-1**：参数与 design §5 表逐项一致（快照与表值断言）。多声道的码率 design 没有给出，按「每两个声道取立体声值」处理（见差异 1）。ALAC 的「保持源位深」受编码器 24 位上限约束（见差异 7）。
- **AC-ENCODE-04-2**：扩展名映射逐项测试；AAC 与大端 PCM 两种在本机实测为逐包复制。评审修复后，SMPTE 302M 按「其他 PCM」无损转为 .wav（实测）。Matroska 拒收的非 PCM 编码（QuickTime IMA ADPCM、Nellymoser 等）原本会写进 .mka 而失败，现在同样无损解码为 .wav（见差异 11）。
- **AC-ENCODE-04-3**：MP3（ID3v2.3、APIC、章节）、M4A（标签、封面）、FLAC（标签、封面，来自 M4A 的转换）、Opus（标签、章节、`cover_dropped`）、三种输出没有品牌标签，都在本机实测。FLAC/WAV/Ogg Vorbis 的 `chapters_dropped` 只有单元测试。
- **AC-ENCODE-04-4**：Opus 的各种布局、AAC/MP3/ALAC、采样率、双音轨的独立滤镜链都在本机实测。批次 B 后，ALAC 不支持的布局按位置重混到最接近的 ALAC 布局，quad、2.1、7.1 的声道位置逐声道实测。与 design 文字不同的两处：7.1(wide) 用 channelmap 改标签（按 AC 的「wide 同义布局」，design 表写的是重混），AAC 的三种同义布局改标签以避免 PCE（见差异 2、3）。
- **AC-ENCODE-04-5**：确认标记有测试。批次 B 纠正后，目标码率不低于源码率时复制，低于时重新编码，单元测试与真实测试（320k MP3、Ogg Opus 的总码率）都覆盖；`already_target` 由 T-ENCODE-01 的判定给出。MP3 的名义码率见「批次 B 修正」第 1 条。批次 B 修正评审后，源码率不超过目标名义码率的 1.05 倍时视为不高于目标（测量余量，需设计确认），同档的输出再转同档判为已是目标格式（真实测试）。
- **AC-ENCODE-05-1**：转换与压缩的直通规则、BPS 标签、码率未知、无损与 DTS 都有单元测试；本机实测了压缩时 AC-3 448k 与 FLAC 被重编码。评审修复后，「MKV 为全部」只包括 Matroska 封装器实际能存的编码；蓝光、DVD 的 LPCM 等转 MKV 时重新编码为 Opus（MOV 中的 pcm_f32be 转 MKV 已实测，见差异 11）。
- **AC-ENCODE-05-2**：码率表与声道数单元测试；本机实测了 MKV（Opus）与 MP4（AAC）中的 5.1 + 立体声。

## 风险与未执行项

**与设计的差异，以及设计未写明处采用的做法**（未修改设计文档，请设计负责人确认）

1. **多声道码率。** design §5 纯音频表只有立体声与单声道值。多于两个声道时按「立体声值 × 声道数 ÷ 2」（超过 8 声道按 8 计），例如 M4A 标准档 5.1 为 576k、Opus 标准档 5.1 为 384k。视频内音频表只有立体声与 5.1，其他声道数取「5.1 值 × 声道数 ÷ 6」，且不低于立体声值。
2. **7.1(wide) 用 channelmap 改标签。** AC-ENCODE-04-4 写「side/back/wide 同义布局用 channelmap 改标签」，design 表写「7.1(wide) 等 → 重混」。实测重混会让 SL/SR 静音、其余声道降 3–6 dB（事实 2），所以按 AC 改标签（前宽声道对应到侧声道），8 个声道都保留。7.1(wide-side) 仍按表重混。quad(side) 与 6.1(back) 按表重混，实测与改标签的电平完全相同。另外把 `downmix`（DL/DR）作为立体声的同义布局，未标布局的源按声道数改标签为标准布局。
3. **AAC 的布局。** design 写「AAC 不改布局」。实现保持这一点（不重混、样本不变），但 5.0(side)、5.1(side)、7.1(wide) 三种同义布局改标签为标准布局，否则 aac 写出 channelConfiguration 0 加 PCE（事实 3），很多播放器读不了；而电影中最常见的 AC-3 5.1 解码后就是 5.1(side)。aac 拒绝的布局（带顶置声道的 5.1.2 等）重混到同声道数的标准布局，超过 8 声道下混到 7.1（AC-ENCODE-05-2 对视频内音频也这样要求），否则编码会失败。
4. **编码相同时复制。**（2026-10-28 已被批次 B 修正取代：目标码率低于源码率时重新编码，见实际结果。）AC-ENCODE-04-5 写「编码相同、且目标码率不高于源时，改为直接复制」。实现按此复制；AC 没有写目标码率高于源时怎么办，实现同样复制：同编码重新编码到更高码率不会提升音质，只会变大（与本 AC 前半句同理），码率未知时也复制。结果是同编码一律复制，封装也相同时判为 `already_target`。代价是不能用「转换为同一格式」把 320k 的 MP3 压小；如果需要这种用法，请在 design 中明确「源码率高于目标多少时重新编码」。
5. **MP3 的 `-ac 2` 与采样率。** design 写「MP3 输出加 `-ac 2`」。实现只在多于两个声道或声道数未知时加，单声道仍为单声道；`downmixed_to_stereo` 只在多于两个声道时附加。MP3 最高 48 kHz，所以高于 48 kHz 时与 AAC 一样用 soxr 降到 48 kHz（design 只写了 AAC），否则 ffmpeg 会用默认重采样器自动降。Opus 只在源不是 48 kHz 时加 `aresample=48000`，结果与总是加相同。
6. **ALAC 与 FLAC 的布局（design 未写）。**（2026-10-28 ALAC 部分已被批次 B 修正取代：按位置重混到最接近的 ALAC 布局，见实际结果。）ALAC 只接受每种声道数的一种布局，交给 ffmpeg 会改变声道数（事实 4），所以不在其列表中的布局按声道数改标签为 ALAC 的布局（无损输出保留每个样本），超过 8 声道先下混到 7.1 再改标签为 7.1(wide)。FLAC 超过 8 声道下混到 7.1。
7. **位深上限。** FLAC 与 ALAC 编码器最多 24 位：32 位整数与浮点源（含有损源解码后的浮点）写成 24 位，这对 32 位整数与超出 0 dBFS 的浮点不是无损。WAV 按规则保持（浮点为 32 位浮点，有损源转 WAV 因此也是 32 位浮点）。探测不出位深时按 24 位处理。如需 32 位 FLAC，要加 `-strict experimental`，兼容性差，未采用。
8. **标签清理的范围。** design 列出 MP3、FLAC、Opus；实现也包括 Ogg Vorbis（.ogg，同为 Vorbis 注释）。Opus/Ogg 的音轨还清除 `handler_name`、`vendor_id`（事实 8），这两项是 MP4 音轨自带的，会以注释形式出现；音轨标题（title）保留。复制输出（例如提取 MP3）同样清理。
9. **无损与 DTS 的判定。** 无损编码集合为 PCM、FLAC、ALAC、TrueHD、MLP、WavPack、TTA、APE、TAK、Shorten、WMA Lossless、RALF，以及 profile 含「HD MA」的 DTS；其他编码一律按有损处理，所以未知编码转无损时会要求确认。压缩任务总是重编码的集合因此也包括 ALAC 等其他无损编码，以及全部 DTS。
10. **视频内 Opus 的参数。** 与纯音频 Opus 相同，带 `-vbr on -compression_level 10`；design 的视频内音频表只写了编码器与码率。
11. **Matroska 不能存的音频（评审修复）。** design §2 与 AC-ENCODE-05-1 写「MKV 音频允许复制：全部」，AC-ENCODE-04-2 写「其他 → .mka」。实测 matroska 封装器拒收 pcm_bluray、pcm_dvd、大端浮点、8 位有符号、planar 与无符号 PCM、s302m，以及 adpcm_ima_qt、nellymoser 等 15 种非 PCM 编码（清单与证据见 T-ENCODE-04-review.txt）。处理方式：
    - 「转换为 MKV」时，这些音轨按不能直通处理，重新编码为 Opus（AC-ENCODE-05-2）。
    - 「提取·保持原音轨」时，s302m 按「其他 PCM」处理，被拒收的非 PCM 编码不写 .mka，而是无损解码为同位深的小端 PCM .wav，摘要中显示为编码。
    - matrix.ts 的兼容表不在本任务写集内，所以判断写在 audio.ts 的 `matroskaTakesAudio()` 中。建议 design §2 的 MKV 行注明「除封装器拒收的编码」。只能解码、不能编码的编码无法实测，按「可存」处理。

**风险**

- **其他布局的 AAC 仍有 PCE。** aac 接受、但不属于三种同义布局的少见布局（quad(side)、3.1、4.1、6.0、hexagonal、6.1、6.1(back) 等）仍会写成 channelConfiguration 0 加 PCE。按「AAC 不改布局」没有处理。
- **执行器日志。** engine 写 `.partial` 文件时，ipod 封装器（M4A/ALAC）会在 `level+warning` 日志中输出「extension is not .m4a nor .m4v」；无布局输入会输出「Guessed Channel Layout」。T-ENGINE-07 判定结果时不应把它们当作错误。本任务的真实测试直接写正确的扩展名，所以没有前者。
- **Opus VBR 的上限。** 上限按名义码率 × 1.2 + 16 MiB。白噪声实测低于名义码率；极端素材的长文件理论上可能接近上限。
- **探测的布局。** 没有声道掩码的布局被探测报告为 null，Matroska 中的 PCM 也是如此；这类源按 ffmpeg 推定的默认布局处理，多数情况下正确。
- **同编码复制**：见差异 4（批次 B 已改）。评审确认它与 design §7「音频转换同理：编码与封装都相同时跳过」一致。
- **ALAC 的改标签位置（评审补充）。**（2026-10-28 design 已决定重混，批次 B 修正已实施并逐声道实测。） 差异 6 的改标签保留每个样本，但会改变声道的空间位置：quad 转 ALAC 时后左、后右被标为前中、后中（实测为 4 声道 4.0）；7.1 转 ALAC 时两个侧声道被标为前宽声道。重混能保持位置，但会合并或丢失声道。design 没有规定这种取舍，需要设计确认。
- **同编码规则的测量余量（批次 B 修正评审，需设计确认）。**
  - 余量 1.05 来自实测：AAC 的流码率比名义码率高约 0.03%–1.6%，Ogg Opus 的文件总码率高约 2%。
  - 它不能覆盖 VBR 源与名义码率之间随内容变化的偏差。例如 LAME V2 制作的 MP3 在复杂音乐上平均可能有 200–220 kbit/s，再转「标准」（名义 190k）时仍会以 V2 重新编码，体积基本不变。若希望同档的 VBR 输出也稳定跳过，需要更大的余量，或读取 LAME 标签中的 VBR 质量，请在 design §7b 写明。
  - 单声道 MP3 的名义码率沿用立体声的值，偏高，所以单声道 MP3 更倾向于复制。
- **顶后声道在下混中丢失（批次 B 修正评审，写集外的限制）。**
  - swresample 没有顶后声道（TBL/TBR）的混音规则：5.1.4、7.1.4 等布局转 ALAC（7.1(wide)），或转 Opus、AAC、FLAC 时下混到 7.1，顶后声道的内容都会丢失；顶前声道会混入前左、前右（实测）。
  - 要保留它们，需要按声道位置生成完整的 `pan` 矩阵，请在 design §5/§7b 中决定。
- **低采样率 AAC 的码率（评审补充）。** 高档单声道 128k 的 8 kHz、16 kHz 源超过 aac 每帧上限，编码器在 `level+warning` 日志中输出「Too many bits … clamping to max」后自动降到上限（实测输出正常）。T-ENGINE-07 不应把这条日志当作失败。
- **只能解码的编码（评审补充）。** Matroska 拒收清单来自随附 ffmpeg 能编码的格式。只能解码的少见格式（例如 DSD）没有实测，提取时仍写 .mka，可能失败。
- **写集外测试（重复列出，便于跟踪）。**（2026-10-28：video.test.ts 已由 T-ENCODE-02 的批次 B 修正更新，encode-real.test.ts 的类型错误也已不再出现，全部测试文件类型检查通过。）video.test.ts 的 30 项失败来自 T-ENCODE-03 的 `setparams`，需要由写集包含该文件的任务更新期望值；本任务没有加重（评审后重跑仍为 30 failed / 32 passed）。encode-real.test.ts（T-ENCODE-02）的 spawn `env` 有与本任务修复前相同的类型错误；它只在把测试文件纳入类型检查时出现，不影响运行，评审没有修改它（不在写集内）。

**未执行**

- 没有启动 Electron，没有运行全量测试。
- encode-real.test.ts 没有重跑（素材没有音轨，不受影响）。
- 没有真实测试的部分：FLAC/WAV/Ogg Vorbis 的 `chapters_dropped`（只有单元测试）；TrueHD/DTS 源（随附构建无法生成）。超过 48 kHz 的 MP3 不在测试套件中，评审另用临时脚本实测过（96 kHz 5.1(side) 转 MP3，输出 48 kHz 立体声）。
- 本任务新增的提示与确认码都是 T-ENCODE-01 已定义的码（`downmixed_to_stereo`、`lossy_to_lossless`、`cover_dropped`、`chapters_dropped`），没有修改 contract.ts。
