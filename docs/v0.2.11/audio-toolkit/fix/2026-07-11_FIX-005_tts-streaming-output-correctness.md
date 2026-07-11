# FIX-005：TTS streaming 与输出正确性

- 日期：2026-07-11
- 状态：已完成；全量 Vitest、Vite test build 与 Electron 32 组合矩阵通过
- 对应：`AUD-P1-012`～`AUD-P1-014`、`AUD-P1-017`～`AUD-P1-020`

## 修复

- PCM player 在 AudioContext ready 前排队首包；完成使用 drain 等待尾音，取消才 hard stop。
- Speech task 使用 generation/唯一终点，监听器 finally 退订，新任务清空旧 stream text。
- MiMo SSE 使用 streaming `TextDecoder`，限制事件、转写和 PCM 大小；一旦发出 delta，后续错误禁止透明重试。
- Base64 使用 canonical 严格校验；OpenAI/MiMo 音频校验 Content-Type 与 magic。
- 输出以原子 `wx` 预留，写入错误分类为 `output_write_failed`；取消后删除新产物。
- OpenAI raw PCM 包装为 WAV；播放器通过 output token 读回 Blob，不再拼 `file://`。
- MiMo payload 按 preset/design/clone 白名单构造，移除未文档化 `audio_tags_enabled`。
