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
