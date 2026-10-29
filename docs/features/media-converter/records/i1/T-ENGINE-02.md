# 实施记录：T-ENGINE-02

| 字段 | 值 |
| --- | --- |
| 任务 | T-ENGINE-02 |
| 日期 | 2026-10-26 |
| 验证版本 | snapshot-sha256:97f14f59943f5ae02a2c538b6dccabb4e6b9cc3ae229af8c717ddecae9847e5f（基线 a742ec76 + 未提交工作树）。独立评审修复之后取得：最后一次代码修改、全部验证重跑与证据文件写入都在它之前。其他任务同时在同一工作树中修改各自的文件，这个快照覆盖全部未跟踪文件，因此会随它们变化。本任务写集文件在快照时的 sha256：`engine/process.ts` d5935317…a8e81285，`engine/progress.ts` ce61a5d7…6084b9（评审未改），`process.test.ts` 2a752a3c…36fc8b77，`progress.test.ts` 7c024e22…cb03b（评审未改）。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；随附 ffmpeg/ffprobe n8.1.2-21-gce3c09c101-20260630（BtbN，LGPL），经 `verifyLocalSubtitleRuntimeBundle` 校验；i5-13600KF，20 个逻辑处理器；RTX 4070 Ti SUPER（未使用 GPU 编码）。被测的 ffmpeg 由本任务代码设为 BELOW_NORMAL，低占用用例设为 IDLE；测试素材以 IDLE 优先级生成，均为 lavfi 小样（≤2 s，≤320×180；两段 20 s 时间线的样片只有 2 s 画面，其中一段带 20 s、8 kHz 的正弦音频，用来构造超出 max(2 s, 1%) 容差的时长差）。 |
| 任务指纹 | d4d1b819bf6d1697370b3e3e6bf3964fd37e71a044c6dc33faba94defcde04b6 |

## 实际结果

本任务没有界面，不涉及截图。

**新增文件（均在写集内）**

- `electron/main/media-converter/engine/progress.ts`：纯函数，没有 I/O，也没有定时器。
  - `ProgressParser` 逐行解析 `-progress pipe:1`。
    - 每行上限 16 KB。超长的行整行丢弃，跨分块时同样丢弃。解析器只保留一行未完成的内容和正在读的块。
    - 处理时长依次取 `out_time_us`、`out_time_ms`（其值实为微秒）、`out_time`。
    - `N/A`、负值、非法数字、超过 2^53 的值都记为 null。
    - 能解析 `speed`、`bitrate` 的前导空格与单位，并识别 `progress=end`。
    - 关闭时，没有换行的最后一行仍会读入，未结束的块丢弃。
  - `mergeProgress`：某个值为 N/A 时保留上一次的已知值。处理时长与已写字节只增不减。
  - `phaseFraction` / `jobFraction` 计算百分比：处理时长 ÷ 预期时长，结束前最多 99%。多阶段按权重合成。时长未知时返回 null，界面显示不确定进度。
  - `EtaEstimator` / `ProgressTracker` 估算剩余时间：对观测到的进度速率做按时间加权的指数平滑（半衰期 8 s，前 3 s 不给估计）。平滑的对象是整个任务的进度份额，所以后续阶段按权重计入剩余时间。
  - `createLogRedactor` / `redactFfmpegLog` / `redactedLogTail` / `utf8Tail` 负责脱敏，规则见下文。
- `electron/main/media-converter/engine/process.ts`：
  - **启动**：自有 spawn，参数为 `shell:false`、`windowsHide:true`、`stdio:['ignore','pipe','pipe']`，不设 `detached`。
    - 环境变量由 `encodeEnvironment()` 生成。它只复用 `buildLocalSubtitleMediaEnvironment`，TEMP 指向任务工作目录。
    - 没有修改，也没有包装冻结的 `media-process.ts` 运行器。
    - 启动前会创建工作目录。
  - **优先级**：`spawn` 事件后立即调用 `os.setPriority(BELOW_NORMAL)`。
  - **低占用模式**：优先级改为 `PRIORITY_LOW`（Windows 上即 IDLE），再用一次 PowerShell（`$ErrorActionPreference='Stop'; (Get-Process -Id <pid>).ProcessorAffinity = [IntPtr][Int64](<掩码>)`）设置亲和性。
    - 掩码 `lowUsageAffinityMask` 取前 64 个逻辑处理器中编号靠后的一半。本机有 20 个，掩码为 0xFFC00。
    - PowerShell 用 SystemRoot 下的绝对路径启动，隐藏窗口，有自己的 16 s 截止时间。
    - 设置失败只记录日志，不影响任务。
    - ffmpeg 先结束时中止 PowerShell，记为 `abandoned`。
    - 设置函数、处理器数、平台、时钟、阈值、日志都可以注入。
  - **参数**：
    - 统一前缀为 `FFMPEG_COMMON_PREFIX`。调用方传入的参数已带前缀时不重复添加。
    - `ffmpegInput()` 生成 `-f <解复用器> -protocol_whitelist file -i file:<路径>`。
    - `assertGuardedInputs()` 要求每个 `-i` 都按上面的形式写：解复用器在 `MEDIA_DEMUXERS` 内，路径是绝对路径；`-re`、`-ss` 等输入选项可以写在前面。
    - 前缀已有的选项（`-loglevel`、`-v`、`-progress`、`-stats_period`、`-nostdin` 等）和 `-report` 不允许调用方再给。
    - `-fs` 必须与 `capBytes` 一致：给了上限就必须有 `-fs`，反之亦然。
    - 命令行估算超过 32,000 字符时拒绝启动。
  - **超长滤镜**：单个流的滤镜超过 8 KB（按 UTF-8 计）时，`externalizeLongFilters` 把它写入 `work/<id>/filter-<v|a><n>.txt`，改为 `-/filter:v:0 file:<路径>`（`-vf` 改为 `-/filter:v`，音频改为 `-/filter:a:N`）。`-filter_complex` 不处理，留给 I2。
  - **stderr**：只保留最后 256 KB（环形缓冲），超出不会终止进程。每行先脱敏再分类，识别 `disk_full` 与 `output_open_failed`；`disk_full` 优先。
  - **停滞**：纯函数 `assessStall` 加上每 10 s 一次的检查，阈值与时钟都可以注入。超阈值时终止进程，原因码为 `encoder_stalled`。
  - **取消**：AbortSignal 触发 `child.kill()`（即 TerminateProcess），结果在 `close` 之后才给出。`close` 迟迟不来时，5 s 后以 `close_unconfirmed` 结束；`closed` Promise 仍会在进程真正关闭时完成（FK-PIT-0036）。
  - **触顶**：进程关闭后，取最后一个进度块的 `total_size` 与输出文件实际体积中的较大者，≥ 上限 − min(64 KB, 上限的 0.5%) 时记为触顶。
  - **成功判定**分两步：
    - `runFailure`：进程层面，依次检查取消、停滞/磁盘满/输出无法打开、启动失败、触顶、退出码、`progress=end`。
    - `judgeEncode`：输出层面，依次检查 ffprobe 能否解析、计划中的各类流数量、时长是否在 max(2 s, 1%) 内。时长未知，或者源文件的流时长与容器时长矛盾时，只要求处理时长 > 0，并附 `duration_unverified`。预期时长来自源主流时，与输出主流的时长比较；来自源容器时（`expectedFrom: 'container'`），与输出容器的时长比较。输出自身的流时长与容器时长不一致不会免检（见「评审与修复」）。
    - 失败结果带 `reason`、引擎原因码 `code` 和 `detail`（脱敏后的 stderr 末尾）。
- 测试：
  - `test/media-converter/progress.test.ts`：纯测试，20 项。用一段真实 ffmpeg 8 进度输出（逐字复制）验证各种分块方式下的解析结果。
  - `test/media-converter/process.test.ts`：40 项（评审前 37 项，评审新增 3 项并扩充 4 项）。
    - 前半部分用脚本化的假子进程和手动时钟，验证生产阈值（300/600/120 s，以及 120 s + 字节数 ÷ 20 MB/s）、kill 与 close 的处理、stderr 洪泛和分类。
    - 后半部分用真实随附 ffmpeg 做集成测试（14 项）。

**脱敏规则**

- 已知的输入路径替换为 `<input>`；输出路径与临时路径（partial）替换为 `<output>`；工作目录替换为 `<work>`。
- 带或不带 `file:` 前缀、正斜杠或反斜杠、大小写不同、带 `\\?\` 前缀的写法都会替换。最长的先替换，所以工作目录中的 partial 文件记为 `<output>`。
- 其他绝对路径按 `server-diagnostics.ts` 的模式处理，替换为 `[path]`：Windows 路径、UNC 路径、file:// URL、引号中的路径、POSIX 路径。路径末尾的 `: ; , .` 不算在路径内。SVT 日志中 `width / height` 这类孤立的 `/` 不当作路径。
- 去掉控制字符与终端转义序列。
- 取日志尾部时只取整行。环形缓冲丢弃过旧数据后，开头那行不完整，会被丢弃，因此被截断的路径不会以残片出现。

**用真实 ffmpeg 核对的事实**（随附 n8.1.2，以 IDLE 优先级在 scratchpad 实测，素材用后已删除）

- 输出初始化之前（每个输出流都拿到第一个包之前），ffmpeg 不输出任何进度块。因此首包前的阶段只能靠计时判断，本实现的看门狗不依赖进度块到达。
- 纯音频输出的进度块中没有 `frame`/`fps` 两个键。
- `-fs` 截断的情况：
  - 退出码仍为 0，仍会输出 `progress=end`。
  - 截断后文件的最终体积大于等于上限。例如上限 100 000 字节时，MP4 为 280 KB，MKV 为 193 KB。
  - 最后一个进度块的 `total_size` 等于文件实际体积。
  - 截断后时长为 1.48 s，与预期 2 s 的差在容差 max(2 s, 1%) 之内。这种截断只有触顶判定能发现，测试中也是这样验证的。
- 用 `-n` 写入已存在的文件时，ffmpeg 输出 `File '…' already exists. Exiting.`，退出码为 0，没有任何进度。
- 输出目录不存在时，先输出 `[out#0/matroska @ …] Error opening output file:<路径>: No such file or directory`，再输出通用的 `Error opening output file <路径>.`。滤镜与流类型不匹配（视频滤镜用在音频流上）时，也会出现这行通用文字，但没有 `[out#…]` 开头的那一行。
- `-/filter:v:0 file:<绝对路径>`、`-/vf`、`-/filter:a:0` 都能从文件读取滤镜。
- 用 noise bsf 损坏的 mpeg4 在解码时，按 `level+warning` 产生约 518 KB stderr，退出码为 0。
- PowerShell 设置亲和性约需 350 ms。读回结果为 `Idle|1047552`。

**变异检查**（file:records/i1/T-ENGINE-02-mutations.txt）

在评审前的源码上（`process.ts` 5180c6f6…）逐一做 24 处临时修改，每次修改后用 V-ENGINE-02-1/2 的命令运行对应测试文件，再写回原文件，并比较 sha256 确认已还原。24 处修改都至少使一项测试失败；证据文件中列出了每次失败的测试名。评审修复的 6 处另做了变异检查，见「评审与修复」与 file:records/i1/T-ENGINE-02-review-mutations.txt：

| 编号 | 变异 | 失败的测试 |
| --- | --- | --- |
| M1 | 不设 BELOW_NORMAL | 2：假进程优先级用例；真实 ffmpeg 的 BelowNormal 回读 |
| M2 | 低占用掩码改为全部处理器 | 3：掩码表；假进程低占用用例；真实 PowerShell 回读（期望值在测试中独立算出） |
| M3 | 不检查输入守卫 | 1：参数校验用例 |
| M4 | 首包前宽限改为 400 s | 2：`assessStall` 阈值；手动时钟下的生产阈值终止 |
| M5 | 收尾预算去掉字节项 | 3：两项 `assessStall`；真实收尾停滞（预算 = 1000 ms + 字节数） |
| M6 | 首个输出只看 frame | 1：纯音频输出用例 |
| M7 | 不检测触顶 | 1：真实 `-fs` 用例 |
| M8 | stderr 保留 1 MiB | 2：假进程洪泛；真实约 500 KB stderr |
| M9 | 分类前不脱敏 | 1：文件名中含关键词的分类用例 |
| M10 | 通用的 "Error opening output file" 也判为 output_open_failed | 2：假进程分类；真实错误音频滤镜 |
| M11 | 超长滤镜不写文件 | 1：真实 `-/filter:v:0` 用例 |
| M12 | 取消时不终止进程 | 2：真实取消 3 s 用例；`close` 截止时间用例 |
| M13 | 时长容差改为 1 s | 1：时长容差用例 |
| M14 | 不识别 `-n` 拒绝覆盖 | 2：假进程分类；真实 `-n` 用例 |
| M15 | 不要求 `progress=end` | 1：进程层面判定用例 |
| M16 | 触顶余量固定为 64 KB | 1：余量用例 |
| P1–P8 | 负值保留、`out_time_ms` 按毫秒、取消行长上限、不做 ETA 平滑、不替换 `file:` 写法、尾部保留被截断的首行、N/A 覆盖已知值、阶段不加权 | 各 1，均为对应的专项用例 |

**与设计的差异，以及设计未明确处的做法**（没有修改设计文档，详见「风险与未执行项」）

1. 触顶余量：设计是上限 − 64 KB。实现为上限 − min(64 KB, 上限的 0.5%)，并以文件实际体积为主要依据。
2. `output_open_failed` 的识别范围比设计窄。设计中凡出现 `Error opening output file` 都算，实现只认三种情况：`[out#N/…]` 开头的 `Error opening output <路径>: <原因>`、`File '…' already exists. Exiting`、`Not overwriting - exiting`。
3. 「首个进度块之前」的判定：只要出现一个 `frame > 0` 或处理时长 > 0 的进度块，就算已有输出。
4. 预期时长未知时，编码阶段的停滞预算取 max(120 s, 收尾预算)。
5. 通用失败（退出码非 0、没有 `progress=end`、无法解析、缺少流、时长不符）没有专门的原因码，使用 `unknown`，并在 `reason` 中给出细分。触顶对应 `output_cap_exceeded`，由执行器按计划的 `capSemantics` 改报为 `not_smaller`。启动失败对应 `runtime_spawn_failed`。

**评审与修复**（2026-10-26，独立对抗式评审；只改了写集内的 `engine/process.ts` 与 `process.test.ts`）

逐条对照 AC-ENGINE-04-1～5、design §4、T-ENCODE-01 的 `toFfmpegArgs` 与 FK-PIT-0036/0040/0042，通读了写集全部代码与测试，并确认真实 ffmpeg 部分确实运行（不是被 `skipIf` 静默跳过）。发现与处理如下：

1. **（主要）成功判定会放过「主流被截短」的输出。** 原 `judgeEncode` 在「输出主流时长与输出容器时长相差超过容差」时直接返回成功并附 `duration_unverified`。但这正是要拦的失败形态：视频提前结束、音频照常写完，容器时长被音频撑长，主流却短了一截。AC 中「流时长与容器时长相互矛盾」指的是预期时长的来源（源文件），不是输出。原测试还把这种情况断言为成功。
   - 修复：输出侧不再因为流与容器不一致而免检；只保留源文件侧（`sourceContainerDurationUs`）的矛盾判定。
   - 为避免误判，新增可选的 `expectedFrom`：预期时长取自源主流（默认）时，与输出主流比较；取自源容器时（源主流没有时长），与输出容器比较。这样「源容器比视频长几秒（音频更长）」的正常文件不会被误判为时长不符。
   - 复验：单元用例改为期望 `duration_mismatch`，并新增 `expectedFrom` 用例；新增真实 ffmpeg 用例：20 s 时间线加 20 s 音频的样片用 `-frames:v 25` 编码，输出视频约 1 s，容器与音频远长于它；修复前判为成功（变异 R1 证实），修复后判为 `duration_mismatch`；完整编码的对照判为成功。
2. **（次要）进程关闭未确认时仍可能报「触顶」。** `close_unconfirmed` 时进程可能仍在写文件，原顺序先看触顶，会让执行器把条目按 `not_smaller` 跳过。改为先看状态：未确认关闭一律按 `exit_code` 失败。新增用例。
3. **（次要）结果给出之后仍可能回调进度。** `close_unconfirmed` 之后迟到的 `close` 会再跑一遍解析器收尾，把未换行的 `progress=end` 当作新块回调给 `onProgress`。现在迟到的 `close` 只用来确认进程已结束。扩充了截止时间用例来证明。
4. **（次要）触顶依据的文件可能不是 ffmpeg 写的文件。** `outputPath` 只用于关闭后量体积，原实现不核对它与参数中的输出是否一致；不一致时触顶判定会悄悄失效。现在给了 `outputPath` 时，最后一个参数必须是 `file:<outputPath>`（与 `toFfmpegArgs` 一致），否则拒绝启动。新增用例。
5. **（次要）磁盘写满后又卡住时报成「停滞」。** stderr 已出现 `No space left on device`，随后进程卡住被看门狗终止时，原实现报 `encoder_stalled`，用户看不到可以处理的原因。改为 `disk_full` 优先。新增用例。
6. **（记录更正）** 原记录把执行器写成 T-ENGINE-05；按 tasks.md，执行器是 T-ENGINE-07，T-ENGINE-05 是队列。下文已更正。

检查后保留原实现的点：触顶余量 min(64 KB, 0.5%)、`output_open_failed` 的识别范围、首个输出含处理时长 > 0、停滞从最后一次增长计时，这四处偏差的理由与实测证据成立；路径脱敏的正则做了回溯耗时检查（8000 个连续斜杠的行也在 1 ms 内完成），没有问题；参数守卫、优先级与亲和性、取消与 `closed` 承诺、stderr 环形缓冲都与 design §4 一致。

变异检查：6 处修复逐一还原后，每次都至少有一项测试失败（R1 两项，其中一项是真实 ffmpeg 用例），每次都确认源文件已按 sha256 还原，见 file:records/i1/T-ENGINE-02-review-mutations.txt。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ENGINE-02-1 | 通过 | file:records/i1/T-ENGINE-02-progress.txt |
| V-ENGINE-02-2 | 通过 | file:records/i1/T-ENGINE-02-process.txt |
| V-ENGINE-02-3 | 通过 | file:records/i1/T-ENGINE-02-tsc.txt |

- V-ENGINE-02-1：（评审后在最终源码上重跑：20 passed，exit 0；评审未改 progress.ts 与其测试）。覆盖：N/A、负值（含 -9223372036854775807 与负的 out_time）、前导空格与单位、`out_time_ms` 实为微秒且优先级低于 `out_time_us`、逐字节/2/3/7/13/64 字节分块以及 CRLF 在 \r 与 \n 之间断开、超长行（单块与跨块，恰好 16 KB 保留、多 1 字节丢弃）、`progress=end` 与无换行末行、多阶段权重（两遍、分析 + 编码、非法权重）、ETA（预热、稳定速度精确、突发与暂停只部分改变估计、时间倒退与份额下降被忽略、双阶段跟踪）；脱敏：输入、临时、输出、工作路径都替换为占位符（带或不带 `file:`、正反斜杠、大小写、`\\?\`），其他绝对路径按规则替换为 `[path]`，普通 ffmpeg 文字不变，尾部按整行截取且被截断的路径不出现残片。变异检查 P1–P8 见 file:records/i1/T-ENGINE-02-mutations.txt
- V-ENGINE-02-2：（评审后在最终源码上重跑：40 passed，其中真实 ffmpeg 14 项，0 skipped，exit 0；最终源码上共完整运行 4 次（含这次证据运行），均为 40 passed）。真实 ffmpeg 部分：BELOW_NORMAL（`os.getPriority` 与 PowerShell `Get-Process` 都读回 BelowNormal，亲和性为全部处理器）；低占用模式下 PowerShell 读回 `Idle` 与掩码 0xFFC00（期望值在测试中独立算出）；记录下的 spawn 参数中每个 `-i` 前都有 `-f matroska -protocol_whitelist file`，值为 `file:<绝对路径>`；`shell:false`、`windowsHide`、cwd 与 TEMP 都是任务工作目录、PATH 只有 media 目录与 System32；取消后在 3 s 内退出（整个用例约 0.55 s，其中约 0.5 s 是等待第一个进度块），进程已不存在，partial 与工作目录可以立即删除；首包前（`-readrate 0.5` 加 select 推迟首帧）、编码中（时间戳跳跃 18 s 的样片加 `-re`）、收尾（预期 1 s，预算 = 1000 ms + 字节数 ÷ 1000 B/s）三种阶段在注入的阈值下都得到 `encoder_stalled` 和对应阶段；慢速但一直在前进的进程（`-readrate 0.3`，约 4.7 s，阈值 2 s）不被终止，并判为成功；超过 256 KB 的真实 stderr（损坏输入的解码错误，实测约 500 KB）不终止进程，只保留最后 256 KB；`-fs` 触顶被识别（退出码 0 且有 `progress=end`，时长差在容差内，只靠触顶识别）；去掉一半的 MP4 无法解析，判为失败；`-t 1` 截短 20 s 时间线判为 `duration_mismatch`；视频提前结束（约 1 s）而音频把容器撑长的输出判为 `duration_mismatch`，完整编码的对照判为成功（评审新增）；无时长的裸 H.264 输入判为成功并附 `duration_unverified`；超过 8 KB 的滤镜经 `-/filter:v:0` 文件生效（输出 160×90）；输出目录不存在与 `-n` 都识别为 `output_open_failed`，脱敏后的尾部中没有运行目录与用户名；错误的音频滤镜不被误判为 `output_open_failed`。假进程部分另验证（评审新增）：`outputPath` 与最后一个参数不一致时拒绝启动；`close_unconfirmed` 时不报触顶；迟到的 `close` 不再回调进度；磁盘写满后卡住被终止时报 `disk_full`。变异检查：评审前源码上的 M1–M16 见 file:records/i1/T-ENGINE-02-mutations.txt，评审修复 R1–R6 见 file:records/i1/T-ENGINE-02-review-mutations.txt
- V-ENGINE-02-3：（`pnpm exec tsc --noEmit -p tsconfig.json` 无诊断，exit 0）。`tsconfig.json` 只包含 src 与 electron，所以另外用继承它的临时配置检查了两个测试文件，见 file:records/i1/T-ENGINE-02-tsc-tests.txt（exit 0）。两项都在评审修复后重跑

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ENGINE-04-1 | 通过 | V-ENGINE-02-2, V-ENGINE-02-3 |
| AC-ENGINE-04-2 | 通过 | V-ENGINE-02-1, V-ENGINE-02-2 |
| AC-ENGINE-04-3 | 通过 | V-ENGINE-02-2 |
| AC-ENGINE-04-4 | 通过 | V-ENGINE-02-2 |
| AC-ENGINE-04-5 | 通过 | V-ENGINE-02-2, V-ENGINE-02-1 |

## 风险与未执行项

**由后续任务接线的部分**（本任务提供接口，并已验证到接口为止）

- AC-ENGINE-04-1 的工作目录 `userData/media-converter/work/<短 id>` 由执行器（T-ENGINE-07）选定并传入 `workDirectory`。本任务验证的是：进程的 cwd 与 TEMP 就是传入的目录，路径必须是绝对路径，启动前会创建该目录。
- AC-ENGINE-04-3 的「删除临时输出、2-pass 日志和工作目录，任务状态为已取消」由执行器与输出模块（T-ENGINE-07/04）完成。本任务保证三点：进程关闭之后才给出结果；`close` 不来时有自己的截止时间，`closed` Promise 会在进程真正关闭时完成；`runFailure` 把取消报为 `cancelled`。测试中取消后远早于 3 s 进程就已退出，随后 partial 与工作目录都能立即删除。
- AC-ENGINE-04-5 中「重新用 ffprobe 探测输出」由执行器调用 `MediaProber`，再把结果交给 `judgeEncode`。测试中用真实的 `MediaProber` 走完了这一流程。`PlannedStreamCounts` 由执行器根据计划中未丢弃的流统计得出。
- SVT-AV1 在低占用模式下附加的 `lp=1` 属于 encode 的参数表（T-ENCODE-02）。进度推送的节流（每 250 ms）属于 T-ENGINE-05；本任务的 `onProgress` 每个块都回调一次，不节流。
- 已对照 T-ENCODE-01 的 `plan/args.ts`，两边兼容：`toFfmpegArgs` 不带前缀（由本封装添加），每个输入都写成受守卫的形式，`-fs` 总是与 `capBytes` 一致，滤镜写成 `-filter:v:N` / `-filter:a:N`，长滤镜由本封装改为写文件。

**与设计的差异及理由**（未修改设计文档，建议设计负责人确认后回写 design §4）

1. 触顶余量改为 min(64 KB, 上限的 0.5%)，并以进程关闭后输出文件的实际体积为主要依据。
   - 实测中，`-fs` 截断后的文件总是大于等于上限，最后一个进度块的体积也与文件一致，所以并不需要 64 KB 的余量。
   - 固定 64 KB 对小文件会误判：「不变大」上限为源体积的 98%，源文件 1 MB 时，比源文件小 8% 的正常输出也会被判为 `not_smaller`。
   - 大文件不受影响，余量仍为 64 KB。
2. `output_open_failed` 只在三种情况下报告：`[out#N/…] Error opening output <路径>: <原因>`（avio 打开失败）、`File '…' already exists. Exiting`、`Not overwriting - exiting`。实测中，滤镜配置错误也会输出通用的 `Error opening output file X.`。若按设计的字面意思处理，会把滤镜错误显示成「无法打开输出文件」。`disk_full` 按设计识别（`No space left on device` / ENOSPC），并优先于其他原因；评审后也优先于 `encoder_stalled`（写满后卡住、被看门狗终止的进程报 `disk_full`）。
3. 「首个进度块之前」解释为：还没有 `frame > 0` 或处理时长 > 0 的进度块。实测中，纯音频输出不会报 `frame`，只看 `frame > 0` 的话，提取音频的任务会在 300 s 后被误判为停滞。实测还表明，输出初始化之前 ffmpeg 不输出任何进度块，因此这样判定与 AC 的「首个进度块」一致。另外，结果中的 `firstFrameSeen` 单独给出 `frame > 0`，供执行器的硬件降级规则（design §5）使用。
4. 停滞时长从「最后一次增长」开始计算。各阶段都这样计算，收尾阶段也一样，所以收尾阶段只要处理时长或字节还在增长就不会被终止。这样，探测到的时长偏短时（FK-PIT-0042），慢速但仍在前进的进程不会被误杀。预期时长未知时无法判断是否进入收尾，编码阶段的预算取 max(120 s, 120 s + 字节数 ÷ 20 MB/s)，避免大文件重写 `+faststart` 时被误判为停滞。
5. 原因码：`contract.ts` 不在本任务写集内，其中也没有通用的编码失败码。因此退出码非 0、没有 `progress=end`、输出无法解析、缺少流、时长不符时，原因码都用 `unknown`，`reason` 字段给出细分，`detail` 为脱敏后的日志尾部。建议由负责 contract 的任务增加专门的失败码（例如 `encode_failed`），并加上对应的 i18n。
6. 「流时长与容器时长相互矛盾」只按源文件判断：`sourceContainerDurationUs` 与计划中的预期时长相差超过 max(2 s, 1%) 时不检查时长。评审前还对输出的流与容器做同样判断，那样会放过主流被截短的输出，已删除（见「评审与修复」第 1 条）。执行器（T-ENGINE-07）需要传入 `expectedFrom`：计划的预期时长来自源容器（源主流没有时长）时传 `'container'`，否则省略。
7. 额外的防护：
   - 禁止调用方使用 `-report`。它会把含全部路径的日志写进工作目录。
   - 一个运行最多 4096 个参数，命令行估算不超过 32,000 字符。
   - 调用方已带上统一前缀时，不会重复添加。

**测试覆盖的局限**

- `disk_full` 无法在本机用真实 ffmpeg 触发（需要写满一个卷）。它由分类函数的单元测试验证（文字取自 ffmpeg 的真实报错格式），并经假进程走完整个运行流程。
- 「主进程崩溃时 ffmpeg 随之结束」依赖 libuv 的作业对象。本任务没有使用 `detached`，但没有用让进程崩溃的方式验证。
- 生产阈值（300/600/120 s、10 s 检查间隔、20 MB/s）用手动时钟验证；真实 ffmpeg 用例注入的是小阈值，用来验证阶段判定与终止确实生效。
- 混合架构 CPU 上「编号靠后的是能效核」是常见情况，但没有保证。本机 20 个逻辑处理器中，编号 10–19 包含一个性能核的两个线程和 8 个能效核。超过 64 个逻辑处理器（多处理器组）时只使用第一组。
- 时长不符的用例使用一段 2 s 的画面，其时间线带 18 s 跳跃（总长 20 s）。原因是容差为 max(2 s, 1%)，素材不超过 2 s 时无法构造超出容差的不符。

**潜在风险**

- 系统负载很高（例如用户正在玩游戏）时，BELOW_NORMAL/IDLE 的 ffmpeg 可能长时间得不到 CPU。生产阈值（120 s 以上）足够宽，但真实测试用的小阈值（1–2 s）在极端负载下可能误报。最终源码上连续多次运行都稳定通过。
- 参数守卫只约束输入（`-i`）与本封装自己的选项。`-attach`、滤镜中的 `movie=`/`subtitles=` 等也能读取其他文件，`-vstats_file` 等能写文件；I1 的参数全部由 `toFfmpegArgs` 生成，不含这些。I3 若开放用户自填滤镜，需要在那时为滤镜内容加白名单（评审记录，未在本任务处理）。
- AC-ENGINE-04-3 与 AC-ENGINE-04-5 同时列在 T-ENGINE-07 的验收中。本任务的「通过」只覆盖进程层（3 s 内退出、关闭后才给结果、判定逻辑与真实 ffprobe 回读）；清理、「已取消」状态、重新探测输出与 `expectedFrom` 的接线由 T-ENGINE-07 实现并验收。
- PowerShell 设置亲和性要启动 powershell.exe，约需 350 ms，期间 ffmpeg 已经以 IDLE 优先级在全部核上运行。企业策略禁用 PowerShell 时，只会得到 `affinity: 'failed'` 和一条日志。
- 一个运行结果持有 256 KB 的 stderr 缓冲，直到结果对象被释放。执行器应在取出日志尾部后丢弃结果对象。

**未执行项与运行环境说明**

- 未运行全量测试，也未启动 Electron。所有命令都只运行这两个非 Electron 的 vitest 文件。
- 真实测试在 `test-results/media-converter/process-*` 下创建运行目录，结束后删除，`test-results/media-converter/` 本身为空；假进程用例使用 `%TEMP%` 下的 `fk-process-*` 目录，结束后删除。运行后检查过，没有残留的 ffmpeg 进程。
- 前期实测在会话 scratchpad 的独立子目录中进行，素材是 lavfi 小样，没有提交任何二进制文件。
