# 拆分与插入字幕 任务

每个任务块是唯一任务台账。设计基准见 design.md「UI 设计基准」。

### T-SPLIT-01 拆分与插入的编辑操作

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SPLIT-01, R-SPLIT-02 |
| 验收 | AC-SPLIT-01-1, AC-SPLIT-01-2, AC-SPLIT-01-3, AC-SPLIT-01-4, AC-SPLIT-02-1, AC-SPLIT-02-2 |
| 依赖 | - |
| 写集 | src/subtitle-studio/cue-edit-contract.ts, src/subtitle-studio/cue-split.ts, src/subtitle-studio/cue-split.test.ts, src/subtitle-studio/domain.ts, src/subtitle-studio/formats/preserved.ts, src/subtitle-studio/ipc-contract.ts, electron/main/subtitle-studio/cue-edit-service.ts, electron/main/subtitle-studio/export-planner.ts, electron/main/subtitle-studio/index.ts, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, resources/speech-resources/provenance/current-integration-audits.v1.json, test/subtitle-studio/cue-split-insert.test.ts, test/subtitle-studio/ipc.test.ts |
| 负责人 | Claude |
| 依赖确认 | - |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-SPLIT-01.md |
| 集成版本 | - |

#### 实现要点

按 design.md「契约与校验」「主进程」：两个操作与撤销、校验放宽、导出保护、建议时刻纯函数与只读通道、组合审计。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SPLIT-01-1 | unit | required | node node_modules/vitest/vitest.mjs run src/subtitle-studio/cue-split.test.ts test/subtitle-studio/cue-split-insert.test.ts：建议时刻、SRT / VTT / LRC / 转写上的拆分与插入、导出、撤销与重做、拒绝、译文、翻译进行中 | - |
| V-SPLIT-01-2 | interface | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/ipc.test.ts test/subtitle-studio/cue-edit.test.ts test/subtitle-studio-provenance：通道白名单、未授权文档、既有编辑回归、组合审计 | - |

### T-SPLIT-02 拆分与插入的对话框

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SPLIT-03 |
| 验收 | AC-SPLIT-03-1, AC-SPLIT-03-2, AC-SPLIT-03-3 |
| 依赖 | T-SPLIT-01 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioCueSplit.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueInsert.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueSplit.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueMenu.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx, src/services/subtitle-studio/cue-history.ts, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/locales/, test/subtitle-studio/cue-split-insert-ui.test.ts |
| 负责人 | Claude |
| 依赖确认 | T-SPLIT-01：同一工作树 376b63a+未提交改动，操作与建议时刻测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-SPLIT-02.md |
| 集成版本 | - |

#### 实现要点

按 design.md「渲染端」与「UI 设计基准」：拆分对话框（光标定位、两半预览、建议时刻、试听、译文）、插入对话框（默认时间、校验、试听）、菜单、选中新字幕；初版后渲染审查并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SPLIT-02-1 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-split-insert-ui.test.ts：菜单入口与禁用、点击放置拆分位置、建议时刻、试听范围、应用与选中、撤销；插入默认时间、校验与应用 | - |
| V-SPLIT-02-2 | manual | required | 查看 1280×860 浅色与 786×660 深色截图：两个对话框的文字框、预览、时间与按钮；问题修复后复验 | - |
| V-SPLIT-02-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json；pnpm run i18n:check | - |

### T-SPLIT-03 回归与文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SPLIT-01, R-SPLIT-02, R-SPLIT-03 |
| 验收 | AC-SPLIT-01-2, AC-SPLIT-03-1 |
| 依赖 | T-SPLIT-02 |
| 写集 | CHANGELOG.md, docs/TODO.md, docs/features/studio-cue-split-insert/ |
| 负责人 | Claude |
| 依赖确认 | T-SPLIT-02：同一工作树，对话框界面测试通过后回归 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-SPLIT-03.md |
| 集成版本 | - |

#### 实现要点

字幕工作台单元 / 接口 / provenance 回归与相关 Electron UI 测试；CHANGELOG 与 TODO；记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SPLIT-03-1 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio test/subtitle-studio-provenance src/subtitle-studio src/services/subtitle-studio src/pages/Tools/Subtitle electron --maxWorkers=4 --minWorkers=1 | - |
| V-SPLIT-03-2 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 cue-split-insert-ui、cue-structure-ui、cue-editing-ui、cue-shift-ui、cue-audio-ui | - |

### T-SPLIT-04 内置 Agent 拆分与插入

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-SPLIT-04 |
| 验收 | AC-SPLIT-04-1, AC-SPLIT-04-2, AC-SPLIT-04-3, AC-SPLIT-04-4 |
| 依赖 | - |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/agent-context.ts, src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts, src/subtitle-studio/cue-structure.ts, src/subtitle-studio/cue-split.ts, src/subtitle-studio/cue-split.test.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueInsert.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.tsx, src/agent/ui-events.ts, src/locales/, test/subtitle-studio/cue-structure-revision-ui.test.ts |
| 负责人 | Claude |
| 依赖确认 | - |
| 完成日期 | 2026-10-14 |
| 实施记录 | records/T-SPLIT-04.md |
| 集成版本 | - |

#### 实现要点

按 design.md「I2 → 内置 Agent」：`editSchema` 两种新编辑、拆分位置与建议时刻、插入默认时间与本地规则（`defaultInsertTiming` 移入 `cue-split.ts`）、重叠规则、两种提案与 `revisionOperation` 顺序、预览行 / 计数 / 标签、应用后报告与说明文字；初版后渲染审查预览行并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SPLIT-04-1 | unit | required | node node_modules/vitest/vitest.mjs run src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts src/subtitle-studio/cue-split.test.ts src/subtitle-studio/cue-structure.test.ts：拆分位置（唯一 / 多次 + 序号 / 不存在）、建议时刻与给定时刻、插入默认时间与规则、`invalid_split` / `invalid_time` / `overlapping_edits`、混合编辑生成一个批次且顺序正确 | - |
| V-SPLIT-04-2 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-structure-revision-ui.test.ts：脚本化 Agent 准备拆分 + 插入 + 改时间，预览 3 项，应用后两条 / 新第 3 条，Ctrl+Z 一次恢复；截图 1280 浅色、786 深色 | - |
| V-SPLIT-04-3 | manual | required | 查看预览中拆分 / 插入行截图（文字换行、时间、依据标签、试听按钮），问题修复后复验 | - |
| V-SPLIT-04-4 | static | required | pnpm exec tsc --noEmit -p tsconfig.json；pnpm run i18n:check | - |

### T-SPLIT-05 外部 Agent 拆分与插入

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-SPLIT-05 |
| 验收 | AC-SPLIT-05-1, AC-SPLIT-05-2, AC-SPLIT-05-3, AC-SPLIT-05-4 |
| 依赖 | T-SPLIT-04 |
| 写集 | src/agent/external/catalog.ts, src/agent/external/tools/structure.ts, src/agent/external/tools/index.ts, src/agent/external/tools/studio-tools.test.ts, src/agent/external/confirmations.ts, src/agent/external/instructions.ts, src/pages/AgentDock/ExternalAgentConfirmDialog.tsx, src/locales/, .agents/skills/fusionkit-app/SKILL.md, test/external-agent-tools.electron.test.ts |
| 负责人 | Claude |
| 依赖确认 | T-SPLIT-04：共用 `cue-split.ts` 的插入规则与拆分位置计算 |
| 完成日期 | 2026-10-14 |
| 实施记录 | records/T-SPLIT-05.md |
| 集成版本 | - |

#### 实现要点

按 design.md「I2 → 外部 Agent」：两个工具与 `studio_structure` 组、实现与新字幕 id、确认框文字、说明与 Skill；初版后渲染审查确认框并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SPLIT-05-1 | unit | required | node node_modules/vitest/vitest.mjs run src/agent/external：两个工具在 auto / confirm_writes / read_only 下的结果、放行组互不覆盖、修订号过期、`track_not_writable`、`invalid_split` / `invalid_time`、新字幕 id | - |
| V-SPLIT-05-2 | browser | required | 运行 test/external-agent-tools.electron.test.ts（真实 MCP 客户端）：拆分与插入确认框、确认后文档变化、放行本类别后不再询问、拒绝不变；截图 1280 浅色、900 深色 | - |
| V-SPLIT-05-3 | manual | required | 查看确认框截图，问题修复后复验 | - |
| V-SPLIT-05-4 | static | required | pnpm exec tsc --noEmit -p tsconfig.json；pnpm run i18n:check | - |

### T-SPLIT-06 I2 回归与文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-SPLIT-04, R-SPLIT-05 |
| 验收 | AC-SPLIT-04-4, AC-SPLIT-05-1 |
| 依赖 | T-SPLIT-05 |
| 写集 | CHANGELOG.md, docs/TODO.md, docs/features/studio-cue-split-insert/, docs/features/external-agent/README.md, README.md, README.en.md |
| 负责人 | Claude |
| 依赖确认 | T-SPLIT-05：同一工作树，外部工具测试通过后回归 |
| 完成日期 | 2026-10-14 |
| 实施记录 | records/T-SPLIT-06.md |
| 集成版本 | - |

#### 实现要点

Agent 与字幕工作台相关单元 / Electron 回归；CHANGELOG 0.5.0、TODO、外部 Agent 工具表与工具数；记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SPLIT-06-1 | integration | required | node node_modules/vitest/vitest.mjs run src/agent src/pages/Tools/Subtitle src/subtitle-studio test/subtitle-studio test/external-agent --maxWorkers=4 --minWorkers=1 | - |
| V-SPLIT-06-2 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 cue-structure-revision-ui、cue-split-insert-ui；运行 external-agent*.electron.test.ts | - |
