# 实施记录：T-ENCODE-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-ENCODE-01 |
| 日期 | 2026-10-26 |
| 验证版本 | snapshot-sha256:c2d906fc4c29918290e68a0c2aa3d33d18fbc21831470145fb220aeba77f42a3（基线 a742ec76 + 未提交工作树）。批次 C 修正的独立评审与修复（2026-10-28）后取得：在最后一次代码修改（`engine/executor.ts`、`executor.test.ts`）与 engine design §11 的修改、全部检查的重跑与证据写入之后，更新 T-ENGINE-05、T-ENGINE-06、T-ENGINE-07、T-ENCODE-01 四份记录并写入 FIXUP-C-check-spec.txt 之前；这些文件的这次改动未计入。工作树中还有其他任务的文件，快照包含它们。此时的文件 sha256 前 12 位：`engine/executor.ts` 7dfb9f0b1a3b，`executor.test.ts` 411a7588fa6e，engine design.md 681c032ce2a4；其余批次 C 修正改过的源文件与下述批次 C 修正时相同（`contract.ts` f088a18910e4，`queue/queue.ts` c62fc626049d，`queue/types.ts` e2d75d204f5f，`ipc.ts` 1345ed1d1f70，`plan/stream-plan.ts` 8b491a782e0b，`plan/types.ts` d1ee7cfded4c）。评审之前的验证版本与说明：snapshot-sha256:2f201d53b059332cb0e6f9dc79dd3d6616d307b1086a3746b5ff9dd816aea715（基线 a742ec76 + 未提交工作树）。批次 C 修正（2026-10-28）后取得：在最后一次代码修改、受影响检查的重跑与证据文件写入之后，更新 T-ENGINE-05、T-ENGINE-06、T-ENGINE-07、T-ENCODE-01 四份记录并写入 FIXUP-C-check-spec.txt 之前；这些文件的这次改动未计入。工作树中还有其他任务的文件，快照包含它们。此时批次 C 修正改过的文件 sha256 前 12 位：`contract.ts` f088a18910e4，`queue/queue.ts` c62fc626049d，`queue/types.ts` e2d75d204f5f，`engine/executor.ts` 7bbc95cfd44d，`ipc.ts` 1345ed1d1f70，`plan/stream-plan.ts` 8b491a782e0b，`plan/types.ts` d1ee7cfded4c，`queue.test.ts` 3804c62b1a5a，`executor.test.ts` 0961d9822a8e，`ipc.test.ts` 96a24113d1c4，`plan/stream-plan.test.ts` cafa28d8d09e，engine design.md dca0ac38db09，encode design.md 3e39a493f5dd。批次 C 修正之前的验证版本与说明：snapshot-sha256:6f79b2d5a82acad0248f85ab4bb88fc72928e92b2c0ba8ec50c35c14c6047f86（基线 a742ec76 + 未提交工作树）。批次 B 修正评审（2026-10-28）后取得：在评审的最后一次代码修改、受影响检查的重跑与证据文件写入之后，更新本记录及同批的 T-ENGINE-01、T-ENCODE-01～04 记录之前；这些记录文件的这次改动未计入。工作树中另有协调者对 spec 文档的未提交纠正（design、requirements、tasks、spec.json、changes/），以及其他任务的未提交文件。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；随附 ffmpeg/ffprobe n8.1.2-21-gce3c09c101-20260630（BtbN，LGPL），经 `verifyLocalSubtitleRuntimeBundle` 校验；RTX 4070 Ti SUPER（本任务未用 GPU 编码）。测试与临时实测中的 ffmpeg 一律以 IDLE（`PRIORITY_LOW`）运行，ffprobe 经 `MediaRuntime` 以 BELOW_NORMAL 运行；素材为 lavfi 生成的 ≤2 s、≤320×180 小样。评审复测与临时实测同样以 IDLE 运行，素材放在 scratchpad 或测试自己的运行目录中，用后删除。 |
| 任务指纹 | ba7fb764aa5aaaf6f82aa2d5b4c9ee3519d339b31be7cf059c1777fdd160d016 |

## 实际结果

本任务没有界面部分，不涉及截图。

**新增与修改的文件（均在写集内）**

- `src/media-converter/contract.ts`（在 T-ENGINE-01 的文件上追加，engine 部分未改结构，只更新了文件头注释）：
  - 计划原因码封闭枚举 `PLAN_REASON_CODES`：design §1 的 19 个码，外加 `chapters_dropped`（见差异 2）。`duration_unverified` 与 `output_name_collision` 复用 engine 枚举，不重复声明。
  - 子集 schema：警告（含两个复用的 engine 码）、跳过、不适用、错误、确认；`PLAN_LOSS_CODES` 标出表示内容丢失或变差的警告，供界面行内提示与开始前确认。
  - `ConversionSettings`：`compress` / `convert` / `extract-audio` 三种设置的 zod schema（strict）与类型。`DEFAULT_CONVERT_SETTINGS`、`DEFAULT_EXTRACT_AUDIO_SETTINGS`、`defaultCompressSettings(codec)`、`defaultConversionSettings(task, compressCodec)`。压缩的 `codec` 是必填字段，默认值由 T-ENCODE-02 的 `defaultCompressCodec(caps)` 提供，schema 中没有占位值。
  - 编码器 id（视频、音频、字幕转换）、能力变体键 `VARIANT_KEYS`（`8bit`、`10bit`、`8bit_uhq`、`10bit_uhq`、`8bit_sw`）、输出容器 id。
  - `PlanSummary` schema：任务、是否只换封装、编码器列表（按首次使用的顺序去重）、每个输出逐流的处理（复制/编码含编码器与变体/丢弃含原因）、附件与章节的去留、丢弃的数据流数、合并后的警告（含涉及的流与数量）、需确认项。
- `electron/main/media-converter/plan/types.ts`：`PlannerCapabilities`、`StreamRef`、`EncodeSpec`、`StreamDecision`、`OutputBaseName`、`PlannedOutput`、`ConversionPlan`、`PlanOutcome`（ready / skipped{already_target, 附完整计划} / not_applicable / error{附替代编码}）。
- `plan/matrix.ts`：输出容器表（muxer、扩展名、对应的源容器标识、faststart、能否保存章节与附件、muxer 选项）；视频与音频的可复制编码表；字幕处理规则；压缩容器「自动」；转换时的重编码编码；编码器到输出编码的对照；任务 × 媒体矩阵；容器标识比较。
- `plan/stream-plan.ts`：`buildPlan`。按任务矩阵判定；为每个输出逐流决定复制、编码或丢弃；写处置标记、MP4/MOV 的 `handler_name` 与 `hvc1`；计算期望时长、`-t` 上限、只换封装与 `+genpts`；调用 `caps.ts` 定上限；汇总警告与摘要；转换任务判定 `already_target`。视频与音频编码的选择是有类型的占位实现（见差异 11），分别由 T-ENCODE-02 到 T-ENCODE-04 替换。
- `plan/caps.ts`：`outputCapBytes`，实现 design §7 的上限与 `not_smaller` / `output_cap_exceeded` 语义。
- `plan/naming.ts`：基础名规则、Windows 清洗、按码点截断、`output_path_too_long`、track 命名与语言校验。
- `plan/args.ts`：`toFfmpegArgs(output, io)`。输入固定解复用器与 `file` 协议；逐流按绝对序号 `-map`；`-map_metadata 0`、`-map_chapters 0/-1`；逐流 `-c`、参数（自动加流说明符）、独立滤镜链；处置、流元数据、标签；`-max_muxing_queue_size 4096`、`-avoid_negative_ts make_zero`、`+faststart`、muxer 选项、`-fs`、`-t`；最后是 `-f <muxer> -y file:<partial>`。`videoArgs()` / `audioArgs()` 是组合点，目前是占位实现。公共前缀由进程封装加。
- 测试：
  - `test/media-converter/plan/stream-plan.test.ts`：67 项（评审后）。用 schema 校验过的 MediaInfo 构造器生成 7 个夹具（多音轨多字幕 + 字体 + 封面 + 数据流 + 章节的 MKV、无码率 MKV、竖屏 HEVC MOV、MP4、无声 MP4、FLAC、带封面和章节的 FLAC）。设置共 17 种。两张内联快照：一张是 119 种「夹具 × 设置」组合的结果、逐流处理、上限与警告；另一张是每个输出的完整参数，只省略固定的输入与输出路径。
  - `test/media-converter/plan/naming.test.ts`：15 项。
  - `test/media-converter/remux-real.test.ts`：5 项（评审后），用真实运行时。

**用真实 ffmpeg 核对的事实**（随附 n8.1.2，IDLE 优先级，素材在 scratchpad 中用后删除）

- Matroska 中的图片附件被 ffmpeg 当作 `attached_pic` 视频流读出。把它流复制进 MKV 后，写出的是一帧的 mjpeg 视频轨，而不是附件（`attached_pic=0`）。因此视频输出不复制封面，改为 `cover_dropped`。
- 不写处置标记时，ffmpeg 会给「同类型 ≥2 条且没有默认」的第一条流自动加默认标记。逐流写 `-disposition` 后，这一行为关闭，标记与源一致。
- MP4（mov muxer）保留语言、强制标记（kind 盒）和音轨默认标记，`handler_name` 可以写入。源没有默认字幕时，第一条字幕被标为默认。MP4 中的章节在重新探测时会多出一条 `bin_data` 数据流（章节文本轨）。
- E-AC-3 可以复制进 MOV 和 MP4。
- `-max_muxing_queue_size 4096` 不产生警告。重复的 `-fs` / `-t` 也不产生警告。

**V-ENCODE-01-3 实测结果**（评审后的 5 项；证据中附有保留运行目录的 ffprobe 输出，运行目录随后已删除）

- 源 MKV：H.264；两条 AAC（eng「Main audio」为默认，jpn「Commentary」带评论标记 `comment`）；一条强制 SRT（eng「Signs」）；两个章节；全局 title/artist/comment；一个 text/plain 附件。
- 转 MP4（`ready`，只换封装）：
  - 全局用户标签与章节（起止时间与标题）一致；
  - 音轨的语言、`handler_name`=源标题、默认与强制标记一致，评论标记保留；
  - 字幕为 mov_text，语言、强制标记一致，`handler_name`=Signs；第一条字幕被标为默认，与摘要中的 `mp4_default_subtitle_forced` 相符；
  - 没有附件，与摘要中的 `attachment_dropped` 相符。
- 转 MKV：计划判为 `already_target`；用附带的计划执行（即「仍然转换」）。全局标签、章节、音轨与字幕的语言、标题、默认、强制与评论标记一致，附件（文件名与 MIME 类型）保留。
- 再把该 MP4 转回 MKV：mov_text 变为 subrip，标记保留；MP4 的章节文本轨不会带进 MKV。
- 源改为没有默认音轨后转 MP4：摘要中有 `mp4_default_audio_forced`（流 1）；ffprobe 显示第一条音轨被标为默认，第二条保留评论标记。
- 所有运行的 stderr（`level+warning`）中都没有 `Invalid option`、`Error parsing option`、`auto-selecting format`、`only the last`。

**变异检查**（实现时的原始记录；每次只临时修改 `plan/*.ts` 中的一处，运行相关测试，然后还原；运行前后 6 个文件的 sha256 一致。评审后已在新代码上重跑，并另加 R1–R6，见「评审与修复」）。证据：file:records/i1/T-ENCODE-01-mutations.txt

| 变异 | 失败的测试数 |
| --- | --- |
| M1 `already_target` 不比较扩展名 | 1 |
| M2 不写 `handler_name` | 4（含真实 MP4 测试） |
| M3 不映射附件 `0:t?` | 7（含真实 MKV 测试） |
| M4 `not_smaller` 改为 99% | 3 |
| M5 「自动」忽略图形字幕 | 2 |
| M6 改用类型选择器映射（`0:a:0`） | 7（含真实 MP4 测试） |
| M7 不写音轨处置标记 | 3 |
| M8 按 UTF-16 单元截断 | 1 |
| M9 不去掉双向控制字符 | 2 |
| M10 mov_text 直接复制进 MKV | 2（含真实往返测试） |

**评审与修复（2026-10-26，独立评审）**

逐条对照 AC 阅读了写集内全部代码与测试，并用随附 ffmpeg 以 IDLE 优先级做了小样实测（scratchpad，用后删除）。发现与处理如下：

1. **（主要）提取音轨的输出上限按整个源计算。** 只换封装的捷径对音频输出同样生效：从 40 GB 影片中提取一条音轨（或「转换为音频格式」时复制音轨），上限为 42 GB + 16 MiB。engine 的预检用这个上限做按卷磁盘检查（`disk_space_low`），并在 FAT32 上拒绝超过 4 GiB 的上限（`file_too_large_for_volume`），所以几乎任何较大的视频都无法提取音轨到 U 盘，空间不足源体积的磁盘也会被拒绝。修复（`caps.ts`）：只有带视频的只换封装（或时长未知）才用「源体积 × 1.05」；不带视频时，复制的音轨按「采样率 × 声道 × 4 字节（64 位样本按 8 字节）× 时长 × 1.2」计算，并且不超过「源体积 × 1.05」。不采信探测到的码率（FK-PIT-0042）：任何音频编码都达不到这一 PCM 上界。
2. **（主要）处置标记写成绝对值，会清掉探测不报告的源标记。** 例如 `default`、`0`。实测：MKV 中带 `comment`（评论音轨）、`visual_impaired`（口述影像）、`original` 的音轨，按原计划转 MKV 后这些标记全部丢失。修复（`stream-plan.ts`）：改为相对于源标记的写法，例如 `+default-forced`、`-default+forced-hearing_impaired`。ffmpeg 先复制源标记再应用相对修改，所以默认、强制与听障标记仍与探测结果一致，其他标记保留。逐流写处置标记的作用不变，仍会关闭 ffmpeg 自动加默认标记的行为。真实测试中，源的第二条音轨加了 `comment` 标记，MKV→MP4、MKV→MKV、往返三次运行都比较了这个标记。
3. **（主要）AC-ENCODE-01-4 的「音轨默认标记一致」在一类常见源上不成立，且没有提示。** 实测：源中没有默认音轨时（MPEG-TS、AVI、FLV 本身没有这个标记，有的 MKV 也没有），mov muxer 会把第一条音轨标为启用，与字幕的情况相同。修复：在 `contract.ts` 的封闭枚举中增加仅提示用的 `mp4_default_audio_forced`（不属于 `PLAN_LOSS_CODES`）。输出为 MP4/MOV 视频、保留了音轨且没有一条为默认时，在开始前的摘要中注明。单音轨的音频输出不提示。真实测试新增一项：把源改为没有默认音轨后转 MP4，摘要中有这个码，ffprobe 显示第一条音轨被标为默认。
4. **（次要）复制的封面没有计入上限。** 只有 16 MiB 余量，所以一个 4 分钟、内嵌 20 MB 扫描封面的 FLAC 转 MP3 时，会因 `output_cap_exceeded` 失败。修复：音频输出中复制的封面按「宽 × 高 × 8 字节」计，并且不超过源体积；尺寸未知时按源体积计。
5. **（次要）提取音频时可能与源同名。** 例如 Ogg（Theora + Vorbis）视频提取原音轨，会得到与源同名的 `.ogg`，engine 随后会报 `output_is_input`。修复（`naming.ts`）：`source` 规则与 `converted` 相同，输出到源文件旁且扩展名与源相同时加 `-converted`。
6. **（次要）源码中有不可见的双向控制字符。** `naming.ts` 的 `BIDI` 正则与 `naming.test.ts` 直接写入了 U+200E、U+202E 等字符，属于 Trojan Source 风险，GitHub 也会警告。修复：全部改为 `\u` 转义，行为不变。
7. **已核对、无需修改：**
   - 显式映射与输出流序号；
   - MKV 图片附件写回时会变成视频轨（重新实测确认，所以丢弃并附 `cover_dropped` 是正确的）；
   - E-AC-3 可以复制进 MOV；
   - `srt` 与 `subrip` 编码器都存在；
   - 命名的截断与保留名；
   - 任务矩阵与 `already_target`；
   - 参数中没有路径或协议注入：输入固定为 `-f <demuxer> -protocol_whitelist file -i file:`，由 engine 的 `assertGuardedInputs` 复核；
   - 测试没有空跑：真实测试 5 项全部执行，没有跳过。

变异检查：原有 M1–M10 在评审后的代码上重跑，全部被捕获。评审另加 R1–R6，每个修复各一个变异（改回绝对处置标记、去掉音轨默认提示、音频只换封装按源体积、复制音轨不设 PCM 上界、`source` 规则不加后缀、封面不计入上限），全部被捕获，其中 R1、R2 也被真实 ffmpeg 测试捕获。还原后 7 个文件的 sha256 不变。证据：file:records/i1/T-ENCODE-01-mutations.txt。

**与设计的差异**：摘要如下，详见下文「风险与未执行项」。

- 按绝对序号映射；
- 新增 `chapters_dropped`；
- 上限统一加 16 MiB 余量；不带视频的复制音轨按 PCM 上界计，复制的封面按像素计（评审）；
- 新增仅提示用的 `mp4_default_audio_forced`（评审）；
- 处置标记相对于源标记写入（评审）；
- 提取音频的 `source` 规则在源旁同扩展名时加 `-converted`（评审）；
- 类型字段有扩充；
- `already_target` 还比较扩展名；
- 视频输出丢弃封面；
- 数据流静默丢弃。

**批次 B 修正（2026-10-28）**

依据 changes/2026-10-26-batch-b-spec-corrections.md 与 design §7b「输出上限」：

- `plan/caps.ts`：重新编码视频的上限改为 max(源体积 × 4, 1.0 bpp × 像素速率 × 时长) × 1.05 + 16 MiB（`CAP_POLICY` 的 `videoBitsPerPixel` 1.0、`videoSourceFactor` 4、`videoMargin` 1.05），替代原来的 max(源体积, 0.15 bpp …)。原因：MF 等编码器在「画质优先」档对细节多的画面实测约 1.6 bpp，超过 0.15 bpp 的上限，任务会以 `output_cap_exceeded` 失败。其他公式不变（只换封装、有损音频、PCM/FLAC/ALAC、时长未知、不变大）。
- 与 design 公式的一处差别：音轨码率仍加在像素一项上，即 max(源体积 × 4, (1.0 bpp × 像素速率 + 音频码率) × 时长) × 1.05 + 16 MiB。音频码率的取法不变：重新编码的取 `maxBitRate`，复制的取流码率，码率未知的复制音轨合计按文件总码率计一次。这只会让上限更宽：低分辨率画面配多声道重编码音频时，按 design 原式可能误触上限。变异 M7 表明测试能区分两种写法；如果 design 要求严格不含音频，删去这一项即可。
- ALAC 的上限按输出声道数计算。T-ENCODE-04 的批次 B 修正后，quad 输出 5.0、2.1 输出 5.1，声道数可能多于源；输出声道数由 audio.ts 的 `alacChannels` 给出。
- `plan/stream-plan.ts`：转为音频格式时，把「文件中只有这一条音轨」时的文件总码率传给 `planAudioFormat`，供 T-ENCODE-04 的同编码规则使用（见 T-ENCODE-04 记录）。
- 测试（`plan/stream-plan.test.ts`）：
  - 上限用例改为新公式：1 GB 源取 4 GB × 1.05 + 16 MiB；1 MB 源取像素一项；在「源体积 × 4 = 像素一项」两侧各取一点，分别由两项决定。
  - 组合快照只有 15 行的 `-fs` 变化：重新编码视频的输出由 1016777216、1125563774、1129091774 变为 4216777216。用脚本比对，去掉 `-fs` 数值后，变化前后的行完全相同；同一用例第二张快照中的每个 `cap=` 都与第一张的 `-fs` 一致。确认后才用 `-u` 更新这一个用例。
  - 「已是目标格式」用例的 MP3 与 Ogg Opus 夹具改为写明文件总码率（128k、96k），因为夹具默认的 133 Mbit/s 是视频文件的码率。新增「同编码、目标码率更低时重新编码，不判为已是目标格式」用例，以及 ALAC quad、2.1 的上限用例。
- 变异检查（file:records/i1/T-ENCODE-01-batchb-mutations.txt）：改回 0.15 bpp 与 1 × 源体积时 4 项失败；去掉音频一项时 2 项失败；写回后 sha256 一致。
- 回归：test/media-converter 下全部 14 个测试文件，581 项通过（file:records/i1/T-ENCODE-01-batchb-full.txt）。

**批次 B 修正评审（2026-10-28）**

- 独立评审核对了 caps.ts 的新公式与 design §7b：
  - 重新编码视频的上限为 max(源体积 × 4, (1.0 bpp × 输出像素速率 + 音频码率) × 时长) × 1.05 + 16 MiB。
  - 像素速率用缩放后的输出宽高与源的平均帧率，帧率未知时取 60 fps；尺寸未知时像素一项为 0，只剩源体积 × 4；时长未知时为源体积 × 4 + 16 MiB。
  - 其他公式未改；ALAC 按输出声道数计算。
  - stream-plan.test.ts 在两项交界的两侧各测一点；组合快照只有 `-fs` 变化（4216777216 = 4 GB × 1.05 + 16 MiB，已核对）。
- 与 design §7b 字面的差异保留，已列入风险，需设计确认：音频码率仍加在像素一项上，只会放宽上限。
- `soleTrackBitRate` 核对无问题：只有一条音轨、没有视频与封面的音频文件才用文件总码率。
- 本任务的文件没有修改。同批评审在 audio.ts 中为同编码规则加了测量余量，在 video.ts 中去掉了 NVENC 的旧下限（见 T-ENCODE-04、T-ENCODE-02 记录），所以按最终工作树重跑了本任务的检查：V-ENCODE-01-1 69 passed，V-ENCODE-01-4 两项 tsc 都没有诊断，test/media-converter 全目录 582 passed（file:records/i1/T-ENCODE-01-batchb-full.txt，已覆盖）。

**批次 C 修正（2026-10-28）**

T-ENGINE-07 的测试发现：裸 H.264（`.h264`）重封装为 MP4 时，ffmpeg 报「Timestamps are unset」，进度一直是 `N/A`，执行器判为 `encode_failed`。这次在本任务的规划中修正。本任务写集内改了 `plan/stream-plan.ts`、`plan/types.ts`（只改了注释）与 `plan/stream-plan.test.ts`；端到端用例在 executor.test.ts 中（见 T-ENGINE-07 记录）。设计回写见 encode design §7b「批次 C 修正」。

- **实测**（随附 n8.1.2，IDLE 优先级，2 s lavfi 小样，证据见 file:records/i1/FIXUP-C-raw-streams.txt）：
  - 探测白名单只接受三种裸视频流的解复用器：`h264`、`hevc`、`mpegvideo`。`m4v`、`obu`、`vvc` 不在白名单中，ffprobe 报 `Format not on whitelist`，探测返回 `container_not_allowed`。
  - 裸 H.264/HEVC 的数据包没有任何 pts/dts。下列做法都无法让复制产生时间戳：
    - 修正前的规划参数（`-fflags +genpts`）；
    - 在输入前加 `-r 30` 或 `-framerate 30`；
    - `-fflags +genpts+igndts`；
    - `setts=ts=N*DURATION` 码流过滤器：DTS 不单调。

    结果是：MP4 写入猜测的时间戳并警告，有 B 帧时每个包都报 `pts has no value`；Matroska 直接拒收（exit -22）；`out_time` 始终为 `N/A`。
  - 裸 MPEG-2（`mpegvideo`）由解析器给出 dts。加 `-fflags +genpts` 后能复制进 MKV，60 帧逐帧哈希一致；不加时 Matroska 同样拒收。
  - 重新编码可行：解码会给每帧时间。H.264（NVENC，带 B 帧）转 libopenh264 MP4、kvazaar HEVC 转 SVT-AV1 MKV，都是 60 帧、2.0 s。
- **选择与理由。** 复制方案在这个 ffmpeg 版本中都不可行，只有重新编码稳定可行。所以只要源的解复用器是 `h264` 或 `hevc`，视频一律重新编码（新增常量 `UNTIMED_VIDEO_DEMUXERS`）：
  - 「转换格式」即使开启了「优先只换封装」也是如此，编码按 AC-ENCODE-01-7 的目标表选择：MP4/MOV 用 H.264 降级链，MKV/WebM 用 AV1；
  - 判断依据是解复用器而不是编码，容器中的 H.264/HEVC 照旧只换封装。

  `GENERATE_PTS` 去掉了 `h264` 与 `hevc`，只保留 `avi` 与 `mpegvideo`。重新编码带来的画质损失按档位控制，与其他需要重新编码的转换相同。
- **测试。** stream-plan.test.ts 新增「裸 H.264/HEVC 重新编码，裸 MPEG-1/2 以 +genpts 复制」：
  - 两种裸流 × MP4/MOV/MKV/WebM × 是否优先只换封装，都是 encode（libopenh264 或 libsvtav1）。计划非只换封装，`generatePts` 为 false，参数中没有 `-fflags`，以 `-f h264` 或 `-f hevc` 开头。
  - 有 NVENC 时改用 h264_nvenc；HEVC 压缩用 libkvazaar，并附 `duration_unverified`。
  - 容器中的 H.264/HEVC 照旧只换封装。
  - 裸 MPEG-2 转 MKV 为 copy，带 `-fflags +genpts -f mpegvideo`；转 MP4 为 encode。

  共 70 项通过。真实 ffmpeg 的端到端证据见 T-ENGINE-07 记录：转 MP4、转 MKV、压缩各自成功，帧数与时长正确。
- **变异。** M12 把规划恢复为修正前的代码，stream-plan.test.ts 与 executor.test.ts 的新用例都失败（file:records/i1/FIXUP-C-mutations.txt）。

**评审与修复（批次 C 修正的独立评审，2026-10-28）**

评审复核了 F6 的三处改动：`plan/stream-plan.ts` 的修正、`plan/types.ts` 的说明，以及 encode design §7b 的条目。本任务的文件未改动。

- **结论成立。** 裸 H.264/HEVC 的数据包没有时间戳，复制无法补齐；重新编码时由解码给出时间。按 AC-ENCODE-01-7，「流不兼容」时重新编码，选择的编码与转换表一致。
- **补充证据。** 带 B 帧的裸 H.264（h264_nvenc 生成，VUI 为 30 fps）经真实的规划器与执行器处理：转为 MP4、转为 MKV、按 HEVC 压缩，三种都是 60 帧、2.0 s（file:records/i1/FIXUP-C-raw-streams.txt 末尾）。
- **发现但未修改（记入风险）。** 探测对裸流报告的 fps 是解复用器假定的 25。openh264 的码率与 GOP 都按它计算，所以源的 VUI 为 30 fps 时，码率约低 17%。
- 重跑：V-ENCODE-01-1 70 项、V-ENCODE-01-2 15 项、V-ENCODE-01-3 5 项通过，V-ENCODE-01-4 无诊断。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ENCODE-01-1 | 通过 | file:records/i1/T-ENCODE-01-stream-plan.txt |
| V-ENCODE-01-2 | 通过 | file:records/i1/T-ENCODE-01-naming.txt |
| V-ENCODE-01-3 | 通过 | file:records/i1/T-ENCODE-01-remux-real.txt |
| V-ENCODE-01-4 | 通过 | file:records/i1/T-ENCODE-01-tsc.txt |

- V-ENCODE-01-1：（批次 B 修正评审后重跑，证据已覆盖：69 passed，exit 0；批次 B 修正后同为 69 passed，评审后为 67 passed）。批次 B 的变化：重新编码视频的上限按 design §7b 的新公式，同编码的音频转换按 T-ENCODE-04 的新规则，ALAC 上限按输出声道数；组合快照只有 `-fs` 变化（见实际结果）。用例覆盖：多音轨多字幕（文本、带样式的 ASS、PGS）；字体附件；数据流；封面；MP4/MOV/MKV/WebM 逐流的处理与丢弃原因（含 MP4 的完整参数数组）；不出现 `-map 0` 或类型选择器，且主视频取探测结果（静止图在前时也正确）；元数据、章节、相对于源标记的处置标记、`handler_name`、`mp4_default_subtitle_forced` 与 `mp4_default_audio_forced`；`hvc1` 与 faststart；MP4 的 mov_text 与 EIA-608 转 MKV 时变为 srt；压缩容器「自动」9 种情况与显式选择；无码率 MKV（H.264+AAC）转 MP4、MOV 转 MP4 都只换封装；MKV 转 WebM、.m4v 转 MP4、名为 .mp4 的 TS 都不跳过；MP4 转 MP4 判为 `already_target`，且附带计划；任务矩阵 16 格逐格；上限与 `not_smaller` 语义（不变大、关闭保护、只换封装、视频复制加音频重编码、不带视频的复制音轨按 PCM 上界、复制封面按像素、PCM/FLAC/ALAC/有损、时长未知、`-t`）；119 种组合 × 2 张能力表 × 3 档在冻结输入下各调用两次，结果一致；两张内联快照。
- V-ENCODE-01-2：（评审后重跑：15 passed，exit 0）。覆盖：非法字符与控制字符；末尾的点和空格（包括截断后新出现的）；全部双向控制字符；保留设备名（大小写、上标数字、CONIN$、后跟空格或 `.track`）；按码点截断，不拆代理对；恰好 240 与超出 1 个字符；截断时保留任务后缀与扩展名；截断后不足 16 字符时返回 `output_path_too_long`，正好 16 字符时通过；短名称能放下时不拒绝；track 命名与 lang 校验；`-converted` 只在源旁且扩展名不变时添加（转换与提取的 `source` 规则都是如此）。
- V-ENCODE-01-3：（评审后重跑：5 passed，没有跳过，exit 0；运行后 `test-results/media-converter` 为空）。源 MKV 符合检查要求（H.264，两条带标题的 AAC 其中一条默认、另一条带评论标记，强制 SRT，两个章节）。转 MP4 与转 MKV 后，用 ffprobe 比较了 AC-ENCODE-01-4 规定的字段，以及评论标记；另比较了 MP4 转回 MKV，以及源没有默认音轨时 MP4 的第一条音轨被标为默认（与摘要的 `mp4_default_audio_forced` 一致）。附保留运行目录时 6 个文件的 ffprobe 输出，该目录随后已删除。
- V-ENCODE-01-4：（批次 B 修正评审后重跑：`pnpm exec tsc --noEmit -p tsconfig.json` 没有诊断，exit 0）。测试文件不在 tsconfig 的 include 中，另用继承该配置的临时配置检查了 test/media-converter 下的全部测试文件，同样没有诊断。
- V-ENCODE-01-2、V-ENCODE-01-3 不受批次 B 修正影响，证据文件保持评审后的重跑结果；两者在批次 B 修正评审后的全目录回归（582 passed）中同样通过（file:records/i1/T-ENCODE-01-batchb-full.txt）。
- 批次 C 修正（2026-10-28）后，四项检查都已重跑，新输出追加在证据文件末尾，原内容保留：
  - V-ENCODE-01-1：70 passed，新增用例见实际结果「批次 C 修正」；
  - V-ENCODE-01-2：15 passed；
  - V-ENCODE-01-3：5 passed，没有跳过；
  - V-ENCODE-01-4：两项 tsc 都没有诊断。
  - 全部非 Electron 的 media-converter 测试 691 项通过（file:records/i1/FIXUP-C-vitest.txt）。
- 评审与修复（2026-10-28，批次 C 修正的独立评审）后，四项检查都已重跑（本任务的文件未改），新输出追加在证据文件末尾：
  - V-ENCODE-01-1：70 passed；V-ENCODE-01-2：15 passed；V-ENCODE-01-3：5 passed，没有跳过；
  - V-ENCODE-01-4：两项 tsc 都没有诊断；
  - 全部非 Electron 的 media-converter 测试 692 项通过（file:records/i1/FIXUP-C-vitest.txt 末尾）。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ENCODE-01-1 | 通过 | V-ENCODE-01-1 |
| AC-ENCODE-01-2 | 通过 | V-ENCODE-01-1, V-ENCODE-01-3 |
| AC-ENCODE-01-3 | 通过 | V-ENCODE-01-1, V-ENCODE-01-3 |
| AC-ENCODE-01-4 | 通过 | V-ENCODE-01-3, V-ENCODE-01-1 |
| AC-ENCODE-01-5 | 通过 | V-ENCODE-01-1 |
| AC-ENCODE-01-6 | 通过 | V-ENCODE-01-1 |
| AC-ENCODE-01-8 | 通过 | V-ENCODE-01-1 |
| AC-ENCODE-06-1 | 通过 | V-ENCODE-01-1 |
| AC-ENCODE-06-2 | 通过 | V-ENCODE-01-1, V-ENCODE-01-3 |

AC-ENCODE-01-4 补充：评审补上一条规则。源文件没有默认音轨时，MP4/MOV 会启用第一条音轨；计划摘要中用 `mp4_default_audio_forced` 注明这一点，处理方式与字幕相同。这是对 AC 的补充，见差异 14。

- AC-ENCODE-06-2（批次 B）：音频同编码转换只有在直接复制时才判为已是目标格式；目标码率低于源码率时重新编码，不再跳过（AC-ENCODE-04-5 已纠正）。批次 B 修正评审后，源码率不超过目标名义码率的 1.05 倍时视为不高于目标，所以同档的输出再转同档仍判为已是目标格式（见 T-ENCODE-04 记录）。
- AC-ENCODE-06-1：计划部分：上限为源体积的 98%，语义为 `not_smaller`；关闭保护后改用 `output_cap_exceeded` 公式。触顶或完成后比较体积、不发布、删除临时文件，按 tasks.md 由 T-ENGINE-07 做端到端验证

## 风险与未执行项

**与设计的差异，以及设计未写明处采用的做法**（未修改设计文档）

1. **映射。** 所有流都按绝对序号映射（`-map 0:<index>`），主视频取 `MediaInfo.primaryVideoIndex`，而不是字面上的 `0:V:0`。原因是：平均帧率为 0/0 的静止图排在前面时，探测不把它当主视频，但 ffmpeg 的 `V` 会选中它。AC 要求的「显式映射、不用默认映射、不用 `-map 0`」都满足。
2. **新增原因码 `chapters_dropped`。** AC-ENCODE-04-3 要求目标格式会丢章节时（FLAC、WAV、Ogg Vorbis）在开始前提示，但 design §1 的列表中没有对应的码。T-ENCODE-04 的写集不含 contract.ts，所以在本任务一次定义。
3. **上限。**
   - 所有 `output_cap_exceeded` 上限统一加 16 MiB 余量（design §7 只有「只换封装」一行带这个余量）。原因是探测不提供封面、字体和标签的大小，例如一段带 1 MB 封面的 30 s MP3 会超过「码率 × 时长 × 1.2」。
   - 重编码视频时，码率未知的复制音轨合计按源总码率计一次。
   - design 表中没有「视频复制 + 音频重编码」这一行，按「源体积 × 1.05 + 音频上限」处理（评审后：复制的音轨已包含在源体积中，不再另计）。
   - （评审）「只换封装：源体积 × 1.05」只用于带视频的输出，以及时长未知的情况。不带视频时，复制的音轨按「采样率 × 声道 × max(4, 样本字节) × 时长 × 1.2」计，且不超过「源体积 × 1.05」。design §7 没有提取音轨这一行，原先的写法会让从大视频中提取音轨的上限等于整个源。
   - （评审）音频输出中复制的封面按「宽 × 高 × 8 字节」计，不超过源体积；尺寸未知时按源体积计。
4. **类型扩充。**
   - `PlannedOutput` 在 design §1 字段之外增加了：`container.id`、`container.options`、`durationLimitUs`、`attachments`、`chapters`、`dataStreams`、`metadata`、`remux`、`generatePts`。
   - 保留的流增加了 `outputIndex`、`disposition`、`metadata`、`tag`。
   - `EncodeSpec` 增加了 `filters`、`maxBitRate`、`frame`。`params` 是「选项名, 值」对，由 args.ts 加上 `:<类型>:<序号>`。
   - `container.baseName` 是命名规则 `OutputBaseName`，不是字符串。原因有两个：MediaInfo 中没有源文件名；`-converted` 与截断都取决于输出目录。最终文件名在执行时由 `naming.outputFileName` 得出。
   - `PlannerCapabilities.encoders` 用 Partial，缺省表示未检测到；`nvencMin` 的类型是数值，不是字面量。
5. **`already_target`。**
   - 除了容器标识相同，还要求源扩展名等于目标扩展名，所以 .m4v 转 .mp4、.m4b 转 .m4a 不会跳过。
   - 被丢弃的流（封面、数据流）不阻止跳过；任何编码（包括字幕格式转换）都会阻止跳过。
6. **只换封装的判定。** `isRemuxOnly` 的条件是「没有音视频或封面被编码」，文本字幕的格式转换不算。所以 MKV(SRT) 转 MP4 仍算只换封装，并带 `-avoid_negative_ts make_zero`。
7. **封面。**
   - 视频输出一律丢弃封面，并附 `cover_dropped`。design §2 的映射中没有封面；另外，Matroska 会把封面写成视频轨（已实测）。
   - MKV 源中的图片附件被 ffmpeg 当作封面读出，因此 MKV 转 MKV 时会丢失这些附件（附 `cover_dropped`；全部流复制时会先判为 `already_target`）。
   - 音频输出中，MP3、M4A、FLAC 保留 mjpeg/png 封面（`attached_pic`）；其他格式附 `cover_dropped`。
8. **数据流与非主视频流。**
   - 数据流不附警告，只在摘要的 `dataStreamsDropped` 中计数。原因：MP4 的章节会以 `bin_data` 数据流读出，iPhone MOV 也带 mebx 轨。如果当作「丢失」处理，几乎每个文件都会触发开始前确认。
   - 非主视频流记为 `not_selected`。
9. **MOV 可复制的音频。** 取 AC-ENCODE-05-1 的清单（aac、mp3、ac3、eac3、alac）与 design §2 表格（pcm_s16le、pcm_s24le）的并集。E-AC-3 进 MOV 已实测。
10. **字幕。**
    - MKV 直接复制有 Matroska CodecID 的字幕：subrip、text、ass、ssa、webvtt、dvd、pgs、dvb、hdmv_text。
    - mov_text、eia_608 转为 srt；无法解码的（如 dvb_teletext、xsub）附 `subtitle_dropped` 后丢弃。
    - 带样式的 ASS 转为 WebVTT 时，同样附 `subtitle_styling_lost`。
11. **占位实现**（T-ENCODE-02/03/04 替换，它们的写集包含 stream-plan.ts 与 args.ts）：
    - 视频重编码一律用该编码的 CPU 编码器（libsvtav1 10bit / libkvazaar / libopenh264），不带参数；
    - 音频在转换和压缩中都是「编码兼容就复制」，压缩任务的码率与无损规则尚未实现；
    - 有损编码用 ffmpeg 默认参数，输出上限按每对声道 320 kbit/s 估算；
    - WAV 与提取时的 PCM 按源位深选择；
    - 提取的「保持原音轨」按 AC-ENCODE-04-2 的表映射；
    - `videoArgs()` / `audioArgs()` 只组合 `EncodeSpec`。

    在这些任务完成前，压缩与重编码的结果不能作为生产质量。例如压缩 MKV 时，FLAC、TrueHD、DTS 仍会被复制。
12. **`-fs` / `-t` 由 `toFfmpegArgs` 写入。** 公式与 T-ENGINE-04 的 `outputLimitArgs` 相同。T-ENGINE-07 接线时只需用其中一个；重复写也不会产生警告（已实测）。
13. **处置标记相对写入（评审）。** `-disposition` 的值写成 `+default-forced` 这样的相对形式，而不是 design §2 隐含的绝对形式。这样默认、强制与听障标记与探测结果一致，探测不报告的源标记（评论、口述影像、原声等）得以保留（已实测）。封面仍写绝对值 `attached_pic`。
14. **新增提示码 `mp4_default_audio_forced`（评审）。** AC-ENCODE-01-4 只为字幕列出了 MP4 自动启用第一条轨道的例外，但实测音轨也一样。没有默认音轨的源（TS、AVI、FLV 等）转 MP4/MOV 时，这一项无法与源一致，所以按字幕的方式在摘要中注明，只用于提示，不需要确认。此码需要 workbench 的 i18n 文案；是否把它写进 design §1 与 AC-ENCODE-01-4，请设计负责人确认。
15. **提取音频的 `source` 命名规则（评审）。** design §6 中提取音频的基础名是 `{原名}`。评审改为与「转换格式」相同：输出到源文件旁且扩展名不变时加 `-converted`，避免 Ogg 视频提取 Vorbis 时与源同名而失败。
16. **其他。**
    - 摘要的 `encoders` 包含字幕转换器（mov_text、srt、webvtt）。
    - 快照用内联快照写在测试文件中，没有新建 `__snapshots__` 文件，以保持在写集内。

**潜在风险**

- **长时间多声道音轨提取到 FAT32。** 评审后，提取音轨的上限按 PCM 上界计算（不采信探测到的码率）。2 小时 5.1 声道 48 kHz 的音轨上限约为 9.95 GB，仍超过 4 GiB，所以在 FAT32 上仍会被预检拒绝，尽管 AC-3 音轨实际只有约 400 MB。如果要采信 BPS 标签或 MP4 按样本大小算出的码率，需要先确认探测码率在各种来源上的可信度（FK-PIT-0042）。
- **封面与视频输出。** mov muxer 可以把封面写成 `covr`，但 design §2 的映射中没有封面，所以 MP4 视频输出仍丢弃封面并附 `cover_dropped`，评审没有改动。
- **`srt` 编码器。** ffmpeg 源码中 `srt` 是 `subrip` 的旧名（标注为 deprecated）。随附的 8.1.2 两者都有，并且版本已固定，所以评审没有改名。如果升级运行时，建议改用 `subrip`。
- **MP4 转 MKV 的标题。** 探测只读 `title`，不读 `handler_name`。因此 MP4 转 MKV 时，标题只以 `HANDLER_NAME` 标签保留，不会变成 Matroska 的 title。MP4 的品牌标签（major_brand 等）也会作为全局标签带进 MKV，仅影响外观。
- **FLAC 与 ALAC 的上限。** design 规定 FLAC × 0.85、ALAC × 0.9。噪声类音频的压缩率可能接近 PCM，很长的此类文件即使加上 16 MiB 余量，仍可能触发 `output_cap_exceeded`。
- **`PlanOutcome` 的 error 分支。** 目前还没有产生方（`no_encoder_available`、`dolby_vision_p5_unsupported` 由 T-ENCODE-02/03 产生），因此没有被测试覆盖。
- **其他 kind 的字幕。** 无法解码的字幕（如 dvb_teletext）不参与压缩容器「自动」的判定。按 AC-ENCODE-01-8 会选 MP4，这些字幕被丢弃并附 `subtitle_dropped`。

**未执行项与运行环境说明**

- 没有运行全量测试，没有启动 Electron。
- 真实测试的运行目录建在 `test-results/media-converter/remux-*` 下，结束后删除（失败时同样删除）。为取证保留过一次运行目录（`FUSIONKIT_KEEP_TEST_RUNS=1`），读取 ffprobe 后已删除，`test-results/media-converter/` 现为空。
- 临时实测与变异脚本放在会话 scratchpad 中，实测素材已删除。没有提交任何二进制夹具。

**批次 C 修正后的说明（2026-10-28）**

- 裸 H.264/HEVC 现在总是重新编码。没有 VUI 计时信息的 H.264 按 ffmpeg 的默认 25 fps 计时；如果源实际是其他帧率，输出时长会按 25 fps 计算。这是裸流本身缺少信息造成的，复制也无法避免。
- 摘要通过 `remuxOnly: false` 与视频的 `encode` 动作说明了会重新编码，但没有专门的原因码说明「裸流无法只换封装」。如果界面需要单独解释，要在契约中新增警告码（workbench 或后续任务决定）。
- 只验证了 openh264、kvazaar、NVENC 生成的裸流，以及 mpeg2video 生成的裸 MPEG-2。其他编码器生成的裸流没有实测。

**评审后的说明（2026-10-28）**

- 裸流的 fps 不可靠：探测报告的 `avg_frame_rate` 是解复用器假定的 25。H.264 的 `r_frame_rate` 是场频，例如 VUI 为 30 fps 时报 60/1。openh264 的码率与 GOP 都按 25 fps 计算，源实际为 30 fps 时码率约低 17%、GOP 约 4.2 s，画质略低于同档位的预期。帧时间由解码按 VUI 给出，不受影响。要改进，需要在探测时读取 VUI 计时信息，或解码几帧来测量，留给 T-ENCODE-05 校准时评估。
