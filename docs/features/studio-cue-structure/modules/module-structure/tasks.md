# structure 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。

### T-STRUCTURE-01 结构编辑操作、校验与导出

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-STRUCTURE-01, R-STRUCTURE-02, R-STRUCTURE-03 |
| 验收 | AC-STRUCTURE-01-1, AC-STRUCTURE-01-2, AC-STRUCTURE-01-3, AC-STRUCTURE-01-4, AC-STRUCTURE-02-3, AC-STRUCTURE-03-1, AC-STRUCTURE-03-2, AC-STRUCTURE-03-3 |
| 依赖 | - |
| 写集 | src/subtitle-studio/cue-edit-contract.ts, src/subtitle-studio/cue-structure.ts, src/subtitle-studio/cue-structure.test.ts, src/subtitle-studio/domain.ts, electron/main/subtitle-studio/cue-edit-service.ts, electron/main/subtitle-studio/export-planner.ts, test/subtitle-studio/cue-structure.test.ts, test/subtitle-studio-provenance/real-default-comparison-analysis.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-STRUCTURE-01.md |
| 集成版本 | f869d2e + 未提交工作树（studio-cue-structure） |

#### 实现要点

按 [设计·编辑操作、校验放宽、导出](design.md)。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-STRUCTURE-01-1 | unit | required | node node_modules/vitest/vitest.mjs run src/subtitle-studio/cue-structure.test.ts test/subtitle-studio/cue-structure.test.ts test/subtitle-studio/cue-edit.test.ts test/subtitle-studio/export-planner.test.ts test/subtitle-studio/export-service.test.ts test/subtitle-studio-provenance/real-default-comparison-analysis.test.ts | - |

### T-STRUCTURE-02 合并、时间编辑与平移的界面

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-STRUCTURE-01, R-STRUCTURE-02, R-STRUCTURE-03 |
| 验收 | AC-STRUCTURE-01-1, AC-STRUCTURE-01-3, AC-STRUCTURE-01-4, AC-STRUCTURE-02-1, AC-STRUCTURE-02-2, AC-STRUCTURE-02-3 |
| 依赖 | T-STRUCTURE-01 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueMenu.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTimeEditor.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueShift.tsx, src/services/subtitle-studio/cue-history.ts, src/locales/zh/studio.json, src/locales/en/studio.json, src/locales/ja/studio.json, src/locales/zh-Hant/studio.json, test/subtitle-studio/cue-structure-ui.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-STRUCTURE-01：同一工作树 f869d2e+未提交改动，合并/时间编辑单元测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-STRUCTURE-02.md |
| 集成版本 | f869d2e + 未提交工作树（studio-cue-structure） |

#### 实现要点

按 [设计·UI](design.md)。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-STRUCTURE-02-1 | browser | required | 构建后 FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-structure-ui.test.ts：合并用户样本的重复两条、撤销/重做、时间编辑与错误态、平移、导出 SRT；1280×860 浅色与 786×660 深色截图审阅 | - |
