# 实施记录：T-ASRQ-07

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-07 |
| 日期 | 2026-10-22 |
| 验证版本 | 工作树，基于 68ffd05（未提交）。新增：`test/subtitle-studio/transcription/noTimestampsRequest.test.ts`、`test/subtitle-studio/cue-recognize-models-ui.test.ts`；记录与证据 `records/T-ASRQ-07{.md,-unit.txt,-integration.txt,-ui.txt}`。修改：`src/subtitle-studio/cue-recognize-contract.ts`、`electron/main/subtitle-studio/cue-recognize-service.ts`、`electron/main/subtitle-studio/transcription/runtime.ts`（组合文件）、`electron/main/subtitle-studio/transcription/native/server-contract.ts`、`native/server-supervisor.ts` 与 `native/server-http-client.ts`（后两个在写集外，见“偏离”）、`electron/main/subtitle-studio/cue-review.ts`（T-ASRQ-05 的文件，评审后只把 `compressedSize` 改为导出，写集外，见“偏离”）、`scripts/subtitle-studio-provenance/current-copy-audits.{mjs,json}`、`resources/speech-resources/provenance/current-integration-audits.v1.json`、`src/pages/Tools/Subtitle/SubtitleStudio/{StudioCueRecognize.tsx,StudioCueRecognize.css,StudioCueReview.tsx,StudioCueTable.tsx,index.tsx}`、`src/locales/{zh,zh-Hant,en,ja}/studio.json`、`test/subtitle-studio/{cue-recognize.test.ts,cue-recognize-ui.test.ts,helpers/transcription-ui-runtime.ts}`、design.md 方案 5 与“界面设计基准”中本任务的一条 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；TypeScript 5.9.3；Electron 41 + Playwright 1.58.2（静默离屏窗口，隔离的临时 userData，受控转写运行时 + 开发版 FFmpeg 媒体运行时）；一次可选真实用例用本机已安装的 large-v3-q5_0 在 CPU 上运行（复制到临时目录）；没有用 GPU，没有运行 anime-whisper 或 Belle |
| 任务指纹 | a1f8ec9879ad8ddc191803b180379d41d583610989bec7e37545d6a5f5f6dab9 |

## 实际结果

### 契约（`native/server-contract.ts`，受审计）

- 请求新增可选 `noTimestamps: true`，生成 `no_timestamps=true`；字段位置不变，其他请求的 multipart 字段与顺序与之前逐项相同（新测试断言 `{ ...untimed, no_timestamps: "false" }` 等于普通请求）。值不是 `true` 或与 DTW 计时同用时拒绝。
- `parseLocalSubtitleServerVerboseJson` 增加同名选项。只有带该选项时，原始段才可以没有 `start`/`end`，并且每段都以请求窗口（0 到 `duration`）为时间；服务端仍返回的时间也不用（anime-whisper 有时间戳时结束恒为 30.00 s）。其余字段仍按 strict 校验；不带选项时缺时间的响应照旧被拒绝。解析用的是 records/model-smoke.md 中 anime-whisper A-00 的真实响应形状（`words` 只有 word 与 probability）。
- 转发：`server-supervisor.ts` 的请求快照复制 `noTimestamps`；`server-http-client.ts` 把它传给解析函数。新测试用本地 HTTP 桩验证真实客户端发出 `no_timestamps=true` 并按无时间戳解析。

### 主进程（`cue-recognize-service.ts`、`runtime.ts`）

- `recognizeCue` 按所选模型的配置（`transcription-model-profiles.ts`）决定发送内容：锁定语言的模型用锁定语言（anime-whisper 收到 auto 也发 ja，Belle 收到 ja 发 zh），禁止提示词的模型不发提示词，未知模型保持请求原样。是否已安装由运行时解析模型时校验（未安装即失败，界面只列已安装的模型）。
- 剪辑：有时间戳的模型为字幕 ±1000 ms，无时间戳的模型为 ±200 ms（`cueRecognizeClipRange`）；两者都受 30 s 总长限制（先限制前侧再给后侧），并在媒体开头与结尾截断。
- 选段：有时间戳的模型只保留属于该字幕的段（`segmentBelongsToCue`，段时间先换算成媒体时间）：段的大部分落在字幕 ±200 ms 内，或段覆盖字幕的大部分。只伸进 200 ms 边缘的相邻句段不算。保留的段按书写系统拼接（中日韩文字和全角标点之间不加空格）；无时间戳的模型保留全部段。
- 上下文混入时退回窄剪辑（评审后补充）：保留的段伸进文档中其他字幕超过 200 ms（`segmentHearsOtherCue`，其他字幕的范围用 `resolveCueAudioRange` 求，与播放一致），说明模型把相邻句和本句合成了一段，时间戳拆不开；或者有文字却没有段可选。这两种情况都改用字幕 ±200 ms 的剪辑再识别一次，取全部文字，也就是改动前听到的范围。窄剪辑同样做低音量增益、配 VAD 填充，用同一个剪辑票据，停止与忙碌语义不变。代价是这些句子多一次识别。原测试里断言混入（`朝なのに。ん？なんですか？`）的一条已改为断言重新识别：第二次请求是 1.4 s，结果只有本句。界面测试中同样的情形（一段跨第 2、3 句）得到第二次 1.9 s 请求的文字，并且预先勾选。
- 低音量：解码后的剪辑先用 `conditionQuietPcm16`（RMS 在 [-60, -30) dBFS 时整段增益），不增益时再试 `conditionWhisperPcm16`（活动电平低时门控增益），两者都只读使用。增益后的剪辑对有时间戳的模型带 `vadSpeechPadMs: 1000`；无时间戳的模型不开 VAD。
- `runtime.recognize.clip` 收到 `vadSpeechPadMs` 时，与模型一起预留固定的 Silero VAD，通过同一模型解析器解析，并核对 sha256 与生产契约一致；VAD 未安装或无效时按 VAD 关发送，和改动前一样能识别。有 VAD 时用带 `vadModel` 的加载身份获取租约（与无 VAD 的身份不同，服务会重新加载），并发送 `vadEnabled` 与填充；`noTimestamps` 原样转发。返回值多了 `segments`（剪辑内时间）。转写任务以其他加载身份运行时仍返回 busy，界面照旧提示“转写任务正在进行”并停止后续句子。
- 结果附 `confidence`（与转写稿相同的 `exp(avg_logprob) × (1 − no_speech_prob)`，按保留段的时长加权，保留 3 位小数）和 `reasons`：把识别结果当作该字幕的新文本（`edited: false`，上一句作为相邻句，语言取识别出的语言，否则取文档语言），用 `transcription-review.ts` 的规则评估。压缩比用复核栏同一个 `compressedSize`（评审后从 `cue-review.ts` 导出并引用，不再各写一份）。
- 组合审计：`runtime.ts` 改后在 `current-integration-audits.v1.json` 重登记 `currentBlobOid`（`1d5e5d7a…` → `cdc82d0a…`），并追加 2026-10-22 的原因。`current-composition-audits.json` 只有 main/preload/package.json 三项，没有 runtime.ts，因此未改。`electron/main/subtitle-studio/index.ts` 的接线不变（`recognize` 依赖直接得到新的返回形状），所以没有改。
- 拷贝审计：`server-contract.ts` 与 `server-supervisor.ts` 更新 `currentSha256` 并追加原因；`server-http-client.ts` 加入 `CURRENT_COPY_AUDIT_OWNERS`（FORK_PATH），新条目的 `copiedSha256` 取 `transcription-fork.json` 的 `6df80f27…`（其原因文字开头多出的空格已在评审后删去，哈希不变）。执行器与其他冻结副本未改；评审后改动的主进程文件只有 `cue-recognize-service.ts` 与 `cue-review.ts`，二者都不在拷贝或组合审计范围内。
- 对照工具的替身（`test/asr-quality/ab-comparison-harness.ts`）已经提供 `reserveUse` 与 `resolveManagedVad`。runtime.ts 没有用到新的服务方法，所以没有扩展它。

### 界面（`StudioCueRecognize.tsx` 等）

- 模型选择：只列已安装的模型，选项沿用转写设置的两行写法；仅重识别模型带“仅重新识别”“实验性”徽标和用途说明。默认依次取本次会话上次的选择、本文档在本会话转写任务列表中的模型（`getStudioTranscriptionController().getState().tasks`）、转写设置的模型，再取第一个已安装的模型（与任务要求的差异见“偏离”）。
- 所选模型有限制时：语言显示锁定语言，其他语言禁用；提示词输入禁用；输入框下方一段说明，内容是仅重识别模型的用法（先转写取得时间轴再逐句替换）、锁定的语言和不使用提示词。
- 结果：被复核规则标记的结果不预先勾选，文本下一行显示琥珀色原因标签（Tooltip 给出复核栏同样的说明与置信度，评审后改为开在标签下方、左对齐，不再盖住该句的删除标记）；摘要下方的提示条写“N 条结果可能不可靠……请试听后再决定是否采用”。从不自动应用，用户可以手动勾选后应用。换模型后的第一句进度显示“正在加载模型并识别”，是忙碌状态而不是失败。
- 从复核栏发起：第一行“只列出待复核的句子”开关后新增 `ListRestart` 按钮“重新识别筛选出的 N 句…”，把当前原因筛选下的全部句子（含其他页，附带它们在文档中的位置）交给对话框。对话框读取所在页取得文本，按文档顺序列出，应用时其他页的句子用读取到的原文生成编辑；一次最多 100 句，超过时显示原有的“一次最多识别所选的前 100 条”。评审后，其他页每次最多同时读 4 页（原来 100 句可能分在 100 页上一起读）；某页读取失败或文档已改动时，那些句子不列出，并在提示词输入下方写“有 N 条没能读取（文档可能已改动），没有列出；关闭后重新打开可再试。”（四种语言）。界面测试让 6 页中的第 4 页读取失败：其余 5 页的读取最多同时 4 个，列出 50/150/250/450/550，提示写 1 条。
- 渲染审查共修了 6 处界面问题（模型说明被浮层裁掉、中文句间多了空格、标记标签随未勾选的文本一起变淡、Tooltip 指向整行中部、Tooltip 盖住该句文字、评审指出的右侧 Tooltip 仍盖住删除标记），另有 3 处测试本身的问题（英文时按中文标题找对话框、提示打开时 Esc 先关提示、包装读页处理函数时没取 `payload`），见 `T-ASRQ-07-ui.txt`。具体尺寸已写入 design.md“界面设计基准”中本任务的一条。

### 偏离

- `modelId`：design 原文是“增加可选 `modelId`”，但契约从 studio-cue-recognize 起已有必填的 `modelId`，渲染端总是发送所选模型。为避免只为不存在的调用方加回退逻辑，保持必填；design 方案 5 第一条已改写为现状。
- “重叠”的含义：只要求区间有交集时，会把只伸进 ±200 ms 边缘的相邻句段也算进去，与 AC-ASRQ-05-2 冲突。改为“段的大部分在范围内，或段覆盖字幕的大部分”；保留的段伸进其他字幕超过 200 ms、或有文字没有段时，退回 ±200 ms 剪辑再识别。design 方案 5 已补写这两点。
- 单次上限从 20 提高到 100（一页），用于两遍式整篇替换；仍是逐句顺序执行，停止与忙碌语义不变，design 方案 5 已改写。
- 写集外：`native/server-supervisor.ts`（请求快照转发 `noTimestamps`）与 `native/server-http-client.ts`（把 `noTimestamps` 传给解析）。不改它们，新字段就到不了 whisper-server，响应也无法按无时间戳解析。两者都已登记拷贝审计，http client 首次加入审计所有者。
- 默认模型：任务要求默认取“文档的转写模型（若已安装）”。文档本身在主进程记录了这个模型（`preservation.transcript.model.modelId`），但渲染端拿不到：`DocumentPage` 与页面摘要不含它，复核栏的 `reviewCues` 结果也不含它。要把它交给对话框，得新增一个查询通道（preload、通道策略和 index.ts 都是组合文件），或者扩展 `ipc-contract.ts` 的 `summarizeDocument`、T-ASRQ-05 的 `CueReviewResult`。这些都在写集外，后者还会改变所有媒体文档摘要的比较。因此只在本会话的转写任务列表里能找到该文档时才用它的模型；对上一次会话转写的文档，默认落到转写设置的模型。它排在本会话上次的选择之后，这样两遍式连续使用同一个仅重识别模型时不用每次重选。这是记录在案的偏离。
- 写集外（评审后）：`electron/main/subtitle-studio/cue-review.ts` 只把 `compressedSize` 改为 `export`，重识别服务引用它，两条复核路径用同一个压缩口径；行为不变，T-ASRQ-05 的复核测试在评审后重跑通过。
- `CueRecognizeResult` 新增必填 `reasons` 与可选 `confidence`。仓库内只有 Studio 对话框调用 `recognizeCue`。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-07-1 | 通过 | file:records/T-ASRQ-07-unit.txt |
| V-ASRQ-07-2 | 通过 | file:records/T-ASRQ-07-integration.txt |
| V-ASRQ-07-3 | 通过 | file:records/T-ASRQ-07-ui.txt |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-05-1 | 通过 | V-ASRQ-07-1, V-ASRQ-07-2, V-ASRQ-07-3 |
| AC-ASRQ-05-2 | 通过 | V-ASRQ-07-1, V-ASRQ-07-3 |
| AC-ASRQ-05-3 | 通过 | V-ASRQ-07-1, V-ASRQ-07-3 |
| AC-ASRQ-05-4 | 通过 | V-ASRQ-07-3 |

## 风险与未执行项

- 2026-10-22 协调者修补：重识别默认模型在会话选择之后优先使用文档转写稿记录的模型（文档摘要新增 transcriptionModelId），见 records/polish.md。
  - 2026-10-23 整体回归：`test/subtitle-studio/cue-recognize-models-ui.test.ts` 原先断言对话框默认选转写设置的模型（标准），修补后实际默认为文档转写稿记录的 large-v3（“最高精度”），用例因此失败。这是有意的行为变化，不是回归；断言改为期望 `resource_name_best`，并注明原因。更新后在工作树上通过（1 项），截图 `01-models-1280-light.png` 中默认值为“最高精度（约 2.9 GB，较慢）”；原有的 `cue-recognize-ui.test.ts` 的文档转写稿记录的是 `large-v3-q5_0`（即“标准”，与转写设置相同），默认仍为“标准”，该用例通过。
- 没有用 anime-whisper 或 Belle 经应用路径做真实识别。无时间戳解析依据的是冒烟记录中的真实响应形状，加上本地 HTTP 桩，没有连真实服务；有时间戳路径用 large-v3-q5_0 在 CPU 上做了一次真实运行（英文合成语音，`T-ASRQ-07-unit.txt`）。真实模型的重识别冒烟与听审归 T-ASRQ-10（V-ASRQ-10-1/2）。
- 选段和退回规则依赖时间戳。AC-ASRQ-05-2 记为通过，依据是测试中的两种情形：边缘相邻段被丢掉，合成一段时退回窄剪辑。下面几种情况仍可能混入：模型给合成段的时间戳没有伸进相邻字幕超过 200 ms；相邻字幕本身的时间不准；上下文里有没有字幕覆盖的语音（例如用户删掉的句子）。最后一种只在合成进同一段时进入结果。这些都没有用真实音频验证。退回窄剪辑的句子多花一次识别，比例取决于真实素材。加上 ±1 s 上下文后，模型听到的内容与改动前的 ±0.2 s 剪辑不同，识别质量是好是坏也没有做真实音频对照，需要听审。
- 门控增益可能抬高呼吸、底噪等非语音，且增益后会开 VAD（与转写一致）。这条路径的识别质量没有用真实低音量素材验证；未安装 VAD 时只增益不开 VAD。
- 第一次在会话中识别时，进度总是显示“正在加载模型并识别”，即使服务进程已经以同一模型加载（例如刚转写完）；这只是文字，不影响行为。
- 预留 VAD 资源时，若用户恰好在安装 VAD，共享资源服务会对该次识别报忙（低音量剪辑才会预留 VAD）。
- 100 句一次的耗时没有用真实模型测量；按冒烟中每句 0.2–1 s 的识别时间加解码估计约 1–2 分钟，退回窄剪辑的句子还要再加一次，期间可随时停止。
- 渲染时发现：转写设置的模型下拉（T-ASRQ-06 的 `.studio-transcription-model-options`，最宽 22rem）在触发器宽于 22rem 时同样会裁掉说明，例如 640–1023 px 两列布局中模型字段占通栏时。本任务只修了重识别对话框，没有改转写设置，也没有在那里验证，交协调者决定。
- 以 `FUSIONKIT_STUDIO_E2E=1` 门控的 Studio UI 测试共 33 个。评审修复后在 19:57 的构建上运行了 7 个（新增的模型重识别、原有重识别、复核、查找、撤销历史、编辑、原声播放），全部通过；其余未运行。“没能读取”的提示只在测试里替换主进程读页处理函数时出现过，没有在真实的文档改动竞争中复现。
- `check-i18n-usage` 的 40 条既有错误与仍保存着的最早一份结果（同一工作树，17:44）逐条相同；初版记录比对的 17:01 结果已被覆盖。没有对 HEAD 导出副本复核。
- 未提交；`current-copy-audits.{mjs,json}` 与 `current-integration-audits.v1.json` 的条目必须与对应源码一起提交。
