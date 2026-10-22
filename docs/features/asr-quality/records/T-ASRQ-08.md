# 实施记录：T-ASRQ-08

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-08 |
| 日期 | 2026-10-22 |
| 验证版本 | 工作树，基于 68ffd05（未提交）。修改：`electron/main/subtitle-studio/transcription/task-service.ts`、`electron/main/subtitle-studio/transcription/runtime.ts`（组合文件）、`electron/main/subtitle-studio/transcription-ipc.ts`、`electron/preload/subtitle-studio-api.ts`、`src/subtitle-studio/ipc-contract.ts`、`src/subtitle-studio/transcription/task-contract.ts`（写集外，见“偏离”）、`src/services/subtitle-studio/transcription-controller.ts`、`src/pages/Tools/Subtitle/SubtitleStudio/{StudioTranscription.tsx,StudioTranscription.css,transcription-errors.ts,transcription-errors.test.ts}`、`src/pages/Tools/_shared/ui/TranscriptionEmptyResult.tsx`、`src/locales/{zh,zh-Hant,en,ja}/studio.json`、`src/agent/external/tools/{transcription.ts,export-transcription.test.ts}` 与 `src/agent/{modern-tools.ts,modern-tools.test.ts}`（任务要求的 Agent 工具说明，写集外）、`resources/speech-resources/provenance/current-integration-audits.v1.json`、`test/subtitle-studio/{transcription-task-service.test.ts,transcription-controller.test.ts,helpers/transcription-ui-runtime.ts,interaction-queue-ui.test.ts}`、`test/integration/transcription-empty-result-ui.test.ts`（写集外），design.md 方案 6 与“界面设计基准”中本任务的一条。新增：`test/subtitle-studio/transcription-retry-ipc.test.ts`、`test/subtitle-studio/transcription-retry-ui.test.ts`；记录与证据 `records/T-ASRQ-08{.md,-unit.txt,-errors.txt,-ui.txt,-integration.txt}` |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；TypeScript 5.9.3；Electron 41 + Playwright 1.58.2（静默离屏窗口，隔离的临时 userData，受控转写运行时）；HEAD 基线为 `git archive HEAD` 导出到 `test-results/asrq08-head-baseline` 后单独构建；没有运行真实模型或 GPU |
| 任务指纹 | 62051de3e5e53ab7832ac307d3366325a2ab014611d247c8887522fd71064411 |

## 实际结果

### 主进程（`task-service.ts`、`runtime.ts`、`transcription-ipc.ts`）

- 任务记录另存其批次请求的 `config`（冻结副本，同批任务共用）。新增 `prepareRetry(owner, taskId, overrides)`：只接受本 owner 的 `failed`/`no_content` 且没有待清理的任务（其他状态 `invalid_input`，别的 owner 或已移除 `access_denied`）；先用 `captureSourceInput(inputPath, inputIdentity)` 复核文件（被改写、移动或任何读取失败都抛 `media_changed`），再通过同一个输入授权注册表新建一个 `probe/transcribe/derive_source_output` 授权，并对新授权解析出的文件身份再核对一次（两步之间被替换也拒绝，同时撤销该授权）。返回的请求是原 `config`，带原音轨 `audioStreamId`；`audioProfile` 覆盖时同时设 `vadEnabled: true`（与设置面板选择音频类型一致），`devicePreference` 覆盖只改设备。原任务的令牌在任务结束时已释放，从不复用。
- `runtime.tasks.retry`：调用 `prepareRetry`，像选择文件时一样用媒体规范化器探测新授权并记入运行时的探测表（音轨可绑定，发布的文档记住音轨），再走原来的入队路径。原 `tasks.enqueue` 的函数体原样移到同文件的 `enqueue` 函数里，重试与普通入队共用同一个共享资源预留与释放；探测或入队失败时撤销新授权（已成为任务的授权 `revokeDraft` 不会动）。重试生成新的批次与任务，原任务保留到用户移除；同一文件已有进行中的任务时照旧返回 `resource_busy`。
- 公开错误增加可选 `stage`：`publicError` 对原生错误保留其 `stage`（例如窗口级 `runtime_protocol_mismatch` 是 `transcribing`）。任务摘要 schema 相应扩展（见“偏离”）；既有测试用 `toMatchObject`，不受影响。
- IPC：`retryTranscriptionTask { taskId, audioProfile?, devicePreference? }`（strict，值来自契约自身的枚举）加入 `transcriptionRequestSchemas`，因此 `index.ts` 的通用转写分派与 preload 通道策略自动包含它，`index.ts` 与通道策略文件没有改；preload API 增加同名方法。返回 `{ status: 'admitted', admission }`；`media_changed`（文件变了，或原音轨已不在）返回 `{ status: 'source_changed' }`，其他失败照旧映射为错误码。
- 组合审计：`runtime.ts` 在 `current-integration-audits.v1.json` 中重登记 `currentBlobOid`（`cdc82d0a…` → `c256e2db…`）并追加 2026-10-22 T-ASRQ-08 原因。`current-composition-audits.json` 只有 main/preload/package.json 三项，没有 runtime.ts，因此未改；其他组合文件未改。`transcript-executor.ts` 与 `native/*.ts` 均未改，拷贝审计不变。

### 界面（`StudioTranscription.tsx`、`transcription-errors.ts`、`TranscriptionEmptyResult.tsx`）

- 失败与无内容任务行（没有待清理时）都有“重试”。建议按钮（`transcriptionRetrySuggestion`）：无内容且不是 `quiet_whisper_v1` → “改用低音量·耳语重试”，旁边注明“实验性：更容易识别出微弱声音，也可能多出需要复核的句子。”，未安装语音检测时禁用并改为说明需先安装；失败码在 `LOCAL_SUBTITLE_CPU_RETRY_ERROR_CODES` 且后端不是 CPU → “改用 CPU 重试”。三个按钮都一键提交，请求进行中显示加载图标并禁用该行按钮。
- `TranscriptionEmptyResult` 增加可选 `help` 与子元素；经典转写页不传参数，输出与改动前相同。Studio 在有低音量建议时用自己的说明（可改用低音量·耳语重试，或检查音轨、媒体语言和模型后重新添加；相同设置重试结果通常不变），按钮行放在框内说明之下。
- 文件已移动或修改时，控制器记下该任务（`sourceChangedTaskIds`），行内显示“这个文件在转写后被移动或修改了，请重新添加文件后再转写。”；再次重试前清除，任务移除后清理。控制器 `retryTask` 把新任务并入列表；原任务用自动设备时新任务继承“为何落到 CPU”的标注。
- 错误映射：新增“识别质量”组。`transcript_quality_failed` 一律归入；`runtime_protocol_mismatch` 只在 `stage` 为 `transcribing`/`post_processing`（窗口级）时归入，其他阶段或没有阶段仍是“程序不完整，重启后重装”。识别质量组的原因写明“这是识别质量问题，不是程序损坏”，下一步建议在转写设置里换“分段方式”（高级设置中）、“音频类型”或模型后重新添加，并说明不需要重新安装。`out_of_memory` 的下一步改为换用较小的“标准”或“快速”模型，用显卡时也可以改用 CPU 重试，并加“管理资源”按钮。
- 每个失败任务都有“复制诊断信息”（原来只有未知错误码才有）：`code`、`stage`、`model`、`device`、`audioType`（标准为 `standard`）各一行，不含任务名、文件名或路径。
- 文案：四种语言新增 `retry_cpu`、`retry_quiet`、`retry_quiet_note`、`retry_quiet_needs_vad`、`retry_source_changed`、`empty_retry_help`、`task_error.quality.{cause,next}`，改写 `task_error.memory.next`；“重试”沿用已有的 `studio:retry`。
- 渲染审查修了 3 处（与重试按钮矛盾的“不能直接重试”文案、英文 1024 下过长的说明、无内容框按钮行 4px 与失败块 6px 不一致），并补看了未安装语音检测的状态，见 `T-ASRQ-08-ui.txt`。具体尺寸写入 design.md“界面设计基准”中本任务的一条。

### Agent 工具

- 外部工具 `start_studio_transcription`（`src/agent/external/tools/transcription.ts`）：所选模型是仅重识别模型，或传入了模型不支持的语言时，直接返回 `transcription_model_unsupported`，`detail` 带 `reason`（`recognize_only`/`language`）和说明，不再表现为“未就绪”；来自 Studio 设置的不适用项仍按页面方式回退。
- 内置 Agent 的 `prepare_studio_transcription`（`src/agent/modern-tools.ts`）：在改动任何设置前，对用户明确要求而模型做不到的项返回具名失败 `studio_transcription_model_{recognize_only,translate,prompt,language}`（例如 turbo + 翻译为英文、anime-whisper 整段转写）；没有明确要求、只是来自 Studio 设置的项仍静默回退。两个工具各加一条测试。

### 偏离

- 写集外：`src/subtitle-studio/transcription/task-contract.ts` 的任务摘要 `error` 增加可选 `stage`。design 要求区分“窗口级”失败并在诊断里给出“阶段”，而摘要原来只有错误码，渲染端无法得知失败阶段；只加一个可选字段，旧摘要照常解析。
- 写集外：`src/agent/**`（任务明确要求的工具说明，改动小）与 `test/integration/transcription-empty-result-ui.test.ts`（Studio 无内容说明按设计改变，该门控用例相应更新；它的经典转写页断言未改并通过）。`test/subtitle-studio/interaction-queue-ui.test.ts` 原断言“已知错误码不显示复制诊断信息”，与 AC-ASRQ-06-3 的“每种失败都能复制”冲突，已改为显示，并断言清理中的任务没有重试。
- “按原批次配置入队”只包括转写配置：自动翻译与自动导出不随重试提交。翻译需要的 API 密钥在任务结束时就从记录中清除，不为重试保留；只带导出而不带翻译会改变导出内容，所以都不带。design 方案 6 已写明。
- 文件不符的结果用返回值 `{ status: 'source_changed' }` 表达，不新增公开错误码（`ErrorCode` 集合没有“需重新添加”）；design 方案 6 已写明。
- 没有批量重试入口；每次重试只有一个文件，单批文件上限自然满足。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-08-1 | 通过 | file:records/T-ASRQ-08-unit.txt |
| V-ASRQ-08-2 | 通过 | file:records/T-ASRQ-08-errors.txt |
| V-ASRQ-08-3 | 通过 | file:records/T-ASRQ-08-ui.txt |
| V-ASRQ-08-4 | 通过 | file:records/T-ASRQ-08-integration.txt |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-06-1 | 通过 | V-ASRQ-08-1, V-ASRQ-08-3, V-ASRQ-08-4 |
| AC-ASRQ-06-2 | 通过 | V-ASRQ-08-1, V-ASRQ-08-2, V-ASRQ-08-3 |
| AC-ASRQ-06-3 | 通过 | V-ASRQ-08-2, V-ASRQ-08-3 |

## 风险与未执行项

- 2026-10-22 协调者修补：Home Agent 为四个模型不匹配错误码映射专门文案，见 records/polish.md。
- `runtime.tasks.retry` 的生产组合（探测新授权、失败时撤销、共享资源预留）只经过类型检查与代码审查：界面测试用受控运行时替换了 `runtime.ts`，任务服务测试直接调用 `prepareRetry` 与 `enqueue`。没有用真实模型、真实媒体探测或 GPU 做一次端到端重试；首次真实使用时建议对一个无内容任务点一次“改用低音量·耳语重试”确认。
- “改用 CPU 重试”按任务要求用 `LOCAL_SUBTITLE_CPU_RETRY_ERROR_CODES`，其中 `runtime_missing`、`transcription_failed` 等并非一定与显卡有关；对这些失败 CPU 重试不一定有帮助。
- 低音量·耳语预设仍是实验性（T-ASRQ-09：B-noise 在该预设下也出字），建议按钮旁已注明，结果需要复核。
- 资源下载/导入失败的“复制诊断信息”仍只在未知错误码时出现（AC 针对任务失败）。
- 既有 UI 用例 `acceptance-queue-overview-ui`（翻译概览 Tooltip 同时匹配两个）与 `interaction-queue-ui`（停止按钮 Tooltip 仍显示“查看字幕”）在 HEAD 基线上以相同消息失败，与本任务无关；后者中本任务修改的断言位于失败点之前且通过。
- 整体回归（212 个文件）全部通过；门控的 UI 用例只运行了与转写队列相关的 5 个（本任务新增 1 个、既有 4 个），没有运行全部门控用例。既有的 `reclaims clean released-owner task history…`（15 s 上限，单独约 14 s）在与整体回归同时运行时超时一次（15.3 s），单独与整体回归中都通过，属于负载下的计时问题。
- `test-results/asrq08-head-baseline`（HEAD 导出副本与其构建，本任务创建）验证完后已删除；`test-results/studio-t06-ui/controlled-*` 中保留截图与 `asrq08-result.json`。
