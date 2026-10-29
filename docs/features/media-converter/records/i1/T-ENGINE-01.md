# 实施记录：T-ENGINE-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-ENGINE-01 |
| 日期 | 2026-10-26 |
| 验证版本 | snapshot-sha256:6f79b2d5a82acad0248f85ab4bb88fc72928e92b2c0ba8ec50c35c14c6047f86（基线 a742ec76 + 未提交工作树）。批次 B 修正评审（2026-10-28）后取得：在评审的最后一次代码修改、受影响检查的重跑与证据文件写入之后，更新本记录及同批的 T-ENGINE-01、T-ENCODE-01～04 记录之前；这些记录文件的这次改动未计入。工作树中另有协调者对 spec 文档的未提交纠正（design、requirements、tasks、spec.json、changes/），以及其他任务的未提交文件。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；随附 ffmpeg/ffprobe n8.1.2-21-gce3c09c101-20260630（BtbN，LGPL），经 `verifyLocalSubtitleRuntimeBundle` 校验；RTX 4070 Ti SUPER（未使用 GPU 编码）。运行时启动的 ffmpeg/ffprobe 一律为 BELOW_NORMAL 优先级，测试生成素材与评审中的临时实测用 IDLE 优先级；素材为 lavfi 生成的 ≤2 s、≤640×360 小样。 |
| 任务指纹 | 6b13657903c2e26d6f7e8e1aa83b08ebef850d03c6033dd5718b626272993322 |

## 实际结果

本任务无界面部分，不涉及截图。

**新增文件（均在写集内）**

- `src/media-converter/contract.ts`：只依赖 zod。包含 engine 全部原因码的封闭枚举 `ENGINE_REASON_CODES`（运行时、探测、能力类别与 `busy`、编码进程、队列、输出、IPC/输入授权，以及 engine 自己产生的警告 `duration_unverified`、`output_name_collision`），子集 `runtimeFailureCodeSchema`、`probeFailureCodeSchema`；`runtimeStatusSchema`（`unverified` / `ready` / `unavailable{code}`）；`MEDIA_DEMUXERS`、`CONTAINER_IDENTITIES`；`mediaInfoSchema` 及视频/音频/字幕/封面流、HDR、母版显示元数据的 schema 与推断类型。文件中为 T-ENCODE-01 的计划原因码留出了单独一节，并注明不要重复声明上面两个警告码。
- `electron/main/media-converter/engine/runtime.ts`：`MediaRuntime`。
  - 只通过 `verifyLocalSubtitleRuntimeBundle({scope:'media'})` 取得 ffmpeg/ffprobe；`selectMediaTools` 要求带品牌的证明、恰好各一个、同一目录、版本等于 `LOCAL_SUBTITLE_MEDIA_POLICY.mediaRuntimeVersions`。
  - 两个程序都运行 `-hide_banner -version` 并核对第一行版本号。
  - 校验结果按 lstat 的体积与修改时间复用；校验失败不缓存。
  - `run()` 遇到 `spawn_error` 时重新校验一次并重试一次，再失败报 `runtime_spawn_failed`。
  - 平台不是 win32 时直接报 `platform_unsupported`，不触碰运行时。
  - 环境变量由 `buildLocalSubtitleMediaEnvironment` 生成，PATH 只有 media 目录与 System32，从不查 PATH。
  - 所有运行都经 `belowNormalPriority` 设为 BELOW_NORMAL。
  - `status()` 给出 `unavailable` 及原因码。
  - 环境、校验函数、spawn、stat、固定版本都可注入，供测试使用。
- `electron/main/media-converter/engine/probe.ts`：按 design §2 实现。
  - 扩展名预检，拒绝 `.m3u8/.m3u/.mpd/.ffconcat/.sdp/.txt`，不启动 ffprobe。
  - 读取文件头 4 KB：识别 SILK（含 0x02 前缀变体）；解析 EBML 头得到 Matroska DocType，因为 ffprobe 不报告它。
  - 主探测参数为 `-format_whitelist <ALLOWED_DEMUXERS> -protocol_whitelist file -show_format -show_streams -show_chapters -show_error -of json file:<path>`，30 s 超时，stdout 上限 4 MB。
  - stderr 出现 `Format not on whitelist` 或 `Not detecting m3u8/hls` 时报 `container_not_allowed`。
  - PQ/HLG 主视频读取首帧侧数据，用 `-f <已探测解复用器>` 固定解复用器，同样带两个白名单。
  - DOVI 从流级侧数据识别：P5 或兼容 id 0 为 `compatible=false`。
  - 容器标识：brand、DocType，再在解复用器族内按扩展名推断。
  - 码率缺失时回退到 `BPS`/`BPS-eng`；时长按 `format.duration` → 流 `duration` → `DURATION` 标签的顺序取值。
  - 旋转规范化为顺时针 0/90/180/270；位深与色度取样由像素格式表推出。
  - ASS/SSA 用 `ffmpeg -f <demuxer> … -map 0:<i> -c:s copy -frames:s 200 -f ass pipe:1` 抽取最多 200 条事件，判断是否含 `\pos`、`\move`、`\an`/`\a`、多个样式或非底部居中样式、时间重叠；抽取不完整时按 styled 处理。
  - 附件与章节计数。
  - 身份缓存：卷 + FileId + 体积 + 修改时间；FileId 全零或身份不可用时改用规范化路径（Windows 下不区分大小写）+ 体积 + 修改时间。
  - 同一文件的并发请求共享同一次探测；探测期间文件变化时重试一次。
  - 信号量限制并发为 4；每个文件的结果单独返回。
  - 只缓存与文件本身相关的结论。
  - `dispose()` 中止所有进行中的探测。
- 测试：`test/media-converter/probe.test.ts`（纯测试，评审后 101 项）、`test/media-converter/runtime.test.ts`（真实运行时，14 项，评审后其中两项加强）、`test/media-converter/fixtures/probe/`。夹具为文本 JSON，覆盖竖屏 Display Matrix、旧 rotate 标签、HDR10、HLG、DV5（传递特性未知）、DV8.1、VFR、MP3/M4A 封面、PGS/DVD/eia_608/SRT、ASS、MOV/MP4/M4A brand、WebM DocType、TS 偏移、无时长、DURATION 标签回退、只有附件、hls 格式名、FileId 全零；另有 ASS/SSA 文本样本。

**用真实 ffprobe 核对的事实**（随附 n8.1.2，IDLE 优先级）

- 设计列出的 27 个解复用器短名在 `-demuxers` 中都存在；hls、dash、concat、sdp、image2、lavfi 是另外的名字，不在清单内。证据：file:records/i1/T-ENGINE-01-demuxers.txt。
- 把 ffconcat 改名为 `.mp4`：带 `-format_whitelist` 时报 `Format not on whitelist`，调试日志中没有打开同目录的哨兵；去掉白名单作对照时，哨兵被打开。
- ffmpeg 8 不会把非 `.m3u8/.m3u` 扩展名的 HLS 识别为 hls，会打印 `Not detecting m3u8/hls…`；改名的 HLS 因此被报为 `container_not_allowed`。
- 带正确扩展名的 `.m3u8` 绕过预检直接交给 ffprobe 时，同样被白名单拒绝；去掉白名单作对照时，会打开 `%TEMP%` 下运行目录之外的哨兵。
- Display Matrix 的 `rotation` 为逆时针角度。
- AV1 的母版显示原色以 1/65536 为步长，0.68 读回为 0.67999。
- 首帧读取在音频为 0 号流时同样有效。

**变异检查**（临时修改 probe.ts 后运行两个测试文件，之后用 sha256 确认已还原）

| 变异 | 失败的测试数 | 失败的测试 |
| --- | --- | --- |
| 去掉 `-format_whitelist` | 3 | 含真实 ffprobe 的播放列表哨兵测试 |
| 并发上限改为 5 | 2 | 纯测试与真实 100 文件测试各 1 个 |
| 去掉扩展名预检 | 2 | — |
| 去掉码率上限（评审新增） | 2 | 新增的码率测试；无时长测试（该变异使 `bitRate` 变为 false） |
| 去掉完全限定路径检查（评审新增） | 1 | 新增的相对路径测试 |

测试确实能发现这些回退。评审新增的两项变异见 file:records/i1/T-ENGINE-01-review.txt，之后 probe.ts 经 sha256 确认已还原。

**与设计的差异**（详见风险一节）

- 首帧读取用主视频流的绝对序号 `-select_streams <index>`，不用 `V:0`。
- `MediaInfo.kind` 只有 video/audio，「不可处理」用探测失败原因码表示。
- 单一格式解复用器的容器标识取解复用器名；扩展名只在 mov/matroska/ogg 族内用于区分。

**评审与修复**（2026-10-26，独立评审）

逐条对照 7 条 AC 与 design §1、§2，读完了写集内全部代码与测试，并用随附 ffprobe 以 IDLE 优先级实测了此前未验证的两处行为（file:records/i1/T-ENGINE-01-review.txt）。没有发现阻断或主要问题。以下次要问题已在写集内修复：

1. 码率越界会让整个文件不可处理。`normalizeProbe` 对流 `bit_rate`、`BPS` 标签和 `format.bit_rate` 只设下限。损坏的文件头声称时长 1 µs 时，由体积推算的总码率会超过 contract 的上限 1e12；流码率声称 5 Tbit/s 时也一样。两种情况都会让 `mediaInfoSchema` 校验失败，文件变成 `probe_failed`（已用 vitest 复现）。现在超出上限的码率记为未知（null），与 FK-PIT-0042「元数据不可信」一致。新增单元测试，去掉上限的变异会使它失败。
2. `probe()` 接受不完全限定的路径。ffprobe 的工作目录是 `work`，而 `lstat` 与读取文件头按进程当前目录解析。同一个相对名字，或 Windows 上不带盘符的 `\dir\x`，会指向两个不同的文件，身份核对的对象与实际探测的对象不一致。现在路径必须完全限定（接受盘符路径、UNC 与 `\\?\`），否则返回 `file_unavailable`，不启动 ffprobe。新增单元测试，去掉该检查的变异会使它失败。
3. V-ENGINE-01-2 的「哈希不符」实际只测到了体积不符：4 KB 的假 ffmpeg 在体积核对时就被拒绝。新增一种情况：两个可执行文件体积都正确，只改 ffmpeg 的一个字节。结果为 `runtime_invalid`，且没有启动任何进程。
4. 「PATH 中有其他 ffmpeg 也不会使用」原来只在运行时可用时验证。新增一种情况：PATH 前置假 ffmpeg，同时运行时缺失。`acquire()` 与 `probe()` 都报 `runtime_missing`，没有启动任何进程，哨兵文件没有出现。
5. 测试素材原来用 `-v error` 生成，不符合 tasks.md 的通用约定。现在改用 `-loglevel level+warning`，stderr 出现 `Invalid option`、`Error parsing option`、`auto-selecting format` 或 `only the last` 即判为失败。
6. contract 中 `kind` 的注释说音频文件「最多带封面」，但平均帧率为 0/0 的非主视频流同样会列在 `video` 中。已更正注释，类型不变。

核查后不成立、因此未改动的疑点：

- 主探测的 stderr 上限是 64 KB，超出时进程会被终止。担心损坏文件的大量解码错误会触发它。实测一段每 97 字节翻转一次的 H.264 TS，`-v error` 的 stderr 只有约 0.9 KB，因为 find_stream_info 只解码少量帧。
- 有解码延迟的 HEVC 能否用 `-read_intervals %+#1` 读到首帧。用 kvazaar 生成 `has_b_frames=7` 的 HEVC MP4 实测，返回了 pts=0 的 I 帧（ffprobe 结束时会冲刷解码器）。`-f mov` 固定解复用器也确认可用。
- 安全边界：所有 ffprobe/ffmpeg 输入都带两个白名单与 `file:` 前缀；白名单内的解复用器不会打开其他文件（mov 的 dref 默认关闭）；运行时只用绝对路径启动程序，环境 PATH 只有 media 目录与 System32。
- 并发：信号量按一次完整探测计数，一次探测内的 ffprobe/ffmpeg 串行运行，所以同时运行的进程不超过 4 个。名额释放时直接交给下一个等待者；`dispose()` 后，排队者拿到名额会立即返回 `probe_failed`。

**批次 B 修正（2026-10-28）**

依据 changes/2026-10-26-batch-b-spec-corrections.md 与 engine design §2 的纠正（旋转角只从 Display Matrix 读取）。改动都在本任务的写集内：

- `engine/probe.ts`：`rotationOf` 只读 Display Matrix 侧数据，旧式 `rotate`/`ROTATE` 标签一律忽略；没有显示矩阵时旋转角为 0。原因：ffmpeg 8 的自动旋转不理会这类标签（T-ENCODE-02 评审实测：带 ROTATE=90 标签的 MKV 重新编码后仍是横向）。如果仍读取标签，规划器会按 90° 交换宽高再缩放，画面变形。
- `test/media-converter/probe.test.ts`：
  - 原「读取旧 rotate 标签」的用例改为断言旋转角为 0、宽高仍为 1280×720（夹具 portrait-legacy-tag.json，MP4 的小写 `rotate`）。
  - 新增夹具 `fixtures/probe/rotate-tag-mkv.json`：随附 ffprobe 对 `-metadata:s:v:0 rotate=90` 所写 MKV 的真实输出。标签被写成大写 `ROTATE`，没有显示矩阵；探测结果为 0。
  - 新增用例：有显示矩阵时，与之矛盾的标签不起作用（-90 → 90、90 → 270、180 → 180、-180 → 180）；没有显示矩阵时，任何标签（90、270、-90）都得 0。
  - 测试稳健性：「并发 4、按完成顺序返回」用例的慢文件延时由 60 ms 改为 400 ms。全目录并行运行时它曾偶发失败（快文件被拖到慢文件之后），单独运行一直通过，与本次修正无关。
- `test/media-converter/runtime.test.ts` 新增一项真实检查（lavfi 小样 320×180、1 s，IDLE 优先级）：
  - 把小样复制成带 `ROTATE=90` 标签的 MKV。先用 ffprobe 确认标签存在、没有显示矩阵，再经 `MediaProber` 探测：旋转角为 0，宽高 320×180。
  - 同一小样用 `-display_rotation 90` 复制为 MP4，探测为 270，说明显示矩阵仍被读取。
- 变异检查（file:records/i1/T-ENGINE-01-batchb-mutations.txt）：把读取标签的回退加回去后，单元测试 2 项、真实测试 1 项失败；写回后 sha256 与变异前一致。
- 回归：test/media-converter 下全部 14 个测试文件，581 项通过（file:records/i1/T-ENCODE-01-batchb-full.txt）。
- 写集外的遗留：`src/media-converter/contract.ts` 中 `VideoStreamInfo.rotation` 的注释仍写「Display Matrix, else the legacy rotate tag」，与现在的行为不符。只是注释，类型不变，需要由写集包含该文件的任务更正。

**批次 B 修正评审（2026-10-28）**

- 独立评审核对了 `rotationOf`：只读 Display Matrix 的 `rotation`（逆时针），换算为顺时针并规范到 0/90/180/270；没有显示矩阵时为 0，`rotate`/`ROTATE` 标签不再参与。这与 engine design §2 的纠正一致。
- 测试有区分力：
  - 新夹具 rotate-tag-mkv.json 是随附 ffprobe 的真实输出。
  - runtime.test.ts 的真实检查先确认标签存在、没有显示矩阵，再断言旋转角为 0；另用 `-display_rotation 90` 的对照证明显示矩阵仍被读取（270）。
  - 并发用例的慢文件延时由 60 ms 改为 400 ms，只提高稳健性，断言没有放宽（仍要求同时最多 4 个、按完成顺序返回）。
- 未发现问题，本任务的文件没有修改。因同批的 video.ts、audio.ts 有评审修复，按最终工作树重跑了本任务的检查：V-ENGINE-01-1 102 passed，V-ENGINE-01-2 15 passed（没有跳过），V-ENGINE-01-3 两项 tsc 都没有诊断，test/media-converter 全目录 582 passed（file:records/i1/T-ENCODE-01-batchb-full.txt）。
- contract.ts 中 `rotation` 注释的遗留问题仍在（写集外）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ENGINE-01-1 | 通过 | file:records/i1/T-ENGINE-01-probe.txt |
| V-ENGINE-01-2 | 通过 | file:records/i1/T-ENGINE-01-runtime.txt |
| V-ENGINE-01-3 | 通过 | file:records/i1/T-ENGINE-01-tsc.txt |

- V-ENGINE-01-1：批次 B 修正评审后重跑（证据已覆盖）：102 passed，exit 0；verbose 用例清单覆盖夹具规范化、HDR10/HLG/DV5/DV8/VFR/旋转/封面/字幕/ASS 样式分类、容器标识表、扩展名拒绝、SILK、EBML DocType、像素格式表、身份兜底与缓存、白名单参数、并发 4、文件变化重试、非 Windows 平台，以及评审新增的码率越界与不完全限定路径；批次 B 新增：旋转角只读 Display Matrix（旧 rotate 与 MKV ROTATE 标签得 0，有矩阵时标签不起作用）
- V-ENGINE-01-2：批次 B 修正评审后重跑（证据已覆盖）：15 passed，无跳过，exit 0。批次 B 新增一项：带 ROTATE=90 标签的 MKV 探测为 0，带显示矩阵的 MP4 探测为 270。其余覆盖同评审修复后：覆盖：校验一次、变更后复检、失败不缓存；runtime_missing；runtime_invalid（体积不符，以及同体积只改一个字节）；runtime_version_mismatch（清单版本与 -version 输出两种）；runtime_spawn_failed；spawn 失败后重校验并重试；PATH 前置假 ffmpeg 时，运行时可用与缺失两种情况都不会使用它；lavfi 小样真实探测（MP4/WebM/ASS/封面 MP3/HDR10 首帧）；.m3u8、改名为 .mp4 的 hls 与 ffconcat 均被拒绝，-v debug 日志未打开哨兵，并有去掉白名单的对照；100 个探测同时运行不超过 4 个，回读优先级为 BELOW_NORMAL。素材以 level+warning 生成，并做 stderr 关键词检查
- V-ENGINE-01-3：批次 B 修正评审后重跑：pnpm exec tsc --noEmit -p tsconfig.json 无诊断，exit 0；另用继承它的 scratchpad 配置检查 test/media-converter 下全部测试文件，无诊断，exit 0

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ENGINE-01-1 | 通过 | V-ENGINE-01-2, V-ENGINE-01-3 |
| AC-ENGINE-01-2 | 通过 | V-ENGINE-01-2, V-ENGINE-01-1 |
| AC-ENGINE-02-1 | 通过 | V-ENGINE-01-1, V-ENGINE-01-2 |
| AC-ENGINE-02-2 | 通过 | V-ENGINE-01-1, V-ENGINE-01-2 |
| AC-ENGINE-02-3 | 通过 | V-ENGINE-01-1, V-ENGINE-01-2 |
| AC-ENGINE-02-4 | 通过 | V-ENGINE-01-1, V-ENGINE-01-2 |
| AC-ENGINE-02-5 | 通过 | V-ENGINE-01-1, V-ENGINE-01-2 |

## 风险与未执行项

**由后续任务接线的部分**

- AC-ENGINE-01-1 的「第一次需要媒体能力时」由调用方决定时机。`MediaRuntime` 是惰性的，构造时不做校验；在首次进入工具页或首次添加文件时调用 `acquire()`，由 T-ENGINE-06 接线。
- AC-ENGINE-01-2 的「引擎状态」：本任务通过 `MediaRuntime.status()` 与 contract 中的 `runtimeStatusSchema` 给出 `unavailable{code}`；把它组合进带 `detecting` 的完整 EngineStatus 和快照，在 T-ENGINE-03/06 完成。
- AC-ENGINE-02-5：探测器保证并发上限为 4，并且每个文件的结果单独返回（已验证）；按文件推送给渲染进程，在 T-ENGINE-05/06 完成。

**与设计的差异，以及在设计未明确处采用的做法**（未修改设计文档）

1. HDR10 首帧读取用 `-select_streams <主视频绝对序号>`，而不是 `V:0`。两者通常指向同一条流；当第一条 V 流的平均帧率为 0/0（被排除在主视频之外）时，用序号更准确。
2. `MediaInfo.kind` 不含 `unsupported`。不可处理的文件以探测失败原因码表示（`no_media_streams`、`container_not_allowed` 等），与队列中的 `unsupported{reason}` 对应。
3. 容器标识：先看 brand 与 DocType。扩展名只在 mov、matroska、ogg 族内用于推断；其他单一格式解复用器取解复用器名；都不满足时为 `unknown`。这样，改名为 `.mp4` 的 TS 不会被识别为 mp4，不会被误判为 `already_target`。
4. 「非默认样式」解释为：事件用到多个样式，或所用样式的 Alignment 不是 2（底部居中）。另外把旧式 `\a<n>` 也算作定位。每个文件最多抽取 8 条 ASS 流，超出的直接按 styled 处理。
5. 预检拒绝的播放列表扩展名使用 `container_not_allowed`，因为 AC 没有为这种情况指定原因码。探测时文件不存在或不是普通文件，使用 R-ENGINE-07 的 `file_unavailable` 与 `not_a_regular_file`；路径不是完全限定时（评审新增的检查）同样返回 `file_unavailable`。
6. 原因码：`duration_unverified` 与 `output_name_collision` 放在 engine 枚举中；`encoder_fallback` 留给 T-ENCODE-01 的计划原因码枚举。T-ENCODE-01 应复用前两个，不要重复声明。

**测试覆盖的局限**

- 杜比视界、HLG、PGS、TS 偏移等只用文本夹具验证：随附编码器无法生成 DV 样片。真实样片（A-07）到位后应补充真实探测核对。
- 首帧读取 `-read_intervals %+#1` 在 AV1 小样上读到了母版元数据。评审时又在有解码延迟的 HEVC（kvazaar，`has_b_frames=7`）上确认能读到首帧。但随附编码器无法写入 HEVC 的母版 SEI，所以 HEVC 首帧中母版元数据的提取仍待真实样片核对。若首帧读取失败，母版元数据为空，HDR 类型不受影响。

**潜在风险**

- 大型 MKV 中字幕很稀疏时，ASS 抽取可能因 15 s 超时而按 styled 处理。这会使「自动」容器选择 MKV，结果偏保守，但不会丢失样式。
- 多条 ASS 流按流串行抽取，每条都从文件开头读起。最坏情况是 8 条 × 15 s，一个探测名额会被占用约 2 分钟，其间其他文件排队等待。
- 隔行 H.264 的 `r_frame_rate` 常报场率，即 `avg_frame_rate` 的两倍，按 design 的 0.5% 规则会被判为 VFR。encode 因此会加 `-fps_mode passthrough`，这对恒定帧率源无害（保持原时间戳），但摘要可能误报 VFR。随附编码器无法生成隔行 H.264，未实测；若要修正，应先修改 design 的判定规则。
- 运行时在哈希校验之后才取 lstat 基准，所以在哈希与 lstat 之间被替换的可执行文件不会被发现（与 `cue-audio-clip.ts` 的先例相同）。利用它需要能写入运行时目录的本地进程，接受此风险。
- 网络盘、FAT/exFAT 卷上的身份兜底只用夹具验证，没有在真实 exFAT 卷上运行。

**未执行项与运行环境说明**

- 未运行全量测试，也未启动 Electron。
- 运行时测试在 `test-results/media-converter/runtime-*` 下创建运行目录，结束后删除（失败时同样删除）；`test-results/media-converter/` 目录本身保留，为空。
- 验证版本快照在更新本记录之前取得，本记录文件的改动会改变未提交工作树的哈希。快照时工作树中只有本任务的文件。
- 评审中的临时实测在会话 scratchpad 中进行，素材用后已删除；`test/media-converter/fixtures/probe/` 没有新增二进制文件。
