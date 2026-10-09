# HomeAgent 正式工具接入任务

### T-TOOLS-05 未指定设置跟随工具页

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I4 |
| 需求 | R-TOOLS-05 |
| 验收 | AC-TOOLS-05-1, AC-TOOLS-05-2, AC-TOOLS-05-3, AC-TOOLS-05-4, AC-TOOLS-05-5, AC-TOOLS-05-6 |
| 依赖 | - |
| 写集 | src/agent/tool-page-settings.ts, src/agent/tool-page-settings.test.ts, src/agent/tool-schemas.ts, src/agent/tool-schemas.test.ts, src/agent/tool-executor.ts, src/agent/tool-executor-translation.test.ts, src/agent/modern-tools.ts, src/agent/modern-tools.test.ts, src/agent/translation-slice-config.ts, src/services/name-translation/agentPlan.ts, src/agent/orchestrator.ts |
| 负责人 | audit_runtime |
| 依赖确认 | 基于本会话未提交改动；本批由单一会话依次执行，tool-executor.ts 仍按共享文件约定归 audit_runtime 写入 |
| 完成日期 | 2026-10-09 |
| 实施记录 | records/i4/T-TOOLS-05.md |
| 集成版本 | df64e8f + 本会话未提交改动 |

#### 实现要点
按本模块 I4 设计；保留覆盖策略原有用户明确要求校验。

#### 验证计划
| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-05-1 | unit | required | vitest run src/agent src/services/name-translation：三种来源、覆盖策略、输出位置例外、名称格式、工作台草稿 | - |
| V-TOOLS-05-2 | static | required | tsc | - |

### T-TOOLS-04 经典工具页面上下文

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I4 |
| 需求 | R-TOOLS-04 |
| 验收 | AC-TOOLS-04-1, AC-TOOLS-04-2, AC-TOOLS-04-3 |
| 依赖 | T-TOOLS-05 |
| 写集 | src/agent/classic-page-contexts.ts, src/agent/classic-page-contexts.test.ts, src/pages/AgentDock/ClassicPageContexts.tsx, src/App.tsx, src/locales/zh/home.json, src/locales/en/home.json, src/locales/ja/home.json, src/locales/zh-Hant/home.json, scripts/i18n-usage-manifest.mjs |
| 负责人 | root |
| 依赖确认 | T-TOOLS-05 已完成（records/i4/T-TOOLS-05.md），共用设置读取器 |
| 完成日期 | 2026-10-09 |
| 实施记录 | records/i4/T-TOOLS-04.md |
| 集成版本 | df64e8f + 本会话未提交改动 |

#### 实现要点
按本模块 I4 设计；不修改经典页面源文件。

#### 验证计划
| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-04-1 | unit | required | vitest run src/agent：五页快照投影、设置更新校验与前后值 | - |
| V-TOOLS-04-2 | static | required | tsc、check-i18n、check-i18n-usage | - |
| V-TOOLS-04-3 | browser | required | 由 T-WORKSPACE-08 在字幕翻译页验证面板页面名、建议与快照进入请求 | - |


### T-TOOLS-03 字幕工作台页面上下文与修订工具

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-TOOLS-03 |
| 验收 | AC-TOOLS-03-1, AC-TOOLS-03-2, AC-TOOLS-03-3, AC-TOOLS-03-4, AC-TOOLS-03-5 |
| 依赖 | T-RUNTIME-03 |
| 写集 | src/subtitle-studio/cue-revision-contract.ts, src/subtitle-studio/ipc-contract.ts, electron/main/subtitle-studio/cue-revision-service.ts, electron/main/subtitle-studio/index.ts, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, resources/speech-resources/provenance/current-integration-audits.v1.json, src/pages/Tools/Subtitle/SubtitleStudio/agent-context.ts, src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/locales/zh/studio.json, src/locales/en/studio.json, src/locales/ja/studio.json, src/locales/zh-Hant/studio.json, test/subtitle-studio/cue-revision.test.ts, scripts/subtitle-studio/boundaries.json, scripts/i18n-usage-manifest.mjs |
| 负责人 | root |
| 依赖确认 | T-RUNTIME-03 已完成（records/i3/T-RUNTIME-03.md），使用 useAgentPageContext 与 pageTools 契约 |
| 完成日期 | 2026-10-09 |
| 实施记录 | records/i3/T-TOOLS-03.md |
| 集成版本 | df64e8f + 本会话未提交改动 |

#### 实现要点
按本模块 I3 设计。`findCues` 为只读主进程方法，复用 `mentionsTerm`；页面工具只作用于当前打开的文档；修订预览预设与 `onSettled` 每次只回调一次；任何模式都不应用修订。`index.ts` 变化按 FK-PIT-0186 刷新审计。

#### 验证计划
| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-03-1 | unit | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/cue-revision.test.ts src/pages/Tools/Subtitle/SubtitleStudio：findCues 写法/编号/上限/版本冲突；快照无文档与有文档；read/find 工具投影；prepare 工具的受阻、空选区、预览已开、设置、取消与结果映射 | - |
| V-TOOLS-03-2 | static | required | tsc、check-i18n.mjs、check-i18n-usage.mjs、scripts/subtitle-studio/check-boundaries.mjs、check-preload-bundle.mjs、vitest run test/subtitle-studio-provenance | - |


### T-TOOLS-02 保留批量回执并校验准确转写范围

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TOOLS-02 |
| 验收 | AC-TOOLS-02-1, AC-TOOLS-02-2, AC-TOOLS-02-3 |
| 依赖 | - |
| 写集 | src/agent/modern-tools.ts, src/agent/modern-tools.test.ts, src/agent/prepared-actions.ts, src/agent/prepared-actions.test.ts, src/services/subtitle-studio/transcription-controller.ts, test/subtitle-studio/transcription-controller.test.ts |
| 负责人 | audit_tools |
| 依赖确认 | 同一161b109基线，receipt契约已记录design并交接UI；controller仅此任务写 |
| 完成日期 | 2026-10-03 |
| 实施记录 | records/i2/T-TOOLS-02.md |
| 集成版本 | 161b109 + records/i2/source-snapshot.json (432f739d9aaad6c65a05c15e505a22fa14ecc77832273bd15cb1c729ee5c8495) |

#### 实现要点
按本模块 I2 design 完整保留失败 data 与有限逐项回执；准确范围检查紧邻真实入队，默认工作台不变；三类资料分别分页。

#### 验证计划
| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-02-1 | unit | required | Vitest modern-tools/prepared-actions/transcription-controller：部分及全失败、过期与多余草稿零提交、分页二页完整性 | - |
| V-TOOLS-02-2 | static | required | tsc --noEmit 与 git diff --check | - |

### T-TOOLS-01 实现正式能力目录与会话绑定准备执行

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-TOOLS-01 |
| 验收 | AC-TOOLS-01-1, AC-TOOLS-01-2, AC-TOOLS-01-3, AC-TOOLS-01-4, AC-TOOLS-01-5, AC-TOOLS-01-6, AC-TOOLS-01-7 |
| 依赖 | - |
| 写集 | src/agent/capability-catalog.ts, src/agent/capability-catalog.test.ts, src/agent/modern-tools.ts, src/agent/modern-tools.test.ts, src/agent/prepared-actions.ts, src/agent/prepared-actions.test.ts |
| 负责人 | audit_tools |
| 依赖确认 | 基于已有固定 API；共享 registry 与 UI 由集成负责人组合 |
| 完成日期 | 2026-10-03 |
| 实施记录 | records/T-TOOLS-01.md |
| 集成版本 | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |

#### 实现要点

按 design.md 正式目录、现代工具和准备动作契约实施。回调仅内存保留，统一会话检查和同步 claim。复用 fixed API、Schema、转写 controller、翻译 overview，不增加 preload/main 权限。经典转写保留真实 File 选择，资料只读投影。导出 modernAgentTools 与 usePreparedActionsStore；写集外必要变更先协调。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-01-1 | unit | required | `node_modules/.bin/vitest run src/agent/capability-catalog.test.ts src/agent/modern-tools.test.ts src/agent/prepared-actions.test.ts`；正式范围、分页/参数、固定授权、执行模式、并发/会话/清理及敏感投影 | - |
| V-TOOLS-01-2 | static | required | `node_modules/.bin/tsc --noEmit` 和 `git diff --check`；其他模块失败记录归属，最终集成重跑 | - |
| V-TOOLS-01-3 | interface | required | 固定 API mock 验证 picker 取消、非 ok、reject、缺 API、旧草稿/配置改变、未知提交和 revision 过期不误报成功或重复提交 | - |
