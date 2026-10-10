# revision 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。

### T-REVISION-01 相邻重复检测与结构提案预览

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-REVISION-01 |
| 验收 | AC-REVISION-01-1, AC-REVISION-01-2, AC-REVISION-01-3 |
| 依赖 | T-STRUCTURE-01 |
| 写集 | src/subtitle-studio/cue-structure.ts, src/subtitle-studio/cue-structure.test.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.css, src/locales/zh/studio.json, src/locales/en/studio.json, src/locales/ja/studio.json, src/locales/zh-Hant/studio.json, test/subtitle-studio/cue-structure-revision-ui.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-STRUCTURE-01：同一工作树 f869d2e+未提交改动，合并/批量编辑单元测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-REVISION-01.md |
| 集成版本 | f869d2e + 未提交工作树（studio-cue-structure） |

#### 实现要点

按 [设计·相邻重复检测、UI](design.md)。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-REVISION-01-1 | unit | required | node node_modules/vitest/vitest.mjs run src/subtitle-studio/cue-structure.test.ts | - |
| V-REVISION-01-2 | browser | required | 构建后 FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-structure-revision-ui.test.ts：检查相邻重复、取消一组、应用、撤销；截图审阅 | - |

### T-REVISION-02 AI 修订的合并与删除

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-REVISION-02 |
| 验收 | AC-REVISION-02-1, AC-REVISION-02-2, AC-REVISION-02-3 |
| 依赖 | T-REVISION-01 |
| 写集 | src/subtitle-studio/cue-revision-contract.ts, electron/main/subtitle-studio/cue-revision-service.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.tsx, test/subtitle-studio/cue-revision.test.ts, test/subtitle-studio/cue-structure-revision-ui.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-REVISION-01：同一工作树 f869d2e+未提交改动，相邻重复与结构提案测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-REVISION-02.md |
| 集成版本 | f869d2e + 未提交工作树（studio-cue-structure） |

#### 实现要点

按 [设计·AI 修订](design.md)。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-REVISION-02-1 | unit | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/cue-revision.test.ts | - |
| V-REVISION-02-2 | browser | required | 同 V-REVISION-01-2 文件中的模型场景：本地脚本模型返回合并与删除，预览与应用 | - |

### T-REVISION-03 Agent 准备结构修复

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-REVISION-03 |
| 验收 | AC-REVISION-03-1, AC-REVISION-03-2, AC-REVISION-03-3 |
| 依赖 | T-REVISION-02 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/agent-context.ts, src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts, src/agent/ui-events.ts, src/agent/ui-events.test.ts, src/agent/orchestrator.ts, src/agent/orchestrator.test.ts, src/pages/HomeAgent/components/AgentToolCall.tsx, src/pages/HomeAgent/components/AgentToolResult.tsx, src/pages/HomeAgent/components/action-error.ts, src/locales/zh/home.json, src/locales/en/home.json, src/locales/ja/home.json, src/locales/zh-Hant/home.json, test/subtitle-studio/cue-structure-revision-ui.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-REVISION-02：同一工作树 f869d2e+未提交改动，模型结构提案测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-REVISION-03.md |
| 集成版本 | f869d2e + 未提交工作树（studio-cue-structure） |

#### 实现要点

按 [设计·Agent](design.md)。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-REVISION-03-1 | unit | required | node node_modules/vitest/vitest.mjs run src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts src/agent/ui-events.test.ts src/agent/orchestrator.test.ts | - |
| V-REVISION-03-2 | browser | required | 构建后 FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-structure-revision-ui.test.ts 的 Agent 部分：脚本模型调用 studio_prepare_cue_edits 合并第 9–10 条，预览（不发修订请求）、应用、下一轮带有应用事件；截图审阅 | - |
