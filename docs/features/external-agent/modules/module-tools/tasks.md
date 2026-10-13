# 外部 Agent 接入：工具面 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。
元数据引用需求与 AC；不要复制 AC 文本。负责人可连续完成多个任务，但同一时刻只领一个。

### T-TOOLS-01 外部工具宿主与活动存储

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-TOOLS-01 |
| 验收 | AC-TOOLS-01-1, AC-TOOLS-01-2, AC-TOOLS-01-3, AC-TOOLS-01-4 |
| 依赖 | T-BRIDGE-03 |
| 写集 | src/agent/external/host.ts, src/agent/external/store.ts, src/agent/external/errors.ts, src/agent/external/tools/index.ts, src/pages/AgentDock/ExternalAgentHost.tsx, src/App.tsx |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-BRIDGE-03 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i1/T-BRIDGE-03.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i1/T-TOOLS-01.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md「宿主」「活动存储」实现；脱敏逐个替换已配置的 Agent/任务模型 API Key。`ExternalAgentHost` 为无界面组件，挂在 `App.tsx` 中 `AgentDock` 旁。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-01-1 | unit | required | pnpm vitest run src/agent/external/host.test.ts（就绪、分派、未知工具、参数错误、异常脱敏与截断、取消、活动上限与会话清理） | - |
| V-TOOLS-01-2 | integration | required | pnpm vitest run test/external-agent.electron.test.ts（真实应用启动后主进程收到就绪，外部调用被分派到工具实现并回传真实数据） | - |

### T-TOOLS-02 首批读取工具

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-TOOLS-02 |
| 验收 | AC-TOOLS-02-1, AC-TOOLS-02-2, AC-TOOLS-02-3 |
| 依赖 | T-TOOLS-01 |
| 写集 | src/agent/external/catalog.ts, src/agent/external/tools/, src/agent/modern-tools.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-TOOLS-01 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i1/T-TOOLS-01.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i1/T-TOOLS-02.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md「工具目录」「工具实现」实现 `get_fusionkit_status` 与 `list_studio_documents`；从 `modern-tools.ts` 导出 `documentSummary`，不改其行为；工作台 API 访问与错误码转换在 `tools/studio.ts` 中独立实现。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-02-1 | unit | required | pnpm vitest run src/agent/external/tools/tools.test.ts（status 不含 Key/地址、工作台不可用时降级；列表映射与分页） | - |
| V-TOOLS-02-2 | integration | required | pnpm vitest run test/external-agent.electron.test.ts（导入夹具后列表与工作台一致、关键字过滤、空库 total=0；status 序列化结果不含合成 Key 与地址） | - |
| V-TOOLS-02-3 | unit | required | pnpm vitest run src/agent/modern-tools.test.ts src/agent/knowledge-tools.test.ts（导出改动不影响内置 Agent） | - |

### T-TOOLS-03 信任判定与应用内确认

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TOOLS-03 |
| 验收 | AC-TOOLS-03-1, AC-TOOLS-03-2, AC-TOOLS-03-3, AC-TOOLS-03-4, AC-TOOLS-03-5, AC-TOOLS-03-6 |
| 依赖 | T-TOOLS-02 |
| 写集 | src/agent/external/catalog.ts, src/agent/external/approval.ts, src/agent/external/confirmations.ts, src/agent/external/contract.ts, src/agent/external/host.ts, src/agent/external/tools/navigation.ts, src/pages/AgentDock/ExternalAgentConfirmDialog.tsx, src/pages/AgentDock/ExternalAgentHost.tsx, electron/main/external-agent/index.ts, electron/preload/external-agent-api.ts, src/locales/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-TOOLS-02 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i1/T-TOOLS-02.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i2/T-TOOLS-03.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md「I2：信任与确认」实现分类与放行组、主进程只读判定、approval 判定、确认存储与延后执行、`get_confirmation_result`、确认对话框与任务栏闪烁。对话框按设计基准实现后做渲染审查。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-03-1 | unit | required | pnpm vitest run src/agent/external/approval.test.ts src/agent/external/confirmations.test.ts | - |
| V-TOOLS-03-2 | integration | required | pnpm vitest run test/external-agent-tools.electron.test.ts（真实点击允许/拒绝/本次连接放行、只读拒绝、自动档 overwrite 必问、超时 pending 后允许取回结果、排队数量与默认焦点） | - |
| V-TOOLS-03-3 | browser | required | 同上测试生成 test-results/external-agent/confirm-*.png（1280×860 与 900×700，浅/深色，中/英，长路径、8 项以上、destructive、资料变更、排队 3 个）；逐张审阅方向→结构→细节→交互→适配，问题修复后重拍复查 | - |

### T-TOOLS-04 Studio 外部 Agent 轨道与 AI 译文写入

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TOOLS-06 |
| 验收 | AC-TOOLS-06-1, AC-TOOLS-06-3, AC-TOOLS-06-4 |
| 依赖 | - |
| 写集 | src/subtitle-studio/domain.ts, src/subtitle-studio/cue-edit-contract.ts, src/subtitle-studio/ipc-contract.ts, electron/main/subtitle-studio/index.ts, electron/main/subtitle-studio/cue-edit-service.ts, electron/main/subtitle-studio/translation-track-service.ts, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioExecutionRecord.tsx, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/services/subtitle-studio/cue-history.ts, src/locales/, resources/speech-resources/provenance/current-integration-audits.v1.json |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i2/T-TOOLS-04.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md「I2：Studio 新增写入能力」实现，并让会话撤销历史接收外部写入（`cueHistory.subscribe`，撤销标签「外部 Agent 写入 N 条译文」）；主进程 Studio 组合文件改后重登记审计。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-04-1 | unit | required | pnpm vitest run test/subtitle-studio/agent-track.test.ts（建轨、agent 写入、撤销、非 agent 轨道拒绝、上限、执行记录入口判定） | - |
| V-TOOLS-04-2 | unit | required | pnpm vitest run test/subtitle-studio/cue-edit.test.ts test/subtitle-studio/boundaries.test.ts test/subtitle-studio-provenance（既有工作台编辑、边界与溯源不回归） | - |

### T-TOOLS-05 文档读取、导入与译文工具

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TOOLS-04, R-TOOLS-05, R-TOOLS-06 |
| 验收 | AC-TOOLS-04-1, AC-TOOLS-04-2, AC-TOOLS-04-3, AC-TOOLS-05-1, AC-TOOLS-05-2, AC-TOOLS-06-1, AC-TOOLS-06-2, AC-TOOLS-06-3 |
| 依赖 | T-TOOLS-03, T-TOOLS-04 |
| 写集 | src/agent/external/catalog.ts, src/agent/external/instructions.ts, src/agent/external/tools/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-TOOLS-03 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i2/T-TOOLS-03.md；T-TOOLS-04 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i2/T-TOOLS-04.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i2/T-TOOLS-05.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md「I2：工具实现要点」实现 `read_studio_document`、`import_studio_subtitles`、`create_studio_translation_track`、`write_studio_translations` 与 `withDocumentAccess`；更新说明文本。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-05-1 | unit | required | pnpm vitest run src/agent/external/tools/studio-tools.test.ts | - |
| V-TOOLS-05-2 | integration | required | pnpm vitest run test/external-agent-tools.electron.test.ts（无模型配置下导入→读取→建轨→分批写入；重启后按 documentId 读取；工作台界面可见轨道、AI 未审校标记与一步撤销；非法文本整批拒绝；过期 revision） | - |

### T-TOOLS-06 导出与本地转写工具

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TOOLS-07, R-TOOLS-08 |
| 验收 | AC-TOOLS-07-1, AC-TOOLS-07-2, AC-TOOLS-07-3, AC-TOOLS-08-1, AC-TOOLS-08-2, AC-TOOLS-08-3 |
| 依赖 | T-TOOLS-05 |
| 写集 | src/agent/external/catalog.ts, src/agent/external/tools/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-TOOLS-05 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i2/T-TOOLS-05.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i2/T-TOOLS-06.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md 实现 `export_studio_document` 与 `start_studio_transcription`。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-06-1 | unit | required | pnpm vitest run src/agent/external/tools/export-transcription.test.ts（导出选项与阻断、有损项接受、overwrite 升级为破坏性；转写不可用、已有草稿、成功入队与自动翻译设置恢复） | - |
| V-TOOLS-06-2 | integration | required | pnpm vitest run test/external-agent-tools.electron.test.ts（双语导出到源文件夹并核对文件内容；自动档 overwrite 仍需确认、拒绝后文件不变；测试环境转写不可用时的错误码） | - |

### T-TOOLS-07 翻译资料、任务进度与打开页面

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TOOLS-09, R-TOOLS-10 |
| 验收 | AC-TOOLS-09-1, AC-TOOLS-09-2, AC-TOOLS-09-3, AC-TOOLS-10-1, AC-TOOLS-10-2 |
| 依赖 | T-TOOLS-03 |
| 写集 | src/agent/knowledge-tools.ts, src/agent/external/catalog.ts, src/agent/external/tools/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-TOOLS-03 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i2/T-TOOLS-03.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i2/T-TOOLS-07.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md 抽取翻译资料纯函数并实现三个资料工具、`get_studio_tasks` 与 `open_fusionkit_page`。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-07-1 | unit | required | pnpm vitest run src/agent/external/tools/knowledge-navigation.test.ts src/agent/knowledge-tools.test.ts | - |
| V-TOOLS-07-2 | integration | required | pnpm vitest run test/external-agent-tools.electron.test.ts（资料变更对话框允许后入库、拒绝不变；打开工作台后 currentPage 变化；转写任务读取的错误码） | - |
