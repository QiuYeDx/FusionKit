# 整篇时间偏移 任务

每个任务块是唯一任务台账。设计基准见 design.md「UI 设计基准」。

### T-SHIFT-01 主进程平移操作与预检

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SHIFT-01 |
| 验收 | AC-SHIFT-01-1, AC-SHIFT-01-2, AC-SHIFT-01-3, AC-SHIFT-01-4 |
| 依赖 | - |
| 写集 | src/subtitle-studio/cue-shift.ts, src/subtitle-studio/cue-shift.test.ts, src/subtitle-studio/cue-edit-contract.ts, src/subtitle-studio/ipc-contract.ts, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, electron/main/subtitle-studio/cue-edit-service.ts, electron/main/subtitle-studio/index.ts, resources/speech-resources/provenance/current-integration-audits.v1.json, test/subtitle-studio/cue-shift.test.ts, test/subtitle-studio/ipc.test.ts |
| 负责人 | Claude |
| 依赖确认 | - |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-SHIFT-01.md |
| 集成版本 | - |

#### 实现要点

按 design.md「主进程」：纯函数检查、`shift` 操作与反向撤销、`previewCueShift` 通道、组合审计。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SHIFT-01-1 | unit | required | node node_modules/vitest/vitest.mjs run src/subtitle-studio/cue-shift.test.ts test/subtitle-studio/cue-shift.test.ts：各原因与边界、250 条整篇与从某条起、撤销精确、拒绝不留改动、翻译进行中拒绝、预检不修改文档、平移后导出按新时间 | - |
| V-SHIFT-01-2 | interface | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/ipc.test.ts test/subtitle-studio-provenance：通道白名单、未授权文档拒绝、组合审计 | - |

### T-SHIFT-02 “平移时间”对话框：范围、微调与试听

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SHIFT-02 |
| 验收 | AC-SHIFT-02-1, AC-SHIFT-02-2, AC-SHIFT-02-3, AC-SHIFT-02-4, AC-SHIFT-02-5 |
| 依赖 | T-SHIFT-01 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioCueShift.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueShift.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx, src/services/subtitle-studio/cue-history.ts, src/locales/, test/subtitle-studio/cue-shift-ui.test.ts, test/subtitle-studio/cue-structure-ui.test.ts |
| 负责人 | Claude |
| 依赖确认 | T-SHIFT-01：同一工作树 eacc62d+未提交改动，主进程平移与预检测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-SHIFT-02.md |
| 集成版本 | - |

#### 实现要点

按 design.md「渲染端」与「UI 设计基准」：范围单选与默认规则、微调按钮、预检预览、按平移后时间试听、工具栏入口、撤销标签；初版后渲染审查并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SHIFT-02-1 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-shift-ui.test.ts：Ctrl+A 默认整篇与跨页生效、撤销、工具栏入口与微调、从第 120 条与越界原因、试听范围、关闭停止试听 | - |
| V-SHIFT-02-2 | manual | required | 查看 1280×860 浅色与 786×660 深色截图：范围选项、微调按钮、预览与试听行、底部按钮；问题修复后复验 | - |
| V-SHIFT-02-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json；pnpm run i18n:check | - |

### T-SHIFT-03 回归与文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-SHIFT-01, R-SHIFT-02 |
| 验收 | AC-SHIFT-01-4, AC-SHIFT-02-1 |
| 依赖 | T-SHIFT-02 |
| 写集 | CHANGELOG.md, docs/TODO.md, docs/features/studio-cue-shift/ |
| 负责人 | Claude |
| 依赖确认 | T-SHIFT-02：同一工作树，对话框界面测试通过后回归 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-SHIFT-03.md |
| 集成版本 | - |

#### 实现要点

字幕工作台单元 / 接口 / provenance 回归与相关 Electron UI 测试；CHANGELOG 与 TODO；记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SHIFT-03-1 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio test/subtitle-studio-provenance src/subtitle-studio src/services/subtitle-studio src/pages/Tools/Subtitle electron --maxWorkers=4 --minWorkers=1 | - |
| V-SHIFT-03-2 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 cue-shift-ui、cue-structure-ui、cue-editing-ui、cue-audio-ui、cue-listening-ui | - |

### T-SHIFT-04 主进程伸缩操作与预检

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-SHIFT-03 |
| 验收 | AC-SHIFT-03-1, AC-SHIFT-03-2, AC-SHIFT-03-3, AC-SHIFT-03-4 |
| 依赖 | - |
| 写集 | src/subtitle-studio/cue-shift.ts, src/subtitle-studio/cue-shift.test.ts, src/subtitle-studio/cue-edit-contract.ts, src/subtitle-studio/ipc-contract.ts, electron/main/subtitle-studio/cue-edit-service.ts, electron/main/subtitle-studio/index.ts, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, resources/speech-resources/provenance/current-integration-audits.v1.json, test/subtitle-studio/cue-shift.test.ts, test/subtitle-studio/ipc.test.ts |
| 负责人 | Claude |
| 依赖确认 | - |
| 完成日期 | 2026-10-14 |
| 实施记录 | records/T-SHIFT-04.md |
| 集成版本 | - |

#### 实现要点

按 design.md「I2 → 方案」的纯模块、`stretch` / `retime` 操作与撤销、预检通道与组合审计。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SHIFT-04-1 | unit | required | node node_modules/vitest/vitest.mjs run src/subtitle-studio/cue-shift.test.ts test/subtitle-studio/cue-shift.test.ts：帧率比例与约分、换算取整、锚点、未知结束、`beyond_media`、比例范围、250 条整篇与从第 120 条、撤销逐条完全一致与重做、10 万条往返与耗时、翻译进行中拒绝、预检不写入 | - |
| V-SHIFT-04-2 | interface | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/ipc.test.ts test/subtitle-studio-provenance：通道白名单、未授权文档、组合审计 | - |

### T-SHIFT-05 “调整时间”对话框：按比例伸缩

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-SHIFT-04 |
| 验收 | AC-SHIFT-04-1, AC-SHIFT-04-2, AC-SHIFT-04-3, AC-SHIFT-04-4 |
| 依赖 | T-SHIFT-04 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioCueShift.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueShift.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx, src/services/subtitle-studio/cue-history.ts, src/locales/, test/subtitle-studio/cue-shift-ui.test.ts, test/subtitle-studio/cue-structure-ui.test.ts |
| 负责人 | Claude |
| 依赖确认 | T-SHIFT-04：同一工作树，操作与预检测试通过后开发 |
| 完成日期 | 2026-10-14 |
| 实施记录 | records/T-SHIFT-05.md |
| 集成版本 | - |

#### 实现要点

按 design.md「I2 → 方案（渲染端）」与「UI 设计基准（I2）」；初版后渲染审查并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SHIFT-05-1 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-shift-ui.test.ts：方式切换、25→23.976 预览与应用、跨页生效与撤销、自定义比例越界、转写越界、试听范围（读主进程收到的请求）、关闭停止 | - |
| V-SHIFT-05-2 | manual | required | 查看 1280×860 浅色与 786×660 深色截图：两种方式、帧率选择、预览与错误；问题修复后复验 | - |
| V-SHIFT-05-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json；pnpm run i18n:check | - |

### T-SHIFT-06 I2 回归与文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-SHIFT-03, R-SHIFT-04 |
| 验收 | AC-SHIFT-03-4, AC-SHIFT-04-1 |
| 依赖 | T-SHIFT-05 |
| 写集 | CHANGELOG.md, docs/TODO.md, docs/features/studio-cue-shift/, test/subtitle-studio/helpers/transcription-ui-build.ts |
| 负责人 | Claude |
| 依赖确认 | T-SHIFT-05：同一工作树，对话框界面测试通过后回归 |
| 完成日期 | 2026-10-14 |
| 实施记录 | records/T-SHIFT-06.md |
| 集成版本 | - |

#### 实现要点

字幕工作台单元 / 接口 / provenance 回归与相关 Electron UI 测试；CHANGELOG 与 TODO；记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SHIFT-06-1 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio test/subtitle-studio-provenance src/subtitle-studio src/services/subtitle-studio src/pages/Tools/Subtitle --maxWorkers=4 --minWorkers=1 | - |
| V-SHIFT-06-2 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 cue-shift-ui、cue-structure-ui、cue-editing-ui | - |
