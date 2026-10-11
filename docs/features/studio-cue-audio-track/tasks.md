# 记住转写时的音轨 任务

每个任务块是唯一任务台账。设计基准见 design.md「UI 设计基准」。

### T-TRACK-01 转写文档记住音轨

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-TRACK-01 |
| 验收 | AC-TRACK-01-1, AC-TRACK-01-2 |
| 依赖 | - |
| 写集 | src/subtitle-studio/domain.ts, electron/main/subtitle-studio/transcription/document-adapter.ts, electron/main/subtitle-studio/transcription/document-sink.ts, electron/main/subtitle-studio/transcription/task-service.ts, electron/main/subtitle-studio/transcription/runtime.ts, resources/speech-resources/provenance/current-integration-audits.v1.json, test/subtitle-studio/helpers/transcription-ui-runtime.ts, test/subtitle-studio/transcription-task-service.test.ts, src/subtitle-studio/cue-audio.ts |
| 负责人 | Claude |
| 依赖确认 | - |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-TRACK-01.md |
| 集成版本 | - |

#### 实现要点

按 design.md「主进程」：来源字段、适配器与 sink、任务服务解析、运行时探测缓存、组合审计、假运行时。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRACK-01-1 | unit | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/cue-audio.test.ts test/subtitle-studio/transcription-task-service.test.ts：解析（选择 / 自动 / 未知）、任务服务发布的文档记住音轨（无描述时不记）、文档来源写入与校验、旧文档 | - |
| V-TRACK-01-2 | interface | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio test/subtitle-studio-provenance：转写与文档相关回归、组合审计 | - |

### T-TRACK-02 原声功能使用记住的音轨

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-TRACK-02 |
| 验收 | AC-TRACK-02-1, AC-TRACK-02-2, AC-TRACK-02-3 |
| 依赖 | T-TRACK-01 |
| 写集 | src/subtitle-studio/cue-audio.ts, electron/main/subtitle-studio/cue-media-service.ts, electron/main/subtitle-studio/cue-audio-clip.ts, electron/main/subtitle-studio/cue-recognize-service.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueAudio.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueAudio.css, src/locales/, test/subtitle-studio/cue-audio.test.ts, test/subtitle-studio/cue-audio-track-ui.test.ts |
| 负责人 | Claude |
| 依赖确认 | T-TRACK-01：同一工作树 d55ec36+未提交改动，任务服务与运行时解析测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-TRACK-02.md |
| 集成版本 | - |

#### 实现要点

按 design.md「截取」与「渲染端」：解析序号、选流与回退、状态中的音轨、面板一行；初版后渲染审查并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRACK-02-1 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/cue-audio.test.ts：两音轨 MKV 按序号解码的频率、单音轨回退、状态中的音轨 | - |
| V-TRACK-02-2 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-audio-track-ui.test.ts：选第 2 条音轨转写后面板显示音轨；截图 1280 浅色与 786 深色并审查 | - |
| V-TRACK-02-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json；pnpm run i18n:check | - |

### T-TRACK-03 回归与文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-TRACK-01, R-TRACK-02 |
| 验收 | AC-TRACK-01-2, AC-TRACK-02-1 |
| 依赖 | T-TRACK-02 |
| 写集 | CHANGELOG.md, docs/TODO.md, docs/features/studio-cue-audio-track/ |
| 负责人 | Claude |
| 依赖确认 | T-TRACK-02：同一工作树，解码与界面测试通过后回归 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-TRACK-03.md |
| 集成版本 | - |

#### 实现要点

字幕工作台单元 / 接口 / provenance 回归与相关 Electron UI 测试；CHANGELOG 与 TODO；记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRACK-03-1 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio test/subtitle-studio-provenance src/subtitle-studio src/services/subtitle-studio src/pages/Tools/Subtitle electron --maxWorkers=4 --minWorkers=1 | - |
| V-TRACK-03-2 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 cue-audio-track-ui、cue-audio-ui、cue-listening-ui、cue-recognize-ui | - |
