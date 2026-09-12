# I6 交互优化任务

I5完整未提交工作树为起点，记录十项后连续实施，写集由root协调。不提交、不打包。

### T-INTERACTION-01 队列密度与进度反馈

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I6 |
| 需求 | R-INTERACTION-01, R-INTERACTION-02 |
| 验收 | AC-INTERACTION-01-1, AC-INTERACTION-01-2, AC-INTERACTION-02-1, AC-INTERACTION-02-2 |
| 依赖 | - |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioTranscription.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranscription.css, test/subtitle-studio/interaction-queue-ui.test.ts |
| 负责人 | admission_design |
| 依赖确认 | 已核对I5快照65文件字节一致；共享组件接口由root统一交付 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-interaction-01.md |
| 集成版本 | feat/subtitle-studio-transcription，3855c2c72bfa45740f248406f7266cf0342ae1f6加I5及I6未提交工作树；精确源码和证据见2026-09-13-interaction.snapshot.json |

#### 实现要点

按design前端基准及单写权完成，实际Electron审阅并修复复验，不删既有保护迎合界面。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-INTERACTION-01-1 | integration | required | 本任务语义及必要反例：实际剪贴板/导出字节或局部选择竞态/队列能力，复验受影响既有路径 | - |
| V-INTERACTION-01-2 | browser | required | 最终Electron宽浅与786×540窄深，hover/focus/长名/失败/步骤，人工审阅截图及相关几何或MutationObserver | - |
| V-INTERACTION-01-3 | static | required | 两套生产和验收测试TS、四语、边界、构建/preload、spec/diff与最终源码证据 | - |

### T-INTERACTION-02 复制菜单与结果反馈

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I6 |
| 需求 | R-INTERACTION-03, R-INTERACTION-06 |
| 验收 | AC-INTERACTION-03-1, AC-INTERACTION-03-2, AC-INTERACTION-06-1, AC-INTERACTION-06-2 |
| 依赖 | - |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioCueCopy.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueCopy.css, src/services/subtitle-studio/cue-copy.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.css, src/locales/, test/subtitle-studio/cue-copy.test.ts, test/subtitle-studio/interaction-copy-ui.test.ts, .agents/skills/fusionkit-pitfall-guard/references/keep-document-selection-local-and-cancel-stale-bulk-reads.md, .agents/skills/fusionkit-pitfall-guard/references/index.md |
| 负责人 | Codex root |
| 依赖确认 | 已核对I5快照65文件字节一致；共享组件接口由root统一交付 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-interaction-02.md |
| 集成版本 | feat/subtitle-studio-transcription，3855c2c72bfa45740f248406f7266cf0342ae1f6加I5及I6未提交工作树；精确源码和证据见2026-09-13-interaction.snapshot.json |

#### 实现要点

按design前端基准及单写权完成，实际Electron审阅并修复复验，不删既有保护迎合界面。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-INTERACTION-02-1 | integration | required | 本任务语义及必要反例：实际剪贴板/导出字节或局部选择竞态/队列能力，复验受影响既有路径 | - |
| V-INTERACTION-02-2 | browser | required | 最终Electron宽浅与786×540窄深，hover/focus/长名/失败/步骤，人工审阅截图及相关几何或MutationObserver | - |
| V-INTERACTION-02-3 | static | required | 两套生产和验收测试TS、四语、边界、构建/preload、spec/diff与最终源码证据 | - |

### T-INTERACTION-03 导出检查与结果步骤

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I6 |
| 需求 | R-INTERACTION-04, R-INTERACTION-05, R-INTERACTION-06 |
| 验收 | AC-INTERACTION-04-1, AC-INTERACTION-04-2, AC-INTERACTION-05-1, AC-INTERACTION-05-2, AC-INTERACTION-06-1, AC-INTERACTION-06-2 |
| 依赖 | - |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioExport.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioExport.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioDocumentList.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioOperationResult.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioOperationResult.css, test/subtitle-studio/interaction-export-ui.test.ts, test/subtitle-studio/experience-export-ui.test.ts, test/subtitle-studio/acceptance-files-ui.test.ts, test/subtitle-studio/export-ui.test.ts |
| 负责人 | windows_baseline |
| 依赖确认 | 已核对I5快照65文件字节一致；共享组件接口由root统一交付 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-interaction-03.md |
| 集成版本 | feat/subtitle-studio-transcription，3855c2c72bfa45740f248406f7266cf0342ae1f6加I5及I6未提交工作树；精确源码和证据见2026-09-13-interaction.snapshot.json |

#### 实现要点

按design前端基准及单写权完成，实际Electron审阅并修复复验，不删既有保护迎合界面。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-INTERACTION-03-1 | integration | required | 本任务语义及必要反例：实际剪贴板/导出字节或局部选择竞态/队列能力，复验受影响既有路径 | - |
| V-INTERACTION-03-2 | browser | required | 最终Electron宽浅与786×540窄深，hover/focus/长名/失败/步骤，人工审阅截图及相关几何或MutationObserver | - |
| V-INTERACTION-03-3 | static | required | 两套生产和验收测试TS、四语、边界、构建/preload、spec/diff与最终源码证据 | - |

### T-INTERACTION-04 工作区布局与局部选择

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I6 |
| 需求 | R-INTERACTION-07, R-INTERACTION-08, R-INTERACTION-09, R-INTERACTION-10 |
| 验收 | AC-INTERACTION-07-1, AC-INTERACTION-07-2, AC-INTERACTION-08-1, AC-INTERACTION-08-2, AC-INTERACTION-09-1, AC-INTERACTION-09-2, AC-INTERACTION-10-1, AC-INTERACTION-10-2 |
| 依赖 | - |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioLibrary.tsx, src/pages/Tools/Subtitle/SubtitleStudio/studio.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslationOverview.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslationOverview.css, test/subtitle-studio/interaction-workspace-ui.test.ts, test/subtitle-studio/acceptance-live-refresh-ui.test.ts, test/subtitle-studio/vertical-layout.test.ts, test/subtitle-studio/library-ui.test.ts |
| 负责人 | ipc_design |
| 依赖确认 | 已核对I5快照65文件字节一致；共享组件接口由root统一交付 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-interaction-04.md |
| 集成版本 | feat/subtitle-studio-transcription，3855c2c72bfa45740f248406f7266cf0342ae1f6加I5及I6未提交工作树；精确源码和证据见2026-09-13-interaction.snapshot.json |

#### 实现要点

按design前端基准及单写权完成，实际Electron审阅并修复复验，不删既有保护迎合界面。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-INTERACTION-04-1 | integration | required | 本任务语义及必要反例：实际剪贴板/导出字节或局部选择竞态/队列能力，复验受影响既有路径 | - |
| V-INTERACTION-04-2 | browser | required | 最终Electron宽浅与786×540窄深，hover/focus/长名/失败/步骤，人工审阅截图及相关几何或MutationObserver | - |
| V-INTERACTION-04-3 | static | required | 两套生产和验收测试TS、四语、边界、构建/preload、spec/diff与最终源码证据 | - |
