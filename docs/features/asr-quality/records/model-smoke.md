# 实施记录：T-ASRQ-10（spike：模型下载与原生冒烟）

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-10 新模型真实冒烟（spike 部分：下载校验 + 原生 whisper-server 冒烟；应用内路径待 T-ASRQ-06/07 完成后另测） |
| 日期 | 2026-10-22 |
| 验证版本 | 工作树，基于 68ffd05（未提交）；本记录只新增 `records/model-smoke.md`、`records/model-smoke-download.txt`、`records/model-smoke-runs.txt`，未改任何源码 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Python 3.12.6；curl 8.6.0（Schannel）；NVIDIA GeForce RTX 4070 Ti SUPER 16 GB，驱动 610.88；whisper.cpp v1.9.1 官方 CUDA 发布包（`docs/v0.2.11/local-subtitle-transcriber/poc/runtime-smoke.local/expanded-cuda-v1.9.1/Release/whisper-server.exe`，flash attn 默认开，`--threads 4 --processors 1`）；Silero VAD v6.2.0 ggml（已安装，885,098 B）；基线模型为已安装的 `large-v3`（f16，3094 MB，非 Studio 默认的 q5_0） |
| 任务指纹 | 5edba1af41bf1799045decf629a423361f0b6d2f2224a47292a8268c7d0ee6c5 |

## 实际结果

### 下载与校验

三个文件都先用 Hugging Face tree API 核对 `size` 与 `lfs.oid`，再用 HTTP Range 读前 48 字节核对 ggml 头，然后用 `curl -C -` 下载到 `D:/fusionkit-asr-eval/models/`，下载后重算 SHA-256。三项全部与 design.md 模型表一致，没有不匹配；未下载其他文件，也未用镜像站。turbo 第一次连接遇到一次 TLS 握手失败（curl 35），自动重试后完整下载。证据：`file:records/model-smoke-download.txt`。

| 本地文件 | 字节 | SHA-256（前 8 位） | ggml 头 |
| --- | --- | --- | --- |
| ggml-large-v3-turbo-q8_0.bin | 874,188,075 | 317eb69c | [51866,1500,1280,20,32,448,1280,20,4,128,2007] |
| ggml-belle-large-v3-turbo-zh.bin | 1,624,555,275 | 2a3bba5b | [51866,1500,1280,20,32,448,1280,20,4,128,1] |
| ggml-anime-whisper-q8_0.bin | 818,305,955 | 6a04b746 | [51866,1500,1280,20,32,448,1280,20,2,128,2007] |

### 冒烟方法

- 每个（模型, 样本, 变体）启动一个新的 whisper-server 进程（规避 v1.9.1 解码器 0 每进程只播种一次），空闲 localhost 端口，服务目录加到 PATH；`/health` 返回 ok 后发一次 multipart `POST /inference`，结束后按 PID 结束进程。
- 基础字段与 Studio 一致：`response_format=verbose_json`、`language`、`translate=false`、`vad=true`、`token_timestamps=false`、`no_language_probabilities=true`、`beam_size=5`、`temperature=0`、`temperature_inc=0.2`、`no_timestamps=false`、`vad_min_silence_duration_ms=500`。
- 样本：A/B/C（30 s，日语 ASMR）、B-noise（18 s 非语音对照）、independent.wav 按 30 s 切成 ind0–ind5（最后一窗 26 s）、中文 PV 前 60 s 切成 zh0/zh1（内置 ffmpeg 转 16 kHz 单声道 s16）。服务端直接收原始 WAV，没有 Studio 的归一化/增益调理。
- 共启动 61 个进程：脚本试跑 3 次（c1，结果已被主流程覆盖）+ 主流程 55 次 + 1 次重跑 + 2 次 Belle 附加探针。每次都确认进程已结束；最后按映像名 `whisper-server.exe` 查询，无残留。原始响应 57 个 JSON（约 345 KB）在 `test-results/asr-quality-smoke/`（已忽略，不入库），脚本副本在其 `_harness/`；逐次完整文本、段时间、avg_logprob 见 `file:records/model-smoke-runs.txt`。
- 加载时间是从启动进程到 `/health` ok 的墙钟时间，含 CUDA 初始化；每个模型首次加载受文件缓存影响偏慢。

### 对比总表

| 组 | 模型 / 变体 | 加载 | 每窗识别耗时 | 段数 | avg_logprob | 时间戳 | 标点 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a 日语 10 窗 | large-v3（基线） | 2.4–4.9 s | 0.27–1.38 s，合计 9.7 s | 47 | −0.93…−0.00 | 句级 | 多数窗有 | 基线 |
| a 日语 10 窗 | turbo q8_0 | 0.82–1.03 s | 0.16–0.79 s，合计 4.4 s | 44 | −0.70…−0.00 | 句级 | 时有时无 | 可做快速档 |
| b 中文 2 窗 | large-v3 | 2.6–2.7 s | 1.02–1.45 s | 11 / 4 | −0.14…−0.00 | 句级 | 无（zh1 用空格） | 基线 |
| b 中文 2 窗 | Belle（VAD 开） | 2.9–3.3 s | 0.42–0.54 s | 1 / 1 | −0.10…−0.09 | 每窗只 1 段 | 有（，。） | 时间戳不可用 |
| b2 附加 | Belle（VAD 关） | 1.4–3.1 s | 0.39–0.54 s | 1 / 1 | −0.15…−0.08 | 每窗只 1 段 | 有 | 同上，错字更多 |
| c1 日语 A/B/C | anime-whisper，30 s 窗 + VAD | 0.82–2.05 s | 0.21–0.45 s | 1 / 1 / 1 | −0.36…−0.14 | 每窗只 1 段 | 有 | 不可用 |
| c2 9 句 | anime-whisper，逐句，有时间戳 | 0.82–1.84 s | 0.16–0.23 s | 9 | −0.84…−0.26 | 结束时间恒为 30.00 | 有 | 不可用 |
| c2 9 句 | anime-whisper，逐句，`no_timestamps=true` | 0.82–1.04 s | 0.16–0.27 s | 9 | −0.46…−0.04 | 响应不含 start/end | 有 | 可用（待听审） |
| d 日语 10 窗 | large-v3 + 安静预设探针 | 2.5–5.7 s | 0.40–1.46 s，合计 10.0 s | 41 | −0.76…−0.00 | 句级 | 多数窗有 | 文本略增，见下 |

记录在案的 57 次成功请求，所有段的 temperature 都是 0（没有触发升温回退）。no_speech_prob 几乎恒为约 1.93e-05（例外只有 anime B 窗 1.2e-10、安静探针 B-noise 2.1e-05），与模型、样本、是否开 VAD 无关。

### turbo q8_0（快速档）

- 速度：加载约 0.8–1.0 s（large-v3 f16 为 2.4–4.9 s），10 窗识别合计 4.4 s，对 9.7 s，约快 2.2 倍。
- 文本：9 个语音窗去标点后共 618 字，基线 638 字。ind2、ind4 与基线逐字相同；ind0 并了段，标点不同，「ごきげん」写成「ご機嫌」；ind5 并了段，「ひまり」写成「ヒマリ」。
- 问题：A 窗丢了开头一句。基线有「来たのって何事?」（0.03–3.66 s），turbo 第一段虽覆盖 0.03–9.63 s，文本却从「あ、そうだ連絡したくて…」开始。C 窗丢了「もう、」。ind3 把「転生先」识别成「先世先」，并且切成 10 段（基线 6 段）。标点不稳定：A、C、ind1–5 基本无标点，ind0 有「。」。
- B 窗两者都差：基线「うわぁ…それでしょう」，turbo「うん…レディション」。

### Belle 中文

- 能加载，识别快（每窗约 0.4–0.5 s），输出有标点，例如「一名优秀的泰姆菲尔德家的淑女，要用行动贯彻自己的美学。」
- 时间戳：每个 30 s 窗只返回 1 段，起止就是整段语音范围（zh0 7.91–30.02 s，zh1 0.83–24.64 s）。关掉 VAD 结果一样（0.00–29.00 s、0.62–24.68 s），说明不是 VAD 拼接造成的，模型本身不产生句内时间戳 token。按现有整段转写流程，一个窗口会变成一条 22–24 s 的字幕。
- 文本：这段 PV 上没有比 large-v3 更准。Belle 有「焕然一些」（基线「才得以焕然一新」）、「笑董定制」（基线「校董定制」）、「你你就修改了她」；关 VAD 时还多出「泰姆菲尔德加」「观彻」「效动」。large-v3 没有标点，但分了 11 / 4 段，时间可用。

### anime-whisper q8_0

- 30 s 窗 + VAD（c1）：每窗只 1 段，覆盖整段语音（A 0.05–29.09 s），3 窗开头都有怪字：A「Sったのって何がだ?あ、そうだ、…」，B 只剩「Sるでしょ」（12.62–25.34 s，大量删字），C「000おい、リズム取るな。…」。不能用作整段转写。
- 逐句、有时间戳（c2，`no_timestamps=false`）：9 句中 8 句开头有一个异常 token：A-00「 There」（概率 0.0003）、A-01「S」、A-02「R…」、A-03「Sめ…」、A-04「s…」、C-00 一个 U+FFFD 替换字符（由 token 120 解码而来）、C-01「s」、C-02「H」。B-00 开头「るぅ…」不确定是不是怪字。9 句的段结束时间都是 30.00 s（片段只有 3.6–21.9 s），起点 0–0.96 s，时间戳没有意义。
- 逐句、`no_timestamps=true`（c2）：9 句全部没有怪字，avg_logprob 更好（−0.46…−0.04，对 −0.84…−0.26），去标点后共 191 字（同片段基线 141 字）。响应里的段没有 `start`/`end` 字段，`words` 只有 word 与 probability。示例：A-00「来たのって何がだ?…あっ」（基线「来たのって何事?」）；C-00「…こら、おい、リズム取るな」（基线「おい、リズム取るな」；安静探针也听到了「こら、おい」）；B-00 除了拟声（れろっ、ちゅっ）还给出「ふふっ、太ももすべすべでしょ?」（基线「うわぁ…それでしょう」，安静探针「ちょっとベスベでしょ…」）。
- 结论：只适合“逐句重新识别 + `vad=false` + `no_timestamps=true` + 无提示词”，与 design.md 第 86 行一致，保持“仅重识别”。逐句文本是否比基线更准，要等用户听审（V-ASRQ-10-2）。

### 安静预设探针（large-v3 + vad_threshold 0.35 / min_speech 150 / pad 300 / no_speech_thold 0.7）

- B-noise：没有新增段，但已有的那段也没去掉。标准参数下是 1 段「お前…」（3.84–4.54 s，avg_logprob −0.93）；探针下仍是 1 段「これ」（3.57–4.83 s，−0.07）。turbo 标准参数下也是「これ」。也就是说这个非语音对照在标准路径里本来就出字，探针让这段的置信度更高。
- 语音窗：9 个语音窗去标点后共 647 字，标准 638 字；10 窗共 41 段，标准 47 段，段更长（ind2 最后一段 18.94–30.02 s 含两句）。新增的内容：C「おい、こら、おい、リズム取るな。」与「もう、やんか、これで。」，B「ちょっとベスベでしょ…」，ind2 窗首（0.00 s）多出「みたいね」（可能是上一窗末尾，需要听）。退步：ind3「転生先」变成「天性先」。ind1 窗尾 29.68–30.02 s 的「起きてしまった。」（标准 −0.55，疑似边界碎片）消失。
- 因为 no_speech_prob 一直约 1.93e-05，`no_speech_thold` 从 0.6 调到 0.7 在这些样本上不可能产生可观察的影响。

### 对设计的影响（交协调者决定，本任务未改 design.md）

1. Belle 不能按 design.md 模型表那样直接当“整段转写”模型用（每窗 1 段、22–24 s）。可选方向：限定为逐句重新识别；或者执行器按 VAD 段 / 已有字幕逐段请求；或者先另测 token 级时间戳（本次未测）。
2. anime-whisper 走 `no_timestamps=true` 时，响应段没有 `start`/`end`。`native/server-contract.ts` 的 `rawSegmentSchema` 目前要求这两个字段，需要为这条路径改成可选，并用字幕或片段的起止时间作为时间。
3. no_speech_prob 在 v1.9.1 这条路径上没有区分度，噪声/幻觉抑制不能依赖 `no_speech_thold`。B-noise 在标准参数下就出字，验证“不新增幻觉”应比较段数和文本，不能只看有没有输出。
4. 61 次启动里有 1 次卡住：anime-whisper A-04（有时间戳），日志停在 `whisper_init_state: compute buffer (decode)`，120 s 内 `/health` 一直不 ok。结束进程后重跑一次就正常了。应用侧需要保留启动超时加重试。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-10-1 | 通过 | file:records/model-smoke-runs.txt；file:records/model-smoke-download.txt。三款模型都在 CUDA 上加载成功（日志有 `using CUDA0 backend`，ftype 7/1/7），各在真实样本上完成识别（turbo 10 窗、Belle 2 窗 + 2 次附加、anime 3 窗 + 18 次逐句），输出摘要见上。只覆盖原生 whisper-server 层，应用内模型目录、校验与执行器路径未覆盖 |
| V-ASRQ-10-2 | 未运行 | 需要用户听审 anime-whisper 逐句重识别（c2 `no_timestamps=true` 的 9 句，A-00…C-02，片段区间见 runs 日志） |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-04-5 | 通过（原生层；应用路径待 T-ASRQ-06/07 后复验） | V-ASRQ-10-1 |

## 风险与未执行项

- 只测了原生 whisper-server，没有走 Studio 的归一化、增益调理窗、窗口规划、后处理和模型校验流程；independent.wav 这类很安静的素材在应用里经过增益后结果可能不同。
- 基线用的是 large-v3 f16，Studio 默认是 large-v3-q5_0；turbo 相对默认模型的差距没有测。
- 样本很少（日语 10 窗、中文 2 窗、逐句 9 句），文本对错只是我对照基线和多个模型输出的判断，没有人工标注的参考文本；V-ASRQ-10-2 听审未做。
- Belle 的 token 级时间戳（`token_timestamps` / DTW）、逐句模式都没测；turbo 只测了 CUDA，没测 CPU 版。
- 观察到 1/61 次服务启动卡住，原因未查明（只出现一次，重跑正常）。
- 模型文件留在 `D:/fusionkit-asr-eval/models/`（约 3.3 GB），供后续 A/B 使用；不需要时请用户自行删除。

## 应用路径（T-ASRQ-09 附带）

本节由 T-ASRQ-09 追加，只覆盖 turbo q8_0；Belle 与 anime-whisper 的应用路径（重新识别）依赖 T-ASRQ-07，仍待 T-ASRQ-10 完成。上文的验证结果与 AC 表未改。

- 日期与版本：2026-10-22；工作树基于 68ffd05（未提交），含 T-ASRQ-01..04、T-ASRQ-06 的代码。
- 命令：`FUSIONKIT_ASR_AB=1 FUSIONKIT_KEEP_TEST_RUNS=1 FUSIONKIT_ASR_AB_MODEL_PATH=D:/fusionkit-asr-eval/models/ggml-large-v3-turbo-q8_0.bin FUSIONKIT_ASR_AB_MODEL=large-v3-turbo-q8_0 FUSIONKIT_ASR_AB_SAMPLES=A,B,C,B-noise,independent,full FUSIONKIT_ASR_AB_VARIANTS=standard npx vitest run --maxWorkers=1 --minWorkers=1 test/asr-quality/ab-comparison.test.ts`，1 passed，60.5 s，输出 `test-results/asr-quality-ab/run-devt9J`。
- 路径：T-ASRQ-01 的对照工具，即生产的 `createTranscriptionRuntime`（任务服务与 `freezeConfig`、`TranscriptionExecutor`、归一化器与内置 FFmpeg、服务监管、CUDA 证明、共享资源）。与原生冒烟不同，这里走 Studio 的归一化、窗口规划、低音量调理、分句候选与后处理。下载的模型由工具复制到临时私有资源根（逐个核对哈希），运行后删除；Studio 默认配置（VAD 开、按停顿切窗、束宽 5、温度 0），standard 变体，每个样本一个新的服务进程。
- 加载与校验：6 个组合都完成（B-noise 无内容），每个服务进程都以 `inference/cuda/large-v3-turbo-q8_0` 加载并证明为 CUDA（加速包代 96eee2a1…），文档转写稿记录的模型为 `large-v3-turbo-q8_0`（SHA-256 317eb69c1167…）；`failures=[]`，进程全部退出，临时目录已删除，样本与已安装资源未变。

| 样本 | 字幕 large-v3 / turbo | 字数 | 总耗时 s | 加载 s | 识别 s | 置信度中位 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 5 / 4 | 116 / 92 | 11.9 / 9.9 | 7.0 / 6.4 | 1.7 / 0.9 | 0.82 / 0.87 |
| B | 1 / 1 | 10 / 10 | 7.6 / 4.6 | 5.0 / 2.6 | 0.4 / 0.2 | 0.80 / 0.76 |
| C | 3 / 3 | 35 / 31 | 13.9 / 4.7 | 9.9 / 2.6 | 1.9 / 0.3 | 0.84 / 0.94 |
| B-noise | 0 / 0 | 0 / 0 | 9.4 / 4.3 | 7.2 / 2.6 | 0.1 / 0.0 | — |
| independent | 34 / 34 | 522 / 506 | 24.5 / 10.6 | 10.1 / 5.4 | 11.9 / 3.2 | 0.96 / 0.97 |
| full | 63 / 60 | 722 / 694 | 42.9 / 11.2 | 23.5 / 5.3 | 16.7 / 3.8 | 0.92 / 0.89 |
| 合计 | 106 / 102 | 1405 / 1333 | 110.2 / 45.2 | 62.7 / 24.9 | 32.7 / 8.5 | — |

large-v3 一列取自同一工具、同一配置的 T-ASRQ-09 正式运行 `run-2512BY`（standard）。

- 速度：识别约快 3.8 倍，总耗时（含每个样本的冷启动）约快 2.4 倍。
- 文字：字数少 5.1%。与原生冒烟一致的问题：A 丢了开头「来たのって何事?」，C 丢了「もう、」。其他差异：independent 开头的假名写成汉字（「わたしは、いせかいのめがみよ」→「私は異世界の女神よ」），「治める」写成「納める」，「毛も耳」写成「けも耳」；full 多处省掉句首「あ、」，「イオリ」写成「いいおり」，「そなたの好きなもん申し付け」两处写成「あなたの好きなもんも押し付け」；full 开头 5 句（large-v3 由 DTW 拆开）在 turbo 中是一条 14.1 s 的字幕，≥ 7 s 的字幕 6 → 8 条。
- 与原生冒烟不同的地方：原生 B 窗两个模型都差（large-v3「うわぁ…それでしょう」、turbo「うん…レディション」），应用路径加了整窗 12 dB 增益与 1000 ms VAD 填充后，两者都是「太ももスベスベでしょ」（turbo 0.763）；原生 B-noise 上 large-v3 出「お前…」、turbo 出「これ」，应用路径两者都无内容。
- 置信度：turbo 102 条，min 0.548、p10 0.766、中位 0.923、p90 0.996，与 large-v3 同样本（min 0.610、中位 0.941）接近；按 T-ASRQ-09 建议的 low_confidence 0.55 只标出 1 条（「うん」0.548）。
- 结论：turbo q8_0 在应用的整段转写路径上能加载、在 CUDA 上识别，时间戳为句级、可用；准确性低于 large-v3，适合作为“快速”档，与原生冒烟的结论一致。只测了 CUDA 与 standard 变体，没有测 CPU 与两个预设。证据：`records/T-ASRQ-09-run.txt`（命令、逐组合 PID、清理）、`records/T-ASRQ-09-analysis.txt` 第 10 节（逐条差异）。
