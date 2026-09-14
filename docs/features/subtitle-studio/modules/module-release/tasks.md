# I9 任务

协调负责人Codex root。共享工作树基线dec9010。任务状态仅在此维护。

### T-RELEASE-01 macOS原生资源

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I9 |
| 需求 | R-RELEASE-01 |
| 验收 | AC-RELEASE-01-1 |
| 依赖 | - |
| 写集 | scripts/subtitle-studio/transcription/runtime/, scripts/subtitle-studio/transcription/overwrite-native/, build/subtitle-studio-resources/, electron/main/subtitle-studio/transcription/shared-resources.ts, test/speech-resources/integration/smoke-startup.test.ts, test/speech-resources/integration/smoke-owner-admission.test.ts |
| 负责人 | implementation_health |
| 依赖确认 | dec9010已集成，固定构建源与模型可读 |
| 完成日期 | 2026-09-14 |
| 实施记录 | records/2026-09-14-release-native.md |
| 集成版本 | dec9010 + records/2026-09-14-release.snapshot.json |

#### 实现要点

新增工具保持固定副本与旧资产不变；签名后hash。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-RELEASE-01-1 | integration | required | 固定来源、runtime/addon、CPU/Metal正向探针、反例及PID清理 | - |

### T-RELEASE-02 启动遮罩回归

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I9 |
| 需求 | R-RELEASE-02 |
| 验收 | AC-RELEASE-02-1 |
| 依赖 | - |
| 写集 | electron/main/index.ts, electron/preload/index.ts, electron/preload/loading/, test/preload-loading-ui.test.ts, test/subtitle-studio/result-feedback-ui.test.ts |
| 负责人 | progress_docs |
| 依赖确认 | dec9010与现有构建可用 |
| 完成日期 | 2026-09-14 |
| 实施记录 | records/2026-09-14-release-loading.md |
| 集成版本 | dec9010 + records/2026-09-14-release.snapshot.json |

#### 实现要点

保持现有视觉契约，先复现诊断再修时序。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-RELEASE-02-1 | browser | required | 真实Electron重载/隐藏显示/结果套件和截图审阅 | - |

### T-RELEASE-03 打包入口与签名工具

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I9 |
| 需求 | R-RELEASE-03 |
| 验收 | AC-RELEASE-03-1, AC-RELEASE-03-2 |
| 依赖 | - |
| 写集 | package.json, scripts/packaging/, docs/features/subtitle-studio/records/2026-09-14-release-signing-readiness.md, scripts/subtitle-studio-provenance/copy.mjs, test/subtitle-studio-provenance/copy.test.ts |
| 负责人 | release_status |
| 依赖确认 | dec9010双资源配置已存在 |
| 完成日期 | 2026-09-14 |
| 实施记录 | records/2026-09-14-release-packaging.md |
| 集成版本 | dec9010 + records/2026-09-14-release.snapshot.json |

#### 实现要点

入口与签名工具先实施，最终实际包由root在资源就绪后验证。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-RELEASE-03-1 | integration | required | 入口/配置反例、签名保护、实际候选包验证及许可/平台条件记录 | - |

### T-RELEASE-04 真实流程与最终集成

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I9 |
| 需求 | R-RELEASE-01, R-RELEASE-03 |
| 验收 | AC-RELEASE-01-2, AC-RELEASE-03-3 |
| 依赖 | T-RELEASE-01, T-RELEASE-02, T-RELEASE-03 |
| 写集 | test/subtitle-studio-provenance/release-real-workflow.test.ts, test/subtitle-studio/helpers/release-real-workflow.ts, docs/features/subtitle-studio/README.md, docs/features/subtitle-studio/architecture.md, README.md, scripts/subtitle-studio/boundaries.json, scripts/subtitle-studio-provenance/current-composition-audits.json, resources/speech-resources/provenance/current-integration-audits.v1.json, .agents/skills/fusionkit-pitfall-guard/references/ |
| 负责人 | Codex root |
| 依赖确认 | T-RELEASE-01、T-RELEASE-02、T-RELEASE-03均已在当前共享工作树集成；按release.snapshot.json和实际app hash核对，双资源原生、最终加载构建及签名成品均通过 |
| 完成日期 | 2026-09-14 |
| 实施记录 | records/2026-09-14-release-closeout.md |
| 集成版本 | dec9010 + records/2026-09-14-release.snapshot.json |

#### 实现要点

生产链路隔离实测，真实服务与受控响应分别报告，成品签名和平台状态不混淆。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-RELEASE-04-1 | browser | required | 真实转写、文档重开、翻译、单批导出及截图审阅 | - |
| V-RELEASE-04-2 | static | required | 最终TS/i18n/边界/preload/来源/回归/spec/diff与进程清理 | - |
