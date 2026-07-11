# 工作包 FIX-002～FIX-007：四个音频工具页审计修复收口

## 基本信息

- 日期：2026-07-11
- 状态：已完成
- 对应执行计划：`FIX-002`、`FIX-003`、`FIX-004`、`FIX-005`、`FIX-006`、`FIX-007`

## 本次实现内容

- 收紧 preload/main IPC、文件与输出 token、sender/revision/controller ownership。
- 重构 Realtime/WebRTC/recorder/chunk queue 的 abort、失败、离页与背压生命周期。
- 对齐 OpenAI Realtime GA 事件、双模型字段、音频格式、response status/item identity 与打断清缓冲。
- 修复 TTS 首包/尾音、任务 generation、MiMo SSE UTF-8/Base64/上限/重试、输出原子写与安全播放。
- 对齐 OpenAI/MiMo ASR/TTS capability matrix，接入 profile defaults、ASR 当前结果保存和取消 cleanup。
- 收口 elapsed、暂停/音量/时间戳、a11y、四语言错误、原生保存、store migration、临时文件清扫。

## 关键接口与数据结构变化

- `AudioModelProfile.models` 新增 `realtimeTranscription`、`realtimeVoice`，保留旧 `realtime` 迁移。
- Realtime format 改为 `pcm16 | pcmu | pcma`；事件携带 identity、response terminal status 与 `fatal`。
- renderer ASR 使用 `fileToken`；生成产物使用 `outputToken`；新增受控 read/reveal/save-text IPC。
- runtime config sync 产生 sender-bound revision，任务显式绑定 revision。
- stream artifact 返回 WAV，`streamStats.streamEncoding` 记录 PCM16 wire encoding。

## 验证结果

已通过：

- `tsc --noEmit`。
- `node scripts/check-i18n.mjs`：四语言、9 namespace、每语言 1410 key 对齐。
- 本轮前段定向测试：7 files / 33 tests；修正契约后再次运行核心 2 files / 17 tests，均通过。
- 全量 `vitest run`：73 files / 560 tests 全部通过；覆盖 IPC token 契约、文件 magic、OpenAI/MiMo runtime、stream abort、store migration、录音/队列/player 与 Electron e2e。
- `vite build --mode test`：renderer 5879 modules、main 73 modules、preload 281 modules 构建通过。
- Electron 自动化矩阵：4 个音频路由 × 4 语言 × 1280×800 / 786×540 共 32 个组合通过；每次等待 `.app-loading-wrap` 与 `#app-loading-style` 均消失，并验证标题可见、正文非空、无横向溢出、无 `getSnapshot` / `Maximum update depth` / pageerror。
- `git diff --check` 无空白错误。

回归补强：

- 更新旧 IPC 测试为 file/output/voice-sample token 契约，并将伪音频 fixture 改为可通过真实 magic 校验的 WAV/MP3。
- 修复 MiMo 流式回调触发 abort 后被误包装成 `stream_parse_failed` 的竞态；增加 fake server 请求消费等待，消除超时测试时序波动。
- 全量测试暴露 Windows CRLF Markdown 混合换行，已统一按源文件行尾组装并将语义断言改为跨平台；经验沉淀为 `FK-PIT-0005`。

## 未完成事项

- `FIX-002`～`FIX-007` 与 `QA-001` 无未完成项。
- 没有使用真实 OpenAI/MiMo Key 或真实麦克风/扬声器；真实 ASR/TTS 音质、流式延迟和 Realtime/WebRTC 会话仍归 `QA-002`，不能由 fixture/Electron 路由矩阵替代。

## 下一步建议

- 执行 `QA-002` 真实供应商与真实设备验收，并单独记录 verified/degraded/failed 结果。
