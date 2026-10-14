# 列表内查找替换 任务

每个任务块是唯一任务台账。设计基准见 design.md「UI 设计基准」。

### T-FIND-01 查找与替换的主进程部分

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-FIND-01, R-FIND-02 |
| 验收 | AC-FIND-01-1, AC-FIND-01-2, AC-FIND-02-1, AC-FIND-02-3 |
| 依赖 | - |
| 写集 | src/subtitle-studio/cue-find.ts, src/subtitle-studio/cue-find.test.ts, src/subtitle-studio/cue-edit-contract.ts, src/subtitle-studio/ipc-contract.ts, electron/main/subtitle-studio/cue-edit-service.ts, electron/main/subtitle-studio/index.ts, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, resources/speech-resources/provenance/current-integration-audits.v1.json, test/subtitle-studio/cue-find.test.ts, test/subtitle-studio/ipc.test.ts |
| 负责人 | Claude |
| 依赖确认 | - |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-FIND-01.md |
| 集成版本 | - |

#### 实现要点

按 design.md「纯函数」「主进程」：查找区间与整篇查找、替换文字、`searchCues` 通道、`replace` 操作与撤销、组合审计。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-FIND-01-1 | unit | required | node node_modules/vitest/vitest.mjs run src/subtitle-studio/cue-find.test.ts test/subtitle-studio/cue-find.test.ts：区间、整篇查找、替换格式、操作与撤销、上限与拒绝、翻译进行中 | - |
| V-FIND-01-2 | interface | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/ipc.test.ts test/subtitle-studio/cue-edit.test.ts test/subtitle-studio-provenance：通道白名单、未授权文档、既有编辑回归、组合审计 | - |

### T-FIND-02 查找栏

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-FIND-03, R-FIND-02 |
| 验收 | AC-FIND-02-2, AC-FIND-03-1, AC-FIND-03-2, AC-FIND-03-3, AC-FIND-03-4 |
| 依赖 | T-FIND-01 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioCueFind.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueFind.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx, src/services/subtitle-studio/cue-history.ts, src/locales/, test/subtitle-studio/cue-find-ui.test.ts |
| 负责人 | Claude |
| 依赖确认 | T-FIND-01：同一工作树 110ad54+未提交改动，查找与替换单元测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-FIND-02.md |
| 集成版本 | - |

#### 实现要点

按 design.md「渲染端」与「UI 设计基准」：查找栏、快捷键、高亮、跨页跳转、替换当前与全部；初版后渲染审查并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-FIND-02-1 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-find-ui.test.ts：Ctrl+F、计数、跨页跳转与高亮、替换当前与全部、撤销后重新查找、Esc | - |
| V-FIND-02-2 | manual | required | 查看 1280×860 浅色与 786×660 深色截图：查找栏位置、计数、按钮、高亮；问题修复后复验 | - |
| V-FIND-02-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json；pnpm run i18n:check | - |

### T-FIND-03 回归与文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-FIND-01, R-FIND-02, R-FIND-03 |
| 验收 | AC-FIND-02-1, AC-FIND-03-1 |
| 依赖 | T-FIND-02 |
| 写集 | CHANGELOG.md, docs/TODO.md, docs/features/studio-cue-find/ |
| 负责人 | Claude |
| 依赖确认 | T-FIND-02：同一工作树，查找栏界面测试通过后回归 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-FIND-03.md |
| 集成版本 | - |

#### 实现要点

字幕工作台单元 / 接口 / provenance 回归与相关 Electron UI 测试；CHANGELOG 与 TODO；记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-FIND-03-1 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio test/subtitle-studio-provenance src/subtitle-studio src/services/subtitle-studio src/pages/Tools/Subtitle electron --maxWorkers=4 --minWorkers=1 | - |
| V-FIND-03-2 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 cue-find-ui、cue-editing-ui、cue-structure-ui、cue-split-insert-ui、cue-listening-ui | - |

### T-FIND-04 正则与全词：匹配器、替换与超时

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-FIND-04 |
| 验收 | AC-FIND-04-1, AC-FIND-04-2, AC-FIND-04-3, AC-FIND-04-4 |
| 依赖 | - |
| 写集 | src/subtitle-studio/cue-find.ts, src/subtitle-studio/cue-find-query.ts, src/subtitle-studio/cue-find.test.ts, src/subtitle-studio/cue-edit-contract.ts, electron/main/subtitle-studio/cue-find-worker.ts, electron/main/subtitle-studio/cue-edit-service.ts, electron/main/subtitle-studio/index.ts, resources/speech-resources/provenance/current-integration-audits.v1.json, test/subtitle-studio/cue-find.test.ts, test/subtitle-studio/ipc.test.ts |
| 负责人 | Claude |
| 依赖确认 | - |
| 完成日期 | 2026-10-14 |
| 实施记录 | records/T-FIND-04.md |
| 集成版本 | - |

#### 实现要点

按 design.md「I2 → 匹配器」「主进程与超时」。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-FIND-04-1 | unit | required | node node_modules/vitest/vitest.mjs run src/subtitle-studio/cue-find.test.ts test/subtitle-studio/cue-find.test.ts：正则与字面、区分大小写、空匹配、捕获组展开与字面 `$`、全词（拉丁 / 带重音 / 西里尔 / 中日文端）、无效正则、展开后为空或含 `<` 拒绝、格式保留、回溯严重的表达式 3 秒内 `pattern_too_slow` 且文档不变、旧调用（无新字段）行为不变 | - |
| V-FIND-04-2 | interface | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/ipc.test.ts test/subtitle-studio-provenance：`searchCues` 新字段与错误码、组合审计 | - |

### T-FIND-05 查找栏的正则与全词开关

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-FIND-04, R-FIND-05 |
| 验收 | AC-FIND-04-5, AC-FIND-05-1, AC-FIND-05-2, AC-FIND-05-3 |
| 依赖 | T-FIND-04 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioCueFind.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueFind.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx, src/locales/, test/subtitle-studio/cue-find-ui.test.ts |
| 负责人 | Claude |
| 依赖确认 | T-FIND-04：同一工作树，匹配器与主进程测试通过后开发 |
| 完成日期 | 2026-10-14 |
| 实施记录 | records/T-FIND-05.md |
| 集成版本 | - |

#### 实现要点

按 design.md「I2 → 渲染端」与「UI 设计基准（I2）」；初版后渲染审查并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-FIND-05-1 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-find-ui.test.ts：两个开关与快捷键、正则计数 / 高亮 / 跳转、捕获组全部替换与撤销、无效正则提示与按钮禁用、全词 | - |
| V-FIND-05-2 | manual | required | 查看 1280×860 浅色与 786×660 深色截图：三个开关、错误说明；问题修复后复验 | - |
| V-FIND-05-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json；pnpm run i18n:check | - |

### T-FIND-06 I2 回归与文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-FIND-04, R-FIND-05 |
| 验收 | AC-FIND-04-5, AC-FIND-05-1 |
| 依赖 | T-FIND-05 |
| 写集 | CHANGELOG.md, docs/TODO.md, docs/features/studio-cue-find/ |
| 负责人 | Claude |
| 依赖确认 | T-FIND-05：同一工作树，查找栏界面测试通过后回归 |
| 完成日期 | 2026-10-14 |
| 实施记录 | records/T-FIND-06.md |
| 集成版本 | - |

#### 实现要点

字幕工作台单元 / 接口 / provenance 回归与相关 Electron UI 测试；CHANGELOG 与 TODO；记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-FIND-06-1 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio test/subtitle-studio-provenance src/subtitle-studio src/services/subtitle-studio src/pages/Tools/Subtitle --maxWorkers=4 --minWorkers=1 | - |
| V-FIND-06-2 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 cue-find-ui、cue-editing-ui、cue-structure-ui | - |
