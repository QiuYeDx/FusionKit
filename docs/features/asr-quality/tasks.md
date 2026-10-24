# 转写质量与复杂音频支持 任务

每个任务块是唯一任务台账。共同的验证约定：vitest 使用 `npx vitest run --maxWorkers=4 --minWorkers=1 <路径>`；Electron UI 测试与截图在静默离屏模式（默认）运行；受审计文件保持 LF；提交只包含本任务文件。

### T-ASRQ-01 真实音频对照工具

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-ASRQ-07 |
| 验收 | AC-ASRQ-07-1 |
| 依赖 | - |
| 写集 | test/asr-quality/ |
| 负责人 | Agent（工作流 wf_ebed0106-f61） |
| 依赖确认 | - |
| 完成日期 | 2026-10-22 |
| 实施记录 | records/T-ASRQ-01.md |
| 集成版本 | 工作树（基于 68ffd05，未提交） |

#### 实现要点

按 design 方案 7 实现受 `FUSIONKIT_ASR_AB=1` 门控的对照用例与报告生成；复用 `test/subtitle-studio-provenance/real-default-*` 的资源与样本固定逻辑（只读引用或复制必要辅助到本目录，不改动原文件）。变体通过任务配置的 `advanced.audioProfile` 传入；在 T-ASRQ-02 完成前只能运行 standard，其余变体以“未实现”记录而非失败。每个样本 × 变体使用新的服务进程；CUDA 包与模型从已安装位置只读获取，找不到时明确报错。差异报告按时间重叠对齐字幕，列出新增、消失与文本变化。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-01-1 | unit | required | 报告生成与时间对齐差异的纯函数单元测试：`npx vitest run --maxWorkers=4 --minWorkers=1 test/asr-quality` | - |
| V-ASRQ-01-2 | integration | required | `FUSIONKIT_ASR_AB=1` 下以 standard 变体跑 A、B-noise 两段样本，产出 SRT/JSON/summary.md 且进程与临时文件被清理 | - |
| V-ASRQ-01-3 | static | required | 未设置环境变量时该用例被跳过，普通 `vitest run` 不受影响 | - |

### T-ASRQ-02 音频类型预设与请求参数

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-ASRQ-01 |
| 验收 | AC-ASRQ-01-1, AC-ASRQ-01-2, AC-ASRQ-01-3, AC-ASRQ-01-4, AC-ASRQ-01-5 |
| 依赖 | - |
| 写集 | src/subtitle-studio/transcription-audio-profiles.ts, src/subtitle-studio/transcription/task-contract.ts, src/subtitle-studio/transcription/preferences-contract.ts, src/services/subtitle-studio/transcription-controller.ts, src/pages/Tools/Subtitle/SubtitleStudio/, electron/main/subtitle-studio/transcription/native/server-contract.ts, electron/main/subtitle-studio/transcription/native/server-supervisor.ts, electron/main/subtitle-studio/transcription/task-service.ts, electron/main/subtitle-studio/transcription/transcript-executor.ts, scripts/subtitle-studio-provenance/current-copy-audits.mjs, scripts/subtitle-studio-provenance/current-copy-audits.json, src/locales/, test/subtitle-studio/ |
| 负责人 | Agent（工作流 wf_ebed0106-f61） |
| 依赖确认 | - |
| 完成日期 | 2026-10-22 |
| 实施记录 | records/T-ASRQ-02.md |
| 集成版本 | 工作树（基于 68ffd05，未提交） |

#### 实现要点

按 design 方案 1 与参数表实现；请求字段只在 VAD 开启的识别请求上追加；默认快照不含 `audioProfile` 时请求逐字段不变。`server-contract.ts` 加入审计所有者并登记。界面按“界面设计基准·音频类型”实现，写代码前在 design 该节补充本任务的参照测量。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-02-1 | unit | required | 请求字段单元测试：默认快照字段与改动前快照逐项相等；两个预设的字段与取值；VAD 关闭时拒绝 vad_* 字段；越界值被拒绝 | - |
| V-ASRQ-02-2 | static | required | `node scripts/subtitle-studio-provenance/copy.mjs --check`、`node scripts/subtitle-studio-provenance/transcript-executor-copy.mjs --check`、`npx tsc --noEmit -p tsconfig.json` | - |
| V-ASRQ-02-3 | integration | required | `npx vitest run --maxWorkers=4 --minWorkers=1 test/subtitle-studio-provenance test/subtitle-studio/transcription test/subtitle-studio/transcription-preferences.test.ts` 全部通过（偏好键断言按新字段更新） | - |
| V-ASRQ-02-4 | browser | required | Electron 中打开 Studio 转写面板（1280×800 与 1024×700，浅/深色）：音频类型选项与说明、选择后自动开启 VAD、关闭 VAD 回到标准并显示说明、重开后保留、任务行标签；截图审阅后修复并复验 | - |
| V-ASRQ-02-5 | static | required | `node scripts/check-i18n.mjs` 通过；`node scripts/check-i18n-usage.mjs` 与 HEAD 导出副本的结果逐条比对无新增错误（HEAD 已有 40 条与本功能无关的错误） | - |

### T-ASRQ-03 门控动态增益

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-ASRQ-01, R-ASRQ-02 |
| 验收 | AC-ASRQ-01-2, AC-ASRQ-02-1, AC-ASRQ-02-2, AC-ASRQ-02-3, AC-ASRQ-02-4 |
| 依赖 | T-ASRQ-02 |
| 写集 | electron/main/subtitle-studio/transcription/native/quiet-audio.ts, electron/main/subtitle-studio/transcription/native/pcm-window.ts, electron/main/subtitle-studio/transcription/native/media-normalizer.ts, electron/main/subtitle-studio/transcription/transcript-executor.ts, scripts/subtitle-studio-provenance/current-copy-audits.mjs, scripts/subtitle-studio-provenance/current-copy-audits.json, test/subtitle-studio/transcription/ |
| 负责人 | Agent（工作流 wf_ebed0106-f61） |
| 依赖确认 | T-ASRQ-02 已完成（同一工作树） |
| 完成日期 | 2026-10-22 |
| 实施记录 | records/T-ASRQ-03.md |
| 集成版本 | 工作树（基于 68ffd05，未提交） |

#### 实现要点

按 design 方案 2 的算法实现 `conditionWhisperPcm16` 与 `quietAudioMode` 选项；执行器仅在 quiet_whisper_v1 时传入；回退原音逻辑不变。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-03-1 | unit | required | 合成信号单元测试：采样数不变、峰值 ≤ -1 dBFS、远离语音的噪底帧提升 ≤ 6 dB、-65 dBFS 活动语音被提升、含强瞬态的安静窗被提升、静音/满幅/极短输入原样返回 | - |
| V-ASRQ-03-2 | unit | required | 执行器测试：quiet_whisper_v1 窗口使用门控增益且增益窗带 1000 ms 填充；结果过长/重复时回退原音一次；标准预设窗口字节哈希与改动前一致 | - |
| V-ASRQ-03-3 | integration | required | 同 V-ASRQ-02-2 与 V-ASRQ-02-3 的 provenance、类型与转写测试全部通过 | - |

### T-ASRQ-04 逐句置信度

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-ASRQ-03 |
| 验收 | AC-ASRQ-03-1 |
| 依赖 | T-ASRQ-03 |
| 写集 | electron/main/subtitle-studio/transcription/native/subtitle-post-processor.ts, electron/main/subtitle-studio/transcription/native/overlap-group-splice.ts, scripts/subtitle-studio-provenance/current-copy-audits.mjs, scripts/subtitle-studio-provenance/current-copy-audits.json, test/subtitle-studio-provenance/, test/subtitle-studio/transcription/ |
| 负责人 | Agent（工作流 wf_ebed0106-f61） |
| 依赖确认 | T-ASRQ-03 已完成（同一工作树） |
| 完成日期 | 2026-10-22 |
| 实施记录 | records/T-ASRQ-04.md |
| 集成版本 | 工作树（基于 68ffd05，未提交） |

#### 实现要点

按 design 方案 3 的公式在工作段上携带置信度并输出到 `segments[].confidence`；回放测试中把 `confidence` 作为审阅过的差异剥离比较，并另行断言其存在与范围；文档写入与旧文档读取保持兼容。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-04-1 | unit | required | 后处理单元测试：单段、跨窗合并、裁剪、去重后的置信度加权与取值范围；无段时不报错 | - |
| V-ASRQ-04-2 | integration | required | provenance 全量、转写测试与文档生成测试通过；旧文档（无 confidence）可读取 | - |

### T-ASRQ-05 质量复核与复核栏

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-ASRQ-03 |
| 验收 | AC-ASRQ-03-2, AC-ASRQ-03-3, AC-ASRQ-03-4, AC-ASRQ-03-5 |
| 依赖 | T-ASRQ-04 |
| 写集 | src/subtitle-studio/transcription-review.ts, src/subtitle-studio/, electron/main/subtitle-studio/, electron/preload/, src/services/subtitle-studio/, src/pages/Tools/Subtitle/SubtitleStudio/, src/locales/, test/subtitle-studio/ |
| 负责人 | Agent（工作流 wf_60854ff0-d0b） |
| 依赖确认 | T-ASRQ-04 已完成（同一工作树） |
| 完成日期 | 2026-10-22 |
| 实施记录 | records/T-ASRQ-05.md |
| 集成版本 | 工作树（基于 68ffd05，未提交） |

#### 实现要点

规则模块按 design 方案 3 的规则表实现并带样例测试；全文档计算与跳转参照 cue-find 的服务与通道；复核栏、徽标与快速操作按“界面设计基准·复核栏”，写代码前在 design 补充本任务的参照测量。修改组合文件时重新登记审计。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-05-1 | unit | required | 规则模块单元测试覆盖 AC-ASRQ-03-2 的全部样例与编辑后、已忽略、旧文档等边界 | - |
| V-ASRQ-05-2 | interface | required | 主进程查询与跳转的接口测试：分页文档上的计数、顺序与上一个/下一个 | - |
| V-ASRQ-05-3 | browser | required | Electron 中打开真实转写文档：复核栏计数、原因筛选、跳转播放、忽略后重开仍隐藏、折叠重复后撤销；无标记/大量标记/旧文档三种状态；1280×800 与 1024×700，浅/深色；截图审阅后修复并复验 | - |
| V-ASRQ-05-4 | static | required | `npx tsc --noEmit -p tsconfig.json`、i18n 检查、`npx vitest run --maxWorkers=4 --minWorkers=1 src/pages/Tools/Subtitle/SubtitleStudio test/subtitle-studio` | - |

### T-ASRQ-06 新模型与模型配置

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-ASRQ-04 |
| 验收 | AC-ASRQ-04-1, AC-ASRQ-04-2, AC-ASRQ-04-3, AC-ASRQ-04-4 |
| 依赖 | T-ASRQ-02 |
| 写集 | resources/speech-resources/manifests/speech-models.v1.json, electron/main/speech-resources/, resources/speech-resources/provenance/resource-engine-extraction.v1.json, test/speech-resources/, electron/main/network/download-sources.ts, test/network/, src/subtitle-studio/transcription-model-profiles.ts, src/pages/Tools/Subtitle/SubtitleStudio/, electron/main/subtitle-studio/transcription/task-service.ts, src/locales/, test/subtitle-studio-provenance/shared-resources.test.ts |
| 负责人 | Agent（工作流 wf_ff5e05d2-77e） |
| 依赖确认 | T-ASRQ-02 已完成（同一工作树） |
| 完成日期 | 2026-10-22 |
| 实施记录 | records/T-ASRQ-06.md |
| 集成版本 | 工作树（基于 68ffd05，未提交） |

#### 实现要点

按 design 方案 4 的模型表与目录修改流程实现；实现前用 HF tree API 复核每个文件的大小与 SHA-256，并用 Range 读取前 48 字节复核 ggml 头；新增条目追加在现有条目之后，默认推荐不变。主进程在入队时按模型配置拒绝不一致请求。旧版本地转写工具共用目录时，仅重识别模型不得出现在其模型选择中。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-06-1 | unit | required | `npx vitest run --maxWorkers=4 --minWorkers=1 test/speech-resources test/network test/subtitle-studio-provenance/shared-resources.test.ts test/subtitle-studio-provenance/checkout-bytes.test.ts src/pages/Tools/Subtitle/SubtitleStudio/resource-names.test.ts` | - |
| V-ASRQ-06-2 | unit | required | 模型配置表与入队校验测试：翻译禁用、语言锁定、禁止提示词、仅重识别模型被整段转写拒绝 | - |
| V-ASRQ-06-3 | static | required | `node scripts/subtitle-studio-provenance/shared-resource-extraction.mjs`、`npx tsc --noEmit -p tsconfig.json`、i18n 检查 | - |
| V-ASRQ-06-4 | browser | required | Electron 中资源面板与模型选择：新模型名称、大小、标签、许可提示；选中后翻译/语言/提示词控件状态与原因提示；截图审阅后修复并复验 | - |

### T-ASRQ-07 重新识别增强

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-ASRQ-05 |
| 验收 | AC-ASRQ-05-1, AC-ASRQ-05-2, AC-ASRQ-05-3, AC-ASRQ-05-4 |
| 依赖 | T-ASRQ-05, T-ASRQ-06 |
| 写集 | src/subtitle-studio/cue-recognize-contract.ts, electron/main/subtitle-studio/cue-recognize-service.ts, electron/main/subtitle-studio/transcription/runtime.ts, electron/main/subtitle-studio/transcription/native/server-contract.ts, scripts/subtitle-studio-provenance/, resources/speech-resources/provenance/current-integration-audits.v1.json, src/pages/Tools/Subtitle/SubtitleStudio/, src/locales/, test/subtitle-studio/ |
| 负责人 | Agent（工作流 wf_60854ff0-d0b） |
| 依赖确认 | T-ASRQ-05, T-ASRQ-06 已完成（同一工作树） |
| 完成日期 | 2026-10-22 |
| 实施记录 | records/T-ASRQ-07.md |
| 集成版本 | 工作树（基于 68ffd05，未提交） |

#### 实现要点

按 design 方案 5 实现；`no_timestamps` 可选字段只在禁止提示词/无时间戳模型的重识别路径使用；改 `runtime.ts` 后重新登记组合审计。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-07-1 | unit | required | 重识别服务测试：所选模型生效；只取重叠段；低音量剪辑增益并开启 VAD 填充；禁止提示词模型不发提示词并带 no_timestamps；结果附置信度与复核原因 | - |
| V-ASRQ-07-2 | integration | required | provenance 全量与 `docs/features/studio-cue-recognize` 既有测试通过 | - |
| V-ASRQ-07-3 | browser | required | Electron 中重识别对话框：模型选择、结果提示、从复核栏发起多句重识别；截图审阅后修复并复验 | - |

### T-ASRQ-08 重试与建议

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-ASRQ-06 |
| 验收 | AC-ASRQ-06-1, AC-ASRQ-06-2, AC-ASRQ-06-3 |
| 依赖 | T-ASRQ-06 |
| 写集 | electron/main/subtitle-studio/transcription/task-service.ts, electron/main/subtitle-studio/transcription-ipc.ts, src/subtitle-studio/ipc-contract.ts, electron/preload/, src/services/subtitle-studio/transcription-controller.ts, src/pages/Tools/Subtitle/SubtitleStudio/, src/pages/Tools/_shared/ui/TranscriptionEmptyResult.tsx, src/locales/, test/subtitle-studio/, resources/speech-resources/provenance/current-integration-audits.v1.json, scripts/subtitle-studio-provenance/current-composition-audits.json |
| 负责人 | Agent（工作流 wf_60854ff0-d0b） |
| 依赖确认 | T-ASRQ-06 已完成（同一工作树） |
| 完成日期 | 2026-10-22 |
| 实施记录 | records/T-ASRQ-08.md |
| 集成版本 | 工作树（基于 68ffd05，未提交） |

#### 实现要点

按 design 方案 6 实现；重试必须复核源文件身份，不复用已回收的令牌；错误映射与诊断复制不泄露路径。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-08-1 | unit | required | 任务服务测试：失败/无内容任务重试生成新任务；覆盖音频类型/设备生效；源文件被修改或移动时返回需重新添加 | - |
| V-ASRQ-08-2 | unit | required | 错误映射测试：窗口级失败归入识别质量组；诊断文本不含路径 | - |
| V-ASRQ-08-3 | browser | required | Electron 中（假运行时）失败与无内容任务行的重试与建议按钮、复制诊断；截图审阅后修复并复验 | - |
| V-ASRQ-08-4 | integration | required | provenance 全量、转写任务服务与 Studio 页面测试通过 | - |

### T-ASRQ-09 真实音频对照与听审包

| 字段 | 值 |
| --- | --- |
| 状态 | 待验证 |
| 批次 | I1 |
| 需求 | R-ASRQ-07 |
| 验收 | AC-ASRQ-07-1, AC-ASRQ-07-2, AC-ASRQ-07-3 |
| 依赖 | T-ASRQ-01, T-ASRQ-02, T-ASRQ-03, T-ASRQ-04 |
| 写集 | docs/features/asr-quality/records/, test/asr-quality/ |
| 负责人 | Agent（工作流 wf_f5bfa7da-98d） |
| 依赖确认 | T-ASRQ-01, T-ASRQ-02, T-ASRQ-03, T-ASRQ-04 已完成（同一工作树） |
| 完成日期 | - |
| 实施记录 | records/T-ASRQ-09.md |
| 集成版本 | - |

#### 实现要点

在集成版本上运行一次对照（large-v3、CUDA、固定语言、三变体、固定样本），把 summary/diff/listening 的文本结论与置信度分布写入 record，据此校准 design 中的复核阈值（仅一次，写明依据；复核标记数由 T-ASRQ-05 用规则模块对本次输出统计）；B-noise 门槛不通过的预设标记为不推荐。交付听审清单后停在用户听审。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-09-1 | integration | required | `FUSIONKIT_ASR_AB=1` 跑完全部样本与三变体，报告齐全，缺失样本如实记录 | - |
| V-ASRQ-09-2 | integration | required | B-noise 在 quiet_whisper_v1 下无新增文字（或记录不通过与处理） | - |
| V-ASRQ-09-3 | manual | required | 用户按 listening.md 听审并给出结论（由用户填写，Agent 不代签） | - |

### T-ASRQ-10 新模型真实冒烟

| 字段 | 值 |
| --- | --- |
| 状态 | 待验证 |
| 批次 | I1 |
| 需求 | R-ASRQ-04 |
| 验收 | AC-ASRQ-04-5 |
| 依赖 | T-ASRQ-06, T-ASRQ-07 |
| 写集 | docs/features/asr-quality/records/, test/asr-quality/ |
| 负责人 | Agent（工作流 wf_60854ff0-d0b） |
| 依赖确认 | T-ASRQ-06, T-ASRQ-07 已完成（同一工作树） |
| 完成日期 | - |
| 实施记录 | records/T-ASRQ-10.md |
| 集成版本 | - |

#### 实现要点

需要 Q-01 下载许可。下载到非 C 盘的独立目录（只用于验证），用对照工具：turbo 与 Belle 在 A/B/C 与中文 PV 上整段转写；anime-whisper 在 A/B/C 的字幕上做重新识别（有无 no_timestamps 各一次），记录能否加载、开头怪字是否出现、时间戳与文本是否可用。结论决定 anime-whisper 是否保持“仅重识别”。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-10-1 | integration | required | 三款模型各完成一次加载与识别并记录输出摘要 | - |
| V-ASRQ-10-2 | manual | required | 用户对 anime-whisper 重识别结果的听审结论 | - |

### T-ASRQ-11 窗口接缝去重

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-ASRQ-14 |
| 验收 | AC-ASRQ-14-1, AC-ASRQ-14-2, AC-ASRQ-14-3 |
| 依赖 | - |
| 写集 | electron/main/subtitle-studio/transcription/native/subtitle-post-processor.ts, electron/main/subtitle-studio/transcription/transcript-executor.ts, scripts/subtitle-studio-provenance/current-copy-audits.json, scripts/subtitle-studio-provenance/current-copy-audits.mjs, test/subtitle-studio/transcription/, test/subtitle-studio-provenance/, test/asr-quality/, docs/features/asr-quality/records/ |
| 负责人 | Agent（工作流 wf_3dc42c4d-9bb、wf_70f07a30-8c6、wf_af8ca977-dc4） |
| 依赖确认 | 无依赖 |
| 完成日期 | 2026-10-24 |
| 实施记录 | records/T-ASRQ-11.md |
| 集成版本 | 工作树（基于 748285ec，未提交） |

#### 实现要点

按 design 方案 8 实现接缝去重：后处理在跨窗合并之后检测，候选只来自被裁到接缝时刻的句子，只与接缝另一侧原始时间重叠的句子比较，在拼接文字中找最接近的一段连续文字，按编辑覆盖率（≥ 80%）判断是否重合；先判下一窗口的候选，去掉的句子不再拿来比较。2026-10-24 按重跑结果补两条：候选远端（离开接缝的一端）有达到字数下限的字在另一侧没有对应时保留候选（去重不丢字）；去掉一份拷贝后，被裁到同一接缝的保留句把被裁的一端往原始时间移回，不越过去掉那份的远端与最近一句仍在的字幕，不超过最长字幕时长。Studio 执行器在 CUDA 修复之后去掉重复并移回这一端，去掉的句子与移回的一端只写进诊断（不含文字，不进文档）；T02 执行器不去重。更新审计条目；旧版对拍回放若因此变化，作为审阅过的差异处理并说明。随后用对照工具按 run-2512BY 的配置重跑 9 段样本 × 3 种音频类型（设置 FUSIONKIT_KEEP_TEST_RUNS=1），逐条对比修复前后。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-11-1 | unit | required | 后处理单元测试：下一窗口被裁到接缝的重复句被去掉；上一窗口被裁到接缝的重复句被去掉；文字覆盖不足 80% 的保留；候选远端有达到字数下限（2 个 CJK 字或 4 个拉丁字符）的字另一侧没有时保留，另一侧被它覆盖的截断片段随后被去掉，远端多出的字不到下限、只在接缝一侧多出或远端只是与另一侧的字不同时仍去掉；「うん」「うん」合法重复与非接缝处相同句保留；保留一侧的文字一律不变，时间只有被裁到同一接缝的那一端按方案 8 往原始时间移回（不越过去掉那份的远端与最近一句仍在的字幕，不超过最长字幕时长；保留句被改过或没被裁时不动） | - |
| V-ASRQ-11-2 | integration | required | provenance 全量、转写与文档测试通过，审计条目更新；回放差异逐条说明 | - |
| V-ASRQ-11-3 | integration | required | 9 段样本 × 3 种音频类型重跑，与 run-2512BY 逐条对比：列出被去掉的句子，其余字幕文字与时间不变或差异逐条说明 | - |

### T-ASRQ-12 复核规则识别近似重复

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-ASRQ-14 |
| 验收 | AC-ASRQ-14-4 |
| 依赖 | - |
| 写集 | src/subtitle-studio/transcription-review.ts, test/subtitle-studio/transcription-review.test.ts, src/locales/en/studio.json, src/locales/ja/studio.json, src/locales/zh/studio.json, src/locales/zh-Hant/studio.json, docs/features/asr-quality/records/ |
| 负责人 | Agent（工作流 wf_3dc42c4d-9bb、wf_70f07a30-8c6、wf_af8ca977-dc4） |
| 依赖确认 | 无依赖 |
| 完成日期 | 2026-10-24 |
| 实施记录 | records/T-ASRQ-12.md |
| 集成版本 | 工作树（基于 748285ec，未提交） |

#### 实现要点

按 design 复核规则表扩展 `duplicate_neighbor`：包含关系（较短 ≥ 5 字）与编辑距离相似度（两句 ≥ 6 字、≥ 0.8），间隔条件不变；规则模块保持纯函数。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-12-1 | unit | required | 规则测试：包含上一句、只差一两个字的相邻句被标记；「うん」「はい」与不相邻、间隔 ≥ 1 s 的句子不被标记；既有用例全部通过 | - |
| V-ASRQ-12-2 | static | required | 在 run-2512BY 与修复后的重跑输出上统计各变体的“与上一句重复”标记数，并抽查被标出的句子 | - |

### T-ASRQ-13 去重前后听审对比

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-ASRQ-14 |
| 验收 | AC-ASRQ-14-5 |
| 依赖 | T-ASRQ-11, T-ASRQ-12 |
| 写集 | test-results/asr-quality-listening/, docs/features/asr-quality/records/ |
| 负责人 | Agent（工作流 wf_3dc42c4d-9bb、wf_70f07a30-8c6、wf_af8ca977-dc4） |
| 依赖确认 | T-ASRQ-11, T-ASRQ-12 已完成（同一工作树） |
| 完成日期 | 2026-10-24 |
| 实施记录 | records/T-ASRQ-13.md |
| 集成版本 | 工作树（基于 748285ec，未提交；页面只存本机） |

#### 实现要点

在本地听审页面新增“接缝去重对比”：每一处被去掉的句子给出原声剪辑（含前后文）、修复前后的字幕对照与“去得对 / 不该去”选择，并纳入导出；页面与剪辑只放在被忽略的 test-results 中，不提交。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ASRQ-13-1 | integration | required | 页面在本地服务下加载全部新剪辑、对比条目与导出字段正确（隐藏窗口自检与截图审阅） | - |
| V-ASRQ-13-2 | manual | required | 用户逐处听审去重结果并导出结论（由用户完成，Agent 不代签） | - |
