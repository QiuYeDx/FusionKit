# import 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。

### T-IMPORT-01 导入时识别与恢复原样（主进程与契约）

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-IMPORT-01, R-IMPORT-02 |
| 验收 | AC-IMPORT-01-1, AC-IMPORT-01-2, AC-IMPORT-01-3, AC-IMPORT-01-4, AC-IMPORT-02-2 |
| 依赖 | - |
| 写集 | src/subtitle-studio/bilingual.ts, src/subtitle-studio/ipc-contract.ts, electron/main/subtitle-studio/index.ts, electron/main/subtitle-studio/bilingual-service.ts, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, resources/speech-resources/provenance/current-integration-audits.v1.json, test/subtitle-studio/bilingual-import.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-IMPORT-01.md |
| 集成版本 | f869d2e + 未提交工作树（studio-cue-structure） |

#### 实现要点

按 [设计·导入时识别与恢复原样](design.md)。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-IMPORT-01-1 | unit | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/bilingual-import.test.ts test/subtitle-studio/bilingual.test.ts test/subtitle-studio/ipc.test.ts | - |
| V-IMPORT-01-2 | unit | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance（审计记录与边界） | - |

### T-IMPORT-02 识别提示与「按原样导入」

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-IMPORT-01, R-IMPORT-02 |
| 验收 | AC-IMPORT-01-1, AC-IMPORT-01-2, AC-IMPORT-02-1, AC-IMPORT-02-2 |
| 依赖 | T-IMPORT-01 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioBilingual.tsx, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioOperationResult.tsx, src/locales/zh/studio.json, src/locales/en/studio.json, src/locales/ja/studio.json, src/locales/zh-Hant/studio.json, test/subtitle-studio/bilingual-import-ui.test.ts, test/subtitle-studio/bilingual-ui.test.ts, test/subtitle-studio/export-ui.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-IMPORT-01：同一工作树 f869d2e+未提交改动，导入识别单元测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-IMPORT-02.md |
| 集成版本 | f869d2e + 未提交工作树（studio-cue-structure） |

#### 实现要点

按 [设计·UI](design.md)。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-IMPORT-02-1 | browser | required | 构建后 FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/bilingual-import-ui.test.ts（并回归 bilingual-ui、export-ui）：多文件导入（双语 LRC + 单语 SRT）、标签与提示条、按原样导入后 302 条；1280×860 浅色与 786×660 深色截图审阅 | - |
