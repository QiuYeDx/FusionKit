# AUDIT-001：四个音频工具页发布前缺陷审计与后续修复台账

- 日期：2026-07-10
- 状态：审计已完成；`FIX-002`～`FIX-007` 与 `QA-001` 已完成，完整自动化、构建和 Electron 32 组合矩阵通过
- 范围：音频转文本、文本转音频、实时字幕、双向语音，以及共享 store、renderer service、Electron IPC/runtime、供应商 adapter 和现有测试
- 结论：白屏已由 `FIX-001` 修复；6 个 P0、23 个 P1、14 个 P2 已闭环，发布门禁现仅剩 `QA-002` 真实设备与真实供应商验收，完成前仍不发布

## 1. 审计方式与边界

本次执行了：

- 完整阅读 audio-toolkit Final Design、Execution Plan、四页实施记录及相关源码。
- 检查四页所有 Zustand selector、effect、取消、卸载、流式播放、麦克风、WebRTC、文件输出、持久化和 i18n 路径。
- 检查 audio IPC/runtime、OpenAI/MiMo adapter、临时文件、错误/重试、并发 ownership 和测试 fixture。
- 运行 TypeScript、i18n、19 个音频测试文件共 111 个测试、Vite test build。
- 在实际 Electron 中等待全局 preload loading 完全退出后，逐一挂载四个音频路由并监听 renderer console error 与 `pageerror`。
- 按 2026-07-10 的 OpenAI 官方 GA 文档复核 Realtime 事件、transcription model、会话音频格式、manual commit 和 WebRTC buffer clear。

本次未执行：

- 未使用真实 OpenAI/MiMo API Key，不把 fixture 通过等同于真实供应商通过。
- 未做真实麦克风、扬声器、远端音轨和长会话测试。
- 后续已补跑四路由×四语言×1280×800/786×540 Electron 自动化矩阵，共 32 个组合通过；严格等待全局 loading 退出并检查白屏关键错误、页面异常与横向溢出。

## 2. 官方协议基线

- [OpenAI Realtime 与 GA 迁移概览](https://developers.openai.com/api/docs/guides/realtime)：GA 使用 `response.output_audio.*` 与 `response.output_audio_transcript.*` 等新事件名。
- [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)：实时字幕使用 transcription session；当前推荐 `gpt-realtime-whisper`，并要求按 `item_id` 处理乱序 completion。
- [OpenAI Realtime API reference](https://developers.openai.com/api/reference/resources/realtime)：会话音频格式为 PCM 24k / PCMU / PCMA；manual 模式需要 `input_audio_buffer.commit`，Voice 还需 `response.create`；WebRTC 打断需要 `response.cancel` 后发送 `output_audio_buffer.clear`。
- [OpenAI Realtime WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)：浏览器/Electron renderer 使用 WebRTC，长期 Key 留在可信后端，客户端使用 ephemeral credential。
- [Electron 安全：验证 IPC sender](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)。

## 3. 总体结论

### 已完成

- `AUD-FIXED-001`：四页共享 selector 造成的 React 19 / Zustand 无限更新白屏已修复，并通过 selector referential-stability test 与 Electron 四路由 smoke。

### 2026-07-11 修复回填

| 范围 | 实现状态 | 验证状态 |
| --- | --- | --- |
| 6 个 P0 | 已闭环 | TypeScript、全量 Vitest、Vite test build、Electron matrix 通过 |
| 23 个 P1 | 已闭环 | 全量 73 files / 560 tests 通过 |
| `AUD-P2-001`～`AUD-P2-013` | 已闭环 | 四语言 1410 keys 与 Electron 32 组合矩阵通过 |
| `AUD-P2-014` | 已闭环 | GA/lifecycle fixtures、页面 render 与 Electron 矩阵通过 |

对应 fix 文档见同目录 `2026-07-11_FIX-002_*` 至 `2026-07-11_FIX-007_*`；实施记录见 `audio-toolkit_implementation_records/2026-07-11_FIX-002-FIX-007_audio-audit-fix-closure.md`。

### 原审计发布阻断（现已由 FIX-002～FIX-007 闭环）

去重后归纳为 6 个 P0、23 个 P1 和 14 个 P2。最危险的三类不是样式问题，而是：

1. renderer 可以通过过宽 IPC 同步任意 endpoint 并让 main 读取/上传任意本地文件，音频功能扩大了现有 IPC 信任边界风险。
2. Realtime/录音失败或建连竞态可让页面显示失败、禁用停止，但麦克风、PeerConnection 或排队上传仍继续。
3. 当前 OpenAI Realtime GA 事件、模型和格式契约与实现/测试不一致，Realtime Captions 与 Voice 的核心行为不能视为可用。

## 4. P0：发布前必须修复

### `AUD-P0-001` 音频 IPC 可被 renderer 组合成任意本地文件外传通道

- 证据：`electron/preload/index.ts:5-20` 暴露通用 `on/off/send/invoke`；`audioRuntimeConfigService.ts:14-39` 可同步 endpoint/API Key；`audioIpc.ts:273-400` 接受 renderer 的 runtime snapshot 与文件路径；`audio-file.ts:74-181` 显式 MIME 优先于扩展名且未校验文件头。
- 触发：renderer 出现脚本注入后，同步攻击者 endpoint，再把任意 ≤25 MiB 本地文件伪装成 `audio/wav` 交给 main 上传。
- 目标：preload 改为窄类型音频 API；main 校验 sender；文件路径必须来自 main 文件选择并绑定一次性 token/nonce；校验真实文件头；任务不能覆盖主进程持有的 endpoint/Key。
- 后续工作包：`FIX-002`。

### `AUD-P0-002` Realtime GA 事件 mapper 过期

- 证据：`audioRealtimeService.ts:326-388` 只识别 `response.audio_transcript.*` / `response.audio.*`；`audioServices.test.ts:466-484` 固化旧事件。
- 影响：当前 GA 的助手字幕、音频开始/结束、WebRTC buffer started/stopped 收不到；`input_audio_transcription.failed`、cancelled/incomplete 也缺失。
- 目标：支持 `response.output_audio_transcript.*`、`response.output_audio.*`、`output_audio_buffer.started/stopped/cleared`，保留必要的旧事件兼容，并携带 `item_id/response_id/content_index`。
- 后续工作包：`FIX-004`。

### `AUD-P0-003` Realtime Voice 与 Captions 错误共用同一个模型合同

- 证据：`audio.ts:78-82,228-255,424-435`；`openai-realtime-adapter.ts:134-149`；`AudioModelConfig.tsx:774-782,914-924`；现有测试用 `gpt-realtime` 构造 transcription session。
- 影响：设置页一个 `models.realtime` 同时承担双向语音模型和实时转写模型；默认 `gpt-realtime` 被写入 `audio.input.transcription.model`，与当前 `gpt-realtime-whisper` transcription 契约不符。
- 目标：拆分 `realtimeVoiceModel` / `realtimeTranscriptionModel`，迁移旧配置，分别校验 capability/model family；修正默认值与 fixture。
- 后续工作包：`FIX-004`。

### `AUD-P0-004` 失败状态会禁用停止，但资源仍活跃

- 证据：`RealtimeVoice/index.tsx:239-241,319-342,470-476`；`RealtimeCaptions/index.tsx:289-291,365-371,442-463,596-602,762-766`；`audioRealtimeService.ts:192-212`。
- 触发：DataChannel error、recorder error、任一 chunk 转写失败。页面只 `setStatus("failed")`，没有 stop；`failed` 又不在 `isRunning`，停止按钮随即禁用。再次开始会覆写 ref，旧资源成为孤儿。
- 目标：统一幂等 `failSession()`；置失败前释放 recorder/tracks/PC/channel、取消 in-flight 和 queued；停止按钮由实际 resource ref 决定。
- 后续工作包：`FIX-003`。

### `AUD-P0-005` 建连过程中离页/断开存在迟到成功与孤儿麦克风

- 证据：`RealtimeVoice/index.tsx:244-280,331-342`；`RealtimeCaptions/index.tsx:297-311,400-463`；`audioRealtimeService.ts:149-190,217-252`。
- 触发：client secret IPC、权限弹窗或 SDP 交换期间离页。handle 尚未写入 ref，cleanup 看不到；AbortSignal 只覆盖 SDP fetch，未覆盖 credential/getUserMedia，也没有每个 await 后的 generation 检查。
- 目标：全阶段单一 try/finally；session generation/AbortSignal 覆盖每个 await；迟到 handle 立即 stop；PC/dataChannel/addTrack 初始化也纳入回滚。
- 后续工作包：`FIX-003`。

### `AUD-P0-006` WavChunkRecorder 初始化/错误路径可遗留麦克风

- 证据：`wavChunkRecorder.ts:43-99,133,181`；`RealtimeCaptions/index.tsx:346-390`。
- 触发：getUserMedia 成功后 AudioContext/node/connect 抛错，或 `flushFinalChunk/onChunk` 抛错。当前 start/stop 没有 finally 回滚，页面 error handler 只改状态。
- 目标：recorder 自身拥有幂等 cleanup；start 失败回滚全部已创建资源；stop 即使 flush 失败也必须停 track/close context；异步 onChunk rejection 进入受控错误路径。
- 后续工作包：`FIX-003`。

## 5. P1：高优先级功能与数据正确性

| ID | 问题与证据 | 目标工作包 |
| --- | --- | --- |
| `AUD-P1-001` | `manual` 只把 `turn_detection` 设为 null，却没有 `input_audio_buffer.commit`；Voice 也没有 `response.create`（`openai-realtime-adapter.ts:154-163`，唯一 sendClientEvent 在 `RealtimeVoice:387-390` 且只 cancel）。首版应先禁用，或实现完整 push-to-talk 状态机。 | `FIX-004` |
| `AUD-P1-002` | Voice/Captions 提供 Opus，adapter 发 `{type:"audio/opus"}`（Voice `123-160`、Captions `134-151`、adapter `166-181`），但当前 session config 只接受 PCM24k/PCMU/PCMA。移除或改成官方格式。 | `FIX-004` |
| `AUD-P1-003` | `response.done` 无条件映射 completed，所有 Realtime error 又都当 session fatal（service `350-386`）。需解析 status/status_details，并区分 operation error 与 fatal disconnect。 | `FIX-004` |
| `AUD-P1-004` | delta 丢弃 item identity，partial 只按 role 保存（service `333-368`、两个 realtime store 的 partial）。交错 item 会串字和误清空；需按 item/response/content index reconcile。 | `FIX-004` |
| `AUD-P1-005` | Voice 打断只发 `response.cancel`（`RealtimeVoice:387-398`），不会清 WebRTC 已缓冲音频；需随后发 `output_audio_buffer.clear` 并等待确认。 | `FIX-004` |
| `AUD-P1-006` | 未监听 DataChannel close、PC/ICE failed/disconnected（service `192-215`），UI 可永久 connected 且 track 不释放。 | `FIX-003` |
| `AUD-P1-007` | 5 秒 chunk 串行 Promise 队列无背压（Captions `346-363,740-784`）；慢 API 会无限积压 WAV bytes、延迟和上传。需限制队列长度/总字节/最大延迟。 | `FIX-003` |
| `AUD-P1-008` | 离页 cancel 包含尚未 invoke 的 queued ID，cancel 返回未找到后旧 Promise 仍会上传/写 store（Captions `297-311,749-784`）。queued/in-flight 必须分离并检查 session generation。 | `FIX-003` |
| `AUD-P1-009` | request controller Map 全窗口共享，cancel 立即 delete 造成 ID 重用竞态；renderer destroyed 也不会 abort（`audio/ipc.ts:89-92,120-365,311-346`）。Map 需绑定 sender，finally 只删除自己的 controller，renderer 销毁批量 abort。 | `FIX-002` |
| `AUD-P1-010` | runtime config 的 sync→invoke 非原子且每次传所有 API Key（`audioRuntimeConfigService.ts:14-39`、`audio-runtime-config.ts:11-19`）。需主进程持有配置或使用不可伪造 revision，并仅携带引用项。 | `FIX-002` |
| `AUD-P1-011` | recorded chunk temp file 在 try 外创建，写失败会泄漏 controller；unlink 失败/崩溃后无 TTL 清扫（`audio/ipc.ts:191-233,494-514`）。 | `FIX-002` |
| `AUD-P1-012` | 输出写入/stream callback 普通 Error 被当 network_error 重试，可能二次计费/播放；并发唯一文件名存在 TOCTOU，取消后仍可能写“幽灵文件”（`audio-file.ts:184-221`、`audio-http.ts:39-48,160-184`）。网络重试与本地写入必须分层，使用原子 `wx`。 | `FIX-005` |
| `AUD-P1-013` | MiMo SSE buffer/PCM 全量驻留、无大小/时长限制；每块独立 UTF-8 解码会破坏跨 chunk 中文 JSON，已发 delta 后透明重试会重播（MiMo adapter `345-474,684-755`）。 | `FIX-005` |
| `AUD-P1-014` | 200 响应未校验 Content-Type/magic，宽松 Base64 解码会把 HTML/错误 JSON/损坏音频当成功（OpenAI adapter `316-345`、MiMo `305-342,806-819`）；IPC 数值/长度也只校验 finite。 | `FIX-005` |
| `AUD-P1-015` | OpenAI Audio capability/model matrix 与实现不符：部分 transcribe model 不支持所列格式；ASR `stream:true` 仍按普通响应解析；TTS 声称 streaming 却收完整 arraybuffer（`audio.ts:228-233`、transcriber config `129-299`、OpenAI adapter）。 | `FIX-006` |
| `AUD-P1-016` | MiMo 偏差：ASR stream 被明确拒绝；voice design optimize+空 input 仍发空 assistant；audio tags 发送未文档化开关（MiMo adapter `182-225,537-610`）。需按当前供应商文档重做 fixture。 | `FIX-006` |
| `AUD-P1-017` | Speech stream 的 started callback 未 await player.start，首包可能在 context 就绪前被丢；completed 立即 hard stop 会截断已调度尾音（Speech `605,617-641`、PCM player `8-73`）。 | `FIX-005` |
| `AUD-P1-018` | Speech 离页只 best-effort cancel，未先失效 store generation；新一轮未清 streamText，event/result 双终点造成旧结果、无成功 toast或 listener 泄漏（Speech `559-669`、speech store `103-112`、service `81-161`）。 | `FIX-005` |
| `AUD-P1-019` | OpenAI 裸 PCM 交给 `<audio>` 必然不可解码；手拼 `file://` 对 Vite renderer、UNC、`#` 等路径不可靠（Speech `897-901,1052-1058`）。需 WAV 封装或受限 media protocol/blob URL。 | `FIX-005` |
| `AUD-P1-020` | MiMo 切模式后禁用字段仍无条件进入 payload，如 preset audio tags、design optimize（Speech UI `182-475`、config `200-221`）。按 mode 白名单构造并清互斥字段。 | `FIX-005` |
| `AUD-P1-021` | Audio Profile 全局 defaults 没进入 summary，四页始终用本地 store 硬编码默认（`audio.ts:83-91`、`audioToolConfig.ts:27-37,63-124`）。定义 profile 默认与用户覆盖优先级及迁移。 | `FIX-006` |
| `AUD-P1-022` | ASR 没有保存当前 display-only 结果，只能复制或把“下一次”改成 source_dir；取消忽略 IPC result，且无路由离开 cleanup（Transcriber `355-416,617-651`）。 | `FIX-006` |
| `AUD-P1-023` | OpenAI Audio profile 虽声明可用于 chunked captions，但 realtimeCaptions resolver 取 `models.realtime`，设置页对 openai_audio 不保存该字段，最终 model_missing（`audio.ts:228-255,424-435`、Captions config、AudioModelConfig）。应使用 transcription model。 | `FIX-006` |

## 6. P2：体验、可访问性、可维护性与 QA

| ID | 问题 | 建议 |
| --- | --- | --- |
| `AUD-P2-001` | Realtime elapsed 直接在 render 中 `Date.now()`，无 store 更新时计时静止。 | 运行时 1 秒 tick，结束冻结最终时长。 |
| `AUD-P2-002` | transcript/conversation 数组与 DOM 无上限。 | 窗口化、分段归档或可配置上限；导出数据与可见窗口分离。 |
| `AUD-P2-003` | 运行中配置仍可编辑但不会作用于当前请求/session。 | 锁定不可动态字段；可动态字段显式 session.update 并展示确认。 |
| `AUD-P2-004` | Captions instructions 被 adapter 忽略，assistant transcript 在 transcription session 中无 assistant response。 | instructions 映射 transcription prompt；移除 assistant 开关或更改产品模式。 |
| `AUD-P2-005` | Captions 缺设计中的暂停/继续、输入音量、可见时间戳；SRT 只用本地估算时间却始终可选。 | 补控制/Analyser；无稳定 segment 时间时禁用或标注近似 SRT。 |
| `AUD-P2-006` | `ToolField` 支持 htmlFor，但四页多数 label 未关联控件。 | 稳定 id/htmlFor；Radix Select 使用 aria-labelledby。 |
| `AUD-P2-007` | segmented/button group 选中态只有颜色。 | 改 RadioGroup/ToggleGroup，或补 aria-pressed、组 label、方向键。 |
| `AUD-P2-008` | 动态字幕/timeline 没有 live region。 | `role="log"`、aria-live/relevant，并节流 partial。 |
| `AUD-P2-009` | 已知 runtime error 直接显示英文 message。 | 先按 error code/field 映射四语言，未知详情放 technical detail。 |
| `AUD-P2-010` | speed 只依赖 HTML min/max，builder 不 clamp；下载点击后不确认真实写入路径，partial 不导出。 | submit 本地校验；使用 Electron save dialog/IPC 返回路径。 |
| `AUD-P2-011` | `%TEMP%/fusionkit-audio` 的 TTS 临时输出和 main 保存的 client-secret/session 记录无 TTL/配额清扫。 | 启动/退出清扫、容量上限、只保存最小 session ownership/expiry。 |
| `AUD-P2-012` | 四个 persist store 没有 migrate/schema validate/deep defaults merge。 | 提升 version，实现 migrate + defaults merge + runtime validation。 |
| `AUD-P2-013` | 小型死状态/死字段：Captions sessionId 订阅不展示，Speech fileNameHint 无入口；流式产物写 WAV 却返回 pcm16 format。 | 删除死字段或补用途；拆 stream encoding 与 artifact format。 |
| `AUD-P2-014` | 没有页面级 render/lifecycle/GA fixture/Electron 窄窗口矩阵；现有测试反而固定旧事件、Opus、manual 和错误模型。 | 增加四路由 render、unmount during connect、error teardown、乱序 item、当前 GA fixtures、最小窗口×四语言 Electron 验收。 |

## 7. 后续工作包与顺序

| 顺序 | 工作包 | 范围 | 完成标准 |
| --- | --- | --- | --- |
| 1 | `FIX-002` Audio IPC 信任边界与任务 ownership | sender、preload 窄 API、文件 token/magic、runtime config、controller ownership、renderer destroyed、temp cleanup | renderer 不能指定任意 endpoint+file；跨 sender/ID 重用/销毁测试通过 |
| 2 | `FIX-003` Realtime/recorder 生命周期与背压 | 全阶段 abort、failSession、PC/DC close、recorder finally、queued/in-flight、backlog | 任意错误/离页/重连后 mic/PC/queue 均为 0；停止始终可用 |
| 3 | `FIX-004` OpenAI Realtime GA 协议与模型合同 | model split、GA events、manual/format、buffer clear、response status、item identity | 官方 GA fixture 全通过；Captions/Voice 用各自模型真实可连 |
| 4 | `FIX-005` TTS streaming 与输出正确性 | player drain/start、generation、SSE decoder/backpressure、content validation、retry/write boundary、PCM/media URL | 首包/尾音不丢，取消无幽灵文件，不重复计费/播放 |
| 5 | `FIX-006` ASR、provider matrix 与 Profile defaults | ASR cancel/save、OpenAI/MiMo matrix、chunked model、defaults seed/migration | 全局默认真实生效；不支持组合在提交前阻止；当前结果可保存 |
| 6 | `FIX-007` UX、a11y、i18n 与页面 QA | no-op 控件、pause/volume/timestamp、live region、下载、持久化迁移、视觉矩阵 | 四语言、宽窄窗口、键盘/读屏基础、四路由 Electron matrix 通过 |
| 7 | `QA-001` / `QA-002` | 离线回归与真实供应商/设备验收 | 所有 P0/P1 关闭后再执行；真实 Key/音频不写日志或文档 |

## 8. 发布门禁

- `FIX-002`、`FIX-003`、`FIX-004` 完成前，不进行带真实私密文件/API Key 的供应商验收。
- 所有 P0 与 P1 未关闭前，不把 `QA-002` 或 audio-toolkit 标记为发布候选。
- 每个工作包必须新增独立 fix/实施记录，更新本 Execution Plan 台账，并运行 TypeScript、i18n、音频完整回归和 Electron 资源清理检查。
- 真实供应商结果必须区分 verified/degraded/failed；fixture 通过不能替代真实低延迟、麦克风和远端音轨验收。
