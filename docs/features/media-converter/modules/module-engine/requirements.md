# engine 需求

需求行为只在这里定义；业务目标来源于 [brd.md](../../brd.md)。不要在 tasks 或 record 中另写一套期望。

## 目标与范围

engine 是媒体转换的主进程运行层，负责：

- 定位并校验随附的 ffmpeg/ffprobe；
- 探测媒体信息与编码能力（含硬件编码器实测）；
- 运行编码进程，管理进度、取消、优先级和停滞；
- 在主进程中维护任务队列，处理应用生命周期；
- 安全地发布输出文件；
- 处理渲染进程 IPC 与输入授权。

encode 模块产出的 ffmpeg 参数由 engine 执行；编码策略不由 engine 决定。

当前批次 I1 只覆盖 Windows x64。

## 范围外

- macOS 媒体引擎（R-ENGINE-09，I4）。I1–I3 期间 macOS 上该工具显示「暂不支持此平台」。
- 采样切片、VMAF 测量与帧提取（R-ENGINE-08，I2）。
- 下载或更换 ffmpeg；使用系统 PATH 中的 ffmpeg，或用户指定的 ffmpeg。
- 应用重启后自动继续编码（重启后只标记为已中断，用户可重试）。
- 编码中途暂停与恢复。
- 添加文件夹（I1 拒绝文件夹并提示）。

## 需求

### R-ENGINE-01 使用随附且经过校验的 ffmpeg/ffprobe

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01, BR-02, BR-03 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

Windows 复用字幕工作台转写运行时中的 ffmpeg/ffprobe（BtbN n8.1.2 LGPL）。只通过现有的校验入口取得路径，不修改冻结副本，不新增打包内容。

#### 验收标准

- AC-ENGINE-01-1: 在 Windows 开发环境（已暂存 `build/subtitle-studio-resources/transcription`）或打包环境下，第一次需要媒体能力时：
  - 调用 `verifyLocalSubtitleRuntimeBundle({scope:"media"})`；
  - 取得同一目录下的 ffmpeg 与 ffprobe，且版本与 `LOCAL_SUBTITLE_MEDIA_POLICY.mediaRuntimeVersions` 一致；
  - 同一会话的后续调用复用这次校验结果，文件体积或修改时间变化时重新校验。
- AC-ENGINE-01-2: 运行时缺失、哈希不符、版本不符或无法启动时，引擎状态为 `unavailable`，并带对应原因码：`runtime_missing`、`runtime_invalid`、`runtime_version_mismatch`、`runtime_spawn_failed`。即使 PATH 中有其他 ffmpeg，也不会使用。
- AC-ENGINE-01-3: 在 macOS 上：
  - 预加载暴露的 `supported` 为 false；
  - 主进程照常注册全部 `media-converter:` 通道，但每个请求都返回 `{ok:false, error:{code:"platform_unsupported"}}`；
  - 不触碰运行时，也不执行探测。

#### 边界与异常

- 校验约需 1 秒，在第一次进入工具页或第一次添加文件时进行，不在应用启动时执行。
- 校验失败的结果不缓存，用户可以重试。

### R-ENGINE-02 媒体探测

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01, BR-02 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

添加文件后，用 ffprobe 得到结构化的媒体信息，供界面展示和编码规划使用。探测本身不能读取用户没有选择的文件。

#### 验收标准

- AC-ENGINE-02-1: 添加一个媒体文件后，主进程用 ffprobe（`-show_format -show_streams -show_chapters -of json`，30 s 超时，stdout 上限 4 MB）探测，得到经 zod 校验的媒体信息，内容包括：
  - 容器标识（含 `format_name`、MP4 系的 `major_brand`、Matroska 的 DocType，以及扩展名）、时长、文件体积、总码率；
  - 视频流：编码、profile、像素格式与位深、宽高、SAR、`r_frame_rate` 与 `avg_frame_rate`（以及是否为可变帧率）、旋转角、色彩原色/传递特性/矩阵/范围、场序；
  - 音频流：编码、声道数与布局、采样率、码率（缺失时取 `tags.BPS`）、语言、标题、默认标记；
  - 字幕流：编码、文本还是图形、语言、标题、默认/强制标记，以及 ASS/SSA 是否含样式定位或重叠事件；
  - 封面图、附件数量、章节数量。
- AC-ENGINE-02-2: 每条视频流都从流级侧数据识别杜比视界：`DOVI configuration record` 的 `dv_profile` 与 `dv_bl_signal_compatibility_id`，不依赖传递特性。传递特性为 `smpte2084` 或 `arib-std-b67` 时，另外读取首帧侧数据，取得 HDR10 的 Mastering Display 与 Content Light Level。媒体信息中的 HDR 类型为 `none`、`hdr10`、`hlg` 或 `dolby_vision`（附 profile 与兼容 id）。
- AC-ENGINE-02-3: 封面图（`attached_pic`）不算主视频流；只有音频加封面的文件被识别为音频文件。
- AC-ENGINE-02-4: 每次调用 ffprobe 都带输入选项 `-format_whitelist <允许的解复用器短名>` 与 `-protocol_whitelist file`。扩展名为 `.m3u8`、`.m3u`、`.mpd`、`.ffconcat`、`.sdp`、`.txt` 的文件，直接拒绝，不启动 ffprobe。以下情况把该文件标记为不可处理并附原因码，不影响其他文件：
  - 探测失败、超时：`probe_failed`；
  - 没有可识别的音视频流：`no_media_streams`；
  - 解复用器不在允许清单内：`container_not_allowed`；
  - 文件以 `#!SILK_V3` 开头：`wechat_silk_unsupported`。

  拖入一个引用其他文件的播放列表时，引用的文件不会被打开（测试中以调试日志确认）。
- AC-ENGINE-02-5: 一次添加 100 个文件时，同时运行的 ffprobe 不超过 4 个；每个文件探测完成就单独推送结果，不等其他文件。

#### 边界与异常

- 时长取值顺序：`format.duration` → 流 `duration` → `tags.DURATION`。都没有时记为未知。
- 探测结果按文件身份缓存，文件变化后重新探测。身份由卷与文件 ID、体积、修改时间组成。文件 ID 不可用或为全零时（常见于 FAT/exFAT 卷），改用「规范化路径 + 体积 + 修改时间」。

### R-ENGINE-03 编码能力探测（含硬件编码器实测）

| 字段 | 值 |
| --- | --- |
| 来源 | BR-02 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

`-encoders` 列出的编码器不一定能用；即使能用，生产参数也可能被驱动拒绝。所以必须用真实参数实测，并区分「确定的结论」和「临时的失败」。

#### 验收标准

- AC-ENGINE-03-1: 引擎第一次就绪时，先解析 `-encoders`、`-muxers`、`-filters` 得到软件能力，再按顺序测试每个候选编码器。
  - 候选：h264/hevc/av1 × nvenc/qsv/amf、h264/hevc 的 mf（硬件），以及 h264_mf 软件。
  - 每个候选用 encode 模块为它生成的真实生产参数（各种位深与 tune 组合），以 `-loglevel level+warning` 对 3 帧 lavfi 画面编码，写入工作目录中的小 MKV，再用 ffprobe 核对编码、像素格式与 profile。
  - stderr 出现 `auto-selecting format` 或 `Invalid option` 时判为失败。
  - 每项测试 15 s 超时，全部测试总预算 30 s；超出预算的候选记为 `unknown`。
  - 结果为可用或不可用；不可用时附原因类别：`driver_too_old`、`no_device`、`runtime_missing`、`session_limit`、`params_rejected`、`unknown`。
- AC-ENGINE-03-2: 只有确定的结论（可用、`driver_too_old`、`no_device`、`runtime_missing`、`params_rejected`）写入 `userData/media-converter/capabilities.json`，以「ffmpeg 版本 + 显卡与驱动版本」为键，键不变时启动后不重测。`session_limit`、`unknown` 和超时只在本会话有效，下次启动重测。用户点「重新检测」时重新测试；有硬件编码任务运行时，该按钮不可用。
- AC-ENGINE-03-3: 编码时，硬件编码器在第一个 frame > 0 的进度块之前失败（无论原因类别），该编码器被标记为本会话降级，并只重试一次：用条目开始时冻结的设置和当前能力表重新生成计划，改用降级链上的下一个编码器，并把切换写入处理计划摘要。如果已经产出进度后才失败，任务直接失败，不重试。
- AC-ENGINE-03-4: `*_d3d12va`、`*_vulkan` 不作为候选。NVENC 因驱动低于 570 失败时，原因类别为 `driver_too_old`，界面提示所需的最低驱动版本。

#### 边界与异常

- 能力探测期间引擎状态为 `detecting`。这时可以添加文件、查看信息，但不能开始编码。
- 测试编码串行执行，以低优先级运行。

### R-ENGINE-04 编码进程：进度、取消、优先级与停滞

| 字段 | 值 |
| --- | --- |
| 来源 | BR-03 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

长时间编码需要可靠的进度、取消和异常判定，同时不能影响用户正在做的其他事（例如玩游戏）。

#### 验收标准

- AC-ENGINE-04-1: 进程启动方式：
  - `shell:false`，隐藏窗口，使用精简的环境变量；
  - 工作目录为 `userData/media-converter/work/<短 id>`；
  - 每个 `-i` 前带 `-f <探测得到的解复用器>`、`-protocol_whitelist file`，输入路径加 `file:` 前缀；
  - 日志级别为 `level+warning`；
  - 启动后立即设为低于正常的优先级。开启低占用模式时，设为最低优先级，并把 CPU 亲和性限制在约一半的逻辑核上。
- AC-ENGINE-04-2: 进度从 `-progress pipe:1` 中按行解析，每行有长度上限。解析得到：
  - 百分比：已处理时长 ÷ 预期时长，多阶段任务按各阶段权重合成；
  - 速度倍数与 fps；
  - 已写字节；
  - 剩余时间：按平滑后的速度估算。

  `N/A` 和负值被忽略。
- AC-ENGINE-04-3: 用户取消后，Windows 上 3 s 内进程退出。确认进程关闭后，删除临时输出、2-pass 日志和工作目录，任务状态为已取消。
- AC-ENGINE-04-4: stderr 只在内存中保留最后 256 KB，超出不会终止进程。停滞判定按阶段区分：
  - 首个进度块之前：宽限 300 s，低占用模式下 600 s；
  - 编码阶段：连续 120 s 内处理时长和已写字节都没有增长；
  - 收尾阶段（处理时长已达到预期时长 − 1 s，例如 `+faststart` 重写文件）：预算为 120 s + 输出字节 ÷ 20 MB/s。

  超过对应阈值时终止进程，错误码为 `encoder_stalled`。
- AC-ENGINE-04-5: 任务成功需要同时满足：
  - 退出码为 0；
  - 收到 `progress=end`；
  - 没有达到输出字节上限；
  - 输出经 ffprobe 可以解析，并包含计划中的全部流；
  - 预期时长已知时，输出时长与它相差不超过 max(2 s, 1%)。预期时长取计划中的主流（提取音频时为被提取的音轨），没有则取容器时长。

  预期时长未知，或者流时长与容器时长相互矛盾时，不检查时长，只要求处理时长 > 0，并附警告 `duration_unverified`。不满足以上条件时任务失败，错误详情是脱敏后的 stderr 末尾。

#### 边界与异常

- 时长未知时，进度条显示为不确定状态，只显示已处理时长与已写大小。
- 多遍任务（I2 的 2-pass）的每一遍单独计算停滞。
- Windows 上 ffmpeg 处于 libuv 的「关闭即终止」作业对象中，主进程崩溃时 ffmpeg 会随之结束；macOS 上的孤儿进程处理见 R-ENGINE-09。

### R-ENGINE-05 主进程任务队列与生命周期

| 字段 | 值 |
| --- | --- |
| 来源 | BR-03 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

队列由主进程持有，状态以主进程为准。离开页面、窗口重载都不会中断任务。

#### 验收标准

- AC-ENGINE-05-1: 渲染进程只发命令、订阅变更事件，事件带严格递增的 sequence。离开工具页或重载窗口后，任务继续运行；回到页面时先取快照，再接着应用后续事件，看到的是当前进度。推送给渲染进程的进度，每个任务每秒不超过 4 次。
- AC-ENGINE-05-2: 默认同一时间只运行 1 个转换任务，其余按开始顺序排队；探测不占这个名额。引擎支持并发 2，但 I1 不在界面上开放（I3 开放）。队列选项（并发数、低占用模式）只由主进程保存，渲染进程从快照读取，通过 `set-options` 修改。
- AC-ENGINE-05-3: 持久化与恢复：
  - 队列条目与结果摘要以原子写入方式保存到 `userData/media-converter/state.json`。错误日志只保存脱敏后的最后 16 KB。
  - 条目由排队转为运行前，重新核对输入文件的身份、体积与修改时间。文件不存在时任务失败，代码 `input_missing`；文件已变化时标记 `input_changed`，不运行。
  - 应用重启后恢复队列：未开始的条目做同样的核对；重启前正在运行或排队的条目标记为已中断。
  - 以上情况都可以重试，重试时重新探测并重新生成计划。
- AC-ENGINE-05-4: 应用退出或安装更新时，转换模块参与共享关停流程：取消运行中的任务，等待进程关闭，清理临时文件，并在关停超时内完成。
- AC-ENGINE-05-5: 有任务运行时持有 `prevent-app-suspension` 电源阻止，空闲后释放。
  - 一批任务指：从队列由空闲转为运行开始，到没有排队或运行中的条目为止。
  - 一批结束时发出 `batch-finished` 事件（只发一次）。窗口不在前台时，渲染进程按用户的通知设置发出系统通知。

#### 边界与异常

- 队列最多保留 500 个条目；超出时，按完成时间清理最早结束的条目。
- `state.json` 损坏时改名备份，以空队列启动，并在界面提示一次。

### R-ENGINE-06 安全输出

| 字段 | 值 |
| --- | --- |
| 来源 | BR-03 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

原则：

- 永不修改、覆盖输入文件；
- 未完成的文件不以最终文件名出现；
- 默认不覆盖任何已有文件；
- 即使用户选择覆盖，被替换的文件也先移到回收站；
- 输出不会把磁盘写满。

#### 验收标准

- AC-ENGINE-06-1: 临时文件的处理顺序：
  1. 先把临时文件路径和预期身份写入 `userData/media-converter/partials.json`；
  2. 以独占方式（`wx`）在目标目录创建 `.fusionkit-media-<id>.partial`，记录其文件身份；
  3. ffmpeg 以 `-y` 写入这个文件，并用 `-f` 显式指定封装格式；
  4. 任务成功后才发布为最终文件名。

  发布或删除临时文件前，先核对文件身份未变。失败或取消时，删除临时文件并移除记录。
- AC-ENGINE-06-2: 默认的冲突策略是自动编号。目标文件名已存在时，依次尝试 `名称 (1).扩展名`、`名称 (2).扩展名`，发布过程不覆盖任何已有文件：
  - 默认用硬链接方式不覆盖地发布；
  - 硬链接失败（`EEXIST` 以外的任何错误，例如 exFAT 上的 `EISDIR`）时，先以独占方式创建同名占位文件，再把临时文件替换到占位文件上；
  - 替换失败时，只删除仍为 0 字节且身份未变的占位文件；
  - 在 FAT 卷上，替换后按体积核对，因为那里的文件 ID 可能改变。
- AC-ENGINE-06-3: 覆盖规则：
  - 只有用户显式选择「覆盖同名文件」，并在开始前确认要被替换的文件清单后，才替换已有文件；替换前先用 `shell.trashItem` 把旧文件移到回收站，移动失败则任务失败（`overwrite_trash_failed`），不永久删除旧文件。
  - 「覆盖」只在当前会话有效，重启后恢复为自动编号。
  - 同一批中多个条目解析到同一个目标文件名时，不论哪种策略都自动编号，并附警告 `output_name_collision`。
  - 输出路径与队列中任何一个输入是同一个文件（包括大小写不同、硬链接）时，拒绝开始，错误码 `output_is_input`。
- AC-ENGINE-06-4: 磁盘空间与输出上限：
  - 开始前，按目标卷汇总所有运行中条目的输出上限，再检查剩余空间；不足「上限 + 512 MB」时不启动，错误码 `disk_space_low`，并显示所需与可用空间。
  - 每个输出都带 `-fs <输出上限>`；探测时长已知时，再带 `-t <max(时长 × 1.05, 时长 + 10 s)>`。
  - 达到上限时，按计划给出的语义处理：压缩任务记为已跳过 `not_smaller`，其他任务失败 `output_cap_exceeded`。
  - 编码中磁盘写满时失败，错误码 `disk_full`。
  - 目标卷为 FAT32 且上限超过 4 GiB 时，开始前就拒绝，错误码 `file_too_large_for_volume`。
- AC-ENGINE-06-5: 应用启动时，逐条检查 `partials.json` 中的记录：
  - 文件存在，且名称与身份都和记录一致时，删除文件；
  - 已确认文件不存在，或已删除时，移除记录；
  - 卷未挂载或删除失败时，保留记录，留待以后处理。

  同时清空 `userData/media-converter/work/`。

#### 边界与异常

- 输出目录不存在或不可写时，任务在开始前失败，错误码 `output_dir_unwritable`。
- Windows 上重命名或删除遇到 `EBUSY`/`EPERM`（如杀毒软件占用）时，有限次重试。
- 完整输出路径超过限制时，任务失败，错误码 `output_path_too_long`。

### R-ENGINE-07 IPC 与输入授权

| 字段 | 值 |
| --- | --- |
| 来源 | BR-03 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

渲染进程不能提交任意文件路径；所有路径只来自用户的拖放或主进程对话框。文件路径也不以任何形式（包括错误日志）回到渲染进程。

#### 验收标准

- AC-ENGINE-07-1: 所有 `media-converter:` 通道只接受受信任的应用主窗口顶层框架。请求参数用严格的 zod schema 校验，非法请求返回 `invalid_request`，不执行。遗留的 `window.ipcRenderer` 桥拒绝 `media-converter:` 前缀。
- AC-ENGINE-07-2: 拖放时，预加载在事件中同步取得文件路径；主进程经转换模块自己的封装调用 `resolveDroppedInputPaths`。规则：
  - 拒绝目录（`folder_not_supported`）、符号链接与非普通文件（`not_a_regular_file`）、不存在的文件（`file_unavailable`）。
  - Explorer 放在 `%TEMP%` 的临时副本无法还原时，只拒绝这些临时副本（`temporary_copy_unresolved`）；同批中不在 `%TEMP%` 的文件照常加入。
  - 选择文件和选择输出文件夹都由主进程对话框完成。
- AC-ENGINE-07-3: 渲染进程拿到的内容只有条目 id、显示名、所在文件夹名、媒体摘要和脱敏后的错误日志。日志中已知的输入、临时、输出和工作路径被替换为 `<input>`、`<output>`、`<work>`，其余绝对路径按现有诊断脱敏规则处理。「在文件夹中显示」只接受条目 id，并且只对本工具发布的输出有效。

#### 边界与异常

- 单次最多添加 100 个文件，超出部分不添加，返回数量提示。
- 同一个文件（按身份判断）重复添加时，返回已有条目的 id，不新建条目。

### R-ENGINE-08 采样切片、测量与帧提取

| 字段 | 值 |
| --- | --- |
| 来源 | BR-04, BR-05 |
| 状态 | deferred |
| 批次 | I2 |
| 优先级 | P1 |

#### 说明

为 I2 的画质目标、预估与预览对比提供底层能力：

- 无损切出采样片段；
- 用相同设置对片段做采样编码；
- 运行 libvmaf，得到逐帧分数与分位数；
- 提取时间对齐的原始帧与压缩帧，HDR 帧映射为 SDR 后显示；
- 保留样片供系统播放器播放；
- 管理 2-pass 日志。

多输入的滤镜图使用带标签的 `-/filter_complex` 文件。进入 I2 前细化验收标准。

### R-ENGINE-09 macOS 媒体引擎

| 字段 | 值 |
| --- | --- |
| 来源 | BR-07 |
| 状态 | deferred |
| 批次 | I4 |
| 优先级 | P1 |

#### 说明

macOS arm64 使用独立的 `media-tools` 运行时：许可为 LGPL-2.1-or-later，不启用 version3，有自己的清单、签名与完整性校验，不改动转写用的冻结运行时。方案以 Q-02 的结论为准。

还需解决以下问题：

- **取消：** 立即发 SIGKILL。临时文件反正要删掉，SIGTERM 会触发不必要的 `+faststart` 重写。
- **孤儿进程：** 在记录中保存 ffmpeg 的 pid、启动时间和可执行文件路径；启动时先终止匹配的孤儿进程，再清理临时文件。
- **低占用模式：** macOS 没有 CPU 亲和性，用 `taskpolicy` 或 nice 实现。

进入 I4 前细化。

## 约束

- **冻结副本：** 只 import `electron/main/subtitle-studio/transcription/native/*` 的导出（运行时校验、进程环境、文件身份、拖放还原），不修改这些文件；不新增 `electron/main/local-subtitle/` 下的文件。
- **审计登记：** 修改 `electron/main/index.ts`、`electron/preload/index.ts` 后，要在 `scripts/subtitle-studio-provenance/current-composition-audits.json` 与 `resources/speech-resources/provenance/current-integration-audits.v1.json` 中重新登记 blob，并补一个组合测试。
- **预加载：** 预加载代码只能依赖 zod（`scripts/check-preload-bundle.mjs`）。
- **原因码：** 英文 snake_case，在 `src/media-converter/contract.ts` 中以封闭枚举定义，界面文案经 i18n 映射。
- **测试开关：** 测试注入开关（能力覆盖、故障注入、打开文件夹的桩）只在未打包的测试构建中生效，打包后一律忽略。
- **真实 ffmpeg 测试：** 只用测试时生成的 2 s 以内小样，以低优先级运行；运行时缺失时跳过。
