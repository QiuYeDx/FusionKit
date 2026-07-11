# FIX-006：ASR、供应商矩阵与 Profile defaults

- 日期：2026-07-11
- 状态：已完成；全量 Vitest、Vite test build 与 Electron 32 组合矩阵通过
- 对应：`AUD-P1-015`、`AUD-P1-016`、`AUD-P1-021`～`AUD-P1-023`

## 修复

- OpenAI `gpt-4o-transcribe`/mini 与 `whisper-1` 分别限制响应格式、timestamp、prompt、stream；MiMo ASR 对齐 wav/mp3、10MB Base64、auto/zh/en 与 SSE。
- Transcriber 文件选择使用 token，取消检查真实结果，离页 cleanup；display-only 当前结果可通过原生保存对话框落盘。
- `realtimeCaptions` 对 OpenAI Audio/MiMo 解析 transcription model，不再读取不存在的 realtime model。
- config summary 携带 profile defaults；Transcriber/Speech store 按“用户显式覆盖 > profile 默认 > 工具默认”播种并迁移。
- Speech 对 OpenAI input/instructions 4096、speed 0.25～4 做 UI 与 IPC 双层校验。

## 官方基线

- [OpenAI transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
- [OpenAI speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)
- [MiMo ASR](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/Speech-Recognition)
- [MiMo TTS](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/speech-synthesis-v2.5)
