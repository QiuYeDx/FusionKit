# I3 任务台账

六项用户问题按四个独立写集合并执行，问题与需求仍一一对应。全部以15340fd为基线；先完成ready及公共契约，再并行实现。负责人只能修改design指定写集，实际集成与证据由root统一收尾。

### T-ACCEPTANCE-01 拖入与共享接线

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-ACCEPTANCE-01 |
| 验收 | AC-ACCEPTANCE-01-1, AC-ACCEPTANCE-01-2 |
| 依赖 | - |
| 写集 | electron/main/subtitle-studio/index.ts, electron/main/subtitle-studio/translation-overview.ts, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, electron/preload/index.ts, src/subtitle-studio/ipc-contract.ts, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, test/subtitle-studio/drop-import.test.ts, test/subtitle-studio/translation-overview.test.ts, electron/main/subtitle-studio/drop-input-service.ts, electron/main/subtitle-studio/transcription/runtime.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioLibrary.tsx, src/pages/Tools/Subtitle/SubtitleStudio/studio.css, test/subtitle-studio/ipc.test.ts, test/subtitle-studio/acceptance-files-ui.test.ts, test/subtitle-studio/vertical-layout.test.ts, .agents/skills/fusionkit-pitfall-guard/references/, scripts/subtitle-studio-provenance/current-composition-audits.json, resources/speech-resources/provenance/current-integration-audits.v1.json |
| 负责人 | Codex root |
| 依赖确认 | 15340fd现有I1/I2已集成，当前范围与共享文件单写权见design；所需公共接口由root在实际接入前落实 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-acceptance-01.md |
| 集成版本 | 15340fd74752484df9982ab7ca894b7410577273加本轮未提交工作树；records/2026-09-12-acceptance.snapshot.json |

#### 实现要点

遵循design对应段落及前端设计基准，不改变既有ASR算法。接口以代码严格schema为准，遇到其他写集先与负责人协调。最终用户场景在同一实际Electron构建上综合验证。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ACCEPTANCE-01-1 | integration | required | 原生File/IPC负例、多文件部分失败、实际Electron拖入和picker/忙碌/退出、来源记录与四格式集成 | - |
| V-ACCEPTANCE-01-2 | browser | required | 隔离Electron实际renderer/preload/main，1280×860浅色与786×540深色、长名称/空态/忙碌/失败/键盘；审阅截图并修复复验 | - |
| V-ACCEPTANCE-01-3 | static | required | 两套TS、i18n、真实边界/相关provenance、spec/diff；记录最终源码及证据 | - |

### T-ACCEPTANCE-02 转写队列批量操作与翻译总览

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-ACCEPTANCE-02, R-ACCEPTANCE-03 |
| 验收 | AC-ACCEPTANCE-02-1, AC-ACCEPTANCE-02-2, AC-ACCEPTANCE-03-1, AC-ACCEPTANCE-03-2 |
| 依赖 | - |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioTranscription.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranscription.css, src/services/subtitle-studio/transcription-controller.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslationOverview.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslationOverview.css, src/services/subtitle-studio/translation-overview-controller.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslationTask.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.css, src/locales/, test/subtitle-studio/acceptance-queue-overview.test.ts, test/subtitle-studio/acceptance-queue-overview-ui.test.ts, test/subtitle-studio/helpers/transcription-ui-runtime.ts |
| 负责人 | windows_baseline |
| 依赖确认 | 15340fd现有I1/I2已集成，当前范围与共享文件单写权见design；所需公共接口由root在实际接入前落实 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-acceptance-02.md |
| 集成版本 | 15340fd74752484df9982ab7ca894b7410577273加本轮未提交工作树；records/2026-09-12-acceptance.snapshot.json |

#### 实现要点

遵循design对应段落及前端设计基准，不改变既有ASR算法。接口以代码严格schema为准，遇到其他写集先与负责人协调。最终用户场景在同一实际Electron构建上综合验证。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ACCEPTANCE-02-1 | integration | required | 终态/清理保护和部分失败、真实批次进度/分页/并发事件、实际Electron宽窄屏和键盘 | - |
| V-ACCEPTANCE-02-2 | browser | required | 隔离Electron实际renderer/preload/main，1280×860浅色与786×540深色、长名称/空态/忙碌/失败/键盘；审阅截图并修复复验 | - |
| V-ACCEPTANCE-02-3 | static | required | 两套TS、i18n、真实边界/相关provenance、spec/diff；记录最终源码及证据 | - |

### T-ACCEPTANCE-04 VTT和ASS格式工作流

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-ACCEPTANCE-04 |
| 验收 | AC-ACCEPTANCE-04-1, AC-ACCEPTANCE-04-2, AC-ACCEPTANCE-04-3 |
| 依赖 | - |
| 写集 | src/subtitle-studio/domain.ts, src/subtitle-studio/formats/, src/subtitle-studio/bilingual.ts, electron/main/subtitle-studio/export-planner.ts, test/subtitle-studio/acceptance-formats.test.ts, test/subtitle-studio/export-planner.test.ts |
| 负责人 | admission_design |
| 依赖确认 | 15340fd现有I1/I2已集成，当前范围与共享文件单写权见design；所需公共接口由root在实际接入前落实 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-acceptance-04.md |
| 集成版本 | 15340fd74752484df9982ab7ca894b7410577273加本轮未提交工作树；records/2026-09-12-acceptance.snapshot.json |

#### 实现要点

遵循design对应段落及前端设计基准，不改变既有ASR算法。接口以代码严格schema为准，遇到其他写集先与负责人协调。最终用户场景在同一实际Electron构建上综合验证。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ACCEPTANCE-04-1 | integration | required | 四格式导入重开和规范导出、原始字节/同格式节点保留、复杂结构限制/跨格式损失、现有字幕与媒体回归 | - |
| V-ACCEPTANCE-04-2 | browser | required | 隔离Electron实际renderer/preload/main，1280×860浅色与786×540深色、长名称/空态/忙碌/失败/键盘；审阅截图并修复复验 | - |
| V-ACCEPTANCE-04-3 | static | required | 两套TS、i18n、真实边界/相关provenance、spec/diff；记录最终源码及证据 | - |

### T-ACCEPTANCE-05 来源目录和可选文件名后缀

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-ACCEPTANCE-05, R-ACCEPTANCE-06 |
| 验收 | AC-ACCEPTANCE-05-1, AC-ACCEPTANCE-05-2, AC-ACCEPTANCE-05-3, AC-ACCEPTANCE-06-1, AC-ACCEPTANCE-06-2 |
| 依赖 | - |
| 写集 | src/subtitle-studio/export-contract.ts, src/subtitle-studio/batch-contract.ts, src/subtitle-studio/export-filename.ts, electron/main/subtitle-studio/export-service.ts, electron/main/subtitle-studio/batch-service.ts, electron/main/subtitle-studio/source-location-service.ts, electron/main/subtitle-studio/document-repository.ts, electron/main/subtitle-studio/input-service.ts, electron/main/subtitle-studio/transcription/task-service.ts, electron/main/subtitle-studio/transcription/document-sink.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioExport.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioExport.css, test/subtitle-studio/acceptance-source-output.test.ts, test/subtitle-studio/batch-service.test.ts, test/subtitle-studio/transcription-task-service.test.ts, test/subtitle-studio/transcription-runtime.test.ts |
| 负责人 | ipc_design |
| 依赖确认 | 15340fd现有I1/I2已集成，当前范围与共享文件单写权见design；所需公共接口由root在实际接入前落实 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-acceptance-05.md |
| 集成版本 | 15340fd74752484df9982ab7ca894b7410577273加本轮未提交工作树；records/2026-09-12-acceptance.snapshot.json |

#### 实现要点

遵循design对应段落及前端设计基准，不改变既有ASR算法。接口以代码严格schema为准，遇到其他写集先与负责人协调。最终用户场景在同一实际Electron构建上综合验证。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ACCEPTANCE-05-1 | integration | required | 真实临时文件来源持久/重开/媒体路径、目录置换及重名竞争、跨目录批量和部分失败、后缀校验/预览发布一致、实际Electron导出 | - |
| V-ACCEPTANCE-05-2 | browser | required | 隔离Electron实际renderer/preload/main，1280×860浅色与786×540深色、长名称/空态/忙碌/失败/键盘；审阅截图并修复复验 | - |
| V-ACCEPTANCE-05-3 | static | required | 两套TS、i18n、真实边界/相关provenance、spec/diff；记录最终源码及证据 | - |
