# 实施记录：T-ENCODE-03

| 字段 | 值 |
| --- | --- |
| 任务 | T-ENCODE-03 |
| 日期 | 2026-10-26 |
| 验证版本 | snapshot-sha256:6f79b2d5a82acad0248f85ab4bb88fc72928e92b2c0ba8ec50c35c14c6047f86（基线 a742ec76 + 未提交工作树）。批次 B 修正评审（2026-10-28）后取得：在评审的最后一次代码修改、受影响检查的重跑与证据文件写入之后，更新本记录及同批的 T-ENGINE-01、T-ENCODE-01～04 记录之前；这些记录文件的这次改动未计入。工作树中另有协调者对 spec 文档的未提交纠正（design、requirements、tasks、spec.json、changes/），以及其他任务的未提交文件。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；随附 ffmpeg/ffprobe n8.1.2（BtbN，LGPL），经 `verifyLocalSubtitleRuntimeBundle` 校验；NVIDIA RTX 4070 Ti SUPER（NVENC 与 NVIDIA 的 MF 硬件 MFT）。测试中的 ffmpeg 一律以 IDLE（`PRIORITY_LOW`）运行并使用运行时的精简环境，ffprobe 经 `MediaRuntime` 以 BELOW_NORMAL 运行。素材都由 lavfi 在测试时生成，时长 ≤ 2 s、尺寸 ≤ 640×360，放在 `test-results/media-converter/encode-*` 运行目录中，测试结束后删除（每次运行后核对过没有遗留目录）。实现时与评审时的临时实测都用 scratchpad 中的包装脚本（spawn 后 `os.setPriority(PRIORITY_LOW)`）运行，素材放在 scratchpad。 |
| 任务指纹 | 3849b43571e57d5859d44a6a424b86728f4c55f1f45216a38e077ef0bca5ba79 |

## 实际结果

本任务没有界面部分，不涉及截图。

**修改的文件（均在写集内）**

- `electron/main/media-converter/plan/video.ts`：新增「Picture correctness」一节，按 design §4 实现。
  - `dynamicRangeOf`：按 `hdr.format` 与传递特性判定 SDR / PQ / HLG；杜比视界按基础层判定，有传递特性标记时以标记为准，没有时按兼容 id 推定（1、6 → PQ，4 → HLG，2 → SDR）。
  - `isUnsupportedDolbyVision`：Profile 5、兼容 id 为 0，或探测给出 `compatible: false` 时拒绝。`planVideoEncode` 在选编码器之前返回 `dolby_vision_p5_unsupported`，不生成参数，`alternatives` 为空。只换封装（视频复制）时不受影响。
  - `isVariableFrameRate`：沿用探测的 `isVfr`，但按 design §7a，场序为隔行且 r_frame_rate 约等于 avg_frame_rate 的 2 倍（容差 0.5%，与探测判定 VFR 的容差相同）时视为恒定帧率。
  - `pictureHandling`：为一个源和已选的编码配置决定 §4 的全部处理：去隔行、HDR 保留或色调映射、色调映射时 zscale 需要显式给出的输入参数、全范围转换、RGB 的转换矩阵、`setparams` 写入的色彩标记、色度降采样、VFR、去掉杜比视界 RPU。
  - `pictureFilters`：按 design §4 的顺序生成滤镜链：`bwdif` → zscale 色调映射 → `scale`（缩放、奇数修正、全范围或 RGB）→ 编码器像素格式 → `setparams`。旋转仍交给 ffmpeg 的 autorotate，规划器只用旋转后的宽高。
  - `videoEncodeSpec` 增加可选参数 `picture`：给出时使用上面的滤镜链，并在参数中追加 `-dolbyvision 0`（杜比视界源、libsvtav1）与 `-fps_mode passthrough`（VFR）。
  - `planVideoEncode` 附加警告 `hdr_tonemapped`、`dolby_vision_rpu_dropped`、`chroma_subsampled`，都只指向主视频流。
  - HDR 源「先找 10-bit 配置」的条件改为按动态范围判定，所以杜比视界 8.2（SDR 基础层）按普通顺序选择。
  - `scaleFilter` 改为可带转换参数、也可不带尺寸（只做范围或矩阵转换）。
  - 能力探测用的 `probeEncodeSpec` 改为对一张未标记的 1280×720 SDR 画面使用同一套处理，所以 `probeArgs` 末尾也有 `setparams`（BT.709），与生产中普通高清源的参数完全一致。
- `electron/main/media-converter/plan/stream-plan.ts`：只更新注释。错误结果原样经 `draftOutputs` 返回，`buildPlan` 得到 `{ status: 'error', reason: 'dolby_vision_p5_unsupported', alternatives: [] }`。
- `electron/main/media-converter/plan/types.ts`：`EncodeSpec.params` 的注释写明还可以带每条流的输出选项（`-dolbyvision`、`-fps_mode`）；`filters` 的注释写明 §4 的顺序。
- 测试：
  - `test/media-converter/plan/video-correctness.test.ts`（新增，29 项）。
  - `test/media-converter/plan/stream-plan.test.ts`：只更新组合快照。前后差异逐行核对过，正好 30 行，唯一变化是 `-filter:v:0` 末尾多了 `setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`。vitest 写回快照时用了 LF，已把文件统一回 CRLF。
  - `test/media-converter/encode-real.test.ts`：新增 `correctness (V-ENCODE-03-2)` 一组，共 8 项（评审后为 9 项）。

**滤镜链与选择规则（design §4）**

- **色彩标记**：`setparams=color_primaries=P:color_trc=T:colorspace=M:range=tv` 始终位于链末，每个标记各自处理：
  - 源有标记就照抄。只接受 setparams 与编码器都能写入的取值，`gbr`、`vgamut`、`vlog` 等视为未标记。
  - 未标记时，按显示后的短边推定：短边 < 720 为 `smpte170m`，否则为 `bt709`；尺寸未知时为 `bt709`。
  - HDR 保留时，未标记的部分写 BT.2020 与该类型的传递特性。
  - 色调映射后一律写 BT.709。
  - 范围一律写 `tv`。
- **全范围**：源为 `pc` 或像素格式为 `yuvj*`（不论容器的范围标记，评审 F1）时，无论是否缩放，都加 `scale=in_range=pc:out_range=tv`；需要缩放时合并到同一个 `scale`。
- **RGB 源**（`gbr` 矩阵，或 RGB/调色板像素格式）：`scale` 加 `out_color_matrix=<写入的矩阵>` 与 `out_range=tv`，矩阵按上面的规则推定，不照抄 `gbr`。
- **HDR10/HLG**：
  - 选中 10-bit 配置（AV1，或实测可用的 HEVC 10-bit）时保留：链中为 `format=yuv420p10le|p010le`，标记为 BT.2020 + PQ/HLG。MDCV/CLL 随帧由编码器写入。
  - 否则做色调映射：`zscale=t=linear:npl=100[:tin=..][:pin=bt2020:p=bt2020][:min=bt2020nc][:rin=..],format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv`，之后删除 MDCV/CLL 侧数据，再 `format=yuv420p`，附 `hdr_tonemapped`。
- **杜比视界**：Profile 5 或兼容 id 0 拒绝重新编码。Profile 7/8 按基础层处理；libsvtav1 加 `-dolbyvision 0`；附 `dolby_vision_rpu_dropped`。
- **VFR**：`-fps_mode passthrough`。隔行源 r ≈ 2 × avg 时不加。
- **隔行**：场序为 tt/bb/tb/bt 时，链首加 `bwdif=mode=send_frame:parity=auto:deint=interlaced`。
- **色度**：4:2:2、4:4:4（含 RGB）、4:4:0 由 `format` 转为 4:2:0，附 `chroma_subsampled`。

**用真实 ffmpeg 核对、并据此调整实现的事实**（证据：file:records/i1/T-ENCODE-03-ffmpeg-facts.txt）

1. **RGB 源的转换矩阵。** RGB 源不指定矩阵时，swscale 一律按 BT.601 转换，与 setparams 写的标记无关。1280×720 纯红的结果为 Y/U/V = 81/90/240（BT.601）；加 `out_color_matrix=bt709` 后为 63/102/240。所以 RGB 源要显式给出矩阵。
2. **色调映射后紧跟 `scale` 会偏色。** zscale 输出 RGB float 时，后面的 `scale` 会改由 swscale 做 RGB→Y′CbCr 转换，平均亮度从 112.55 降到 107.97，V 从 137.18 降到 133.10。所以色调映射段以 `format=yuv420p` 结束，让 zscale 自己写出 Y′CbCr；改后为 112.55/138.44/137.02，与不缩放时一致。
3. **未标记的 HDR 画面。** zscale 对未标记的画面报「no path between colorspaces」，只给 `tin/pin/min` 仍然报错。要同时给出 `p=bt2020`，因为输出原色默认取帧上原有的（未知）值。给全后，结果与先打标记的路径完全相同（112.67/138.35/136.91）。
4. **MDCV/CLL 会混进 SDR 输出。** 色调映射为 H.264 BT.709 后，MDCV/CLL 仍随帧进入输出：MP4 的流级与首帧都有。在最后一个 zscale 之后用 `sidedata=mode=delete` 删除即可；不能在 tonemap 之前删除，因为 tonemap 用它们推算峰值。
5. **全范围转换的实测。** 平滑亮度斜坡（源 YMAX 255）：不转换时 10-bit 输出 YMAX 1023；转换后为 937。如果源有硬边（testsrc2 加白块），有损编码的振铃会冲到 957，所以 V-ENCODE-03-2 用平滑斜坡测量。
6. **元数据偏低时的过冲。** testsrc2 的白在 PQ 中是 10000 cd/m²，MaxCLL 却写 1000，色调映射后无损输出 YMAX 253–254。按元数据把亮度压到约 1000 cd/m² 后为 211–216。真实测试的 HDR 源因此按元数据控制亮度，风险见下文。
7. **idet 的局限。** bwdif 实际有效（无损输出中 idet 判为 26/30 逐行）。但 libopenh264 在规划器码率（约 621 kbit/s）下的失真，会被 idet 读成场（30/30 TFF）；3 Mbit/s 或 AV1 时为 26/30 逐行。所以去隔行的真实测试改用 AV1。
8. **其他。**
   - `-dolbyvision:v:0 0` 与 `-fps_mode:v:0 passthrough` 按每流写法被接受，没有警告。
   - Matroska 中的 VFR 源，ffprobe 的 avg_frame_rate 等于 r_frame_rate，探测看不出 VFR。
   - 随附编码器都写不出 design §7a 所说的「r_frame_rate 为场率」的流，所以该规则只有单元测试。

**V-ENCODE-03-2 实测结果**（证据：file:records/i1/T-ENCODE-03-correctness-real.txt）

- **旋转**：源为 320×180，显示矩阵 rotation −90，播放时块在右上。
  - 重新编码为 AV1 后为 180×320，流和首帧都没有 Display Matrix，解码像素中的块在右上。
  - 只换封装为 MKV 时保持 320×180、rotation −90，播放方向不变。
- **HDR10 → AV1**（libsvtav1）：yuv420p10le，标记为 bt2020/smpte2084/bt2020nc/tv。首帧的 MDCV 与源首帧逐项一致：最大亮度 1000，最小亮度 2/16384，红 x 0.68；CLL 为 1000/400。
- **HDR10 → HEVC 10-bit**（hevc_nvenc uhq，本机实际编码，没有跳过）：Main 10，标记相同。MDCV 按 HEVC SEI 的步长写为 0.68/0.32/…/0.0001/1000，与源相差不超过一个量化步长；CLL 为 1000/400。
- **HDR10 → AV1（av1_nvenc uhq，评审补测）**：10-bit，标记相同；MDCV 为 0.68/0.32/…/0.0001/1000，CLL 为 1000/400。
- **HDR10 → H.264**（libopenh264）：yuv420p，标记为 bt709/bt709/bt709/tv，流与首帧都没有 MDCV/CLL，摘要含 `hdr_tonemapped`。各帧 Y 均值 106.6–107.6，YMAX ≤ 240。
- **全范围 → AV1 10-bit**：四个源的 YMAX 都 ≤ 940：
  - pc 斜坡：YMIN 63，YMAX 937；
  - 321×181 斜坡（与缩放合并的 `scale`）：YMIN 64，YMAX 937；
  - yuvj420p MJPEG：YMIN 67，YMAX 938；
  - 同一 MJPEG 重封装并标记 tv（评审补测）：YMIN 67，YMAX 938。修复前同类源为 1023。
- **VFR**：源为 MP4，r 30、avg 20。输出与源都是 40 帧，逐帧时间戳相差 ≤ 2 ms，时长 2 s → 2 s。
- **隔行**：源经 idet 判为 30/30 TFF；输出 30 帧，判为 26 帧逐行、4 帧 TFF（多帧检测的起始滞后），没有场序标记。

**对其他任务文件的影响（写集外，未修改）**

- `test/media-converter/plan/video.test.ts`（T-ENCODE-02 的 V-ENCODE-02-1）现在有 30 项失败。原因是 AC-ENCODE-03-2 要求每条视频滤镜链末尾都有 `setparams`，而这些用例逐字比较 `-filter:v:0 format=...`，包括设计行比较、两张快照、probe 快照与低占用用例。
- 证明：用 scratchpad 中的 vitest 配置，在内存中只去掉「追加 `setparams`」这一行（不改磁盘文件），同一个 video.test.ts 62/62 通过。证据：file:records/i1/T-ENCODE-03-regression.txt。
- 需要由写集包含 video.test.ts 的任务，把这些期望值改为带 `setparams` 的新值。本任务的 stream-plan.test.ts 快照就是这样更新的。

**评审与修复（独立评审，2026-10-26）**

评审逐项读了写集内 6 个文件的全部代码，对照 R-ENCODE-03 的 5 条 AC 与 design §4、§7a，并用随附 ffmpeg 核对规划器写出的每个选项值。证据：file:records/i1/T-ENCODE-03-review.txt。

- **F1（已修复，major）：`yuvj*` 源只在探测报告 `pc` 时才转换范围。** AC-ENCODE-03-2 要求「pc 或 yuvj*」的源一律经 `scale=in_range=pc:out_range=tv`。原实现只看 `colorRange === 'pc'`，靠 engine 探测在范围未标记时把 yuvj 推定为 pc。容器把 yuvj 流标成 `tv` 时，探测如实给出 `tv`，规划器就不转换；而 swscale 不管标记，仍把 yuvj 当全范围读取。实测：yuvj420p MJPEG 重封装并标记 tv 后，按原参数编码为 AV1 10-bit，YMAX 为 1023；加上转换后为 938。
  - 修复：`video.ts` 新增 `isFullRange`（`pc` 或像素格式以 `yuvj` 开头），`pictureHandling.fullRange` 与色调映射的 `rin` 都用它。这类源的色调映射也给出 `rin=pc`。
  - 测试：单元测试覆盖 yuvj 的 pc、tv、未标记三种范围标记，以及缩放、色调映射两种情况。顺序与范围性质检查增加一个标记为 tv 的 yuvj 源，共 12 × 3 × 6 = 216 种组合；期望值改为只由源推出（pc 或 yuvj*），不再引用 `pictureHandling` 本身。V-ENCODE-03-2 增加一个由 MJPEG 重封装并标记 tv 的源（`ramp-jpeg-tv`），实测 YMAX 938。
  - 在内存中撤销修复（变异 R1）后，单元测试有 2 项失败，真实测试在 `ramp-jpeg-tv YMAX: expected 1023` 上失败。
- **补强（minor）：AV1 硬件编码器保留 HDR 的实测。** AC-ENCODE-03-3 的「输出为 AV1」也包括打开「使用显卡加速」时的 av1_nvenc，原实测只有 libsvtav1。评审实测 av1_nvenc（uhq）保留了 MDCV/CLL 与 BT.2020/PQ 标记。原有的 hevc_nvenc 用例改为对 hevc_nvenc 与 av1_nvenc 各跑一次，并核对规划器选中的确实是该编码器的 `10bit_uhq`。V-ENCODE-03-2 因此由 8 项变为 9 项。
- **逐项核对、未发现问题的部分：**
  - 色彩标记：`TAG_VALUES` 中每个取值都被 setparams 接受；RGB 源保留 HDR 时写入的 `out_color_matrix=bt2020nc`，随附 scale 也接受。
  - 滤镜注入：所有选项值都来自白名单或常量，探测得到的字符串不会原样进入滤镜串。
  - 色调映射：未标记 HLG 转为 MF 像素格式、奇数尺寸 HDR10 转换后再缩放，两条滤镜链都能实际运行。
  - 杜比视界：随附 libsvtav1 有 `-dolbyvision` 选项。
  - 旋转、VFR、隔行，以及拒绝杜比视界 P5 时既不生成参数、也不给替代编码：与 AC 和 design 一致。
  - 测试：没有空转或静默跳过。NVENC 用例在装有 NVIDIA 驱动时不允许跳过；运行目录在测试结束后删除，每次运行后核对过 test-results/media-converter 下没有遗留目录。
  - 风格与相邻代码一致。
- **写集外、无法在本任务修复的问题**（见「风险与未执行项」）：video.test.ts 的 30 项失败；`rotate` 标签；MKV 中的 VFR；未标记源按短边推定的边界情况。

**批次 B 修正（2026-10-28）**

依据 changes/2026-10-26-batch-b-spec-corrections.md 与 design §7b「色彩推定」，AC-ENCODE-03-2 已纠正：

- `plan/video.ts`：未标记色彩的 SDR 源改为按显示后的尺寸推定：宽 ≥ 1280 或高 > 576 为 BT.709，否则为 BT.601（smpte170m）；尺寸未知时为 BT.709。推定函数导出为 `inferredSdrTag`。原规则「短边 < 720 为 BT.601」会把 1280×544 这类 720p 宽银幕裁切标成 BT.601，与 mpv 等播放器的推定相反，转换后颜色偏移。这正是本记录风险中评审提出的问题。
- `plan/video-correctness.test.ts`：色彩推定用例改写：
  - design 列出的尺寸：1280×544 → bt709，720×576 → bt601，1024×576 → bt601，768×1280（竖屏）→ bt709。
  - 两条边界的内外各一点：宽 1280 与 1278，高 578 与 576。
  - 按旋转后的显示尺寸判定：1024×576 横放、旋转 90° 后显示为 576×1024，为 bt709；576×1024 旋转 270° 后显示为 1024×576，为 bt601。
  - 尺寸未知为 bt709。
  - 滤镜顺序快照没有变化：快照中的未标记源（721×481、720×480、854×480）在新旧规则下都是 BT.601。
- `encode-real.test.ts`（V-ENCODE-03-2）新增真实检查：五个未标记的 libopenh264 小样（3 帧）经规划器转为 AV1，用 ffprobe 读回输出的原色、传递特性、矩阵与范围：1280×544 → bt709，1024×576 → smpte170m，720×576 → smpte170m，768×1280 → bt709，1024×576 加显示矩阵旋转 90° → bt709。
- 同批修正的影响：T-ENGINE-01 的修正让只有 `rotate` 标签的源旋转角为 0，本记录风险中「只有 rotate 标签的旋转」已解决。video.test.ts 的 30 项失败已由 T-ENCODE-02 的批次 B 修正更新期望值，现在 63 项全部通过。
- 变异检查（file:records/i1/T-ENCODE-03-batchb-mutations.txt）：改回「短边 < 720」规则后，单元测试 1 项、真实测试 1 项失败；写回后 sha256 一致。
- 回归：test/media-converter 下全部 14 个测试文件，581 项通过（file:records/i1/T-ENCODE-01-batchb-full.txt）。

**批次 B 修正评审（2026-10-28）**

- 独立评审核对了 `inferredSdrTag` 与 AC-ENCODE-03-2：
  - 用的是显示尺寸（`shownSize`，旋转 90° 或 270° 时交换宽高），不是存储尺寸。
  - 宽 ≥ 1280 或高 > 576 为 BT.709，否则为 smpte170m；尺寸未知（任一边为 0）为 BT.709。
  - 每个缺失的标记单独推定，已有的标记照抄。
  - 单元测试覆盖 design 列出的四种尺寸、两条边界的内外各一点、旋转后的显示尺寸（存储 1024×576 旋转 90° 为 BT.709，存储 576×1024 旋转 270° 为 BT.601）以及尺寸未知；真实检查读回五个未标记小样的输出标记。
  - 未发现问题，本任务的推定逻辑没有修改。
- 同批评审修改了 video.ts 中编码器的尺寸前置条件（见 T-ENCODE-02 记录），不影响色彩、HDR、范围与滤镜顺序。按最终工作树重跑：V-ENCODE-03-1 29 passed，V-ENCODE-03-2 10 passed（其余 16 项为 T-ENCODE-02 的用例，被 `-t` 过滤），两项 tsc 都没有诊断，test/media-converter 全目录 582 passed。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ENCODE-03-1 | 通过 | file:records/i1/T-ENCODE-03-correctness-unit.txt |
| V-ENCODE-03-2 | 通过 | file:records/i1/T-ENCODE-03-correctness-real.txt |

两项检查都在评审修复之后由评审重新运行；批次 B 修正（2026-10-28）及其评审后再次重跑，证据文件已用最新结果覆盖。

- **V-ENCODE-03-1**（批次 B 修正评审后重跑：29 passed，exit 0）。覆盖 tasks 要求的全部项目：
  - HDR10/HLG 输出为 AV1 或 HEVC 10-bit 时保留，像素格式为 10-bit；输出为 H.264、只有 8-bit HEVC（MF、kvazaar）时做色调映射；
  - DV5（传递特性未知）与兼容 id 0 被拒绝；DV8 去掉 RPU；
  - 色彩推定（批次 B 后为「宽 ≥ 1280 或高 > 576 为 BT.709」：两条边界、design 列出的四种尺寸、旋转后的显示尺寸、尺寸未知）；
  - pc 源不缩放时也转换；yuvj 源无论范围标记为 pc、tv 还是未标记，都转换（评审 F1）；
  - VFR 用 passthrough；
  - 隔行加 bwdif；
  - 4:2:2 转为 4:2:0；
  - 滤镜顺序快照（10 种组合，逐行人工核对）。

  另外覆盖：
  - 缺标记时 tin/pin+p/min/rin 的显式参数；
  - 色调映射前固定为 Y′CbCr、删除 MDCV/CLL；
  - RGB 矩阵；无效标记的处理；
  - 隔行 r ≈ 2×avg 及 0.5% 容差边界；
  - DV 7（兼容 id 6）、8.4、8.2；DV 只换封装时仍复制；
  - 216 种「源 × 能力 × 设置」组合（12 × 3 × 6，评审增加了标记为 tv 的 yuvj 源）的顺序与「全范围只转换一次」性质检查，全范围的期望值只由源推出；
  - 旋转不加 transpose，只换封装时复制视频；
  - probe 参数；警告只指向主视频流。
- **V-ENCODE-03-2**（批次 B 修正评审后重跑：10 passed，其余 16 项为 T-ENCODE-02 的用例，被 `-t` 过滤，exit 0）：结果见上文。批次 B 新增一项：未标记色彩按显示尺寸推定，五个小样的输出标记读回为预期值。评审新增两项实测：
  - HDR10 → av1_nvenc（uhq）：10-bit，BT.2020/PQ，MDCV/CLL 与源一致。
  - 标记为 tv 的 yuvj420p MJPEG：YMIN 67，YMAX 938。

  日志中的警告只有两条：libopenh264 的「bitrate can't be controlled…」，以及 yuvj 源时 swscale 的「deprecated pixel format used, make sure you did set range correctly」。都不属于禁止出现的模式（`Invalid option`、`Error parsing option`、`auto-selecting format`、`only the last`）。
- **补充：静态检查**（证据：file:records/i1/T-ENCODE-03-tsc.txt，批次 B 修正评审后重跑）：
  - `pnpm exec tsc --noEmit -p tsconfig.json`：没有诊断，exit 0。
  - 测试文件不在 tsconfig 的 include 中，另用继承该配置的 scratchpad 配置检查了 test/media-converter 下的全部测试文件：没有诊断，exit 0。
- **补充：回归**（批次 B 修正评审后：test/media-converter 全目录 582 项通过，video.test.ts 63 项全部通过，证据：file:records/i1/T-ENCODE-01-batchb-full.txt。以下为评审修复后的结果，证据：file:records/i1/T-ENCODE-03-regression.txt、file:records/i1/T-ENCODE-03-encode-real-full.txt）：
  - stream-plan、naming、video-correctness：112 passed。
  - video.test.ts：30 failed / 32 passed（原因与证明见上文）。评审用自己的内存变换配置复现了证明：只去掉追加 `setparams` 的那一行后，62/62 通过。
  - encode-real 与 remux-real 两个完整文件：30 passed，没有跳过。T-ENCODE-02 的 13 种编码配置 × 三档在加上 `setparams` 后全部通过；体积仍严格递减，与 T-ENCODE-02 表相比每个文件约多 20 字节（VUI 色彩描述）。尺寸范围用例也通过。
- **补充：变异检查**（证据：file:records/i1/T-ENCODE-03-mutations.txt，实现时运行；评审只补跑了针对 F1 修复的变异 R1，见 file:records/i1/T-ENCODE-03-review.txt）：
  - 18 种变异都在内存中施加，不改磁盘文件；运行前后 6 个写集文件的 sha256 一致。
  - 单元测试发现全部 18 种。
  - 真实测试对 6 种可测量的变异，直接在实测值上失败：
    - 不转换全范围：YMAX 1023；
    - 从不保留 HDR：输出不是 10-bit PQ；
    - 从不做色调映射：H.264 的标记不是 bt709；
    - 不加 bwdif：idet 30/30 TFF；
    - 不删除元数据：SDR 输出带 MDCV/CLL；
    - 不加 passthrough：只由参数检查发现，因为 MP4 封装器本身就保持这些时间戳。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ENCODE-03-1 | 通过 | V-ENCODE-03-2, V-ENCODE-03-1 |
| AC-ENCODE-03-2 | 通过 | V-ENCODE-03-1, V-ENCODE-03-2 |
| AC-ENCODE-03-3 | 通过 | V-ENCODE-03-1, V-ENCODE-03-2 |
| AC-ENCODE-03-4 | 通过 | V-ENCODE-03-1 |
| AC-ENCODE-03-5 | 通过 | V-ENCODE-03-1, V-ENCODE-03-2 |

- **AC-ENCODE-03-1**：显示矩阵方式的旋转已实测。批次 B 后，只有旧式 `rotate` 标签的源由探测报告为 0（T-ENGINE-01 的修正，runtime.test.ts 实测），规划器不再交换宽高；ffmpeg 也不旋转这类源，两者一致。
- **AC-ENCODE-03-2**：批次 B 纠正后，未标记源按「宽 ≥ 1280 或高 > 576 为 BT.709」推定，单元测试与 V-ENCODE-03-2 实测都覆盖。评审前，容器把 yuvj 流标为 tv 时不满足（实测 YMAX 1023）。F1 修复后，pc、yuvj、标为 tv 的 yuvj 都实测 YMAX ≤ 940。
- **AC-ENCODE-03-3**：libsvtav1、av1_nvenc（评审补测）与 hevc_nvenc 10-bit 在本机实测保留了 MDCV/CLL；QSV/AMF 的 AV1/HEVC 10-bit 只有单元测试。色调映射在本机用 libopenh264 实测，h264_nvenc、hevc_mf、kvazaar 的色调映射路径只有单元测试。HLG 只有单元测试。
- **AC-ENCODE-03-4**：只有单元测试。随附工具无法生成带 RPU 的杜比视界小样，V-ENCODE-03-2 也不要求。拒绝与参数部分由测试覆盖；「-dolbyvision 0 时 libsvtav1 不写 RPU 与 DOVI 配置」依据的是该选项的定义，没有实测。
- **AC-ENCODE-03-5**：VFR 时长误差为 0（2 s → 2 s，阈值 0.1 s），逐帧时间戳一致。「r ≈ 2×avg 不算 VFR」的规则只有单元测试（原因见实测事实 8）。

## 风险与未执行项

**与设计的差异，以及设计未写明处采用的做法**（未修改设计文档）

- **BT.601 推定的原色（批次 B 修正评审补充）。** AC 与 design 写「BT.601（smpte170m）」，所以推定一律写 smpte170m（525 行的原色）。mpv 对高为 576 或 288 的画面推定 625 行原色（bt470bg）。两者矩阵相同，只有原色略有差别；是否区分，需在 design 中写明。

1. **写集外测试变红（需要处理）。** 见「对其他任务文件的影响」。V-ENCODE-02-1 的 video.test.ts 需要更新 30 处期望值，只是在滤镜末尾加上 `,setparams=...`。本任务按规则没有修改该文件。
2. **能力探测参数也带 `setparams`。** 这样 `probeArgs` 与生产中普通高清源的参数完全一致，保持 T-ENCODE-02 的「探测即生产」性质。T-ENGINE-03 的探测命令因此多一个 `setparams` 滤镜，不影响编码器能否打开。
3. **色调映射段比 design 多两处。**
   - 末尾加 `format=yuv420p`（10-bit 时为 yuv420p10le），让 zscale 自己完成 Y′CbCr 转换（事实 2）。
   - 加 `sidedata` 删除 MDCV/CLL（事实 4）。
   - 缺原色标记时，在 `pin` 之外加 `p=bt2020`（事实 3）。
   - `rin`：范围未知时给 `tv`；全范围（pc 或 yuvj*）时显式给 `pc`。
   - 全范围的 HDR 源做色调映射时，范围由 zscale 转换（`rin=pc` … `r=tv`），不再另加 `scale=in_range=pc:out_range=tv`。AC-ENCODE-03-2 写的是「都经 scale」，但 design §4 的顺序把 scale 放在色调映射之后。那时画面已是有限范围，再按 pc 转换一次就会压缩两次。评审认可这一处理。
4. **RGB 源。** 显式给出转换矩阵，不照抄 `gbr`（事实 1）；design 没有写 RGB 源。
5. **其他取值。**
   - 只接受 setparams 与编码器都能写入的标记值。
   - `chroma_subsampled` 也用于 4:4:0 与 RGB；4:1:1、4:1:0、灰度不提示。
   - 杜比视界：兼容 id 6 按 HDR10 处理；`compatible: false` 也拒绝；Profile 9/10 等按基础层处理。
   - 推定用显示后的短边，尺寸未知时为 BT.709。
6. **参数位置。** `-dolbyvision 0` 与 `-fps_mode passthrough` 放在 `EncodeSpec.params` 中，由 args.ts 现有的每流渲染写成 `-x:v:0`；args.ts 不在写集内，也不需要修改。

**风险**

- **只有 `rotate` 标签的旋转。**（2026-10-28 已由 T-ENGINE-01 的批次 B 修正处理：只读 Display Matrix。）T-ENCODE-02 评审已指出：`engine/probe.ts` 在没有 Display Matrix 时读取 `rotate`/`ROTATE` 标签，但 ffmpeg 8 的 autorotate 只认显示矩阵。规划器会按转置后的宽高缩放，导致画面变形。本任务写集不含 probe.ts，没有修复。建议 T-ENGINE-01 的后续任务只认显示矩阵，或在契约中标明旋转来源。
- **Matroska 中的 VFR 看不出来。** MKV 的 avg_frame_rate 等于 r_frame_rate，`isVfr` 为假，所以不加 passthrough。实测 MP4/MKV 输出的默认 fps_mode 不会补帧，影响有限。如果要严格满足 AC，需要 engine 改用包时间戳判定 VFR。
- **元数据偏低的 HDR 源会过冲。** 内容峰值高于 MaxCLL/MDCV 时，hable 的输出会超过 SDR 白，8-bit 中 Y 最高到 254（事实 6）。这仍是合法码值，播放器通常截到白，但高光会被压平。design 没有要求裁剪或估计峰值，建议在 T-ENCODE-05 校准或 I3 中评估 `peak` 覆盖或 `limiter`。
- **bwdif 只处理标记为隔行的帧。** design 选用 `deint=interlaced`；只有容器标记场序、帧本身标为逐行的源不会被去隔行。自动检测在 I3。
- **yuvj 源的日志。** yuvj 源会让 swscale 在 `level+warning` 日志中输出「deprecated pixel format used…」。执行器（T-ENGINE-07）判定失败时不应把它当作错误。
- **输出体积。** 每个输出多约 20 字节的 VUI 色彩描述，对「不变大」判定没有实质影响。
- **按短边推定标记的边界（评审提出，需设计确认）。**（2026-10-28 design 已改为「宽 ≥ 1280 或高 > 576 为 BT.709」，批次 B 修正已实施。） design §4 写的是「短边 < 720 用 smpte170m」，实现照此执行。但 1280×544、1280×536 这类 720p 宽银幕裁切的短边小于 720，未标记时会被写成 BT.601。mpv 等播放器对未标记画面按宽度 ≥ 1280 或高度 > 576 推定为 BT.709，所以这类片源转换后会被显式标成 601，颜色与转换前的播放效果不同。建议 design 改为「宽 ≥ 1280 或高 > 576 为 BT.709」，或按长边判定。按规则，本任务没有偏离 design。
- **写集外测试（重复列出，便于跟踪）。** video.test.ts 的 30 项失败需要由写集包含该文件的任务更新期望值，在此之前 V-ENCODE-02-1 为红。（2026-10-28 已由 T-ENCODE-02 的批次 B 修正更新，63 项全部通过。）

**未执行**

- 没有启动 Electron，没有运行全量测试。
- 杜比视界、HLG、QSV/AMF 没有真实编码：本机没有对应的样片或设备，随附工具也无法生成 RPU。
- 「r 为场率的隔行源」没有真实样片：随附编码器写不出这种流。
- 校准（A-07 样片）属于 T-ENCODE-05。
