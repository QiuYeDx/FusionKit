# 转写质量与复杂音频支持 设计

本文只详细设计 I1。调研证据与候选方案见 [discovery.md](discovery.md)。

## 现状与约束

- 链路：`StudioTranscription.tsx` → `src/services/subtitle-studio/transcription-controller.ts` → IPC → `electron/main/subtitle-studio/transcription/task-service.ts`（`freezeConfig` 冻结任务快照）→ `document-producer.ts` → `transcript-executor.ts`（窗口规划、请求、重试、后处理）→ `native/server-contract.ts`（请求字段）→ whisper-server；结果经 `document-adapter.ts` 写成 schema 2 媒体文档（`preservation.transcript` 保存完整转写稿）。
- 任务配置的公开 schema 在 Studio 自有的 `src/subtitle-studio/transcription/task-contract.ts`（`advanced` 为 strict 对象），`freezeConfig` 会把 `advanced` 原样展开进快照；冻结的 `src/subtitle-studio/transcription/domain.ts` 类型不需要改，新增字段用局部扩展类型读取。
- provenance：
  - `transcript-executor.ts` 已有 `current-copy-audits.json` 条目，修改后更新 `currentSha256` 与原因。
  - 修改其他 `native/*.ts`（本期：`server-contract.ts`、`server-supervisor.ts`（请求快照转发新字段）、`quiet-audio.ts`、`pcm-window.ts`、`media-normalizer.ts`、`subtitle-post-processor.ts`、`overlap-group-splice.ts`（拼接时保留置信度））须先加入 `scripts/subtitle-studio-provenance/current-copy-audits.mjs` 的 `CURRENT_COPY_AUDIT_OWNERS`，再在 JSON 中加条目（`copiedSha256` 取 `resources/subtitle-studio/provenance/transcription-fork.json` 的 destinationSha256）。
  - 执行器回放（`test/subtitle-studio-provenance/transcript-executor-replay.test.ts`）只允许加载 fork 清单中的文件加 `transcript-executor.ts`，因此执行器不能导入新模块；新逻辑写进已登记的文件或在执行器外（Studio 层）完成。
  - 旧版对拍回放（`replay.test.ts`）要求默认配置下与旧实现严格相同；本期唯一允许的默认路径差异是转写稿新增 `confidence`，须在测试中以“审阅过的差异”剥离比较并单独断言其取值范围。
  - 共享资源目录（`resources/speech-resources/manifests/speech-models.v1.json`、`electron/main/speech-resources/engine/model-manifest.ts`、`test/speech-resources/engine/catalog.test.ts`）是 `resources/speech-resources/provenance/resource-engine-extraction.v1.json` 的精确输出，修改要登记字节编辑记录；`electron/main/speech-resources/catalog-migration.ts` 对迁移收据外的新模型要容忍为空来源。
  - 组合文件（`transcription/runtime.ts`、`subtitle-studio/index.ts`、`electron/main/index.ts`、`electron/preload/index.ts`）改后须重新登记 `currentBlobOid`（两个审计 JSON，见项目记忆 provenance-composition-audits）。
  - 上述受控文件一律 LF。
- 运行环境：Windows CUDA（RTX 4070 Ti SUPER）可用；已安装 large-v3 / large-v3-q5_0 与 CUDA 12.4 包；6 段真实样本位于 `test-results/subtitle-quality-review/`。

## 方案与取舍

### 1. 音频类型预设（R-ASRQ-01）

- 公开配置：`task-contract.ts` 的 `advanced` 新增可选 `audioProfile: 'quiet_whisper_v1' | 'noisy_music_v1'`；缺省即标准。名称常量放在新文件 `src/subtitle-studio/transcription-audio-profiles.ts`（渲染与主进程共用，含界面文案键）。偏好保存在 `preferences-contract.ts`（Studio 自有；按现有偏好键断言测试同步更新）。
- 参数表只放一处：`native/server-contract.ts` 新增 `LOCAL_SUBTITLE_AUDIO_PROFILES`，执行器在 `createInferenceRequest` 中按快照的 `audioProfile` 取值；参数不暴露为单独的高级选项。

| 字段（whisper-server） | 标准 | 低音量·耳语 quiet_whisper_v1 | 嘈杂·音乐音效 noisy_music_v1 |
| --- | --- | --- | --- |
| vad_threshold | 不发送（0.5） | 0.35 | 0.45 |
| vad_min_speech_duration_ms | 不发送（250） | 150 | 不发送 |
| vad_speech_pad_ms | 仅增益窗 1000 | 300；增益窗 1000 | 200；增益窗 1000 |
| no_speech_thold | 不发送（0.6） | 0.7 | 不发送 |
| suppress_nst | 不发送（false） | 不发送（保留「」） | true |
| 低音量调理 | 现有整窗增益 | 门控动态增益 gated_v1 | 现有整窗增益 |

- 取值依据：WhisperJAV Silero v6 预设（0.12–0.42 / 填充 150–350 ms）、Faster-Whisper-XXL（0.45 / 填充 900 ms）、历史 phase1（0.35/100/200 结论不确定），按 discovery 的耦合说明取保守的单一固定值；只用 R-ASRQ-07 的一次对照决定是否推荐，不迭代搜索。对照结果（records/T-ASRQ-09.md）：两个预设在非语音负对照 B-noise 上都新增了文字（标准无字），因此界面把两者标为“实验性”，说明“可能多出需要复核的句子”，不作为默认、不自动套用；是否保留由用户听审决定。
- 这些字段只加在 VAD 开启的识别请求上（含质量恢复重放）；DTW 分句候选（VAD 关）保持原样。`server-contract.ts` 校验范围：阈值 0.1–0.9、最短语音 50–1000、填充 30–1000、no_speech 0.3–0.95，且 VAD 关闭时拒绝 vad_* 字段。
- 界面：非标准预设要求 VAD；选择时自动打开语音检测，关闭语音检测时回到标准并就地说明。任务行显示非标准音频类型的短标签。

### 2. 门控动态增益（R-ASRQ-02）

在 `native/quiet-audio.ts` 新增 `conditionWhisperPcm16`，`pcm-window.ts` 与 `media-normalizer.ts` 的 `materializeWindow` 增加可选 `quietAudioMode: 'gated_v1'`，执行器只在 quiet_whisper_v1 时传入；标准路径调用旧函数，字节不变。

算法（16 kHz 单声道 PCM16，窗口内离线计算，零相位）：
1. 10 ms 帧（160 采样）求 RMS 与峰值；非数字静音帧少于 0.5 s 时原样返回。
2. 噪底 = 非静音帧 RMS 的第 10 百分位；活动帧 = RMS ≥ 噪底 + 10 dB 且 ≥ -80 dBFS；活动总时长 < 0.5 s 原样返回。
3. 语音电平 = 活动帧 RMS 第 80 百分位；目标增益 g0 = clamp(-23 dBFS − 语音电平, 0, 30 dB)；g0 < 3 dB 原样返回。
4. 逐帧期望增益：活动帧及其前 100 ms、后 250 ms 取 g0，其余帧取 min(g0, 6 dB)；再以帧峰值限制 `g ≤ 20·log10(0.891/峰值)`（-1 dBFS），对相邻 ±2 帧取最小值后做 30 ms 滑动平均。
5. 逐采样插值增益并用现有 tanh 软限幅兜底；返回 `{pcm, gainDb: g0}`，`gainDb > 0` 时沿用 1000 ms VAD 填充与“过长/重复回退原音”安全网（`shouldRetryUnconditionedAudio` 不变）。

取舍：不在 FFmpeg 中做（macOS 版无滤镜）；不做降噪（证据显示增强常伤害 Whisper）；不改声道降混（I2 先统计用户素材）。

### 3. 置信度与质量复核（R-ASRQ-03）

- 置信度：`native/subtitle-post-processor.ts` 构建工作段时为每个原始段计算 `c = exp(avg_logprob) × (1 − no_speech_prob)`，合并/裁剪时按重叠时长加权平均，输出 `segments[].confidence`（0–1，保留 3 位小数）。服务端 avg_logprob 偏高，阈值以对照数据校准。冒烟显示 v1.9.1 这条路径的 no_speech_prob 几乎恒为 1.93e-05（records/model-smoke.md），置信度实际约等于 exp(avg_logprob)；公式保留该项以兼容未来引擎版本。
- 复核规则：新纯函数模块 `src/subtitle-studio/transcription-review.ts`，输入字幕文本、时间、置信度、是否编辑过、语言，输出每句的原因列表；整文档计算在主进程按页提供（参照 `src/subtitle-studio/cue-find.ts` 与 searchCues 的全量查询与跳转），渲染端只拿结果。

| 原因 | 规则（2026-10-22 按 records/T-ASRQ-09.md 的 large-v3 对照数据校准一次） |
| --- | --- |
| low_confidence | 未编辑且 confidence < 0.55（初始 0.45 会漏掉 11 条看起来错误的句子；< 0.55 的 30 条中 28 条在三变体间不一致） |
| phantom_phrase | 规范化文本命中按语言维护的短语表（ja：ご視聴ありがとうございました、チャンネル登録、この動画の字幕は…；zh：字幕由…提供、感谢观看、请不吝点赞订阅…；en：Thanks for watching、Subtitles by、Amara.org）；不收录常见真实台词 |
| repetition_loop | 1–10 字的单元连续重复 ≥ 4 次且覆盖 ≥ 60% 文本，或长度 ≥ 20 字且压缩比（deflate）> 2.4 |
| non_speech_only | 去掉空白后只有符号、标点或括号标注（♪、（笑）、【音楽】、[拍手] 等） |
| abnormal_rate | CJK > 12 字/秒或其他 > 30 字符/秒；或时长 ≥ 10 s 且 < 0.8 字/秒（可能包含未识别语音）（≥ 1.5 s 的句子最高 10.6 字/秒；慢速阈值只有 1 个确认样例） |
| duplicate_neighbor | 与前一句规范化文本相同、长度 ≥ 6 且间隔 < 1 s |

- 只标记：“折叠重复”生成一条普通的文本编辑操作（进入现有撤销历史）；“忽略”记在本机（按文档 id + cue id + sourceRevision 保存在 localStorage，读写失败时退化为会话内）。

### 4. 新增模型与模型配置（R-ASRQ-04）

| id | 文件 | 大小 / SHA-256 / ggml 头 | 许可 | 配置 |
| --- | --- | --- | --- | --- |
| large-v3-turbo-q8_0 | ggerganov/whisper.cpp@5359861c… ggml-large-v3-turbo-q8_0.bin | 874,188,075 / 317eb69c… / [51866,1500,1280,20,32,448,1280,20,4,128,2007] | MIT | 任意语言；不可翻译；可整段转写 |
| belle-large-v3-turbo-zh | BELLE-2/Belle-whisper-large-v3-turbo-zh-ggml@0a7f5739… ggml-model.bin（本地名 ggml-belle-large-v3-turbo-zh.bin） | 1,624,555,275 / 2a3bba5b… / [51866,1500,1280,20,32,448,1280,20,4,128,1] | Apache-2.0（训练数据含非商用） | 锁定 zh；不可翻译；仅用于重新识别；实验性 |
| anime-whisper-q8_0 | Aratako/anime-whisper-ggml@35b467f1… ggml-anime-whisper-q8_0.bin | 818,305,955 / 6a04b746… / [51866,1500,1280,20,32,448,1280,20,2,128,2007] | MIT（训练数据 GPL-3.0、禁止商用） | 锁定 ja；不可翻译；禁止提示词；仅用于重新识别；实验性 |

- 完整哈希由实现时用 HF tree API 复核后写入（两路调研结果一致）。
- 模型配置表：新文件 `src/subtitle-studio/transcription-model-profiles.ts`（不在冻结目录下），被渲染端（`resource-names.ts`、`StudioTranscription.tsx`、`StudioCueRecognize.tsx`）与 `task-service.ts` 使用；未知模型保守默认。执行器不读取它（主进程在入队时拒绝不一致请求）。
- 下载镜像：`electron/main/network/download-sources.ts` 新增通用 `huggingface.co/<owner>/<repo>/resolve/<rev>/<file>` → `hf-mirror.com` 同路径的候选（排在官方之后；SHA 校验不变）。
- 不做：DTW 预设泛化（新模型走普通路径）、kotoba/large-v2（I2 评估）。

### 5. 重新识别增强（R-ASRQ-05）

- `cue-recognize-contract.ts` 的 `modelId`（studio-cue-recognize 起已是必填，T-ASRQ-07 未另加字段）指定所选已安装模型，主进程按 `transcription-model-profiles.ts` 使用：锁定语言的模型用锁定语言，禁止提示词的模型不发送提示词；`runtime.ts` 的 recognize 用所选已安装模型的加载身份（与转写同样会因模型不同而重新加载；转写任务运行时返回 busy）。
- 剪辑范围：有时间戳的模型为字幕 ±1000 ms（总长 ≤ 30 s，靠近开头/结尾时截断）；只保留与字幕原范围（±200 ms）重叠的识别段并拼接为结果文本。“重叠”按 T-ASRQ-07 的实现指段的大部分落在该范围内，或段覆盖字幕的大部分；只伸进这 200 ms 边缘的相邻句段不算。保留的段伸进其他字幕超过 200 ms（模型把相邻句与本句合成一段，时间戳无法拆开），或响应有文字却没有段时，改用字幕 ±200 ms 的剪辑再识别一次并取全部文字（评审后补充）。
- 低音量：对剪辑 PCM 计算 RMS，处于 [-60, -30) dBFS 或活动电平低（复用 R-ASRQ-02 的函数）时增益并开启 VAD 与 1000 ms 填充（与转写一致的组合）；否则保持 VAD 关。VAD 只用于有时间戳的模型；未安装语音检测模型时增益后的剪辑仍以 VAD 关发送（与改动前一样能识别）。
- 仅重识别模型（anime-whisper、Belle）的剪辑为字幕 ±200 ms、全部文字计入结果，一律 VAD 关、发送 `no_timestamps=true`（契约新增可选字段，仅在该路径使用）；不允许提示词的模型（anime-whisper）不发送提示词。`no_timestamps=true` 的响应段没有 `start`/`end`（records/model-smoke.md），`native/server-contract.ts` 的原始段 schema 须对这条路径允许缺省并以剪辑范围作为段时间。
- 填充不越过相邻字幕：只用填充（±200 ms）收听且全部文字都算数的情形（仅重识别模型，以及有时间戳模型的“单独再听一次”）中，剪辑在前一条字幕的结束处与后一条字幕的开始处截止（2026-10-22 依据 records/T-ASRQ-10.md：Belle 19 句中 5 句开头带进了紧邻上一句的词）。
- 两遍式用法：先用标准模型整段转写取得时间轴，再在复核栏或多句重识别中选“仅重识别”模型批量替换文本（逐句确认）。多句重识别的单次上限原为 20 条，两遍式替换一整篇时需要反复操作，T-ASRQ-07 提高到 100 条（字幕列表一页），逐句顺序执行、忙碌与停止语义不变。
- 结果附置信度（同上公式）与复核原因；命中时在对话框提示，不自动应用。复核栏可把当前筛选结果交给多句重识别（沿用单次上限）。

### 6. 重试与建议（R-ASRQ-06）

- 主进程：任务记录已保存 `inputPath`/`inputIdentity`；新增“以覆盖配置重新入队”能力：用 `captureSourceInput(inputPath, inputIdentity)` 复核文件身份后生成新的文件授权并按原批次配置（可覆盖 `audioProfile`、`devicePreference`）入队；身份不符返回需要重新添加文件的错误。具体接线以 `transcription-ipc.ts` 与 preload 通道策略为准，若需改组合文件则重新登记审计。实现（T-ASRQ-08）：任务记录另存批次请求的 `config`；`task-service.prepareRetry` 复核身份、新建授权并再次核对新授权的文件身份，`runtime.tasks.retry` 像选择文件时一样探测新授权（音轨可绑定、文档记住音轨）后走与普通入队相同的共享资源预留，未成为任务的授权被撤销；选择音频类型时同时开启语音检测（与设置面板一致）。只重新转写：自动翻译与自动导出不随重试提交（任务结束后不保留其 API 密钥）。身份不符（或原音轨已不存在）时 IPC 返回 `{ status: 'source_changed' }` 而不是错误码（公开错误码集合没有“需重新添加”）。窗口级判断需要失败阶段，因此任务摘要的 `error` 增加可选 `stage`（来自原生错误）。
- 界面：失败/无内容任务行显示“重试”和一条建议按钮（无内容→“改用低音量·耳语重试”，按钮旁注明实验性、可能多出需要复核的句子；`LOCAL_SUBTITLE_CPU_RETRY_ERROR_CODES` 内的错误→“改用 CPU 重试”）。
- 错误映射：`transcription-errors.ts` 将窗口级 `runtime_protocol_mismatch`/`transcript_quality_failed` 归为“识别质量”组并给出切换分段方式、音频类型或模型的建议；`out_of_memory` 建议改用 q5_0/turbo 或 CPU；所有失败显示“复制诊断信息”（错误码、阶段、模型、设备、音频类型，不含路径）。

### 7. 真实音频对照工具（R-ASRQ-07）

- 新目录 `test/asr-quality/`：受环境变量 `FUSIONKIT_ASR_AB=1` 门控的 vitest 用例，平时跳过。直接使用生产 `TranscriptionExecutor` 与真实归一化器、内置 FFmpeg、已安装模型（只读）与 CUDA 包；每个样本 × 变体用新的 whisper-server 进程（规避 v1.9.1 的解码器随机数问题）。
- 输入：6 段既有样本 + E:\workspace\fusionkit 下的广播剧与两段 PV（存在才跑，缺失记录为缺失）；模型 large-v3（用户实际配置），CUDA，语言按样本固定（ja/zh）。
- 变体：standard、quiet_whisper_v1、noisy_music_v1 各一次，参数不搜索。
- 输出：`test-results/asr-quality-ab/<运行 id>/` 下每样本每变体的 SRT 与 JSON（字幕、置信度、请求字段摘要、窗口语言、耗时），`summary.md`（字幕数、字数、请求数、耗时、复核标记数、置信度分布、B-noise 文字）、`diff.md`（按时间对齐的增删改）与 `listening.md`（需要听审的区间）。只保留文本产物，遵守 `createTestRun`/`pruneStaleRuns`。

## 代码落点

- 预设与请求：`src/subtitle-studio/transcription-audio-profiles.ts`（新）、`src/subtitle-studio/transcription/task-contract.ts`、`src/subtitle-studio/transcription/preferences-contract.ts`、`src/services/subtitle-studio/transcription-controller.ts`、`src/pages/Tools/Subtitle/SubtitleStudio/StudioTranscription.tsx`、`electron/main/subtitle-studio/transcription/native/server-contract.ts`、`electron/main/subtitle-studio/transcription/transcript-executor.ts`
- 增益：`electron/main/subtitle-studio/transcription/native/{quiet-audio,pcm-window,media-normalizer}.ts`
- 置信度：`electron/main/subtitle-studio/transcription/native/subtitle-post-processor.ts`
- 复核：`src/subtitle-studio/transcription-review.ts`（新）、Studio 文档 IPC（参照 cue-find 的服务与通道）、`src/pages/Tools/Subtitle/SubtitleStudio/`（复核栏、表格徽标）
- 模型：`resources/speech-resources/manifests/speech-models.v1.json`、`electron/main/speech-resources/engine/model-manifest.ts`、`resources/speech-resources/provenance/resource-engine-extraction.v1.json`、`electron/main/speech-resources/catalog-migration.ts`、`electron/main/network/download-sources.ts`、`src/subtitle-studio/transcription-model-profiles.ts`（新）、`src/pages/Tools/Subtitle/SubtitleStudio/resource-names.ts`
- 重识别：`src/subtitle-studio/cue-recognize-contract.ts`、`electron/main/subtitle-studio/cue-recognize-service.ts`、`electron/main/subtitle-studio/transcription/runtime.ts`、`src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRecognize.tsx`
- 重试：`electron/main/subtitle-studio/transcription/task-service.ts`、`electron/main/subtitle-studio/transcription-ipc.ts`、`src/subtitle-studio/ipc-contract.ts`、`electron/preload/subtitle-studio-*.ts`、`src/pages/Tools/Subtitle/SubtitleStudio/{StudioTranscription.tsx,transcription-errors.ts}`、`src/pages/Tools/_shared/ui/TranscriptionEmptyResult.tsx`
- 审计：`scripts/subtitle-studio-provenance/current-copy-audits.{mjs,json}`、`resources/speech-resources/provenance/current-integration-audits.v1.json`、`scripts/subtitle-studio-provenance/current-composition-audits.json`
- 文案：`src/locales/{zh,en,ja}/studio.json`
- 对照工具：`test/asr-quality/`（新）

## 界面设计基准

依据项目 Skill `.agents/skills/fusionkit-ui-design`（含 references/visual-contract.md）与 spec Skill 的 frontend-quality；各 UI 任务开工前在此节补充本任务的具体测量与截图结论。

- 目标用户：处理日语 ASMR、广播剧、游戏/动画素材的字幕作者；主流程是“转写 → 打开文档听校 → 修正 → 翻译/导出”。
- 音频类型：放在转写设置“识别语言”之后，用与模型/语言行相同的 `Select` 与行布局（参照 `StudioTranscription.tsx` 现有设置行），选项附一行说明；下方提示文字说明适用场景与“会更容易识别出微弱声音，也可能多出需要复核的句子”。
- 音频类型参照测量（T-ASRQ-02，源码基线 68ffd05，渲染后复核）：转写设置为 `ToolConfigPanel`，桌面配置列 320px、正文 12px 内边距；`studio-transcription-config-fields` 字段间距 16px；`ToolField` 标签 11px 中等字重、muted，标签到控件 6px；`Select` 触发器高 32px、字号 12px；字段下提示 `studio-transcription-help` 为 11px/18px、上边距 5px，需要用户注意的变化用同尺寸的琥珀色 `studio-transcription-row-warning`。640–1023px 为两列栅格（模型、输出语言通栏，媒体语言与处理设备并排）：音频类型作为通栏字段放在“媒体语言/处理设备”之后、“输出语言”之前，单列时紧随处理设备，避免两列出现空洞。下拉项两行：名称沿用选项字号，说明 11px muted；浮层宽度等于触发器，说明自然换行，触发器只显示名称。关闭语音检测导致回到标准时，用琥珀色提示替换普通提示，直到再次修改音频类型或语音检测。任务行短标签复用自动翻译标签的外观（10px/16px、1px 边框、4px 圆角、11px 图标），排在模型标签之后，Tooltip 给出完整类型名；行高不变。验收：1280×800 与 1024×700、浅/深色，另看英文长文案换行。
- 模型选择：沿用现有 `Select`；条目显示中文名、大小、场景标签（快速 / 中文 / 日语动画·ASMR）与“实验性”标记；被锁定的语言与不可用的“翻译成英文”显示原因提示；仅重识别模型不出现在此处。参照测量（T-ASRQ-06，基于 68ffd05 工作树，1280×800 / 1024×700、浅/深色、英文渲染后复核）：场景直接作为名称（快速 / 中文普通话 / 日语动画·ASMR，括号内约略大小，与“标准”“最高精度”同一命名方式，资源面板与任务行共用），不再另加同义标签；下拉项沿用音频类型的两行写法，只有带用途说明的模型才有第二行（11px/16px muted），“实验性”为名称后的 10px/14px outline 徽标；浮层不窄于触发器、最宽 22rem，使英文模型名保持单行（1024 下英文浮层 339px，触发器 294px），说明在其中换行。不可用的“翻译为英语”是禁用选项，原因写在字段下方的 `studio-transcription-help`（11px/18px，上边距 5px，距触发器 6px）；语言锁定（禁用其他语言选项）与禁止提示词（禁用输入框）用同一样式，当前没有整段转写模型用到这两项。资源面板模型行：名称；元数据为类型、目录名、大小、状态，以及“仅重新识别”“实验性” outline 徽标；用途与推荐用法、许可提示两行（11px/18px muted）放在行内通栏、与名称左对齐，不挤在操作按钮旁，中文各一行（新行高 78/96px，原有行 58px 不变）；仅重识别模型仍可下载与导入。
- 复核栏：参照 `StudioCueFind.tsx`/`StudioCueFind.css` 的同位置工具栏（计数、上一个/下一个、Enter/Shift+Enter、Esc 关闭）；原因筛选用 `ToolRadioButtonGroup`（窄宽度时改为下拉）；字幕表在 # 列旁显示原因图标与 tooltip，不改变行高，当前项高亮沿用查找高亮；操作沿用 `CueAudioButton`、重新识别入口与现有右键菜单。
- 复核栏参照测量（T-ASRQ-05，源码基线 68ffd05 工作树，渲染后复核）：查找栏是字幕表 sticky 表头的第二行（`th` 内边距 0 8px 6px），外框 `min(480px, 100%)` 右对齐、1px 边框、10px 圆角、popover 底色、6px 内边距、行间 6px；行内控件间 2px，图标按钮 28px（`icon-sm`），计数 11px muted、最小宽 7.5em 右对齐。复核栏用同一外框与行类，替代查找栏的位置（两者互斥）：第一行“待复核”标题（14px 图标 + 12px 中等字重）、计数（“第 3 / 27 条”）、“只列出待复核的句子”开关（`ListFilter` 28px 图标按钮，按下态沿用查找栏开关的 `data-state=on` 底色）、上一个/下一个/关闭；第二行原因筛选（只列出有标记的原因，名称后跟 muted 计数），全部原因的 `ToolRadioButtonGroup`（sm，28px 高、11px）能放下时用它，否则改为同宽 28px 高的 `Select`（按实测最宽标签 × 选项数判断，与语言无关）；第三行当前句：编号与原因（12px，单行省略，完整内容在 Tooltip）和操作（播放 `CueAudioButton`、重新识别、仅句内重复时的“折叠重复”、忽略；28px 图标按钮）；旧文档在末尾加一行 11px muted 说明；有被忽略的标记时再加一行“已忽略 N 条标记”和“全部恢复”文字按钮（同字号、前景色下划线）。列表筛选（AC-ASRQ-03-3，评审后补充）：复核栏打开时字幕表默认只列出当前原因筛选下被标记的句子，未标记的行不渲染（选择、框选、Ctrl+A、键盘移动只经过列出的行；合并、连续播放、时间检查仍按整页的相邻关系），开关关闭后回到全部行并保留徽标以看上下文；没有标记时开关禁用、列表不筛选；分页仍按 100 句，上一条/下一条跨页跳转，手动翻到没有标记的页时表体显示一行 12px muted 居中说明（上下 20px）。入口是工具栏“查找”之后的 `ListChecks` 图标按钮（只对转写文档显示），有标记时在图标后显示琥珀色计数（11px tabular，> 999 显示 999+），栏打开时按钮为按下态。字幕行（33px，# 列 54px、左内边距 12px、编号 10px/20px）只在复核栏打开时显示原因徽标：14px 方块、11px 图标、琥珀色，绝对定位在 # 列右缘（`top: 9px; right: -1px`，渲染实测离时间文字 7px、离 4 位编号约 5px，5 位编号时贴近但不覆盖），不改变行高与列宽；当前项徽标加底色，行本身沿用查找的选中高亮。≤ 520px（# 列 40px、单元格横向内边距 4px）徽标缩为 12px（`right: -2px`），不进入时间文字。渲染复核发现查找栏与复核栏所在的表头第二行原本也 `top: 0` 吸顶，列表滚动后会盖住列名与工具栏；改为吸在第一行之下（`--studio-cue-head-row`，由 StudioCueTable 实测），查找栏同样受益。
- 重识别对话框：在现有 `StudioCueRecognize.tsx` 中增加“识别模型”选择（仅已安装模型）与结果提示条；不新增弹窗层级。
- 重识别对话框参照测量（T-ASRQ-07，基于 68ffd05 工作树，1280×800 / 1024×700、浅/深色与英文渲染后复核）：对话框沿用 640px `ScrollableDialog`、正文 12px 内边距；模型与语言并排（触发器 28px 高、12px 字，1280 下 416px 与 192px，间距 8px），提示词输入 32px。模型下拉沿用转写设置的两行选项写法（名称 14px/20px，“仅重新识别”“实验性” outline 徽标，适用场景 11px/16px muted），浮层与触发器同宽（转写设置的 22rem 上限在这里会让说明被裁掉，渲染时发现后改为与触发器同宽），只列出已安装的模型。所选模型有限制时，输入框下方一段 11.5px/17px muted 说明（仅重识别模型的用法、锁定的语言、不使用提示词），中日文句间不加空格；语言下拉显示锁定语言、其他语言禁用，提示词输入禁用。结果区在摘要之后放提示条：沿用 `studio-cue-revision-note`（12px/18px、8px 10px 内边距、muted 底、8px 圆角）加 13px 琥珀色 `TriangleAlert`；被标记的结果不预先勾选，在文本下一行显示琥珀色原因标签（10.5px/16px、12px 图标，宽度随文字，Tooltip 开在标签下方、与标签左对齐（1280 实测提示顶边在该句文字下方 36px），给出复核栏同样的原因说明与置信度），未勾选时只把文字降到 0.5 透明度、标签保持不透明。换模型后的第一句进度写“正在加载模型并识别”。复核栏第一行在“只列出待复核的句子”开关后加 28px `ListRestart` 图标按钮“重新识别筛选出的 N 句…”，把当前原因筛选下的全部句子（含其他页）交给对话框，1024 英文下第一行仍一行放下；对话框每次最多同时读取 4 页，读不到的句子不列出，在提示词输入下方用与“一次最多…”相同的 11.5px muted 说明写出条数。
- 重试：任务行与 `TranscriptionEmptyResult` 中增加“重试”与一个建议按钮，按钮变体与现有任务行操作一致。
- 重试参照测量（T-ASRQ-08，基于 68ffd05 工作树，1280×800 / 1024×700、浅/深色与英文渲染后复核）：失败行沿用 `studio-task-failure`（原因 11px/18px 琥珀色、下一步 11px/18px muted、上边距 2px），其后的按钮行 `studio-task-failure-actions` 改为每个失败都显示：“重试”（`RotateCcw`）、适用时的“改用 CPU 重试”（`Cpu`）、原有的“管理资源”/“查看帮助”，最后是 ghost 的“复制诊断信息”；按钮均为 outline xs（24px 高、12px 图标），间距 6px，距上一行 6px，与原因文字左对齐（行内 8px）。无内容结果仍是 `TranscriptionEmptyResult` 的 12px 内边距 muted 圆角框，Studio 传入自己的说明（提示可改用“低音量·耳语”重试、相同设置重试结果通常不变），按钮行放在说明之下（实测距说明 6px，与失败行一致），“改用低音量·耳语重试”（`Ear`）后面紧跟 11px/16px muted 的“实验性……”说明（`flex: 1 1 12rem`，英文 1024 下换成两行并与按钮垂直居中）；未安装语音检测时该按钮禁用，说明改为“需要先在‘管理资源’里安装语音检测”。已用低音量·耳语的无内容任务只显示“重试”与共享说明。源文件已移动或修改时，行尾追加一行 11px 琥珀色 `role=status` 提示“请重新添加文件后再转写”，按钮保留（文件恢复后仍可重试）。重试生成的新任务排在队列末尾，原任务保留到用户移除；清理未完成的失败任务不显示重试。行高与操作列（28px 图标按钮）不变，各视口均无横向溢出。
- 状态与样本：无标记、大量标记（> 999 截断显示）、旧文档无置信度、编辑过的句子、长日语句子与窄窗口（≤ 1024 px）；以对照工具生成的真实文档作为样本。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-ASRQ-01 | 方案 1；参数表；请求字段校验；界面设计基准“音频类型” |
| R-ASRQ-02 | 方案 2；`conditionWhisperPcm16` |
| R-ASRQ-03 | 方案 3；置信度公式；复核规则表；复核栏 |
| R-ASRQ-04 | 方案 4；模型表；模型配置表；通用镜像 |
| R-ASRQ-05 | 方案 5 |
| R-ASRQ-06 | 方案 6 |
| R-ASRQ-07 | 方案 7 |

## 验证与风险

- 默认路径不变是硬约束：所有 provenance 测试、执行器测试与转写偏好断言在实现后重跑；`confidence` 是唯一审阅过的默认差异。
- 质量：对照工具在 B-noise 上的负对照是自动门槛；其余差异交用户听审，Agent 不签验收。
- 预设参数与置信度阈值来自外部经验，可能在本项目样本上无效甚至变差；对照结果若显示变差，预设保留为“实验性”或撤下，并记录。
- 门控增益可能抬高呼吸、口水音等非语音，导致 VAD 触发更多 → 依赖原音回退与复核标记兜底，并在对照中重点听审。
- UI：目标路由为 Studio（字幕工作台）；视口 1280×800 与 1024×700，浅色/深色；初版后用真实 Electron 截图审阅（静默离屏模式），修复后复验。
- 新模型的真实可用性依赖 Q-01 的下载许可；未获许可时 AC-ASRQ-04-5 保持待验证，不影响其余任务。
