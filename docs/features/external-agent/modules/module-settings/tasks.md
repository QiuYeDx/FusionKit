# 外部 Agent 接入：设置与接入体验 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。
元数据引用需求与 AC；不要复制 AC 文本。负责人可连续完成多个任务，但同一时刻只领一个。

### T-SETTINGS-01 配置片段、Skill 与安装能力

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-SETTINGS-03, R-SETTINGS-04 |
| 验收 | AC-SETTINGS-03-2, AC-SETTINGS-04-1, AC-SETTINGS-04-2 |
| 依赖 | T-BRIDGE-04 |
| 写集 | src/agent/external/client-configs.ts, src/agent/external/contract.ts, electron/main/external-agent/, electron/preload/external-agent-api.ts, .agents/skills/fusionkit-app/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-BRIDGE-04 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i3/T-BRIDGE-04.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i3/T-SETTINGS-01.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md「片段生成」「主进程补充 IPC」实现；编写随附 Skill。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SETTINGS-01-1 | unit | required | pnpm vitest run src/agent/external/client-configs.test.ts test/external-agent/skill.test.ts | - |
| V-SETTINGS-01-2 | static | required | 审阅 .agents/skills/fusionkit-app/SKILL.md：frontmatter（name、description）、前提、工作流、确认与错误处理，且不复制工具说明 | - |

### T-SETTINGS-02 设置分区与连接指示

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-SETTINGS-01, R-SETTINGS-02, R-SETTINGS-03, R-SETTINGS-04 |
| 验收 | AC-SETTINGS-01-1, AC-SETTINGS-01-2, AC-SETTINGS-01-3, AC-SETTINGS-01-4, AC-SETTINGS-01-5, AC-SETTINGS-02-1, AC-SETTINGS-02-2, AC-SETTINGS-03-1, AC-SETTINGS-03-3, AC-SETTINGS-04-1 |
| 依赖 | T-SETTINGS-01 |
| 写集 | src/pages/Setting/components/ExternalAgentConfig.tsx, src/pages/Setting/index.tsx, src/pages/Setting/settingNavigation.ts, src/pages/components/AppTitleBar.tsx, src/locales/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-SETTINGS-01 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i3/T-SETTINGS-01.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i3/T-SETTINGS-02.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

按 design.md「方案与取舍」中的 UI 设计基准实现设置分区与标题栏圆点；初版后真实渲染审查并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SETTINGS-02-1 | integration | required | pnpm vitest run test/external-agent-settings.electron.test.ts（开关与状态、端口冲突恢复、信任档位生效、令牌显示/复制/重置、片段复制内容、连接列表与断开、标题栏圆点、Skill 安装到临时 HOME） | - |
| V-SETTINGS-02-2 | browser | required | 同上测试生成 test-results/external-agent-settings/*.png（1280×860 与 900×700，浅/深色，中/英，含两个连接与长路径）；逐张审阅方向→结构→细节→交互→适配，修复后重拍复查 | - |
| V-SETTINGS-02-3 | unit | required | pnpm vitest run src/pages/Setting/settingNavigation.test.ts && pnpm i18n:check | - |

### T-SETTINGS-03 说明文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-SETTINGS-04 |
| 验收 | AC-SETTINGS-04-3 |
| 依赖 | T-SETTINGS-02 |
| 写集 | README.md, README.en.md, docs/features/external-agent/README.md |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-SETTINGS-02 已在同一工作树（基于 2d9f88c，未提交）完成，核验见 records/i3/T-SETTINGS-02.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i3/T-SETTINGS-03.md |
| 集成版本 | 未提交工作树（基于 2d9f88c） |

#### 实现要点

README 中英各加「外部 Agent 接入」小节；feature README 汇总接入方法、工具清单、安全边界与验收清单。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SETTINGS-03-1 | static | required | 审阅 README.md / README.en.md 小节内容与链接；pnpm vitest run test/projectMetadata.test.ts（README 结构检查，记录与本改动无关的既有失败） | - |
