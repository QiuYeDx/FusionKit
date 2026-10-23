# 转写质量与复杂音频支持 需求澄清与方案评估

日期：2026-10-22

## 用户原始描述

> 看看字幕转写的能力和功能有没有优化的空间（提升转写准确度和成功率以及结果的可用性，对于不同原始音频的支持程度更好转写效果更好（比如原始人声较小的音频、杂音/环境音/音效较多的复杂音频等））可以先调研一下 梳理一下可行的方案 评估一下可行的有哪些 然后再开始优化）（另外还可以看看支持的/供选择的模型还有没有其他比较好的选择可以加进来的 比如一些领域特化的（比如转写日语ASMR效果比较好的模型等）有价值的可以加进来）

调研方式：9 路并行调研（5 路读代码：编排与选项、音频前端、推理参数与后处理、模型与 provenance、历史研究与评测资产；4 路联网：whisper.cpp 可用模型、非 Whisper 引擎与云端 API、抗噪/增强技术、whisper.cpp 新版本与社区 ASMR 工具配置）+ 1 路查漏复核。代码结论均以 `文件:行` 核对，网络结论附来源；未能核实的标为待验证。

## 已有事实与代码依据

### 当前链路（Subtitle Studio）

- 引擎：whisper.cpp v1.9.1 的 whisper-server（Windows CPU 内置 + 可下载 CUDA 包；macOS Metal），Silero VAD v6.2.0，模型仅 `large-v3-q5_0`（默认）与 `large-v3`（f16）。
- 媒体归一化：FFmpeg 只做 `aresample=async=1000:first_pts=0 -ac 1 -ar 16000`（`electron/main/subtitle-studio/transcription/native/media-normalizer.ts:1654-1659`），没有高通、降噪、响度或声道判断。
- 窗口：默认 `acoustic_quiet_v1` 在静音处切 18–30 s 窗口（RMS ≤ -55 dBFS 且峰值 ≤ -45 dBFS 持续 ≥ 0.6 s），找不到停顿时退回 30 s / 5 s 重叠（`native/pause-window-plan.ts:7-21`）。
- 低音量调理：仅 VAD 开启时，窗口 RMS 在 [-60, -30) dBFS 才整体 +10~12 dB，并把 VAD 填充改为 1000 ms；窗口中超过 0.1%（约 30 ms）的采样会被限幅时整窗放弃调理；调理结果过长或重复时回退原音（`native/quiet-audio.ts:2-55`，`transcript-executor.ts:644-657`）。
- 每窗请求只发送：`vad`、`vad_min_silence_duration_ms`（500）、调理窗的 `vad_speech_pad_ms=1000`、`beam_size`（5）、`temperature`（0）、固定 `temperature_inc=0.2`、可选 `prompt`（`native/server-contract.ts:243-271`）。服务端按请求支持但从未发送的字段：`vad_threshold`（默认 0.5）、`vad_min_speech_duration_ms`（250）、`vad_speech_pad_ms`（30）、`vad_max_speech_duration_s`、`vad_samples_overlap`、`no_speech_thold`（0.6）、`suppress_nst`（false）、`entropy_thold`、`logprob_thold`、`best_of`、`carry_initial_prompt`、`max_context`（已对照 v1.9.1 server.cpp 与内置 `whisper-server.exe --help`）。
- 质量门只看结构：越界、重叠、逆序、≥ 8 条相同字幕覆盖 ≥ 15 s 的重复；失败窗先二分（最多 3 层），再以 T+0.2 重放一次，仍失败则整个任务失败、已完成窗口全部丢弃（`transcript-executor.ts:644-686`，`native/subtitle-post-processor.ts:744-762`）。
- 解析了每段 `avg_logprob`、`no_speech_prob`，但只做范围校验；转写稿 schema 已有可选 `segments[].confidence`，从未填写（`native/server-contract.ts:439-440`，`src/subtitle-studio/transcription/domain.ts:1157-1166`）。没有任何幻觉短语表；仅含 ♪ 等符号的字幕会保留（过滤只覆盖 `\p{P}`）。
- 单句重新识别：裁剪字幕 ±200 ms、VAD 关、无增益、beam 5 / T0，只返回文本，无质量检查（`electron/main/subtitle-studio/transcription/runtime.ts:427-461`）。
- 失败处理：Studio 没有重试按钮；提交后文件令牌被回收，重试需重新添加文件；窗口级契约失败被映射为“程序不完整，请重装”（`src/pages/Tools/Subtitle/SubtitleStudio/transcription-errors.ts:24-26`）。
- 日语接缝/DTW 修复只在 Windows + CUDA + VAD + 完整 `large-v3` 时启用；默认的 q5_0 与 CPU/macOS 用户走普通路径（`transcript-executor.ts:737-751, 1547`）。

### 复核后的关键修正（对照 whisper.cpp f049fff 源码与本机数据）

- 每次 /inference 都从启动默认值复制一份参数再应用本次字段（server.cpp:806, 832-833），按窗口设置的参数不会串到后续请求。
- `no_speech_thold` 与 `logprob_thold` 同时决定“整段静默丢弃”和“是否升温回退”（whisper.cpp:7572-7620）：调高 no_speech 阈值会减少丢弃，但更多低置信段会进入 T≥0.6 的回退，而提示词只在 T<0.5 时生效（whisper.cpp:145, 7111）。预设参数必须作为一组固定值评估。
- 服务端返回的 `avg_logprob` 分母包含时间戳/特殊 token，数值比 OpenAI 的偏高（server.cpp:1100-1145），OpenAI 社区阈值不能直接照搬，置信度阈值要用本项目样本的分布校准。
- v1.9.1 中 0 号解码器的随机数只在建状态时播种一次，同一进程里所有 T>0 的解码都受之前请求影响；A/B 必须每个样本/变体用新进程（v1.9.5 已修）。
- `suppress_nst` 会屏蔽 「」『』 与 ♪，但不屏蔽全角（）【】；对日语不适合作默认，复核侧的符号/标注规则更精准。
- 本机实际使用：Studio 偏好为 large-v3（f16）+ CUDA + 日语，41 个媒体文档（15.15 h、3,569 条）都由该配置生成，且没有一条被编辑过（无可挖掘的人工校对真值）。因此对本用户，语言锁定价值低、large-v3 专属修复已生效；q5_0 的门控缺口影响的是默认用户。
- anime-whisper 卡片上的 13.0 vs 16.5 是在 `no_repeat_ngram_size=5` 与单句短音频条件下测得，whisper.cpp 没有对应参数；长音频顺序解码删字严重。必须先在 whisper.cpp 上做冒烟测试再决定接入方式。
- 历史上放宽 VAD（0.35/100/200）的实验是 3 段 30 s、无参考文本，结论是“不确定”而非“否决”。
- 仓库只打包了 whisper-server.exe，没有可解析的独立 VAD 运行时；“增强/分离只驱动 VAD”需要新运行时，归入第三期。

### 已验证的音频事实（内置 FFmpeg 实测）

- `-ac 1` 是 (L+R)/2：只在一侧耳朵的人声损失 6 dB；左右反相完全抵消（-91 dB）；0.6 ms 双耳时差在 828 Hz 形成约 -38 dB 梳状凹陷；5.1 声源的中置（对白）只占单声道混音约 30%。
- Windows 版 FFmpeg（BtbN LGPL n8.1.2）具备 highpass、afftdn、anlmdn、arnndn（无内置模型）、dynaudnorm、speechnorm、loudnorm、pan、astats、ebur128 等，均验证可保持采样数；macOS 版是 `--disable-everything` 自建，只有 aformat/aresample/anull，任何滤镜方案在 macOS 都需重建 FFmpeg，因此简单 DSP 应在 TypeScript 中实现。

### 历史研究与用户既往决定（docs/v0.2.11/subtitle-quality-harness）

- 已采纳：30 s 窗口、有界低音量调理（B 样本改善、B-noise 保持无字）、DTW 句切、接缝去重系列、每文件新进程、停顿切窗默认化（接受已知不足）。
- 已否决：仅放宽 VAD（0.35/100/200）或关闭 VAD（VAD 关会在非语音音效上编造句子）、调整 200/400 ms 填充、强制对齐、声学打分、窗口投票、faster-whisper/CT2 模型适配。
- 用户决定：验收以人工听审为准；不做无边界调参；接受阶段性不足。所有质量结论必须来自真实音频 A/B，并包含 B-noise 这类负对照。
- 评测资产：`test-results/subtitle-quality-review/` 下的 6 段真实样本都在（`vad-baseline-isolated/{A,B,C}.wav` 各 30 s、`annotation-followup/B-noise.wav` 18 s 非语音负对照、`phase12/final-separators-production/app-inputs-isolated/{independent,full}.wav` 176 s / 216 s，哈希见 `test/subtitle-studio-provenance/real-default-comparison-harness.ts:42-48`），另有 E:\workspace\fusionkit 下 753 s 日语广播剧与两段 BGM 很重的游戏 PV（日/中）。已安装模型：large-v3、large-v3-q5_0 与 CUDA 12.4 包。

## 方案评估

评分：收益 高/中/低；成本 S/M/L/XL；风险 低/中/高。“证据”指已有测量或可靠来源，“假设”需本项目 A/B 证实。

### A. 解码与 VAD 参数（无需新依赖）

| 方案 | 解决的问题 | 收益 | 成本 | 风险 | 依据 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 按音频类型发送 VAD 阈值/最短语音/填充、no_speech_thold、suppress_nst | 耳语被 VAD 丢弃；音效/音乐上的 ♪、(音楽) 等幻觉 | 高 | M | 中 | 服务端已支持；WhisperJAV、Faster-Whisper-XXL 均大幅调整这些值（假设，需 A/B） | 本期做，作为可选预设，标准模式不变 |
| A2 自动语言时锁定首批窗口多数语言 | 安静/嘈杂窗口语言误判、整段夹杂错语言 | 中 | M | 低 | 每窗独立检测已核实；本用户固定用日语，收益主要在默认用户 | 下期做（改变默认路径，需听审） |
| A3 失败窗的多配置重试阶梯（去提示词、suppress_nst、best_of 5） | 重复循环、整任务失败 | 中 | M | 中 | 现仅一次 T+0.2 重放 | 下期 |
| A4 提示词长度提示与 carry_initial_prompt | 长提示词被静默截断到约 224 token | 低 | S | 低 | whisper.cpp 源码 | 随术语提示一起做（下期） |

### B. 音频前端

| 方案 | 解决的问题 | 收益 | 成本 | 风险 | 依据 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 门控动态增益（替换耳语模式下的固定 +12 dB） | 很小的人声、整窗低于 -60 dBFS、有敲击/触碰声的窗口被放弃调理 | 高 | M | 中 | 现策略局限已核实；Silero 对电平敏感；历史上 +12 dB 修好了 B（证据） | 本期做，仅耳语预设启用 |
| B2 双耳/立体声感知降混（按块选响亮侧或中置） | 单耳耳语 -6 dB、反相抵消、梳状凹陷、5.1 对白占比低 | 中 | L | 中 | 合成信号实测；历史检查在 A/B/C 未发现严重相位抵消 | 下期：先用分析脚本扫用户素材的声道差分布，再决定 |
| B3 噪声底自适应的停顿检测 | 持续环境声/BGM 下找不到停顿 → 窗口在词中切开 | 中 | M | 中 | 绝对阈值已核实 | 下期 |
| B4 FFmpeg 降噪（afftdn/arnndn/DeepFilterNet）后直接送识别 | 稳态噪声 | 低 | M | 高 | 多篇论文显示增强常使 Whisper WER 上升；BoH 论文 DCCRN 不减少幻觉 | 不直接送识别；只作为“驱动切窗/VAD”或可疑窗候选（第三期） |
| B5 人声分离（UVR-MDX / htdemucs / RoFormer） | BGM、音乐、密集音效下的人声 | 中 | XL | 高 | 直接送识别 WER 变差（Jam-ALT 35.5→47.9）；用分离结果只定边界有改善（23.02→20.35） | 第三期：可选资源包，仅“音乐音效”模式，只驱动分段 |
| B6 ASMR 专用 VAD（TransWithAI Whisper-VAD-EncDec-ASMR，MIT，119 MB ONNX） | Silero 漏掉耳语 | 中 | L | 中 | 500 h 日语 ASMR 训练；无公开对比 | 第三期：需要 onnxruntime 与独立 VAD 阶段 |

### C. 结果可用性与成功率

| 方案 | 解决的问题 | 收益 | 成本 | 风险 | 依据 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 逐句置信度 + 质量复核（低置信度、疑似幻觉短语、句内重复循环、纯符号行、异常语速、相邻重复） | 用户找不到哪些句子需要听校 | 高 | L | 低 | 数据已在响应中；BoH 论文“VAD+去循环+短语表”WER 8.0→6.5 | 本期做；只标记不自动删除（遵守 FK-PIT-0031/0119） |
| C2 失败/无内容任务一键重试与针对性建议 | 成功率；“重装”误导 | 高 | M | 低 | Studio 无重试已核实 | 本期做 |
| C3 单句重新识别增强（可选模型、上下文、低音量增益、按时间取段、置信度） | 手动修句效果差、短句易幻觉 | 高 | M | 低 | 历史：需要 ±2 s 上下文与增益 | 本期做 |
| C4 单窗失败不拖垮整个任务（保留其余结果并标记缺口） | 长文件一处失败全部白跑 | 高 | L | 中 | 现有产品立场是“不导出不可靠结果”（`transcript-executor.ts:1824`） | 需用户决定（A-02），下期 |
| C5 日语/中文断行与断句默认值 | 42 字/行对 CJK 过长；无标点长句不换行 | 中 | S–M | 低 | 断行只在空白/标点处 | 下期 |
| C6 翻译资料术语作为识别提示词 | 人名/术语识别 | 中 | S | 中 | 现未使用 | 下期 |
| C7 q5_0 默认模型启用接缝/DTW 修复 | 默认用户拿不到已听审验证的修复 | 中 | M | 中 | 门控只认 `large-v3` | 下期，需 CUDA 实测 DTW 在 q5_0 上可用 |

### D. 模型（全部由现有 whisper.cpp 加载，按条目固定 URL、大小、SHA-256 与 ggml 头）

| 候选 | 体积 | 许可 | 适用 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| large-v3-turbo q8_0（ggerganov 官方） | 874,188,075 B | MIT | 通用快速档；CPU 用户 | 日语长音频 CER 与 large-v3 接近（9.5/10.7 vs 9.2/9.9）；带提示词时更稳（24.3 vs 65.9）；不支持“翻译成英文” | 本期加入 |
| Belle-whisper-large-v3-turbo-zh（BELLE-2 官方 GGML） | 1,624,555,275 B | Apache-2.0（训练数据含 WenetSpeech，非商用） | 普通话，带标点 | AISHELL-1 CER 3.07 vs turbo 8.64；HKUST 18.9 vs 37.3；本地冒烟：每个 30 s 窗只出 1 段（无句内时间戳），中文 PV 上不比 large-v3 准 | 本期加入为“仅重识别、实验性”，限定中文 |
| anime-whisper（litagin，Aratako 社区 GGML） | q8_0 818,305,955 B | 模型 MIT；训练数据 Galgame（GPL-3.0、禁止商用） | 日语动画/游戏配音/ASMR，含喘息、笑声、耳语 | 游戏语音 CER 13.0 vs large-v3 16.5；禁用提示词；长音频顺序解码会崩（tedx-seq 59.4）；训练无时间戳；转换者报告 whisper.cpp 输出开头有怪字 | 本期加入为“实验性”，先限定用于单句/批量重新识别；作为主模型需 A/B 通过 |
| kotoba-whisper-v2.0（官方 GGML） | q5_0 537,819,875 B | Apache-2.0（ReazonSpeech 30-4 条限制） | 日语电视类语音 | Reazon CER 11.6 vs 14.9；无标点；长音频崩 | 下期视 A/B 再定 |
| large-v2 q8_0（官方） | 1,656,129,691 B | MIT | 静音/音乐段幻觉较少（社区经验） | 日语 CER 明显差于 v3；证据多为传闻 | 下期作为备选重试模型评估 |
| whisper-ja-1.5B（efwkjn） | 3,095,033,483 B | 未声明 | 日语动画+通用，长音频稳 | 基准最好之一 | 许可不明，暂不加入 |
| whisper-ja-anime-v0.3 | — | 未声明 | — | 自定义 20480 词表，whisper.cpp 无法正确处理 | 否决 |
| distil-large-v3/3.5 | — | MIT | 仅英文 | — | 否决 |
| chickenrice 日→中直译（海南鸡饭） | 3.2 GB（无 GGML） | Apache-2.0 | 日语 ASMR 直出中文 | BLEU 29.4；无原文字幕 | 否决（Studio 用 LLM 翻译并保留原文） |

### E. 新引擎与云端

| 方案 | 收益 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| Qwen3-ASR 1.7B + ForcedAligner（经 CrispASR，MIT 的 whisper.cpp 分支） | 高（ExtremeNoise WER 16.2 vs large-v3 63.2；歌声更好；有日语动画微调） | XL | 高（新运行时、签名、契约、时间轴管线） | 第三期 spike，需用户决定是否引入第二引擎（A-03） |
| sherpa-onnx 平台（Parakeet-ja、SenseVoice、降噪、分离） | 中 | XL | 中 | 第三期，与 B5/B6 一起评估 |
| OpenAI 兼容云端转写（Groq、Mistral Voxtral 等） | 中 | M | 中（上传音频、费用） | 需用户决定（A-04） |
| 升级 whisper.cpp 到 v1.9.5 | 中（温度回退可复现 #4025、极短音频越界修复 #3956） | M–L | 中 | 下期 |

## 目标、范围与非目标

本期（I1）目标：在不改变默认“标准”行为的前提下，为低音量/耳语与嘈杂音频提供可选的转写模式；让结果中需要听校的句子可见、可跳转、可一键重识别；失败任务可重试；增加有证据的新模型；建立可复用的真实音频 A/B 工具，最终以用户听审为准。

非目标：不改默认参数和默认模型；不引入新运行时（onnxruntime、sherpa-onnx、CrispASR）；不上传音频到云端；不自动删除任何字幕；不做开放式调参（每个预设只跑一次固定变体的 A/B）；不升级 whisper.cpp。

## 阻断问题

- A-01 anime-whisper 的训练数据禁止商用：FusionKit 本身是 PolyForm Noncommercial，且模型仅在用户主动下载时获取，界面附许可说明。按此默认处理，非阻断。
- A-02 是否允许“部分完成”（保留成功窗口、标记失败区间）替代整任务失败：改变既有产品立场，留待用户决定，阻断 I2 中的对应需求。
- A-03 是否引入第二个本地引擎（Qwen3-ASR）：第三期决定。
- A-04 是否提供需上传音频的云端转写：第三期决定。
- Q-01 验证新模型需要下载约 3.3 GB 模型文件（turbo q8_0 0.87 GB、Belle-zh 1.62 GB、anime-whisper q8_0 0.82 GB），下载前单独征求同意；未获同意时这三项的真实音频验证保持“待验证”。

## 结论与下一增量

I1 采用：A1（预设与参数）、B1（门控动态增益）、C1（置信度与质量复核）、C2（重试与建议）、C3（重新识别增强）、D 中三款模型与模型配置表、真实音频 A/B 工具。
I2 候选：A2 语言锁定、A3 重试阶梯、B2 声道感知降混、B3 自适应停顿、C4（待 A-02）、C5、C6、C7、kotoba/large-v2 评估、whisper.cpp 升级。
I3 候选：B4/B5/B6 只驱动分段的增强与分离、E 中的新引擎与云端（待 A-03/A-04）。
