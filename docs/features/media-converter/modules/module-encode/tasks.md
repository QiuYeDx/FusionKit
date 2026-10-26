# encode 任务

每个任务块就是唯一的任务台账，不另外手写状态汇总表，总览由脚本生成。任务只引用需求与 AC 编号，不复制 AC 文本。

通用验证约定与 [engine 任务](../module-engine/tasks.md) 相同。规划器测试都是纯函数测试，不启动进程。真实编码测试只用测试时生成的 2 s 小样，以低优先级运行，日志级别为 `level+warning`。stderr 中出现 `Invalid option`、`Error parsing option`、`auto-selecting format` 或 `only the last` 即判为失败。

本模块的任务按 T-ENCODE-01 → 02 → 03 → 04 → 05 串行执行。`plan/args.ts` 与 `plan/stream-plan.ts` 由这几个任务依次修改。

### T-ENCODE-01 兼容矩阵、任务矩阵、流规划与参数骨架

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-ENCODE-01, R-ENCODE-06 |
| 验收 | AC-ENCODE-01-1, AC-ENCODE-01-2, AC-ENCODE-01-3, AC-ENCODE-01-4, AC-ENCODE-01-5, AC-ENCODE-01-6, AC-ENCODE-01-8, AC-ENCODE-06-1, AC-ENCODE-06-2 |
| 依赖 | T-ENGINE-01 |
| 写集 | electron/main/media-converter/plan/types.ts, electron/main/media-converter/plan/matrix.ts, electron/main/media-converter/plan/stream-plan.ts, electron/main/media-converter/plan/naming.ts, electron/main/media-converter/plan/args.ts, electron/main/media-converter/plan/caps.ts, src/media-converter/contract.ts, test/media-converter/plan/stream-plan.test.ts, test/media-converter/plan/naming.test.ts, test/media-converter/remux-real.test.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 按 design §1、§2、§6、§7 实现：
  - `ConversionSettings`（含默认值）、`PlanSummary`；
  - 原因码封闭枚举，一次定义完整；
  - `PlannerCapabilities` 类型；
  - 兼容矩阵、容器标识比较、任务矩阵、压缩任务的容器「自动」选择；
  - 显式映射、处置标记、MP4 的 `handler_name`、MKV 中 mov_text 转 SRT；
  - 只换封装；
  - `already_target`；
  - 输出上限与 `not_smaller` 语义；
  - 输出命名与清洗。
- `args.ts` 只负责组合：调用 `videoArgs()` 与 `audioArgs()`，两者由 T-ENCODE-02 到 T-ENCODE-04 实现；本任务先放占位实现。
- AC-ENCODE-06-1 中「触顶或完成后体积比较，然后不发布」的执行，在 T-ENGINE-07 的执行器测试中做端到端验证。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ENCODE-01-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/plan/stream-plan.test.ts。覆盖以下夹具：多音轨多字幕（文本、带样式的 ASS、图形）；字体附件；数据流；封面；目标为 MP4/MOV/MKV/WebM 时逐流的处理与丢弃原因；不出现 -map 0；元数据、章节、处置标记与 handler_name；hvc1 与 faststart；MP4 中 mov_text 转 MKV 时变为 srt；压缩任务的容器「自动」（带样式的 ASS 或 PGS 选 MKV）；无码率 MKV（H.264+AAC）转 MP4 只换封装；MOV 转 MP4 只换封装；MKV 转 WebM 不跳过；MP4 转 MP4 判为 already_target；任务矩阵 16 格；上限与 not_smaller 语义；同一输入多次调用结果一致 | - |
| V-ENCODE-01-2 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/plan/naming.test.ts。覆盖：非法字符；末尾的点和空格；双向控制字符；保留设备名；按码点截断；output_path_too_long；track 命名与 lang 校验 | - |
| V-ENCODE-01-3 | integration | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/remux-real.test.ts。用 lavfi 生成一个 MKV：H.264 视频，2 条带标题的音轨（其中一条为默认），1 条强制 SRT，2 个章节。分别只换封装为 MP4 与 MKV，用 ffprobe 对比 AC-ENCODE-01-4 规定的字段 | - |
| V-ENCODE-01-4 | static | required | pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-ENCODE-02 视频编码器选择链与参数表

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-ENCODE-02, R-ENCODE-01 |
| 验收 | AC-ENCODE-02-1, AC-ENCODE-02-2, AC-ENCODE-02-3, AC-ENCODE-02-4, AC-ENCODE-02-5, AC-ENCODE-02-7, AC-ENCODE-01-7 |
| 依赖 | T-ENCODE-01 |
| 写集 | electron/main/media-converter/plan/video.ts, electron/main/media-converter/plan/args.ts, electron/main/media-converter/plan/stream-plan.ts, test/media-converter/plan/video.test.ts, test/media-converter/encode-real.test.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 按 design §3 实现：
  - 参数表数据，集中在一个常量模块中，方便 T-ENCODE-05 校准；
  - hevc_nvenc 的 uhq/hq 分两行；
  - MF 使用 nv12 与 `-profile:v 100`；
  - kvazaar 参数用逗号分隔，宽高取 8 的倍数；
  - GOP 约 5 s；
  - openh264 的码率上限；
  - 三条降级链与尺寸前置条件；
  - `cpu_weak_encoder`、`no_encoder_available`；
  - 转换任务按目标容器选择编码；
  - `probeArgs`，与 `toFfmpegArgs` 共用同一份参数表。
- 按 design §4 实现：分辨率上限（按旋转后的短边计算，只缩小不放大，结果为偶数或 8 的倍数）与像素格式表。
- 真实编码测试不依赖能力探测模块：直接尝试每个编码器。如果 stderr 显示设备缺失（no_device 或 runtime_missing），记为跳过并写入测试输出。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ENCODE-02-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/plan/video.test.ts。覆盖：三种编码 × 三档 × 能力组合（全 NVENC / 仅 CPU / 仅 QSV / 仅 AMF / NVENC 降级）的参数快照；hevc_nvenc 选 uhq 时不出现 -bf；MF 参数含 nv12 与 profile 100；kvazaar 参数用逗号分隔；降级链顺序；10-bit 不可用时 HEVC 回退到 8-bit；108×192 跳过 NVENC；854×480 与 1920×804 用 kvazaar 时取 8 的倍数；竖屏 1080×1920 在 720p 上限下为 720×1280；不放大；转换为 WebM/MOV/MKV 时的编码选择；cpu_weak_encoder 与 no_encoder_available；defaultCompressCodec 的取值：任一 HEVC 硬件编码器可用时为 hevc，只有 CPU 编码器时为 h264 | - |
| V-ENCODE-02-2 | integration | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/encode-real.test.ts。在本机对 libsvtav1、av1_nvenc、hevc_nvenc（uhq 与 hq）、h264_nvenc、h264_mf（硬件与软件）、hevc_mf、libkvazaar、libopenh264 各按三档编码一次 2 s 小样。检查：输出都能解码；体积严格递减；编码、位深、profile（h264_mf 为 High）、GOP 约 5 s、hvc1 与 faststart 符合预期；level+warning 日志中没有禁止出现的模式；不可用的编码器记为跳过并写明原因 | - |
| V-ENCODE-02-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-ENCODE-03 视频正确性：旋转、色彩、HDR、VFR、隔行

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-ENCODE-03 |
| 验收 | AC-ENCODE-03-1, AC-ENCODE-03-2, AC-ENCODE-03-3, AC-ENCODE-03-4, AC-ENCODE-03-5 |
| 依赖 | T-ENCODE-02 |
| 写集 | electron/main/media-converter/plan/video.ts, electron/main/media-converter/plan/stream-plan.ts, test/media-converter/plan/video-correctness.test.ts, test/media-converter/encode-real.test.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

按 design §4 实现：

- 滤镜链顺序；
- `setparams` 写入色彩标记；源未标记时推定；
- 全范围源始终经 `scale=in_range=pc:out_range=tv`；
- HDR 判定表：保留时走 10-bit 链；需要色调映射时，缺标记就显式给出 tin/pin/min；
- 杜比视界：P5 或兼容 id 为 0 时拒绝；P7/P8 去掉 RPU；
- VFR 用 passthrough；
- 隔行加 bwdif；
- 4:2:2/4:4:4 转为 4:2:0。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ENCODE-03-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/plan/video-correctness.test.ts。覆盖：HDR10/HLG 输出 AV1 或 HEVC10 时保留且像素格式为 10-bit，输出 H.264 时做色调映射；DV5（传递特性未知）与兼容 id 为 0 时拒绝；DV8 去掉 RPU；色彩推定；pc 源在不缩放时也会转换；VFR 用 passthrough；隔行加 bwdif；4:2:2 转为 4:2:0；滤镜顺序快照 | - |
| V-ENCODE-03-2 | integration | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/encode-real.test.ts -t correctness。用真实小样检查：旋转 90° 的源重编后像素已旋转且没有显示矩阵，只换封装时保留显示矩阵；带 HDR10 标记与 MDCV/CLL 的 10-bit 小样转为 AV1 后，首帧侧数据中仍有 MDCV/CLL，转为 H.264 后为 bt709；pc 范围小样转换后 signalstats 的 YMAX ≤ 940（10-bit）；VFR 小样的时长误差在 max(0.1 s, 0.5%) 以内 | - |

### T-ENCODE-04 音频转换、提取与视频内音频

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-ENCODE-04, R-ENCODE-05 |
| 验收 | AC-ENCODE-04-1, AC-ENCODE-04-2, AC-ENCODE-04-3, AC-ENCODE-04-4, AC-ENCODE-04-5, AC-ENCODE-05-1, AC-ENCODE-05-2 |
| 依赖 | T-ENCODE-03 |
| 写集 | electron/main/media-converter/plan/audio.ts, electron/main/media-converter/plan/args.ts, electron/main/media-converter/plan/stream-plan.ts, test/media-converter/plan/audio.test.ts, test/media-converter/encode-audio-real.test.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

按 design §5 实现：

- 纯音频参数表（含单声道值）；
- 封面与标签处理；
- Opus 标准布局表：用 channelmap 改标签，或重混、下混；
- 采样率；
- 每条音轨使用自己的 `-filter:a:<n>`；
- 位深；
- 提取音频的映射（大端 PCM 输出 aiff，蓝光/DVD PCM 转为 WAV）与「全部音轨」的多输出；
- 有损转无损的确认标记；
- 编码相同且不提高码率时直接复制；
- 视频内音频的直通条件：转换任务与压缩任务分开判断，压缩任务回退读取 BPS。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ENCODE-04-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/plan/audio.test.ts。覆盖：六种格式 × 三档参数快照（含单声道）；提取的扩展名映射（含大端 PCM、pcm_bluray）；全部音轨与 lang 校验；Opus 处理 2.1/5.0(side)/5.1(side)/7.1(wide)/10 声道；MP3 下混；Opus 48 kHz；AAC 高于 48 kHz 时降采样；双音轨时每条有独立的滤镜链；有损转无损需要确认；编码相同不升码率时直接复制；视频内音频直通（转换任务与压缩任务、码率读 BPS） | - |
| V-ENCODE-04-2 | integration | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/encode-audio-real.test.ts。用 lavfi sine 生成带标签、PNG 封面和章节的 FLAC，检查：转 MP3 后有 ID3v2.3、APIC 和章节；转 M4A 后有标签和封面；转 Opus 后有标签和章节，并提示封面丢失；MP3/FLAC/Opus 中都没有源容器的品牌标签；提取 aac 时直接复制为 .m4a；提取大端 PCM 时得到 .aiff；5.1(side) 和 2.1 都能转为 Opus；5.1(side) 加立体声的双音轨视频转 MKV 成功 | - |
| V-ENCODE-04-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-ENCODE-05 真实样片校准与端到端验证

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-ENCODE-02 |
| 验收 | AC-ENCODE-02-6 |
| 依赖 | T-ENCODE-04, T-ENGINE-07 |
| 写集 | electron/main/media-converter/plan/video.ts, scripts/media-converter/calibrate.mjs, docs/features/media-converter/modules/module-encode/design.md |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- **前提（A-07）：** 用户提供 4–6 段真实样片，放在仓库和 `%TEMP%` 之外的文件夹，例如 `D:\FusionKit-media-samples\`。建议包含：
  - iPhone 竖屏 HEVC（最好是 HDR/杜比视界 8.4）；
  - 屏幕录制；
  - 动画；
  - 带颗粒的电影片段；
  - 游戏录像；
  - 一段从微信或社交平台下载的视频。

  这些文件只读，不入库。如果样片没有到位，经用户同意后可改用公开测试片，例如 Xiph 的 derf 集。
- **`scripts/media-converter/calibrate.mjs`：** 以低优先级运行，每段样片只取前 60 s。对每个可用编码器 × 每个档位：通过执行器编码，记录体积、VMAF v0.6.1 的均值与 p5、编码 fps，输出 CSV 与 Markdown 摘要。
- **调参：** 按 AC-ENCODE-02-6 调整参数表，写回 design §3，并在 record 中记录「旧值 → 新值」及原因。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ENCODE-05-1 | integration | required | node scripts/media-converter/calibrate.mjs <样片目录>（低优先级），生成 records/i1/calibration.csv 与 calibration.md，并按 AC-ENCODE-02-6 判定：三档体积严格递减；VMAF 中位数达到各档阈值；均衡档的非高度压缩样片输出都比源小 | - |
| V-ENCODE-05-2 | manual | required | 用户按 calibration.md 列出的文件对逐档观看，确认「均衡」档没有明显的画质损失，并记录主观评价 | - |
