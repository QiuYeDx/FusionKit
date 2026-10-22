# 实施记录：T-ASRQ-02

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-02 |
| 日期 | 2026-10-22 |
| 验证版本 | 工作树，基于 68ffd05（未提交）。新增：`src/subtitle-studio/transcription-audio-profiles.ts`、`test/subtitle-studio/transcription/audioProfileRequest.test.ts`、`test/subtitle-studio/audio-profile-ui.test.ts`、本记录与 `records/T-ASRQ-02-{unit,static,integration,ui}.txt`。修改：`electron/main/subtitle-studio/transcription/native/server-contract.ts`、`electron/main/subtitle-studio/transcription/native/server-supervisor.ts`（写集外，见“实际结果·偏离”）、`electron/main/subtitle-studio/transcription/transcript-executor.ts`、`electron/main/subtitle-studio/transcription/task-service.ts`（写集外，见下）、`src/subtitle-studio/transcription/task-contract.ts`、`src/subtitle-studio/transcription/preferences-contract.ts`、`src/services/subtitle-studio/transcription-controller.ts`、`src/pages/Tools/Subtitle/SubtitleStudio/StudioTranscription.{tsx,css}`、`src/locales/{zh,zh-Hant,en,ja}/studio.json`、`scripts/subtitle-studio-provenance/current-copy-audits.{mjs,json}`、`test/subtitle-studio/{transcription-controller,transcription-preferences,transcription-task-contract,transcription-task-service}.test.ts`、`test/subtitle-studio/transcription/productionExecutor.test.ts`、`test/subtitle-studio/helpers/transcription-ui-runtime.ts`、`docs/features/asr-quality/design.md`（仅“界面设计基准”中本任务的一条） |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；Electron 41.10.6（测试构建 `npx vite build --mode=test`，静默离屏窗口）；NVIDIA GeForce RTX 4070 Ti SUPER（驱动 610.88，本任务的测试不使用 GPU 与真实模型）。同一工作树并行有 T-ASRQ-01 的 `test/asr-quality/` 改动，本任务未触碰 |
| 任务指纹 | 1e8ea5d2b905e45c70bb9653d0f7611c13b8000d8bdd2d920047d9dfe5e579cd |

## 实际结果

### 公开配置与偏好

- 新文件 `src/subtitle-studio/transcription-audio-profiles.ts`（不导入任何模块，渲染端与主进程共用）：`TRANSCRIPTION_AUDIO_PROFILES = ['quiet_whisper_v1', 'noisy_music_v1']`、界面顺序 `TRANSCRIPTION_AUDIO_TYPES`（标准在前）、各类型的文案键（名称、一行说明、提示、任务行短标签），以及 `transcriptionAudioTypeOf` / `withTranscriptionAudioType`。标准类型一律“不写字段”，不会出现 `audioProfile: undefined`。
- `task-contract.ts`：`advanced.audioProfile` 为可选枚举（未知值、`'standard'`、空串被拒绝）；`enqueueTranscriptionRequestSchema` 在 VAD 关闭时拒绝非标准预设（与“按语音停顿”同一位置的规则）。任务摘要新增可选 `audioProfile`，供任务行标签使用。
- `preferences-contract.ts`：偏好沿用 `config` 存储，校验扩展为“按语音停顿或非标准音频类型都要求 VAD”。偏好存储顶层键未变（`transcription-preferences.test.ts` 的精确键断言保持原样并新增往返测试）。
- `task-service.ts`：`freezeConfig` 原本就把 `advanced` 展开进快照，无需改；只在入队时把非标准 `audioProfile` 写进任务摘要（一行）。

### 请求参数（主进程）

- `native/server-contract.ts`：新增 `LOCAL_SUBTITLE_AUDIO_PROFILES`（设计参数表唯一出处）：
  - `quiet_whisper_v1`：`vadThreshold 0.35`、`vadMinSpeechMs 150`、`vadSpeechPadMs 300`、`noSpeechThreshold 0.7`、`quietAudioMode 'gated_v1'`；
  - `noisy_music_v1`：`vadThreshold 0.45`、`vadSpeechPadMs 200`、`suppressNonSpeech true`。
  `quietAudioMode` 是给 T-ASRQ-03 的低音量调理选择（本任务不读取、不实现门控增益），放在同一表里是因为 T-ASRQ-03 的写集不含本文件。新增 `resolveLocalSubtitleAudioProfile`（未知名称抛 `invalid_configuration`，`__proto__`/`toString` 等原型键也被拒绝）。
- 请求接口新增可选 `vadThreshold`、`vadMinSpeechMs`、`noSpeechThreshold`、`suppressNonSpeech: true`；`vadSpeechPadMs` 由字面量 `1000` 改为 30–1000 的整数。字段接口新增 `vad_threshold`、`vad_min_speech_duration_ms`、`no_speech_thold`、`suppress_nst`，`vad_speech_pad_ms` 改为字符串。新字段插在 `vad_min_silence_duration_ms` 之后、`prompt` 之前；不带这些字段的请求得到与改动前完全相同的字段名、值与顺序（单元测试逐项比对 `Object.entries`）。校验：阈值 0.1–0.9、最短语音 50–1000（整数）、填充 30–1000（整数）、no_speech 0.3–0.95、`suppress_nst` 只接受 `true`；VAD 关闭时拒绝三个 `vad_*` 字段。
- `transcript-executor.ts`：用局部扩展类型读取快照的 `advanced.audioProfile`（未改冻结的 `domain.ts`），只从 fork 文件 `server-contract.ts` 导入，满足 executor 回放的文件约束。`createInferenceRequest` 中：只有 VAD 识别请求（含质量恢复重放、条件化窗口回退原音的那次）带预设字段；分隔候选（VAD 关，含 DTW）不带；被低音量调理的窗口仍用 1000 ms 填充，否则用预设填充（`quietAudioGainDb` 由 T-ASRQ-03 的门控增益同样产生，届时无需再改这段）。`execute` 开始时先校验一次预设（未知名称或 VAD 关闭时带预设 → `runtime_protocol_mismatch`，不做媒体准备）。
- 偏离——`native/server-supervisor.ts`（写集外，必要的最小改动）：监管器的 `snapshotInferenceRequest` 逐字段复制请求，不改它新字段会在到达 HTTP 客户端前被丢弃。只新增四行条件复制；无字段时快照完全相同。已按 provenance 流程加入 `CURRENT_COPY_AUDIT_OWNERS` 并登记 JSON 条目（`copiedSha256` = fork 清单 `4630fd50…`）。
- 偏离——`task-service.ts`（写集外，任务说明要求摘要暴露该字段）：只加一行摘要字段；该文件不在任何审计清单中。

### 审计登记

`current-copy-audits.mjs` 新增 `server-contract.ts`、`server-supervisor.ts` 两个 FORK_PATH 所有者（共 6 个，JSON 条目数 6）。JSON：新增两条（`copiedSha256` 取 `transcription-fork.json` 的 `412ff639…` 与 `4630fd50…`，`currentSha256` 为 `bef8784f…`、`22ea3fef…`），`transcript-executor.ts`（`46fadb24…`）与 `productionExecutor.test.ts`（`6ede2f14…`）更新 `currentSha256` 并追加 2026-10-22 的原因句，`copiedSha256` 保持。受审计文件均为 LF。本任务未改任何组合文件，因此无需重新登记 `currentBlobOid`。

### 界面

- `StudioTranscription.tsx`：“音频类型”通栏字段放在“媒体语言/处理设备”之后、“输出语言”之前（两列栅格无空洞；单列紧随处理设备）。`Select` 下拉项为两行（名称 + 11px 说明），浮层宽度等于触发器，触发器只显示名称（`SelectValue` 子内容 + `textValue`）。下方提示随类型变化。关闭语音检测时若为非标准类型，回到标准并用琥珀色一行就地说明（替换普通提示；再次修改音频类型或语音检测即消失）。任务行在模型标签后显示非标准类型的短标签（耳朵/音符图标，复用自动翻译标签外观，Tooltip 给出全名），行高不变。
- 控制器新增 `setAudioType`（非标准类型同时打开 VAD；标准删除字段）与 `setVadEnabled`（关闭时同时回到固定窗口与标准类型，返回“是否因此改回标准”给界面显示说明）。原先界面里的“关 VAD 改固定窗口”逻辑并入后者，行为不变。
- 文案：zh、zh-Hant、en、ja 各 14 个键。渲染审查后改了两处文案：重置说明原文在 1280 宽度把“嘈杂·音乐音效”断在两行、随后又剩孤字，缩短为“已改回“标准”：其他音频类型需要语音检测。”（各语言同步）；标准提示缩短为单行。
- 设计基准：`design.md`“界面设计基准”新增本任务一条参照测量，渲染实测与之一致（见验证结果）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-02-1 | 通过 | inline:证据文件 records/T-ASRQ-02-unit.txt；6 个文件 141 项 + 执行器“Studio audio profiles” 7 项全部通过）。覆盖：默认请求字段名/值/顺序与改动前一致（含 1000 ms 条件化窗口、VAD 关闭）；两个预设的字段与取值；VAD 关闭时拒绝 `vad_*`；各字段越界、非整数、非数字、`suppress_nst=false` 被拒绝，边界值通过；参数表与共享 id 一致；监管器把预设字段原样交给 HTTP 客户端且快照冻结；执行器：标准请求键与改动前相同，quiet 预设在条件化窗口为 1000 ms、回退原音为 300 ms，noisy 预设在质量重放（温度 0→0.2）两次都带字段，分隔候选（VAD 关）不带任何预设字段，未知预设与 VAD 关闭带预设在媒体准备前失败；任务契约、偏好往返、控制器联动、任务服务快照与摘要 |
| V-ASRQ-02-2 | 通过 | inline:证据文件 records/T-ASRQ-02-static.txt；最后一次源码修改后：`copy.mjs --check` passed，120 文件；`transcript-executor-copy.mjs --check` passed；`shared-resource-integration.mjs` exact；`npx tsc --noEmit -p tsconfig.json` exit 0 |
| V-ASRQ-02-3 | 通过 | inline:证据文件 records/T-ASRQ-02-integration.txt；`test/subtitle-studio-provenance test/subtitle-studio/transcription test/subtitle-studio/transcription-preferences.test.ts`：53 文件通过、5 跳过，1135 项通过、7 跳过，含 `replay.test.ts` 20 项旧版对拍与 `transcript-executor-replay.test.ts` 23 项；另跑 `test/subtitle-studio src/pages/Tools/Subtitle/SubtitleStudio src/services/subtitle-studio src/agent src/pages/Tools/_shared`：166 文件通过、56 跳过（UI 用例无环境变量时跳过），2441 项通过 |
| V-ASRQ-02-4 | 通过 | inline:证据文件 records/T-ASRQ-02-ui.txt；inline：`FUSIONKIT_STUDIO_AUDIO_PROFILE_UI=1` 下真实 Electron（受控原生运行时，渲染/预加载/IPC/偏好为生产代码）通过。视口实测 1280×800、1024×700，浅/深色均：处理设备→音频类型、音频类型→输出语言间距 16px，触发器高 32px，提示 11px/18px，设置列与工作区无横向溢出；下拉浮层宽 294 = 触发器 294，三项各高 49px、说明 11px、无溢出（含英文）。交互：关 VAD 后选“低音量·耳语”→ VAD 自动打开、提示切换；再关 VAD → 回到“标准”并显示说明；选“嘈杂·音乐音效”提交 → 入队请求 `vadEnabled:true, audioProfile:'noisy_music_v1'`，标准任务请求无该键；任务行显示“♫ 嘈杂”，Tooltip“音频类型：嘈杂·音乐音效”，标准任务无标签，两行高度均 74px；重启（深色）后保持“低音量·耳语”与 VAD 开；页面错误 0。截图 `test-results/studio-t06-ui/controlled-qKTKNS/asrq02-*.png`（12 张）已逐张查看，修复了重置说明与标准提示的断行后重新构建并复验；之后只改了用例失败分支的空值保护，又跑一次通过（`controlled-yqRlNJ`，日志与测量即该次 |
| V-ASRQ-02-5 | 通过 | inline:证据文件 records/T-ASRQ-02-static.txt；按修订后的检查口径：2026-10-22 协调者把本检查改为“check-i18n.mjs 通过且 check-i18n-usage 相对 HEAD 无新增错误”，原因是 HEAD 已有 40 条与本功能无关的错误）。`check-i18n.mjs` exit 0（四语言键齐全、无空值）。`check-i18n-usage.mjs` exit 1：40 个 DYNAMIC_KEY/STALE_MANIFEST 错误全部在本任务未改动的文件（About、Help、PromptTemplates、Setting、ToolTile、Tools/index、prompt-templates）；对 HEAD 导出副本运行同一检查得到完全相同的 40 条（逐条比对，差集为空），本任务新增的 `t()` 调用均被解析为有限键、无报错。即该命令按原样失败，原因是既有问题 |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-01-1 | 通过 | V-ASRQ-02-1, V-ASRQ-02-3 |
| AC-ASRQ-01-2 | 通过 | V-ASRQ-02-1, V-ASRQ-02-4 |
| AC-ASRQ-01-3 | 通过 | V-ASRQ-02-1 |
| AC-ASRQ-01-4 | 通过 | V-ASRQ-02-1, V-ASRQ-02-4 |
| AC-ASRQ-01-5 | 通过 | V-ASRQ-02-1, V-ASRQ-02-4 |

## 风险与未执行项

- 2026-10-22 协调者修补：两个预设在下拉中标为“实验性”，提示文案改为说明可能编造文字（noisy 的“提高门槛”说法与参数不符，已更正），见 records/polish.md。
- AC-ASRQ-01-2 说明：本任务部分：请求字段与偏好保存；“低音量调理改用门控动态增益”由 T-ASRQ-03 接线并在其 V-ASRQ-03-2 验证

- 预设参数是外部经验的固定值，尚未在真实音频上对照；是否推荐由 T-ASRQ-09 的 A/B 与用户听审决定。`noisy_music_v1` 的 `suppress_nst` 会去掉 ♪ 与「」『』（discovery 已记录），界面提示已写明。
- AC-ASRQ-01-2 的门控增益部分已由 T-ASRQ-03 完成（见 records/T-ASRQ-03.md）。
- 写集外改动：`native/server-supervisor.ts`（必要，已登记审计）与 `task-service.ts`（一行摘要字段；T-ASRQ-06/08 的写集也含该文件，合并时注意）。
- 契约层允许 `no_speech_thold`/`suppress_nst` 出现在 VAD 关闭的请求上（设计只要求拒绝 `vad_*`）；执行器不会这样发送。
- `check-i18n-usage` 既有 40 条错误未处理（不属于本任务，HEAD 上逐条相同）。
- 既有 UI 用例 `test/subtitle-studio/experience-transcription-ui.test.ts`（`FUSIONKIT_STUDIO_I5_TRANSCRIPTION_UI=1`）本次运行失败于第 103 行第三次拖入：该次拖入紧跟一次 `Select` 选择。我在新用例中定位到同类问题——Radix `Select` 关闭动画期间仍对页面其余部分设置 `aria-hidden`，拖放范围据此不接收文件——新用例改为先等待下拉浮层卸载后再拖入。原用例未修改，也未在 HEAD 构建上复跑确认，只能判断与本任务的代码路径无关。
  - 2026-10-23 整体回归已在 HEAD 导出副本上复跑：同一行（第 103 行）以同样的错误失败（`studio-transcription-media-row` 期望 1 个、实际 0 个），确认为既有问题，未修改，见 records/regression.md。
- 2026-10-23 整体回归：`test/subtitle-studio/audio-profile-ui.test.ts` 按 polish 第 1 项更新了断言，不属于回归修复。下拉选项的文字现在含“实验性”标记（回归初跑失败为 `['标准','低音量·耳语实验性','嘈杂·音乐音效实验性']` 不等于不带标记的名称），`options()` 改为只取名称文字，并断言标准无标记、两个预设的标记文字为 `model_experimental`。提示文案仍从语言文件读取，自动跟随新文案。更新后的用例在工作树上通过；另用一次性探针截取了“嘈杂·音乐音效”的新提示（中文 1280 浅色、英文 1024 深色），宽度与触发器一致，没有溢出，探针文件已删除。
- 运行副作用：编辑主进程文件时，用户已在运行的 `vite` 开发服务器（自 10-21 起）按其监听重建并重启了开发版 Electron；三次 `vite build --mode=test` 重写了 `dist/` 与 `dist-electron/`（开发服务器下次重建会覆盖）。本任务启动的测试 Electron 均已关闭，用户的开发实例未被结束。
- 截图中工作区顶部的“FusionKit”标题胶囊会叠在上传区文字上（页面滚动或窗口较矮时），为既有标题栏行为，未在本任务处理。
- 未提交；提交时只应包含上述文件（同一工作树有 T-ASRQ-01 的 `test/asr-quality/` 与其记录）。
