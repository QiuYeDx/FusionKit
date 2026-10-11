# 单句重新识别 设计

## 现状与约束

- **转写链路**（见 explore 记录，全部为现有代码）：任务经 `transcription/task-service.ts` 准入（解析托管模型 / VAD、`media.verifyRuntime`、`backendResolver.resolveBackend`），由 `transcript-executor.ts` 以 `supervisor.acquireBatchRuntimePin(owner, batchId, { purpose: 'inference', verifiedRuntime, serverArtifactId, model, vadModel?, threads: 4, backend[, acceleratorPack] })` 拿到服务进程，再对每个 16 kHz 窗口文件调用 `supervisor.beginInference(lease, request)`，最终由 `native/server-http-client.ts` 的 `inference()` 以 multipart 上传 `window.wav`（≤ 1 MiB，16 kHz 单声道约 32 秒）到本机 whisper 服务。
- **可改与不可改**：`transcription/native/*`、`transcript-executor.ts`、`src/subtitle-studio/transcription/{config,domain,ipc-contract}.ts` 是 provenance 校验的冻结副本，不能改；`transcription/runtime.ts`、`task-service.ts`、`shared-resources.ts` 等为工作台自有适配层，可以改。`electron/main/subtitle-studio/index.ts` 修改需更新组合审计（`resources/speech-resources/provenance/current-integration-audits.v1.json`）。
- **运行时门面**（`runtime.ts`）只暴露 `media / tasks / resources`，供应器（supervisor）与后端解析器在 `compose()` 内部；`tasks.enqueue` 在共享资源模式下先 `sharedResources.reserveUse([...])`。
- **服务运行时校验**：`verifyLocalSubtitleRuntimeBundle(scope: 'server')` 本机实测约 0.2–0.3 秒，可每次请求都做（与任务一致，不另行缓存）。
- **服务进程**：同一加载身份（模型 / 后端 / VAD / 线程）可复用正在运行或空闲中的进程（空闲 5 分钟后回收）；有其他身份的租约或正在推理时 `acquire` / `beginInference` 报资源忙。
- **截取**：`cue-audio-clip.ts` 的 `CueAudioClipper.decode` 固定 48 kHz；`readCueAudio` 已按“窗口 + 用途”分道。
- **界面测试的假运行时**：`transcription-ui-build.ts` 用 esbuild 把 `runtime.ts` 换成 `helpers/transcription-ui-runtime.ts`，测试通过 `globalThis.__studioT06Control` 控制。
- **本机资源**：`%APPDATA%\FusionKit\speech-resources\models\` 已有 large-v3、large-v3-q5_0；有 Windows 语音合成（System.Speech）可生成英文语音样本。

## 方案与取舍

### 主进程（R-RECOG-01）

- `src/subtitle-studio/cue-recognize-contract.ts`（新）：`recognizeCue` 请求 schema `{ documentId, cueId, modelId(transcriptionRef), language('auto' | BCP-47 短标签), initialPrompt?(≤200 字，无控制字符) }`、`cancelCueRecognition {}`；结果 `{ text: string; language?: string }`；常量 `RECOGNIZE_PAD_MS = 200`、`RECOGNIZE_MAX_MS = 30_000`、`RECOGNIZE_SAMPLE_RATE = 16_000`、`RECOGNIZE_BATCH = 20`。
- `CueAudioClipper.decode` 增加可选 `sampleRate`（默认 48000），WAV 头按实际采样率生成；识别使用新用途 `recognize`（第三条解码道），不影响试听与波形。
- `transcription/runtime.ts` 门面新增 `recognize.clip(owner, { modelId, devicePreference, language, initialPrompt?, filePath, signal })`：
  1. `requireOwner`；共享资源模式下 `reserveUse([modelId, (win32 且 auto/cuda) CUDA 包])`，结束释放；
  2. `models.resolveManagedModel(modelId)`（未安装 → `needs_configuration`）、`verifyRuntime('server')`、`backendResolver.resolveBackend({ model, devicePreference, admittedRuntimeGeneration })`；
  3. `server.acquire(owner, { purpose: 'inference', verifiedRuntime, serverArtifactId: resolution 的服务构件, model, threads: 4, backend, acceleratorPack? }, signal)`；
  4. `localSubtitleFileIdentityForPath(filePath)` → `beginInference(lease, { requestGeneration: 1, filePath, expectedFileIdentity, language, taskMode: 'transcribe', beamSize: 5, temperature: 0, vadEnabled: false, vadMinSilenceMs: 500, initialPrompt? })`；取消时 `cancelRequest`；
  5. `finally` 释放租约；返回 `{ text: result.text.trim(), language: result.language }`。
  与任务相同的加载身份（同模型、同后端、无 VAD 时不同）——转写任务启用 VAD 时身份不同，运行中会报资源忙，属预期（需求已说明）。
- `electron/main/subtitle-studio/cue-recognize-service.ts`（新）`recognizeCue(deps, owner, request, guard, signal)`：取文档与字幕 → 时间段（复用 `resolveCueAudioRange` 规则，结束未知取下一条开始；±200 毫秒；> 30 秒 → `limit_exceeded`）→ `CueMediaService.resolve`（错误码见下）→ 解码 16 kHz 到 `subtitle-studio/cue-audio/recognize-<uuid>.wav`（私有临时文件）→ `runtime.recognize.clip` → `finally` 删除临时文件。错误码：未关联 / 不可用媒体 → `document_unavailable`（界面用媒体状态说明具体原因）；解码失败、无音轨 → `transcription_failed`；运行时错误经现有 `transcriptionIpcError` 映射（资源忙 → `resource_busy`，未安装 → `needs_configuration`）。
- `index.ts`：新增 `recognizeCue` / `cancelCueRecognition` 处理（文档授权、`ensureRuntime()`、每窗口一个 `AbortController`，新请求与取消都会中止旧的，窗口释放时中止）；更新组合审计。

### 渲染端（R-RECOG-02）

- `StudioCueRecognize.tsx`（新，`ScrollableDialog`，宽 640，与 AI 修订对话框同一视觉语言）：
  - 顶部选项行：模型 `Select`（`listTranscriptionResources` 中 `resourceType === 'model'` 且 `status === 'ready'`；默认转写偏好 `modelId`，否则第一个）、语言 `Select`（复用转写页的语言列表与文案）、提示词 `Input`；“开始识别”按钮。
  - 进度条行：“正在识别 3 / 8” + 停止按钮（`role=status`）。
  - 结果列表：沿用修订对话框的行结构（复选框 · 试听按钮 · 序号 · 文字），原文→识别结果用 `Diff`（从 `StudioCueRevision.tsx` 导出复用）；标签：“与原文一致”“未识别到语音”、失败原因（警示色）。
  - 底部：已勾选数、“取消”、“应用 N 条”（`editBlocked` 时禁用并显示原因）。
- 应用：`{ kind: 'batch', operations: 勾选项.map(id => ({ kind: 'source', cueId, text: editedText(cue.source, 识别文字) })) }`，历史标签新增 `recognize`。
- 菜单：在“AI 修订…”之后加“重新识别原声…”（`AudioWaveform` 图标）；无可用媒体时禁用，菜单底部提示沿用“未关联原始媒体”。
- 状态：选项 idle / 运行中（选项禁用）/ 完成；单条 pending / done / same / empty / error。

### 测试支撑（R-RECOG-03）

- 假运行时 `helpers/transcription-ui-runtime.ts` 增加 `recognize.clip`：从控制命令 `{ operation: 'recognize', texts: string[] | errors }` 设定的队列依次返回（未设定时返回“识别文本 N”）。新增控制命令同时可把某个模型标为 `ready`。
- 单元：契约 schema；`recognizeCue` 用假运行时与真实 FFmpeg（临时 WAV 为 16 kHz、时长、删除、错误映射）；`runtime.recognize.clip` 用 `helpers/transcription-runtime.ts` 的 `runtimeFixture`（假 HTTP 客户端）验证请求字段与租约释放。
- 真实验证（可选，`FUSIONKIT_REAL_RECOGNIZE=1`）：用 System.Speech 生成英文句子 WAV，按本机已安装模型跑一次，记录识别文字。

### UI 设计基准

- 参照：`StudioCueRevision.tsx` 的对话框（标题图标 + 说明、选项区、结果区 `studio-cue-revision-item` 行、底部按钮）、`ToolRadioButtonGroup`/`Select`/`Input` 尺寸 `sm`/`h-8 text-xs`。
- 层级：标题“重新识别原声”+ 说明“用本地转写模型重新识别所选 N 条的原声，确认后替换原文。”；选项一行（窄屏换行）；结果区可滚动；底部固定。
- 样本：日语短句与 30+ 字长句、识别为空、失败（资源忙）、与原文一致；786 深色。

## 实施中确定（2026-10-11）

- **界面测试需要随应用的 FFmpeg**：假运行时构建（`buildTranscriptionUiApp`）原本只复制 `dist` / `dist-electron`，识别前的截取在主进程用真实 FFmpeg 解码，校验时找不到 `build/subtitle-studio-resources/transcription`。构建助手新增可选 `mediaRuntime`，把开发环境运行时复制到隔离应用目录（`test/subtitle-studio/helpers/transcription-ui-build.ts`，测试写集之外的小改动，默认关闭，其他界面测试不受影响）。
- **假运行时的识别队列每次设定都替换**而不是追加：停止识别时被中断的条目不会消耗队列，追加会让上一步剩余的结果串到下一步。
- **选项行**：模型与语言下拉框填满各自的网格列（初版按内容宽度，1280 下两者之间留出大片空白）。

## 代码落点

- `src/subtitle-studio/cue-recognize-contract.ts`（新）、`src/subtitle-studio/ipc-contract.ts`、`electron/preload/subtitle-studio-api.ts`、`electron/preload/subtitle-studio-channel-policy.ts`
- `electron/main/subtitle-studio/cue-audio-clip.ts`、`electron/main/subtitle-studio/cue-recognize-service.ts`（新）、`electron/main/subtitle-studio/index.ts`、`electron/main/subtitle-studio/transcription/runtime.ts`
- `resources/speech-resources/provenance/current-integration-audits.v1.json`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRecognize.tsx`（新）、`StudioCueRevision.tsx`（导出 `Diff`）、`StudioCueMenu.tsx`、`StudioCueTable.tsx`、`index.tsx`、`src/services/subtitle-studio/cue-history.ts`
- `src/locales/{zh,en,ja,zh-Hant}/studio.json`
- 测试：`test/subtitle-studio/helpers/transcription-ui-runtime.ts`、`test/subtitle-studio/helpers/transcription-ui-build.ts`（`mediaRuntime`）、`test/subtitle-studio/cue-recognize.test.ts`（新）、`test/subtitle-studio/cue-recognize-ui.test.ts`（新）、`test/subtitle-studio/ipc.test.ts`

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-RECOG-01 | 契约、16 kHz 截取、`recognize.clip`、`cue-recognize-service`、`index.ts` 处理与审计 |
| R-RECOG-02 | `StudioCueRecognize` 对话框、菜单项、批量应用与撤销标签、`Diff` 复用 |
| R-RECOG-03 | 假运行时识别接口与控制命令、可选真实验证 |

## 验证与风险

- 单元 / 集成：见“测试支撑”；provenance 测试确保未改冻结副本、组合审计更新。
- Electron UI（假运行时构建，静音）：对话框默认值、逐条识别与进度、勾选应用与撤销、停止、无模型提示、无媒体禁用、截图审阅（1280 浅色、786 深色）。
- 风险：
  - 大模型首次加载需数秒到数十秒（CPU 更慢）：首条显示“正在加载模型…”，可停止。
  - 与转写任务互斥：转写运行中多半返回资源忙，界面说明“转写任务进行中，稍后再试”。
  - whisper 对很短的片段（< 1 秒）可能识别为空或幻听：结果仅作建议，需逐条确认。
