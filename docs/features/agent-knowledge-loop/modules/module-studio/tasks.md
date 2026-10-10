# studio 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。
元数据引用需求与 AC；不要复制 AC 文本。负责人可连续完成多个任务，但同一时刻只领一个。

### T-STUDIO-01 修订请求携带资料并返回可沉淀译法

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-STUDIO-01, R-STUDIO-02 |
| 验收 | AC-STUDIO-01-1, AC-STUDIO-01-2, AC-STUDIO-02-1, AC-STUDIO-02-2, AC-STUDIO-02-3 |
| 依赖 | - |
| 写集 | src/subtitle-studio/cue-revision-contract.ts, electron/main/subtitle-studio/cue-revision-service.ts, electron/main/subtitle-studio/index.ts, test/subtitle-studio/cue-revision.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i2/T-STUDIO-01.md |
| 集成版本 | 45a88e0 + 未提交工作树（I2） |

#### 实现要点

按 [设计·请求与载荷、可沉淀译法](design.md)：契约增加 `knowledge` 与 `knowledgeHints`，提示词扩展，解析与服务端校验去重，服务注入 `readKnowledge`。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-STUDIO-01-1 | unit | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/cue-revision.test.ts | - |

### T-STUDIO-02 修订对话框资料行、预览提示与应用后提示条

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-STUDIO-01, R-STUDIO-02, R-STUDIO-03 |
| 验收 | AC-STUDIO-01-3, AC-STUDIO-03-1, AC-STUDIO-03-2, AC-STUDIO-03-3 |
| 依赖 | T-STUDIO-01, T-KNOWLEDGE-04 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.css, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/pages/Tools/Subtitle/SubtitleStudio/knowledge-hints.ts, src/pages/Tools/Subtitle/SubtitleStudio/knowledge-hints.test.ts, src/locales/zh/studio.json, src/locales/en/studio.json, src/locales/ja/studio.json, src/locales/zh-Hant/studio.json, test/subtitle-studio/cue-revision-knowledge-ui.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-STUDIO-01、T-KNOWLEDGE-04：同一工作树 45a88e0+I2，修订服务与对话框测试通过后开发 |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i2/T-STUDIO-02.md |
| 集成版本 | 45a88e0 + 未提交工作树（I2） |

#### 实现要点

按 [设计·对话框与提示条、UI 设计基准](design.md)。过滤已存在与应用范围的逻辑放在纯函数 `knowledge-hints.ts` 便于单元测试；提示条复用 `.studio-notice`。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-STUDIO-02-1 | unit | required | node node_modules/vitest/vitest.mjs run src/pages/Tools/Subtitle/SubtitleStudio/knowledge-hints.test.ts | - |
| V-STUDIO-02-2 | browser | required | 构建后 FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-revision-knowledge-ui.test.ts：选用资料后修订显示参考资料行与预览提示行；应用后提示条出现、打开对话框保存后资料库可见；撤销/关闭后提示消失；已存在时不提示；截图审阅 1280×860 浅/深色 | - |

### T-STUDIO-03 一致性检查契约、服务与 IPC

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-STUDIO-04 |
| 验收 | AC-STUDIO-04-1, AC-STUDIO-04-2, AC-STUDIO-04-3, AC-STUDIO-04-4, AC-STUDIO-04-5 |
| 依赖 | - |
| 写集 | src/subtitle-studio/consistency-contract.ts, electron/main/subtitle-studio/consistency-service.ts, electron/main/subtitle-studio/index.ts, src/subtitle-studio/ipc-contract.ts, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, test/subtitle-studio/consistency.test.ts, scripts/subtitle-studio/boundaries.json, resources/speech-resources/provenance/current-integration-audits.v1.json |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i3/T-STUDIO-03.md |
| 集成版本 | 45a88e0 + 未提交工作树（I3） |

#### 实现要点

按 [设计·一致性检查](design.md) 的契约与服务部分实现；合并回数为纯函数便于测试。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-STUDIO-03-1 | unit | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/consistency.test.ts test/subtitle-studio/ipc.test.ts | - |

### T-STUDIO-04 一致性检查窗口、统一与撤销

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-STUDIO-04, R-STUDIO-05 |
| 验收 | AC-STUDIO-04-1, AC-STUDIO-04-3, AC-STUDIO-04-5, AC-STUDIO-05-1, AC-STUDIO-05-2, AC-STUDIO-05-3, AC-STUDIO-05-4, AC-STUDIO-05-5 |
| 依赖 | T-STUDIO-03 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioConsistencyCheck.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioConsistencyCheck.css, src/pages/Tools/Subtitle/SubtitleStudio/consistency-apply.ts, src/pages/Tools/Subtitle/SubtitleStudio/consistency-apply.test.ts, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioLibraryContextMenu.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioLibrary.tsx, src/services/subtitle-studio/cue-history.ts, src/locales/zh/studio.json, src/locales/en/studio.json, src/locales/ja/studio.json, src/locales/zh-Hant/studio.json, test/subtitle-studio/consistency-ui.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-STUDIO-03：同一工作树 45a88e0+I3，契约与服务测试通过后开发 |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i3/T-STUDIO-04.md |
| 集成版本 | 45a88e0 + 未提交工作树（I3） |

#### 实现要点

按 [设计·一致性检查·界面](design.md)。编辑生成与撤销计划在 `consistency-apply.ts`；窗口沿用 AI 修订对话框的结构与样式。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-STUDIO-04-1 | unit | required | node node_modules/vitest/vitest.mjs run src/pages/Tools/Subtitle/SubtitleStudio/consistency-apply.test.ts | - |
| V-STUDIO-04-2 | browser | required | 构建后 FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/consistency-ui.test.ts：两个文档检查、选择标准写法、统一、回执撤销、当前文档 Ctrl+Z、记入资料对话框；未翻译文档的原文写法组（合并重复报告、单选方向、统一按钮可用）；截图审阅 1280×860 浅色/深色与 786×660 深色 | - |
