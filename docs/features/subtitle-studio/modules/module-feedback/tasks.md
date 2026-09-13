# I7 任务

按用户本次明确实现授权并行，先冻结共享API，最后串行实际Electron验证。

### T-FEEDBACK-01 共享完成反馈

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I7 |
| 需求 | R-FEEDBACK-01 |
| 验收 | AC-FEEDBACK-01-1, AC-FEEDBACK-01-2, AC-FEEDBACK-01-3 |
| 依赖 | - |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioOperationResult.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioOperationResult.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.css, scripts/subtitle-studio/boundaries.json, .agents/skills/fusionkit-pitfall-guard/references/retain-dialog-result-content-through-exit.md, .agents/skills/fusionkit-pitfall-guard/references/index.md, src/locales/ |
| 负责人 | Codex root |
| 依赖确认 | 8589872已提交，共享工作树基线可用，接口在design冻结 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-feedback-01.md |
| 集成版本 | feat/subtitle-studio-transcription，8589872a54d012199a3ebebc30aae2d9f3184f98加I7未提交工作树；精确文件与证据见2026-09-13-feedback.snapshot.json |

#### 实现要点

按design分工实施，组件和消费者可按冻结props并行；验证时使用全部集成代码，不把旧截图当作新证据。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-FEEDBACK-01-1 | integration | required | 实际Electron覆盖本任务入口及结果/取消/失败/请求语义，复验受影响业务保护 | - |
| V-FEEDBACK-01-2 | browser | required | 1280浅色与786窄深色，长名称、默认折叠、键盘、滚动与截图审阅修复 | - |
| V-FEEDBACK-01-3 | static | required | TS、i18n、构建与diff、spec检查通过 | - |

### T-FEEDBACK-02 导出结果接入

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I7 |
| 需求 | R-FEEDBACK-01 |
| 验收 | AC-FEEDBACK-01-1, AC-FEEDBACK-01-2, AC-FEEDBACK-01-3 |
| 依赖 | - |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioExport.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioExport.css, test/subtitle-studio/export-ui.test.ts, test/subtitle-studio/experience-export-ui.test.ts, test/subtitle-studio/acceptance-files-ui.test.ts, test/subtitle-studio/acceptance-live-refresh-ui.test.ts |
| 负责人 | admission_design |
| 依赖确认 | 8589872已提交，共享工作树基线可用，接口在design冻结 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-feedback-02.md |
| 集成版本 | feat/subtitle-studio-transcription，8589872a54d012199a3ebebc30aae2d9f3184f98加I7未提交工作树；精确文件与证据见2026-09-13-feedback.snapshot.json |

#### 实现要点

按design分工实施，组件和消费者可按冻结props并行；验证时使用全部集成代码，不把旧截图当作新证据。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-FEEDBACK-02-1 | integration | required | 实际Electron覆盖本任务入口及结果/取消/失败/请求语义，复验受影响业务保护 | - |
| V-FEEDBACK-02-2 | browser | required | 1280浅色与786窄深色，长名称、默认折叠、键盘、滚动与截图审阅修复 | - |
| V-FEEDBACK-02-3 | static | required | TS、i18n、构建与diff、spec检查通过 | - |

### T-FEEDBACK-03 导入管理和翻译接入

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I7 |
| 需求 | R-FEEDBACK-01 |
| 验收 | AC-FEEDBACK-01-1, AC-FEEDBACK-01-2, AC-FEEDBACK-01-3 |
| 依赖 | - |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.tsx |
| 负责人 | ipc_design |
| 依赖确认 | 8589872已提交，共享工作树基线可用，接口在design冻结 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-feedback-03.md |
| 集成版本 | feat/subtitle-studio-transcription，8589872a54d012199a3ebebc30aae2d9f3184f98加I7未提交工作树；精确文件与证据见2026-09-13-feedback.snapshot.json |

#### 实现要点

按design分工实施，组件和消费者可按冻结props并行；验证时使用全部集成代码，不把旧截图当作新证据。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-FEEDBACK-03-1 | integration | required | 实际Electron覆盖本任务入口及结果/取消/失败/请求语义，复验受影响业务保护 | - |
| V-FEEDBACK-03-2 | browser | required | 1280浅色与786窄深色，长名称、默认折叠、键盘、滚动与截图审阅修复 | - |
| V-FEEDBACK-03-3 | static | required | TS、i18n、构建与diff、spec检查通过 | - |

### T-FEEDBACK-04 集成与视觉复验

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I7 |
| 需求 | R-FEEDBACK-01 |
| 验收 | AC-FEEDBACK-01-1, AC-FEEDBACK-01-2, AC-FEEDBACK-01-3 |
| 依赖 | - |
| 写集 | test/subtitle-studio/result-feedback-ui.test.ts, test/subtitle-studio/interaction-export-ui.test.ts, test/subtitle-studio/interaction-copy-ui.test.ts, test/subtitle-studio/library-ui.test.ts |
| 负责人 | windows_baseline |
| 依赖确认 | 8589872已提交，共享工作树基线可用，接口在design冻结 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-feedback-04.md |
| 集成版本 | feat/subtitle-studio-transcription，8589872a54d012199a3ebebc30aae2d9f3184f98加I7未提交工作树；精确文件与证据见2026-09-13-feedback.snapshot.json |

#### 实现要点

按design分工实施，组件和消费者可按冻结props并行；验证时使用全部集成代码，不把旧截图当作新证据。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-FEEDBACK-04-1 | integration | required | 实际Electron覆盖本任务入口及结果/取消/失败/请求语义，复验受影响业务保护 | - |
| V-FEEDBACK-04-2 | browser | required | 1280浅色与786窄深色，长名称、默认折叠、键盘、滚动与截图审阅修复 | - |
| V-FEEDBACK-04-3 | static | required | TS、i18n、构建与diff、spec检查通过 | - |
