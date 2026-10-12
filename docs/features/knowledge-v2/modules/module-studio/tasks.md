# studio 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。
元数据引用需求与 AC；不要复制 AC 文本。I2 的任务在 I2 开始前细化。

命令约定同 [module-data/tasks.md](../module-data/tasks.md)。

### T-STUDIO-01 工作台契约与主进程：翻译、试译、批量、执行记录

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-STUDIO-01 |
| 验收 | AC-STUDIO-01-1, AC-STUDIO-01-2, AC-STUDIO-01-6, AC-STUDIO-01-7 |
| 依赖 | T-DATA-05 |
| 写集 | src/subtitle-studio/knowledge-translation-contract.ts, src/subtitle-studio/knowledge-batch-contract.ts, src/subtitle-studio/knowledge-trial-contract.ts, src/subtitle-studio/cue-revision-contract.ts, src/subtitle-studio/execution-record-contract.ts, src/subtitle-studio/execution-view-contract.ts, electron/main/subtitle-studio/knowledge-translation.ts, electron/main/subtitle-studio/knowledge-batch-translation.ts, electron/main/subtitle-studio/knowledge-trial.ts, electron/main/subtitle-studio/knowledge-planner.ts, electron/main/subtitle-studio/execution-records.ts, electron/main/subtitle-studio/execution-view.ts, electron/main/subtitle-studio/translation-service.ts, electron/main/subtitle-studio/cue-revision-service.ts, electron/main/subtitle-studio/document-repository.ts, electron/main/subtitle-studio/index.ts, test/subtitle-studio/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-DATA-05：同一工作树 473d58e+I1，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i1/T-STUDIO-01.md |
| 集成版本 | 473d58e + 未提交工作树（I1） |

#### 实现要点

按 [设计 §1](design.md) 实施：选择结构、knowledge-translation / batch / trial / planner、执行记录与视图、AI 修订、删除闸门与引用扫描。同步重写受影响的测试。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-STUDIO-01-1 | integration | required | VT 受影响的 test/subtitle-studio 资料翻译 / 批量 / 试译 / 执行记录 / AI 修订 / 文档仓库测试 --maxWorkers=2 --minWorkers=1（实际文件清单在 record 中列出） | - |
| V-STUDIO-01-2 | static | required | TSC-I1 | - |

### T-STUDIO-02 工作台契约与主进程：自动翻译、偏好、一致性检查

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-STUDIO-01 |
| 验收 | AC-STUDIO-01-3, AC-STUDIO-01-4, AC-STUDIO-01-5 |
| 依赖 | T-STUDIO-01 |
| 写集 | src/subtitle-studio/automatic-translation-contract.ts, src/subtitle-studio/automatic-knowledge-report-contract.ts, src/subtitle-studio/persistence-contract.ts, src/subtitle-studio/consistency-contract.ts, src/subtitle-studio/transcription/preferences-contract.ts, electron/main/subtitle-studio/automatic-knowledge.ts, electron/main/subtitle-studio/automatic-knowledge-report.ts, electron/main/subtitle-studio/translation-service.ts, electron/main/subtitle-studio/consistency-service.ts, test/subtitle-studio/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-STUDIO-01：同一工作树 473d58e+I1，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i1/T-STUDIO-02.md |
| 集成版本 | 473d58e + 未提交工作树（I1） |

#### 实现要点

按 [设计 §1](design.md) 实施：自动翻译冻结与报告、偏好结构、一致性检查。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-STUDIO-02-1 | integration | required | VT 受影响的 test/subtitle-studio 自动翻译 / 转写偏好 / 一致性检查测试 --maxWorkers=2 --minWorkers=1（实际文件清单在 record 中列出） | - |
| V-STUDIO-02-2 | static | required | TSC-I1 | - |

### T-STUDIO-03 渲染层服务与偏好：新选择结构与最近使用

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-STUDIO-02 |
| 验收 | AC-STUDIO-02-5 |
| 依赖 | T-STUDIO-02 |
| 写集 | src/services/subtitle-studio/translation-draft.ts, src/services/subtitle-studio/translation-session.ts, src/services/subtitle-studio/translation-session.test.ts, src/services/subtitle-studio/transcription-controller.ts, src/store/tools/subtitle-studio/preferences.ts, test/subtitle-studio/transcription-controller.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-STUDIO-02：同一工作树，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i2/T-STUDIO-03.md |
| 集成版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

#### 实现要点

按 [设计 §2](design.md)：草稿与会话改用新选择结构；`hasMaterials` 只看资料集；转写控制器的资料检查只校验资料集存在、未归档、方向一致；偏好新增 `recentKnowledgeSets`（最多 5 组，按使用时间排序并去重）。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-STUDIO-03-1 | unit | required | VT src/services/subtitle-studio/translation-session.test.ts test/subtitle-studio/transcription-controller.test.ts（含最近使用的记录与去重用例） | - |

### T-STUDIO-04 资料选择器、预设与自动翻译设置

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-STUDIO-02, R-STUDIO-03 |
| 验收 | AC-STUDIO-02-1, AC-STUDIO-02-2, AC-STUDIO-02-3, AC-STUDIO-02-4, AC-STUDIO-02-6, AC-STUDIO-03-2 |
| 依赖 | T-STUDIO-03 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioMaterialsFields.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioMaterialsFields.css, src/pages/Tools/Subtitle/SubtitleStudio/studio.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslationSettings.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioAutomaticKnowledge.tsx, src/locales/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-STUDIO-03：同一工作树，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i2/T-STUDIO-04.md |
| 集成版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

#### 实现要点

按 [设计 §2 与设计基准](design.md) 实现：
- 选择器面板自上而下：预设行（下拉、存为预设、管理菜单）、最近使用、搜索、资料集复选（方向不一致的置灰）、底部「管理资料 / 完成」。
- 预设的重命名和删除在选择器内联完成（输入框 / 确认行），不另开对话框；实际未建 StudioPresetDialog.tsx。
- 应用预设时，如有资料集已不存在，给出提示。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-STUDIO-04-1 | browser | required | 改写 test/translation-knowledge/materials-layout-electron.test.ts（静默窗口）。覆盖：勾选资料集；存为预设；应用、重命名、删除预设；引用已删除资料集时的提示；空库入口；自动翻译设置写入偏好 | - |
| V-STUDIO-04-2 | manual | required | 截图审查选择器，组合：中 / 英、亮 / 暗、1280×800 与 900×700。样本含长资料集名、方向不一致的资料集、6 个最近使用。按 frontend-quality 的顺序（方向→结构→细节→交互→适配）记录并复验 | - |

### T-STUDIO-05 试译、执行记录、失败报告与问题文案

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-STUDIO-03, R-STUDIO-05 |
| 验收 | AC-STUDIO-03-1, AC-STUDIO-03-3, AC-STUDIO-05-1, AC-STUDIO-05-2 |
| 依赖 | T-STUDIO-04 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioKnowledgeTrial.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioExecutionKnowledge.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioExecutionRecord.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioAutomaticKnowledgeFailure.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioKnowledgeBatch.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslationReview.tsx, src/pages/Tools/Subtitle/SubtitleStudio/knowledge-hints.ts, src/pages/Tools/Subtitle/SubtitleStudio/knowledge-hints.test.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioConsistencyCheck.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.tsx, src/pages/Tools/Subtitle/SubtitleStudio/agent-context.ts, src/locales/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-STUDIO-04：同一工作树，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i2/T-STUDIO-05.md |
| 集成版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

#### 实现要点

- 试译面板：删除角色与条件确认，只保留参与的资料与问题。
- 执行记录与失败报告：去掉方案、主题、条件，改为显示资料集与条目摘要。
- 问题码文案：只保留新码；遇到未知码时用通用文案。
- knowledge-hints：按 enabled 过滤。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-STUDIO-05-1 | unit | required | VT src/pages/Tools/Subtitle/SubtitleStudio/knowledge-hints.test.ts src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts | - |
| V-STUDIO-05-2 | browser | required | 改写 test/translation-knowledge/trial-electron.test.ts、formal-electron.test.ts、automatic-electron.test.ts、batch-electron.test.ts（静默窗口）。断言：面板中没有角色和条件控件；记录详情显示资料集与条目；失败报告可以重新检查 | - |
| V-STUDIO-05-3 | manual | required | 截图审查试译面板、执行记录详情、自动翻译失败面板，组合为中文亮色 1280×800 与英文暗色；记录观察并复验 | - |

### T-STUDIO-06 记入资料确认即生效

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-STUDIO-04 |
| 验收 | AC-STUDIO-04-1, AC-STUDIO-04-2, AC-STUDIO-04-3 |
| 依赖 | T-STUDIO-03 |
| 写集 | src/pages/TranslationKnowledge/QuickTermDialog.tsx, src/pages/TranslationKnowledge/KnowledgeCaptureDialog.tsx, src/pages/TranslationKnowledge/CaptureDestinationFields.tsx, src/pages/TranslationKnowledge/capture.ts, scripts/subtitle-studio/boundaries.json, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, test/translation-knowledge/capture.test.ts, test/subtitle-studio/consistency-ui.test.ts, test/subtitle-studio/cue-revision-knowledge-ui.test.ts, src/locales/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-STUDIO-03：同一工作树，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i2/T-STUDIO-06.md |
| 集成版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

#### 实现要点

- QuickTermDialog：去掉来源实体和 adopt；新建资料集时选择方向，默认取文档方向。
- KnowledgeCaptureDialog：去掉采纳开关。
- capture.ts：改走新的提案接口。
- 重试时以相同 id 重建，视为已保存。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-STUDIO-06-1 | unit | required | VT test/translation-knowledge/capture.test.ts | - |
| V-STUDIO-06-2 | browser | required | 改写 test/subtitle-studio/consistency-ui.test.ts 与 cue-revision-knowledge-ui.test.ts（静默窗口）。断言：记住译法、修订后记入、保留写法之后，资料库中的条目已启用且 origin 正确；对话框中没有采纳开关 | - |
| V-STUDIO-06-3 | manual | required | 截图审查「记住译法」与「记入翻译资料」对话框（中 / 英），包含新建资料集时选择方向的状态 | - |
