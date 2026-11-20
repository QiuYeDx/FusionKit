# 基线考察与验证问题

## 已确认的打轴模型

2026-11-20 用户确认首版使用 `TransWithAI/Whisper-Vad-EncDec-ASMR-onnx`。模型卡介绍了约 500 小时的日语 ASMR 训练数据及约 20 ms 的帧级概率输出。约 119 MB 的 ONNX 模型使用 MIT 许可。帧粒度描述采样间隔，实际首尾误差由素材评测量化。[上游模型卡](https://huggingface.co/TransWithAI/Whisper-Vad-EncDec-ASMR-onnx)

ChronosJAV 的先分段再识别流程提供了工程参考。VAD 能找出说话区间，连续对白仍需根据可用停顿规划字幕边界。首版按停顿编排字幕，评测单列连续对白合行。[ChronosJAV 流程说明](https://meizhong986.github.io/WhisperJAV/pipelines/chronosjav/)

首轮实验核对上游模型修订、文件大小和哈希、前处理及输出与参考实现的偏差，并用目标 Electron 包验证 CPU 运行时。模型选型已记录在 [规格决策](spec.json)。

## 可以直接沿用的能力

- 共享模型清单已有 `anime-whisper-q8_0`（818,305,955 B，约 818 MB），哈希、下载地址和引擎兼容性都已固定。工作台模型能力表限定 `ja`、禁 prompt、无可用时间戳、仅供短区间重新识别。继续复用共享模型与当前许可提示。见 [共享模型清单](../../../electron/main/speech-resources/engine/model-manifest.ts)、[模型能力表](../../../src/subtitle-studio/transcription-model-profiles.ts)。
- 已有 CUDA 冒烟记录。在 30 秒窗口上 Anime Whisper 每窗只返回 1 段，逐句开启时间戳时结束时间固定为 30 秒。关闭时间戳的 9 条短句请求返回了可听审文字，样本小且当时听审待做。同一记录中 `large-v3-turbo-q8_0` 有句级时间戳。见 [模型冒烟记录](../asr-quality/records/model-smoke.md)。
- 安静语音和带音效预设都曾在 `B-noise` 非语音对照中新增误出字。静音、音效、喘息和耳语需要独立标注。VAD 与解码器置信量是候选信号，空 ASR 输出也不能证明无声。见 [历史对照](../asr-quality/records/T-ASRQ-09.md)、[空结果判定避坑](../../../.agents/skills/fusionkit-pitfall-guard/references/do-not-infer-speech-absence-from-empty-asr.md)。
- 工作台已有选轨、FFmpeg 规范化、固定/停顿窗口、带时轴级联复核、路径授权、任务队列、单句识别、文档一次提交。单句识别中已走通 `noTimestamps` 请求及其响应解析。见 [工作台运行时](../../../electron/main/subtitle-studio/transcription/runtime.ts)、[短句识别设计](../studio-cue-recognize/design.md)。对应的 [whisper.cpp v1.9.1 服务源码](https://github.com/ggml-org/whisper.cpp/blob/v1.9.1/examples/server/server.cpp) 可核对服务协议。

## 首轮实验要区分的问题

1. 用人工区间喂 Anime Whisper，检验正确切句时能否比基线少错字。失败时优先看模型、语种、上下文裁切和听审标注。
2. 对 ASMR VAD 和 Turbo 的区间分别测耳语覆盖、边界、错切和合行，在逐句识别之前记录分段数据。
3. 把两个自动区间方案分别交给同一个 Anime Whisper 配置，测端到端收益和负样本误出字。结合人工轴结果定位第一阶段的候选召回或边界问题。
4. 额外记录模型加载、逐句请求数量、帧读取、取消和长素材磁盘开销。原生冒烟与两阶段整条链路分别记证据。

模型卡与二进制的外部核验入口为 [模型仓库](https://huggingface.co/litagin/anime-whisper) 和 [仓库固定的 GGML 转换版本](https://huggingface.co/Aratako/anime-whisper-ggml/tree/35b467f144c62a3ab2d84bfbb517d6af5135444a)。Anime Whisper 的本地契约以仓库清单、能力表和已有冒烟为据。真实双阶段对比在开发计划首项执行。
