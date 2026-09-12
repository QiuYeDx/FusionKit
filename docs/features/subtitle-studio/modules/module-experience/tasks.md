# I5 体验完善任务

3855c2c为已推送基线；四组单写权并行实施，root统一公共接线和验证。所有任务沿用用户十项明确授权，不等待重复许可。

实施中补充单写权：T02负责清除自动翻译关联轨/任务时同步撤销意图，以及真实主进程自动交接的受控ASR UI适配；T04负责Recovery共享行与旧导出UI验收的默认值/折叠迁移。T03已确认不同时编辑Recovery；这些补充不改变用户验收范围。

### T-EXPERIENCE-01 媒体拖入与整体接线

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I5 |
| 需求 | R-EXPERIENCE-02 |
| 验收 | AC-EXPERIENCE-02-1, AC-EXPERIENCE-02-2 |
| 依赖 | - |
| 写集 | src/subtitle-studio/ipc-contract.ts, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, electron/main/subtitle-studio/index.ts, electron/main/subtitle-studio/transcription-ipc.ts, electron/main/subtitle-studio/drop-input-service.ts, electron/main/subtitle-studio/transcription/runtime.ts, scripts/subtitle-studio-provenance/current-composition-audits.json, resources/speech-resources/provenance/current-integration-audits.v1.json, test/subtitle-studio/media-drop.test.ts, test/subtitle-studio/ipc.test.ts, test/subtitle-studio/transcription-ipc.test.ts, .agents/skills/fusionkit-pitfall-guard/references/keep-background-reconciliation-separate-from-foreground-activity.md, .agents/skills/fusionkit-pitfall-guard/references/capture-native-drop-authority-before-queuing-reader-work.md, .agents/skills/fusionkit-pitfall-guard/references/index.md |
| 负责人 | Codex root |
| 依赖确认 | 已核对3855c2c在本地/远端一致；公共契约按design单写协调并在实际接入前交付，旧I1–I3能力可用 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-experience-01.md |
| 集成版本 | 3855c2c72bfa45740f248406f7266cf0342ae1f6加本轮未提交工作树；records/2026-09-13-experience.snapshot.json |

#### 实现要点

遵循design范围与前端设计基准；共享文件只有指定owner编辑，四locale由windows_baseline统一。实现后审阅实际Electron并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-EXPERIENCE-01-1 | integration | required | 原生File桥负例、20项上限/逐文件部分失败、真实来源、撤销/去重、picker与drop同链、自动翻译应用生命周期接线及跨模块回归 | - |
| V-EXPERIENCE-01-2 | browser | required | 最终实际Electron renderer/preload/main与隔离数据，1280×860浅色和786×540深色，截图人工审阅并修复复验 | - |
| V-EXPERIENCE-01-3 | static | required | 两套TS/测试TS、四语、真实边界/相关来源、spec/diff及最终源码证据 | - |

### T-EXPERIENCE-02 转写设置与自动翻译

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I5 |
| 需求 | R-EXPERIENCE-01, R-EXPERIENCE-03, R-EXPERIENCE-04, R-EXPERIENCE-05 |
| 验收 | AC-EXPERIENCE-01-1, AC-EXPERIENCE-01-2, AC-EXPERIENCE-03-1, AC-EXPERIENCE-03-2, AC-EXPERIENCE-03-3, AC-EXPERIENCE-04-1, AC-EXPERIENCE-04-2, AC-EXPERIENCE-05-1, AC-EXPERIENCE-05-2 |
| 依赖 | - |
| 写集 | src/store/tools/subtitle-studio/preferences.ts, src/subtitle-studio/transcription/preferences-contract.ts, src/services/subtitle-studio/transcription-controller.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranscription.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranscription.css, src/subtitle-studio/automatic-translation-contract.ts, src/subtitle-studio/persistence-contract.ts, src/subtitle-studio/transcription/task-contract.ts, electron/main/subtitle-studio/automatic-translation.ts, electron/main/subtitle-studio/translation-service.ts, electron/main/subtitle-studio/document-repository.ts, electron/main/subtitle-studio/transcription/task-service.ts, electron/main/subtitle-studio/transcription/document-sink.ts, test/subtitle-studio/automatic-translation.test.ts, test/subtitle-studio/transcription-preferences.test.ts, test/subtitle-studio/transcription-controller.test.ts, test/subtitle-studio/transcription-task-service.test.ts, test/subtitle-studio/experience-transcription-ui.test.ts, electron/main/subtitle-studio/bilingual-service.ts, test/subtitle-studio/bilingual-service.test.ts, test/subtitle-studio/helpers/transcription-ui-runtime.ts |
| 负责人 | admission_design |
| 依赖确认 | 已核对3855c2c在本地/远端一致；公共契约按design单写协调并在实际接入前交付，旧I1–I3能力可用 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-experience-02.md |
| 集成版本 | 3855c2c72bfa45740f248406f7266cf0342ae1f6加本轮未提交工作树；records/2026-09-13-experience.snapshot.json |

#### 实现要点

遵循design范围与前端设计基准；共享文件只有指定owner编辑，四locale由windows_baseline统一。实现后审阅实际Electron并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-EXPERIENCE-02-1 | integration | required | 偏好hydration/损坏/写失败、default false/提交快照/密钥不落盘，意图原子发布及崩溃恢复、重复/并发/取消/删除/重启/shutdown，真实转写到受控翻译链路与hover/环境行 | - |
| V-EXPERIENCE-02-2 | browser | required | 最终实际Electron renderer/preload/main与隔离数据，1280×860浅色和786×540深色，截图人工审阅并修复复验 | - |
| V-EXPERIENCE-02-3 | static | required | 两套TS/测试TS、四语、真实边界/相关来源、spec/diff及最终源码证据 | - |

### T-EXPERIENCE-03 静默刷新与译文工具条

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I5 |
| 需求 | R-EXPERIENCE-08, R-EXPERIENCE-09 |
| 验收 | AC-EXPERIENCE-08-1, AC-EXPERIENCE-08-2, AC-EXPERIENCE-09-1, AC-EXPERIENCE-09-2 |
| 依赖 | - |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/pages/Tools/Subtitle/SubtitleStudio/studio.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslationTask.tsx, src/services/subtitle-studio/refresh-coordinator.ts, test/subtitle-studio/refresh-coordinator.test.ts, test/subtitle-studio/acceptance-live-refresh-ui.test.ts |
| 负责人 | ipc_design |
| 依赖确认 | 已核对3855c2c在本地/远端一致；公共契约按design单写协调并在实际接入前交付，旧I1–I3能力可用 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-experience-03.md |
| 集成版本 | 3855c2c72bfa45740f248406f7266cf0342ae1f6加本轮未提交工作树；records/2026-09-13-experience.snapshot.json |

#### 实现要点

遵循design范围与前端设计基准；共享文件只有指定owner编辑，四locale由windows_baseline统一。实现后审阅实际Electron并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-EXPERIENCE-03-1 | integration | required | 事件单飞/追读、前台优先/不丢点击、查询revision删除卸载竞态；实际多批翻译MutationObserver证明无全页busy/无关disabled切换，正文读取次数、焦点滚动/提示/弹窗保留及工具条对齐 | - |
| V-EXPERIENCE-03-2 | browser | required | 最终实际Electron renderer/preload/main与隔离数据，1280×860浅色和786×540深色，截图人工审阅并修复复验 | - |
| V-EXPERIENCE-03-3 | static | required | 两套TS/测试TS、四语、真实边界/相关来源、spec/diff及最终源码证据 | - |

### T-EXPERIENCE-04 导出默认值与统一文档列表

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I5 |
| 需求 | R-EXPERIENCE-06, R-EXPERIENCE-07, R-EXPERIENCE-10 |
| 验收 | AC-EXPERIENCE-06-1, AC-EXPERIENCE-06-2, AC-EXPERIENCE-07-1, AC-EXPERIENCE-07-2, AC-EXPERIENCE-10-1, AC-EXPERIENCE-10-2 |
| 依赖 | - |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioExport.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioExport.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslationOverview.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslationOverview.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioBatchItems.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioBatch.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioSelectedDocuments.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioSelectedDocuments.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioScrollFade.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioScrollFade.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioDocumentList.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioDocumentList.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioPlanDocuments.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioPlanDocuments.css, electron/main/subtitle-studio/export-planner.ts, test/subtitle-studio/export-planner.test.ts, test/subtitle-studio/experience-export-ui.test.ts, test/subtitle-studio/acceptance-files-ui.test.ts, test/subtitle-studio/export-ui.test.ts, test/subtitle-studio/library-ui.test.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioRecovery.tsx, src/locales/ |
| 负责人 | windows_baseline |
| 依赖确认 | 已核对3855c2c在本地/远端一致；公共契约按design单写协调并在实际接入前交付，旧I1–I3能力可用 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-experience-04.md |
| 集成版本 | 3855c2c72bfa45740f248406f7266cf0342ae1f6加本轮未提交工作树；records/2026-09-13-experience.snapshot.json |

#### 实现要点

遵循design范围与前端设计基准；共享文件只有指定owner编辑，四locale由windows_baseline统一。实现后审阅实际Electron并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-EXPERIENCE-04-1 | integration | required | 默认值/零单多轨/错误轨拒绝/回退损失、折叠列表唯一/名称与选择稳定、渐变边缘/focus/长短空错态、真实跨目录导出与浅深窄窗截图 | - |
| V-EXPERIENCE-04-2 | browser | required | 最终实际Electron renderer/preload/main与隔离数据，1280×860浅色和786×540深色，截图人工审阅并修复复验 | - |
| V-EXPERIENCE-04-3 | static | required | 两套TS/测试TS、四语、真实边界/相关来源、spec/diff及最终源码证据 | - |
