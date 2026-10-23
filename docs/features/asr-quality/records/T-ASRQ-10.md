# 实施记录：T-ASRQ-10

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-10 |
| 日期 | 2026-10-22 |
| 验证版本 | 工作树，基于 68ffd05（未提交）。新增：`test/asr-quality/recognize-smoke.test.ts`（门控 `FUSIONKIT_ASR_AB=1`）、`test/asr-quality/recognize-smoke-harness.ts`、`test/asr-quality/recognize-report.ts`、`test/asr-quality/recognize-report.test.ts`；记录与证据 `records/T-ASRQ-10.md`、`records/T-ASRQ-10-run.txt`、`records/T-ASRQ-10-listening.md`。修改：`test/asr-quality/ab-comparison-harness.ts`（导出辅助函数，`readOnlySpeechResources` 改为按 ID 查多个模型）。没有改任何源码，也没有改 design.md；`records/model-smoke.md` 原样保留 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；NVIDIA GeForce RTX 4070 Ti SUPER 16 GB（驱动 610.88）；内置运行时 `build/subtitle-studio-resources/transcription`（whisper.cpp v1.9.1，运行时代 3a2ac09dfc9b…，含 FFmpeg）；模型为 `D:/fusionkit-asr-eval/models/` 的 anime-whisper q8_0（SHA-256 6a04b746…）与 Belle（2a3bba5b…），按目录哈希核对后复制到 `%TEMP%` 下的临时资源根；Silero VAD 与 CUDA 12.4 包（包代 96eee2a1…）只读取自 `%APPDATA%/FusionKit/speech-resources`，同样复制；字幕来自 `test-results/asr-quality-ab/run-2512BY` 的 large-v3 standard 转写；临时 userData 与文档库，没有启动 Electron，没有导入或安装任何资源 |
| 任务指纹 | 5edba1af41bf1799045decf629a423361f0b6d2f2224a47292a8268c7d0ee6c5 |

## 实际结果

### 范围

本任务分两部分：

1. 原生冒烟：下载、校验，并直接用 whisper-server 测三款模型。早先完成，记录是 `records/model-smoke.md`，证据是 `records/model-smoke-download.txt` 与 `records/model-smoke-runs.txt`。本记录引用那里的结论，不重复，那份文件保留不动。
2. 应用路径：turbo 的整段转写由 T-ASRQ-09 跑过（`run-devt9J`，见 `records/model-smoke.md` 末节与 `records/T-ASRQ-09.md`）。本次补上 anime-whisper 与 Belle 的重新识别，走 T-ASRQ-07 做好的生产路径。

### 应用路径怎么测

- 新增门控测试 `recognize-smoke.test.ts`（`FUSIONKIT_ASR_AB=1`），重活在 `recognize-smoke-harness.ts`，报告渲染在纯模块 `recognize-report.ts`（有单元测试）。资源替身复用 A/B 对照工具的 `readOnlySpeechResources`：原来只能给一个模型，现在按 ID 查一个列表，A/B 路径传 `[resources.model]`，行为不变。
- 文档：读 `run-2512BY/<样本>.standard.json` 的字幕，先核对样本文件的 SHA-256 与该次运行记录的一致，再用 `transcriptToDocument` 建文档（与转写任务写文档用的是同一个适配器），`repository.create` 时附上 `captureSourceInput(样本文件)`。这样 `CueMediaService` 会把它当作“转写的原文件”。
- 识别：每句的请求先用 IPC 的 `cueRecognizeRequestSchemas.recognizeCue` 校验，取对话框在默认设置下会发的值：设备 `auto`、语言按样本（A/B/C 为 ja，PV 为 zh）、不带提示词。然后调用生产的 `recognizeCue`，用内置 FFmpeg 的 `CueAudioClipper` 解码；它内部做剪辑范围、低音量增益、模型配置与复核规则，再经 `runtime.recognize.clip` 送到 whisper-server。每个模型一个新的运行时和一个新的服务进程，句子之间共用这个进程，与应用一致。结束后 `shutdown('app_quit')`，逐个确认 PID 已退出。
- 观察：`acquire` 的耗时（加载）、`beginInference` 实际发出的 multipart 字段、服务快照（PID、加载身份）、后端证明。每句的剪辑另存一份 WAV，供听审。
- 对照：所有句子按应用方式识别完后，再把同一剪辑去掉 `noTimestamps` 识别一次，只用来看开头怪字。这不是应用会发出的请求。
- 开头怪字的判定（`oddLead`）：结果开头是拉丁字母、数字或 U+FFFD，而原文不是这样开头。例如「A班」开头的原文不算。

### 结果

运行 `test-results/asr-quality-recognize/run-0fDn3f`（备份 `D:/fusionkit-asr-eval/recognize-runs/run-0fDn3f`），21:42–21:43，测试 51 s，一次通过：`failures=[]`、`sourcesUnchanged=true`、`workRemoved=true`。逐句明细与原始输出在 `records/T-ASRQ-10-run.txt`。

| 模型 | 样本 / 句数 | 服务进程与加载 | 首句 总 / 服务 / 加载 | 其余每句 总 / 服务 | 置信度 | 复核标记 | 开头怪字 应用 / 有时间戳对照 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| anime-whisper-q8_0 | A 5、B 1、C 3，9/9 成功 | 47388，`inference/cuda/anime-whisper-q8_0`，CUDA 证明 | 7.2 / 6.9 / 3.8 s | 0.34–0.51 / 0.27–0.43 s | 0.723–0.925 | 0 | 0/9 / 9/9 |
| belle-large-v3-turbo-zh | 中文 PV 前 60 s 内开始的 19 句，19/19 成功 | 48892，`inference/cuda/belle-large-v3-turbo-zh`，CUDA 证明 | 5.1 / 4.8 / 3.3 s | 0.29–0.58 / 0.20–0.47 s | 0.820–0.989 | 0 | 0/19 / 0/19（另有 3 句以 ASCII 标点开头） |

- 请求字段：28 句全部是 `no_timestamps=true`、`vad=false`、`beam_size=5`、`temperature=0`，语言为 ja（anime-whisper）或 zh（Belle），都没有 `prompt`。剪辑为字幕两侧各加 200 ms，在媒体开头处更短（A #1 前侧只有 30 ms），长度 0.98–11.64 s。服务端每句返回 1 段，没有 `start`/`end`，段的时间取整段剪辑。返回语言是 japanese / chinese。
- anime-whisper 开头怪字：应用路径 9 句都没有。有时间戳的对照 9 句全部有，依次是「There」「S」「R」「S」「s」「S」「U+FFFD」「s」「C」；段的结束时间 9 句都是 30000 ms，avg_logprob 也更差（−0.84…−0.26，应用路径 −0.32…−0.08）。这与原生冒烟 c2 的结论一致：`no_timestamps=true` 去掉了怪字，有时间戳时时间没有意义。A、C 的 8 句剪辑区间与原生 c2 相同，应用路径文字有 6 句与原生 `no_timestamps=true` 逐字相同，另外 2 句只差句末「…」和一处拟声。
- Belle：有时间戳的对照也没有拉丁怪字，但有 3 句以 ASCII 标点开头（「,你。」「,而且。」「.打扰…」）。段的结束时间 15 句等于剪辑末尾，3 句差 10 ms，1 句（#5，1.0 s 剪辑）为 30000 ms。在单句剪辑上 Belle 只给一个整段；原生冒烟中 30 s 窗口也是每窗 1 段。所以它的时间戳仍不能用来切句，保持“仅重识别、用字幕自身的时间”。应用路径的输出带中文标点；19 句中，去掉标点后与原文相同的有 11 句（6 句只加了标点，5 句完全相同）。
- 文字（只看文字，没有听，逐句见听审清单）：
  - anime-whisper 字数 161 → 200，多出的主要是语气词与拟声，例如 C #3 多了「いえ」「痩せるのか」「ちゅっ、んちゅっ…ちょっと」，C #1 多了「こら」（T-ASRQ-09 的低音量预设也听到）。「2駅」写成「二駅」，「スベスベ」写成「すべすべ」。
  - Belle 字数 137 → 160。可能更好的：#18 原文「莱丽丝派姆菲尔德」置信度 0.695，Belle 是「泰姆菲尔德」。可能更差的：#11「焕然一新」→「焕然一些」（原生冒烟同样错），#6「她」→「它」。
- 相邻句重复（新发现）：Belle 有 5 句（#4、#6、#8、#15、#17）开头带着上一句的文字，即「所以」「你」「当然」「可是」「而且」。这 5 个上一句都很短，并与本句首尾相接（large-v3 的 DTW 拆句）。仅重识别模型的剪辑在两侧各多取 200 ms，并且听到的全部文字都计入结果（design 方案 5），所以上一句的尾音会进入本句。如果全部采用，相邻两句会重复一个词。anime-whisper 的 A #4「め…」（上一句以「ごめん」结尾）、C #2「な、」（上一句以「取るな」结尾）可能是同样的原因；原生冒烟的同一剪辑也有「め…」。这 7 句复核规则都没有标记（`duplicate_neighbor` 只比较整句）。这属于产品行为，不在本任务写集内，没有修改。可选的处理交协调者决定：对仅重识别模型，在与相邻字幕相接的一侧不加边距；去掉与上一句结尾相同的开头；或者新增一条复核原因。
- 清理：两次 `shutdown` 都完成，进程 47388、48892 都已退出，工具没有结束任何进程。运行后（含下面的 A/B 回归）`whisper-server` 为 0 个，`%TEMP%` 下没有 `asrrr-*` 或 `asrab-*`。D 盘模型的大小与修改时间不变，只读输入的身份前后一致。
- 对照工具回归：改动 `ab-comparison-harness.ts` 后，用 B-noise × standard（已安装的 large-v3，只读）跑了一次真实 A/B，结果与 `run-2512BY` 相同（no_content，1 个请求），新目录为 `run-mg2gkR`。设置了 `FUSIONKIT_KEEP_TEST_RUNS=1`，`run-2512BY` 仍在。`test/asr-quality/` 单元测试 23 个与 `test/subtitle-studio/boundaries.test.ts` 8 个通过。仓库的 `tsconfig.json` 不包含 `test/`，另用一份继承它、加入 `test/asr-quality` 与 `test/support` 的临时 tsconfig 做了类型检查，0 错误。

### 结论（AC-ASRQ-04-5）

| 模型 | 应用路径 | 加载与识别 | 时间戳 | 输出 |
| --- | --- | --- | --- | --- |
| large-v3-turbo-q8_0 | 整段转写（T-ASRQ-09，`run-devt9J`） | 6 个样本都完成，CUDA，文档转写稿记录 turbo 及其哈希 | 句级，可用 | 可用；准确性低于 large-v3，适合“快速”档 |
| anime-whisper-q8_0 | 重新识别（本次） | 9/9，CUDA | 模型时间不可用（对照中结束恒为 30 s），用字幕自身时间 | 应用路径没有开头怪字；文字是否更准待听审 |
| belle-large-v3-turbo-zh | 重新识别（本次） | 19/19，CUDA | 每段覆盖整个剪辑或窗口，不能切句，用字幕自身时间 | 有标点；有相邻句重复与个别错字，是否更准待听审 |

结论：anime-whisper 与 Belle 都保持“仅重识别”（`transcription-model-profiles.ts` 现有配置）。应用路径能加载并识别，`no_timestamps=true` 是必要的。design.md 第 86 行的描述与实际行为一致，不需要改。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-10-1 | 通过 | file:records/T-ASRQ-10-run.txt |
| V-ASRQ-10-2 | 未运行 | inline:需要用户按 records/T-ASRQ-10-listening.md 的 28 行（anime-whisper 9 句、Belle 19 句，每行有音频路径、区间、原文与重识别文字）听审并填写结论；Agent 没有听音频，不代签 |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-04-5 | 通过 | V-ASRQ-10-1 |

## 风险与未执行项

- 2026-10-22 协调者已按本记录的发现修补：仅重识别剪辑的填充不再越过相邻字幕（records/polish.md 第 5 项）。听审清单仍是修补前的剪辑结果；修补只影响与上一句/下一句首尾相接的句子（Belle #4、#6、#8、#15、#17，anime-whisper A #4、C #2 可能也在内）。
- 2026-10-23 整体回归中用修补后的工作树复跑了本冒烟（同一命令，`FUSIONKIT_KEEP_TEST_RUNS=1`）：`run-olRvTt`（备份 `D:/fusionkit-asr-eval/recognize-runs/run-olRvTt`），一次通过，`failures=[]`、`sourcesUnchanged=true`、`workRemoved=true`，两个服务进程（82756、54416）都已退出，之后 `whisper-server` 为 0 个。证据：`records/T-ASRQ-10-recheck.txt`。与 `run-0fDn3f` 逐句对照：
  - 被点名的 7 句都不再以上一句的词开头：Belle #4「所以爱丽丝。」→「爱丽丝」，#6「你你就修改了它。」→「你就修改了他。」，#8「当然，A班的杰奎琳同学拜托我的。」→「A班的杰奎琳同学拜托我的。」，#15「可是这是…」→「这是贝尼尼教授的得意之作。」，#17「而且还是…」→「还是校董定制的私人肖像。」；anime-whisper A #4「め…いや、…」→「いや、なんかさ、ちょっと徒歩で向かっててさ」，C #2「な、なんか…」→「なんか触り方に情緒がない」。这 7 句的剪辑都短了 200–400 ms（与上一句相接的一侧不再加边距），复核原因仍为空。
  - 副作用：样本中的字幕大多首尾相接，修补后 anime-whisper 9 句中 8 句、Belle 19 句全部的剪辑变短，文字有变化的是 anime-whisper 7 句、Belle 6 句。除上面 7 句外：A #2 开头的「あ、」不再出现（这个音在 A #1 的时间范围内，A #1 的结果修补前后都以「あっ」结尾，所以修补前是同一个音出现两次）；A #5 丢了原文（large-v3）也有的「うん、」，而 A #4 的结果里也没有它，这个词可能跨在 23.91 s 的字幕边界上，两边的剪辑都听不全；C #3 不再有「いえ」（只有修补前带边距的剪辑听到，large-v3 原文没有）。其余是剪辑变短后的识别波动：A #1「来た」→「した」、A #5「二駅」→「二息」、Belle #1「家」→「加」，均更差；Belle #4 不再带句号。字数 anime-whisper 161 → 186（修补前 200），Belle 137 → 149（修补前 160）。
  - 结论：相邻句重复已消除；代价是与上一句首尾相接、且边界正好落在词中间的句子可能丢掉边界上的词（本次 28 句中 1 句：A #5「うん」）。听审清单 `records/T-ASRQ-10-listening.md` 仍是修补前的剪辑与文字，没有重写；`run-olRvTt/clips/` 是修补后的剪辑。是否给相接的一侧留一点余量（例如几十毫秒），交协调者与用户听审后决定，本次没有改代码。

- AC-ASRQ-04-5 只要求加载、识别并记录时间戳与输出是否可用，所以记为通过。anime-whisper 与 Belle 的文字是否比 large-v3 更准，要等用户听审（V-ASRQ-10-2）。
- 相邻句重复（Belle 5/19，anime-whisper 疑似 2/9）是现有重新识别行为的直接后果，复核栏看不到。用户在两遍式整篇替换中全部采用时会出现重复词。本任务没有改产品代码，需要协调者安排处理。
- turbo 的应用路径证据来自 T-ASRQ-09 的运行（本任务只重读了 `run-devt9J/report.json`，没有重跑），覆盖的是整段转写，没有测 turbo 的重新识别。
- 只测了 CUDA 与默认设置：没有测 CPU；没有给 Belle 发提示词（配置允许）；没有通过真实界面对话框操作，对话框由 T-ASRQ-07 的界面测试覆盖，用的是受控运行时。没有记录每个剪辑是否触发了低音量增益（B 是低音量样本）。
- 样本很少（日语 9 句、中文 19 句），字幕来自 large-v3 的一次转写；换一份时间轴，剪辑和结果都会不同。
- 修改了 A/B 对照工具。只回归了 B-noise × standard 一个组合，没有重跑 27 个组合的完整矩阵。门控变量与 A/B 相同：`FUSIONKIT_ASR_AB=1 npx vitest run test/asr-quality/` 会同时跑完整矩阵和本冒烟，单独跑时请指定文件。
- 证据目录 `test-results/asr-quality-recognize/run-0fDn3f` 以后若不设 `FUSIONKIT_KEEP_TEST_RUNS=1` 再跑本测试，可能被清理；D 盘有备份。其中 `clips/` 的 28 个 WAV 是用户素材（含 PV）的片段，git 已忽略，不再需要时可以删除，D 盘的模型（约 3.3 GB）同样如此。
- 未提交。
