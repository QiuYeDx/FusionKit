# 实施记录：T-ASRQ-16

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-16 |
| 日期 | 2026-10-25 |
| 验证版本 | 工作树，基于 8c0980a6（未提交），本步骤没有改代码。文件哈希：`electron/main/subtitle-studio/transcription/native/subtitle-post-processor.ts`（sha256 0bc24af7…）、`electron/main/subtitle-studio/transcription/transcript-executor.ts`（e0859f89…）、`test/subtitle-studio/transcription/productionExecutor.test.ts`（1285ddef…）、`test/subtitle-studio/transcription/anchorRetiming.test.ts`（f6542f36…）、`test/asr-quality/ab-report.ts`（23311055…）、`test/asr-quality/ab-report.test.ts`（71bede98…）、`test/asr-quality/ab-comparison-harness.ts`（00749fd6…）、`scripts/subtitle-studio-provenance/current-copy-audits.json`（59decea2…），与门槛那一步记录的哈希相同。真实重跑 run-8YtcFr（2026-10-25 03:17:21–03:27:21 +0800）。证据：`records/T-ASRQ-16-unit.txt`、`records/T-ASRQ-16-provenance.txt`、`records/T-ASRQ-16-rerun.txt`；门槛那一步的 `records/T-ASRQ-16-gate-*.txt` 与门槛之前那次重跑的 `records/T-ASRQ-16-rerun-lGjDZk.txt` 保留作历史。本机对照脚本 `test-results/asr-quality-ab/timing-fix-compare.mjs` 与 `timing-fix-records.mjs` 在本步骤扩展过（被忽略的目录）。同一工作树里还有 T-ASRQ-14 的改动与协调者的规格改动 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；NVIDIA GeForce RTX 4070 Ti SUPER 16 GB（驱动 610.88）；内置运行时 `build/subtitle-studio-resources/transcription`（whisper.cpp v1.9.1，运行时代 3a2ac09dfc9b…，含 FFmpeg，100 ms RMS 也用它解码）；模型 large-v3（SHA-256 64d182b4…）与 CUDA 包只读；设备 CUDA。开跑前没有 ZenlessZoneZero.exe 与别的 whisper-server，GPU 0%、显存 3.6 GB；没有启动 Electron 或任何窗口，没有结束任何进程 |
| 任务指纹 | 99f88fcc2e7f06bf0502d4241b031f675a4b4c626cf25cc0a51b0979637c2f01 |

## 实际结果

用“只修整体偏早的窗口”门槛之后的代码按 run-2512BY 的配置重跑了 9 段样本 × 3 种音频类型，即 run-8YtcFr，27 个用例都正常结束。门槛的效果与离线推演一致：门槛之前改了时间的 128 个窗口里，现在只有 11 个改时间，117 个保持原时间（not_early），推演里唯一不同的是 drama 嘈杂 330–356 s，按新口径中位只有 +200 ms，也保持原时间。逐句核对也成立：not_early 窗口的 602 句里 600 句的起止与修复前的 run-Gg6ITS 相同，另 2 句是接缝去重把下一窗口那句的起点移回到这个窗口里，起点仍与修复前相同、终点取下一窗口改过的时间；仍改时间的 11 个窗口 59 句全部与门槛之前的 run-lGjDZk 相同。目标问题仍修好了：pv-zh 低音量·耳语 01:42–03:20 偏早超过 1 s 的句子从 17 句降到 2 句，偏差中位从 −2.00 s 变为 −0.08 s，100–130 s 与 175–205 s 两个窗口照旧改时间。门槛之前点名变差的地方都回到了修复前：sample A、广播剧开头（T-09 #3）、drama 150–180 s 的时间与 run-Gg6ITS 相同，被插值压短的 12 句里 10 句恢复。代价是门槛之前改对的一部分也撤回了，与标准相差超过 1 s 的句子合计 79 → 60（门槛之前 38）。门槛修不了的两处仍在：drama 296–301 s 被推晚 2.36 s，pv-ja 嘈杂 205–217 s 被推晚 2.58 s。标准模式的请求与输出与修复前逐句相同，唯一的差异是 AC-ASRQ-14-6 的修剪。预设文字的变化都对上了原因，门槛之前在 pv-zh 嘈杂 177.50 s 回来的接缝重复本次不再出现。锚点照样每个窗口都请求，耗时与门槛之前基本相同。

### 实现（design 方案 9 修法 C 与“只修整体偏早的窗口”；本步骤没有改代码）

- 执行器（`transcript-executor.ts`，不新增 import）：
  - 预设任务先按原有顺序识别完所有窗口，预设识别出的文字因此与以前相同。
  - 之后对每个被接受、有文字的窗口，用同一段 PCM 再发一次请求作为时间锚点：去掉 `vad_threshold`、`vad_min_speech_duration_ms`、`vad_speech_pad_ms`、`no_speech_thold`、`suppress_nst`；音频有增益时 `vad_speech_pad_ms` 发 1000，与标准相同。
  - 音频的 sha256 与被接受那次不同时不发。锚点请求不占窗口的请求预算，计入转写进度，响应取消；锚点失败、听不到内容或对不上时该窗口保持原时间，任务不因此失败。
- 改时间：`native/subtitle-post-processor.ts` 导出的 `retimeLocalSubtitleSegmentsFromAnchor`，在窗口段进入后处理之前调用。
  - 对齐：两边文字做 NFKC、小写，去掉标点与空白后逐字取最长公共子序列。预设段开头（结尾）两个字对到某个锚点段开头（结尾）两个字时，这条边取那个锚点段的时间。
  - 门槛（2026-10-25）：已对齐边的平移（锚点减预设，往后为正）取下中位数，达到 `LOCAL_SUBTITLE_ANCHOR_RETIMING_MIN_MEDIAN_SHIFT_MS = 500` 才改时间；不到时返回原来的段，状态 `not_early`。
  - 通过门槛后：其余边按前后最近的已对齐边插值，最外侧沿用最近一个的平移；保证起点不早于上一段终点、每段至少 0.2 s，并限制在窗口内，从窗口末尾往前挪时只挪没有锚点时间的边。
  - 改完的窗口再过一遍后处理的窗口质量检查，不通过就保持原时间，状态 `rejected`。
- 诊断：执行器返回 `anchorRetiming`，每个窗口记编号、区间、锚点段数、已对齐边数与总边数、平移中位（门槛用的已对齐边中位）、最大平移与状态，不含文字。生产环境不保存；对照工具记进每个用例的 JSON，摘要的“时间锚点”一节按状态计数并列出 retimed 与 not_early 的平移中位范围。
- 文案：两种预设的说明写明“为对准时间会再按标准识别一遍，识别时间约为标准的两倍”（4 种语言）。
- 审计：subtitle-post-processor.ts、transcript-executor.ts、productionExecutor.test.ts 的 currentSha256 与 2026-10-24、2026-10-25 两段原因已更新；三个文件都是 LF，冻结副本没有改。

### 重跑 run-8YtcFr（V-ASRQ-16-3；逐条数字见 records/T-ASRQ-16-rerun.txt）

- 对照：run-Gg6ITS（修复前，下称“前次”）、run-lGjDZk（有锚点、没有门槛，下称“门槛之前”）与 run-2512BY（去重之前），按 report.json 逐项核对为同配置。带文字的逐句对照只存本机（test-results/asr-quality-ab/run-8YtcFr/timing-fix-compare.{json,md}）。
- 门槛逐窗口核对（证据 (h) 节）：
  - 锚点请求与门槛之前逐个相同，所以两次的差别只来自门槛。窗口状态：retimed 11、not_early 119（其中 2 个门槛之前是 unaligned）、unaligned 4、empty 2、skipped 4，failed 与 rejected 都是 0。
  - 仍改时间的 11 个：pv-zh 低音量 100–130 s（+2150 ms）与 175–205 s（+5010 ms），pv-zh 嘈杂 175–205 s（+640 ms），independent 低音量 102–127 s（+510 ms）与嘈杂 152–176 s（+900 ms），drama 低音量 229–255 s（+610 ms）与两种预设的 280–306 s（+2360 / +2970 ms），pv-ja 两种预设的 175–205 s（+1880 / +1960 ms）与嘈杂 200–229 s（+2580 ms）。
  - 与离线推演只差 drama 嘈杂 330–356 s：新口径中位 +200 ms（旧口径 +900 ms），保持原时间。推演里标 proxy? 的其余 12 个窗口都与推演相同。
  - 逐句：not_early 602 句中 600 句、仍改时间 59 句全部、其余 6 句全部符合期望。
  - 不符合的 2 句都是接缝去重把下一窗口（仍改时间）那句的起点移回到前一窗口：pv-zh 低音量 #34 102.25–105.78（起点与前次相同，终点与门槛之前相同）、pv-ja 嘈杂 #59 177.42–182.96（修剪后起点停在相邻句终点 177.42 s，终点与门槛之前相同）。
- 起声强度判读（规则同协调者的 anchor-gating-sim.mjs，自动判读，没有听音频）：起点比前次移动 ≥ 300 ms 的句本次 49 句，更好 26、更差 13、分不出 10，压短 2，全部在仍改时间的窗口里；门槛之前是 238 句，82 / 108 / 48，压短 12。
- 早先变差的地方（证据 (j) 节）：
  - sample A 两种预设 11 句、广播剧开头（T-09 #3）drama 低音量 0–25 s 的 5 句、drama 150–180 s 两种预设的句子，起止都与前次相同。没有句子再落在 0.00–0.40 s 的数字静音里。
  - 被压短的 12 句里 10 句恢复，包括 T-09 #9 低音量多识别出的那句（回到 96.36–97.72 s）。仍压短的 pv-zh 低音量 #45、#72 在仍改时间的窗口末尾，被核心区截短，与门槛之前相同。
  - 门槛修不了：drama 296.39 → 298.75 s 与 296.89 → 299.25 s（低音量），296.49 → 299.46 s（嘈杂），起声判读更差；pv-ja 嘈杂 #63–#65 推晚 2.58 s，判读更差（有 BGM）。
- 与标准相比起点相差 > 1 s（AC-ASRQ-15-2，证据 (c) 节）：
  - 合计：前次 79、门槛之前 38、本次 60（推演估计 61）。
  - pv-zh 低音量 21 / 3 / 6：01:42–03:20 是 18 / 2 / 3，偏早 > 1 s 17 / 2 / 2，偏差中位 −2000 / −80 / −80 ms；100–130 s 是 11 / 0 / 0；175–205 s 是 6 / 2 / 2，偏差中位从 −5670 变为 −660 ms。01:42–03:20 多出的一句是 139.37 s（偏晚 1.76 s，所在窗口中位 0 ms，现在不改）。
  - drama、full、A、pv-ja 等其余样本大多回到前次的数目。本次 60 句逐条列出并附语音起点判读：预设更近 20、标准更近 14、分不出 26（PV 18 句里 16 句分不出）。
- 标准模式：9 个用例的请求与 run-Gg6ITS 逐个相同，8 个的字幕逐句相同；full 只有 #35 被 T-ASRQ-14 修剪。9 个用例的字幕与接缝诊断也与门槛之前完全相同。
- 预设文字与请求：
  - 识别请求与前次相同；按文字配上的句子置信度全部相同（pv-zh 嘈杂 178.18 s 留下的是下一窗口那份，0.916，前次那份 0.905）；14 个预设用例的文字与前次逐句相同。
  - 分句候选请求：drama 低音量少发了 280.05–306.15 s 那一个；另两个（477.77–504.85 s、700.54–725.83 s）窗口与字段相同、返回的段数或字数不同（与门槛之前相同），没有改变字幕。
  - 其余 4 处都对得上原因：
    - pv-ja 嘈杂 177.42 s 的修剪（T-ASRQ-14）；
    - drama 低音量 299–306 s 两句合成一句：字一样，切法与标准相同；仍改时间后分句候选请求不再发；
    - pv-zh 低音量两句被窗口核心区裁掉：127.17 s 是同一句话的另一种听法，那句话在 127.50 s 那句里还在；200.68 s 置信度 0.161，标准里没有；
    - pv-zh 嘈杂 177.50 s 的去重判定变了：留下的是下一窗口那份，与标准逐字相同；上一窗口那份开头多的 1 个语气词（低于 2 字下限）与标点随之去掉，标准里也没有这个字。
  - 门槛之前在 pv-zh 嘈杂 177.50 s 回来的接缝重复、pv-zh 嘈杂 102.50 s 的 70 ms 句与 pv-ja 低音量 127.50 s（T-09 #17）的新切法，本次都回到前次。
- 耗时（证据 (e) 节）：
  - 锚点仍对每个窗口请求，锚点的识别耗时是预设识别的 0.86 倍（Q）与 0.77 倍（N）。
  - 按同一次运行的标准算：drama 1.68 / 1.56 倍，pv-zh 1.73 / 1.71 倍，pv-ja 1.51 / 2.13 倍；9 个样本合计 Q 1.29 倍、N 1.38 倍（门槛之前 1.31、1.45，前次 0.92、1.05）。

### 门槛之前的重跑与离线推演（历史）

- 2026-10-24 实现锚点后的重跑 run-lGjDZk（门槛之前）：pv-zh 修好了，但在 pv-zh 以外也改错了不少时间。非 PV 样本中起点移动超过 1 s 的 65 句里，按 100 ms 音量前次更对的 33 句；sample A 的起点全部移进静音，T-09 #3 的前两句被压进 0.00–0.40 s 的数字静音，8 句被插值压到 0.2–0.7 s。当时判 AC-ASRQ-15-2 按条件通过、AC-ASRQ-15-3 未通过（records/T-ASRQ-16-rerun-lGjDZk.txt）。
- 协调者据此在 design 方案 9 加了“只修整体偏早的窗口”。门槛那一步只用 CPU（records/T-ASRQ-16-gate-unit.txt、T-ASRQ-16-gate-provenance.txt），并按 run-lGjDZk 离线推演（records/T-ASRQ-16-gate-whatif.txt）：12 个窗口仍改、116 个不改，与标准相差 > 1 s 的句子估计 61 句。本次重跑实际 11 个、119 个（含两个原 unaligned）、60 句。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-16-1 | 通过 | file:records/T-ASRQ-16-unit.txt |
| V-ASRQ-16-2 | 通过 | file:records/T-ASRQ-16-provenance.txt |
| V-ASRQ-16-3 | 通过 | file:records/T-ASRQ-16-rerun.txt |

- V-ASRQ-16-1（2026-10-25 03:07 重跑）：
  - anchorRetiming.test.ts 16 个用例全过，其中门槛的 4 个：正好 +500 ms 改、+499 ms 不改；整体往前或平移很小时不改；只看已对齐边；逐句越来越早的窗口仍改。
  - productionExecutor.test.ts 的 “Studio timing anchors” 15 个用例全过，其中 “sends no anchor for the standard type and returns the transcript as before” 断言标准模式不发锚点、请求字段与输出不变，另有锚点平移 −1500 ms 与 +400 ms 时保持原时间的两例。
  - ab-report.test.ts 20 个用例全过。
- V-ASRQ-16-2（2026-10-25 03:07–03:12 重跑）：
  - 三个审计文件的 sha256 与 current-copy-audits.json 的 currentSha256 相同，原因里有 2026-10-25 一段，都没有 CR；copy.mjs --check 与 transcript-executor-copy.mjs --check 通过。
  - provenance 16 个文件 233 个用例通过（2 个文件、3 个用例按条件跳过）。
  - test/subtitle-studio/transcription/ 33 个文件 821 个用例通过；非 UI 的 transcription-*.test.ts 15 个文件 234 个用例通过，transcription-bridge.test.ts 会启动 Electron，按约束没有跑。
  - ab-report.test.ts 通过；tsc --noEmit -p tsconfig.json 通过。
- V-ASRQ-16-3（run-8YtcFr）：
  - 标准逐句不变（只差 AC-ASRQ-14-6 的修剪）。
  - 两种预设与标准对应句起点差超过 1 s 的 60 句逐条列出并附音量判读。
  - 预设文字的 4 处变化逐条说明。
  - 门槛逐窗口、逐句对 run-lGjDZk 核对；早先变差的地方与耗时逐项核对。
  - 判读都是自动的，没有听音频。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-15-2 | 通过 | V-ASRQ-16-3 |
| AC-ASRQ-15-3 | 通过 | V-ASRQ-16-1, V-ASRQ-16-3 |

- AC-ASRQ-15-2：
  - 两种预设中能与标准对应上、起点相差超过 1 s 的 60 句逐条列出，每句附 100 ms 音量的语音起点判读。
  - pv-zh 01:42–03:20：低音量·耳语偏早超过 1 s 从 17 句降到 2 句，偏差中位 −2000 → −80 ms；嘈杂 2 → 1。175–205 s：低音量 6 → 2，偏差中位 −5670 → −660 ms，第一句在 180.17 s（音量起点 180.0 s）。
  - 这两段不再整体提前。剩下偏早的 2 句：176.90 s 在 150–180 s 窗口核心区末尾，时间与前次相同（门槛之前也偏早）；195.86 s 是锚点自己在那里偏早（门槛之前同样）。
- AC-ASRQ-15-3（不计 AC-ASRQ-14-6 的修剪）：
  - 标准模式：请求与 run-Gg6ITS 逐个相同；字幕只有 full #35 一句不同，就是那处修剪。
  - 预设文字：与前次相比的 4 处变化都逐条列出并说明了原因（修剪、同一段字的切法、核心区裁掉的低置信度句、去重判定随时间改变），没有新的错字或丢掉标准里有的内容。
  - T-ASRQ-09 已听审为“更好”或给出正确内容的条目：#1、#2、#3、#4、#5、#8、#11、#19 的预设文字全部不变。
    - 除 #19 外，这些条目的时间都与前次相同；前次判为失败的 #3（广播剧开头）已经恢复。
    - #19 在仍改时间的 pv-ja 175–205 s 窗口里，与门槛之前一样移晚约 1.9 s；同一窗口第一句落到标准附近（差 0–80 ms），#19 的两句判读分不出（有 BGM）。
  - 按文字与时间都看不出明显变差，判为通过。时间是否真的对齐要等 T-ASRQ-17 的听审（AC-ASRQ-15-4）。

## 风险与未执行项

- 没有听音频。所有判读都是 100 ms RMS 的自动判读，PV 有背景音乐，判读基本不可信。AC-ASRQ-15-4 要用户在 T-ASRQ-17 的听审页面确认；页面的“时间修正对比”应改用 run-8YtcFr（前次对比的是 run-lGjDZk）。
- 两种自动判读在 drama 与 full 上方向相反：
  - 按语音起点距离，门槛之前的锚点在那里整体改好了：drama 低音量起点落在停顿里 20 → 13 句，full 低音量 26 → 19 句。
  - 按起声强度，同一批移动多数改错了（门槛撤回的 119 个窗口里 55 更好 / 95 更差 / 38 分不出）。
  - 门槛按 design 的依据跟随后者，这些改善也一起撤回了：本次 drama 回到 20 句、full 回到 26 句，与标准相差 > 1 s 的句子 38 → 60。哪一边对要靠听审。
- 门槛修不了平移中位为正、但仍改错的窗口：
  - drama 280–306 s 只对齐 3/6 条边，296 s 一带两种预设都被推晚 2.4–3.0 s；
  - pv-ja 嘈杂 200–229 s 只对齐 1/6 条边，推晚 2.58 s；
  - drama 低音量 #38（246.64 s）只剩 0.24 s，复核规则标为语速异常。
  - 前次记录列出的候选修法（离已对齐边太远不插值、会压到 0.3 s 以下时整窗不改、要求最少的已对齐比例等）都还没有实现，需要协调者决定。
- 门槛值 +500 ms 与下中位数的取法来自一次重跑。drama 嘈杂 330–356 s 新旧口径相差 700 ms（+200 对 +900），说明只对齐少数边的窗口中位数不稳定。
- pv-zh 嘈杂 177.50 s 的去重留下了下一窗口的那份，上一窗口那份开头的 1 个语气词随之去掉。标准在这里也没有这个字，但前次有，属于文字变化，听审时应留意。
- 锚点照样对每个窗口请求，门槛只决定用不用，所以预设的识别时间仍约为标准的两倍，说明文字不用改。要省时间，只能在门槛判定之前先少发锚点，这需要改设计。
- 对照工具里的起声强度规则照抄协调者的 anchor-gating-sim.mjs。它在 drama 开头把压进数字静音的两句判为“更好”，逐帧看是错的。
- tsc -p tsconfig.json 只包含 src 与 electron，不检查测试文件，本步骤没有另做测试文件的类型检查。测试文件的哈希与门槛那一步（2026-10-25 02:48）相同；那一步用临时配置查过：anchorRetiming.test.ts、ab-report.ts、ab-report.test.ts、ab-comparison-harness.ts 没有错误，productionExecutor.test.ts 的错误都在 “Studio timing anchors” 块以外、没有改的行上。
- 本步骤在 test-results/asr-quality-ab/ 扩展了本机脚本 timing-fix-compare.mjs（第 4 个参数与 (h)–(j)）与 timing-fix-records.mjs（被忽略的目录），协调者的 anchor-gating-sim.mjs 没有修改。门槛之前的两份证据另存为 records/T-ASRQ-16-rerun-lGjDZk.txt 与 T-ASRQ-14-rerun-lGjDZk.txt。
- tasks.md 的状态、完成日期、实施记录栏与 design 没有改，不在本步骤范围内。改动没有提交。
