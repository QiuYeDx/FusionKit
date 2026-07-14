# FIX-004：OpenAI Realtime GA 协议与模型合同

- 日期：2026-07-11
- 状态：已完成；协议 fixture、全量 Vitest、Vite test build 与 Electron matrix 通过，真实 WebRTC 仍属于 QA-002
- 对应：`AUD-P0-002`、`AUD-P0-003`、`AUD-P1-001`～`AUD-P1-005`

## 修复

- profile 拆分 `realtimeTranscription`（默认 `gpt-realtime-whisper`）与 `realtimeVoice`（默认 `gpt-realtime`），旧 `realtime` 自动迁移。
- mapper 支持 `response.output_audio*`、`response.output_audio_transcript*`，保留旧事件兼容并携带 item/response/content/output identity。
- `response.done` 解析 completed/cancelled/failed/incomplete；API operation error 为 non-fatal，transport error 为 fatal。
- Realtime 格式改为 PCM16/PCMU/PCMA；首版禁用 incomplete manual push-to-talk。
- partial 按 item identity reconcile；Voice interrupt 依次发送 `response.cancel` 与 `output_audio_buffer.clear`。
- `response.done/cancelled` 只确认生成结束，不确认播放停止；Voice interrupt 只有收到
  `output_audio_buffer.stopped/cleared` 后才确认打断完成。

## 官方基线

- [Realtime guide](https://developers.openai.com/api/docs/guides/realtime)
- [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [Realtime API reference](https://developers.openai.com/api/reference/resources/realtime)
