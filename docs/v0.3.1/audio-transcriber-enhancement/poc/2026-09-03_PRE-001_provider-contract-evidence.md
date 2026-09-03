# PRE-001 供应商合同证据

- 检查日期：2026-09-03
- 范围：OpenAI Transcriptions、MiMo `mimo-v2.5-asr`、仓库内 Silero runtime surface、脱敏 fake fixture
- 方法：官方文档静态核对 + 仓库/runtime 审计 + fixture 测试；没有把 fake 响应当成真实供应商成功证据

## 1. 官方合同与冻结值

| Route | 当前 v0.3.1 合同 |
| --- | --- |
| OpenAI GPT transcription | `POST /v1/audio/transcriptions`；输入 FLAC/MP3/MP4/MPEG/MPGA/M4A/OGG/WAV/WebM；普通 GPT transcription 只取 JSON 文本合同，不臆造 timestamp |
| OpenAI Whisper | 同端点；支持 JSON/TXT/SRT/VTT/verbose JSON；word/segment timestamp 只与 `whisper-1 + verbose_json` 协商 |
| OpenAI 其他模型 | `gpt-transcribe`/diarize 等虽已出现在官方文档，但当前产品 registry 未声明，v0.3.1 继续 fail closed，不能凭模型名前缀自动继承能力 |
| MiMo ASR | `POST /v1/chat/completions`；仅 `mimo-v2.5-asr`；每次一个 WAV/MP3 Base64 音频；正文来自 Chat Completion，不发送 OpenAI transcription 专属字段 |

| 约束 | PRE-001 结论 |
| --- | --- |
| OpenAI 文件预算 | 官方表述为不超过 25 MB；内置 route 候选 hard cap 取保守十进制 `25_000_000` bytes，planner 目标 `24_000_000` bytes，待真实 413 边界验证后最终冻结 |
| MiMo Base64 | hard cap `10_000_000` ASCII chars，安全目标 `9_000_000`；标准 Base64 对应 raw 上限分别为 `7_500_000` 与 `6_750_000` bytes，发送前按实际编码复核 |
| MiMo 媒体 | MP3=`audio/mpeg + format=mp3`，WAV=`audio/wav + format=wav`；data URL MIME、format、签名必须一致 |
| MiMo duration/output | 保留 4 分钟 target、5 分钟 hard max 与 2,000 output-token 风险门；MP3 候选为 16 kHz/mono/CBR 64 kbps，真实矩阵通过前不得升格为 built-in 默认 |
| MiMo 完成 | 仅 `finish_reason=stop` 可提交；`length` 缩短当前 unit 后有限重试；`content_filter`、空文本、缺 choice、SSE 断流均不提交 |
| MiMo usage/费用 | `usage.seconds` 仅用于音频时长用量摘要，不是 cue 时间轴；当前公开价为 $0.074/音频小时，只能作为带 `checkedAt` 的可更新提示 |
| MiMo 限流/错误 | 100 RPM、10K TPM 是 hint；429/5xx/连接失败可按唯一 retry owner 有限重试，402/403/421 不重试 |

官方依据：[OpenAI transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)、[OpenAI Speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text)、[OpenAI GPT-4o Transcribe](https://developers.openai.com/api/docs/models/gpt-4o-transcribe)、[OpenAI Whisper](https://developers.openai.com/api/docs/models/whisper-1)、[MiMo ASR guide](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/Speech-Recognition)、[MiMo ASR API](https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition)、[MiMo model/rate](https://mimo.mi.com/docs/zh-CN/quick-start/summary/model)、[MiMo errors](https://mimo.mi.com/docs/zh-CN/api/guidance/error-codes)、[MiMo pricing](https://mimo.mi.com/docs/en-US/quick-start/model)。

## 2. Fixture 证据

`test/audio/fakeAudioApiServer.ts` 现可生成 MiMo 非流式和 SSE ASR 响应，覆盖 `stop/length/content_filter`、`usage.seconds`、空文本、缺 choice、无终态断流及 `[DONE]`。Base64 测试证明 `7_500_000` raw bytes 恰为 `10_000_000` chars，增加 1 byte 即超出 4 chars；安全目标同样按十进制字符计算。

验证：`.\node_modules\.bin\vitest.cmd run test/audio/fakeAudioApiServer.test.ts`，1 个测试文件、10 个测试通过。fixture 只验证本地 parser 输入合同，不能证明供应商接受请求。

## 3. 真实最小矩阵与阻塞

| 场景 | 结果 |
| --- | --- |
| MiMo 短 WAV / 短 MP3 | 未运行：本机无 `MIMO_API_KEY` |
| MiMo M4A→候选 MP3 | 未运行：本机无 `MIMO_API_KEY`，且本包不写 production 转码链路 |
| MiMo 约 5 分钟高文本密度 / 多片 | 未运行：同上 |
| OpenAI 小文件 / 25 MB 边界 | 未运行：本机无 `OPENAI_API_KEY` |

当时的解除条件是用户在本机进程环境配置可用密钥、额度与非提交样本；随后用户于 2026-09-03 搁置整批需求，因此 `PRE-001` 已改为废弃，真实矩阵不再执行。本证据仅作为归档资料，不代表当前供应商合同。

## 4. Silero 决策

仓库依赖中没有 `silero-vad`/ONNX runtime。现有本地字幕仅把 `silero-vad-v6.2.0-ggml` 交给 `whisper-server` 内部使用，没有可返回原 PCM intervals 的独立、可取消 Electron 调用面。官方仓库提供 Python/Torch/ONNX 与 C++ 示例，但没有仓库已 pinned 的 Node/Electron executor；直接 ONNX 还要求调用方实现 I/O、状态与后处理。[Silero VAD repository](https://github.com/snakers4/silero-vad)、[version history](https://github.com/snakers4/silero-vad/wiki/Version-history-and-Available-Models)。

结论：`VAD-001` 不进入 v0.3.1 首版并标记废弃，后续新需求重新立项；基础链路继续使用 `pcm_energy_v1 + fixed_window`。该结论关闭 Q-01，不改变任何 P0 能力。
