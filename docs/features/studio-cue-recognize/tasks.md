# 单句重新识别 任务

每个任务块是唯一任务台账。设计基准见 design.md「UI 设计基准」。

### T-RECOG-01 主进程识别链路

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-RECOG-01, R-RECOG-03 |
| 验收 | AC-RECOG-01-1, AC-RECOG-01-2, AC-RECOG-01-3, AC-RECOG-01-4, AC-RECOG-03-1 |
| 依赖 | - |
| 写集 | src/subtitle-studio/cue-recognize-contract.ts, src/subtitle-studio/ipc-contract.ts, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, electron/main/subtitle-studio/cue-audio-clip.ts, electron/main/subtitle-studio/cue-recognize-service.ts, electron/main/subtitle-studio/index.ts, electron/main/subtitle-studio/transcription/runtime.ts, resources/speech-resources/provenance/current-integration-audits.v1.json, test/subtitle-studio/helpers/transcription-ui-runtime.ts, test/subtitle-studio/cue-recognize.test.ts, test/subtitle-studio/ipc.test.ts |
| 负责人 | Claude |
| 依赖确认 | - |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-RECOG-01.md |
| 集成版本 | - |

#### 实现要点

按 design.md「主进程」：契约与通道、16 kHz 截取（第三条解码道）、`runtime.recognize.clip`、`cue-recognize-service`、`index.ts` 处理与取消、组合审计；假运行时识别接口。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-RECOG-01-1 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/cue-recognize.test.ts：16 kHz 临时文件与时长、请求字段（语言、提示词、vadEnabled false）、租约释放、临时文件删除、各错误映射、取消 | - |
| V-RECOG-01-2 | interface | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/ipc.test.ts test/subtitle-studio-provenance：通道白名单、未授权文档拒绝、冻结副本与组合审计 | - |
| V-RECOG-01-3 | manual | required | FUSIONKIT_REAL_RECOGNIZE=1 运行 test/subtitle-studio/cue-recognize.test.ts 的真实用例：System.Speech 英文句子经本机已安装的 large-v3 系列模型识别，记录结果 | - |

### T-RECOG-02 “重新识别原声”对话框

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-RECOG-02 |
| 验收 | AC-RECOG-02-1, AC-RECOG-02-2, AC-RECOG-02-3, AC-RECOG-02-4, AC-RECOG-02-5 |
| 依赖 | T-RECOG-01 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRecognize.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRecognize.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueMenu.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/services/subtitle-studio/cue-history.ts, src/locales/, test/subtitle-studio/cue-recognize-ui.test.ts |
| 负责人 | Claude |
| 依赖确认 | T-RECOG-01：同一工作树 660643d+未提交改动，主进程识别与真实模型测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-RECOG-02.md |
| 集成版本 | - |

#### 实现要点

按 design.md「渲染端」与「UI 设计基准」：对话框、菜单入口、逐条识别与停止、差异与勾选、批量应用与撤销标签；初版后渲染审查并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-RECOG-02-1 | browser | required | 假运行时构建运行 test/subtitle-studio/cue-recognize-ui.test.ts：默认值、逐条识别与进度、勾选应用与撤销、停止、无模型说明、无媒体禁用 | - |
| V-RECOG-02-2 | manual | required | 查看 1280×860 浅色与 786×660 深色截图：选项行、结果差异、长句换行、底部按钮；问题修复后复验 | - |
| V-RECOG-02-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json；pnpm run i18n:check | - |

### T-RECOG-03 回归与文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-RECOG-01, R-RECOG-02, R-RECOG-03 |
| 验收 | AC-RECOG-01-3, AC-RECOG-02-2 |
| 依赖 | T-RECOG-02 |
| 写集 | CHANGELOG.md, docs/TODO.md, docs/features/studio-cue-recognize/ |
| 负责人 | Claude |
| 依赖确认 | T-RECOG-02：同一工作树，对话框界面测试通过后回归 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-RECOG-03.md |
| 集成版本 | - |

#### 实现要点

字幕工作台单元 / 接口 / provenance 回归与相关 Electron UI 测试；CHANGELOG 与 TODO；记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-RECOG-03-1 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio test/subtitle-studio-provenance src/subtitle-studio src/services/subtitle-studio src/pages/Tools/Subtitle electron --maxWorkers=4 --minWorkers=1 | - |
| V-RECOG-03-2 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 cue-recognize-ui、cue-audio-ui、cue-listening-ui、cue-revision-ui、cue-editing-ui，以及转写界面测试（FUSIONKIT_STUDIO_T06_UI=1 transcription-ui） | - |
