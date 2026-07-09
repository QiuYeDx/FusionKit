# 工作包 DOC-001：README、CHANGELOG、隐私说明与发布文档同步

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：DOC-001

## 本次实现内容

- README 新增 0.2.11 音频工具箱版本亮点，说明音频转文本、文本转音频、实时字幕和 Realtime/WebRTC 双向语音。
- README 新增“音频工具箱”功能段落，说明全局音频 Profile、OpenAI/MiMo ASR、OpenAI/MiMo TTS、MiMo 三模式、流式播放、实时字幕和双向语音能力边界。
- README 补充音频隐私与能力提示：
  - 本地音频文件、录音片段和麦克风内容会发送到用户选择的第三方音频 API。
  - OpenAI Realtime 长期 API Key 仅在 Electron 主进程用于创建临时凭证。
  - API Key、Authorization / `api-key` header、Base64 音频、PCM chunk 和完整请求体不写入任务恢复、Zustand 持久化或错误详情。
  - MiMo-only 能力和 MiMo 非 WebRTC 双向语音边界需在 UI 中明确禁用/提示。
- README 项目结构和配置说明补充 `electron/main/audio/` 与“音频模型配置”。
- CHANGELOG 的 0.2.11 条目补充音频工具箱新增能力、安全隐私边界、测试文档和发布前限制。
- 更新 audio-toolkit final design、execution plan、v0.2.11 入口和版本级台账，标记 `DOC-001` 已完成，并保留 `QA-001` / `QA-002` 未完成状态。

## 修改文件

- `README.md`
- `CHANGELOG.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_implementation_records/2026-07-09_DOC-001_audio-release-docs.md`

## 接口或数据结构变化

- 无。仅更新用户可见文档、发布说明和开发台账。

## 验证结果

执行命令：

```text
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/audioTranscriberConfig.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts src/store/tools/audio/realtimeCaptionsConfig.test.ts src/store/tools/audio/realtimeVoiceConfig.test.ts
git diff --check
```

结果：

- `node_modules/.bin/tsc --noEmit`：通过。
- `node scripts/check-i18n.mjs`：通过，9 个 namespace、四语言各 1371 个 key；存在 5 个 same-as-source warning，均为 `SRT 字幕`、`VTT 字幕`、`OpenAI · MiMo`、`MiMo 音色` 等可接受专名/格式。
- `node_modules/.bin/vitest run ...`：通过，19 files / 110 tests。
- `git diff --check`：通过。

## 未完成事项

- `QA-001` 自动化回归矩阵仍未开始。
- `QA-002` Electron 与真实供应商手工验收仍未开始，尤其是 OpenAI Realtime/WebRTC 真实连接、麦克风/远端音轨播放、OpenAI/MiMo 真实 ASR/TTS、MiMo `voicedesign` / `voiceclone` 低延迟流式状态。

## 下一步建议

- 下一次认领 `QA-001`，先补齐自动化回归矩阵。
- 如具备真实 API Key、麦克风和扬声器环境，再进入 `QA-002` 并记录真实供应商验收结果。
