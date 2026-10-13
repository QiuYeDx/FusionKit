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

### T-SETTINGS-04 桌面版客户端指引与一键写入配置

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-SETTINGS-03 |
| 验收 | AC-SETTINGS-03-4, AC-SETTINGS-03-5 |
| 依赖 | T-SETTINGS-02 |
| 写集 | src/agent/external/client-configs.ts, src/agent/external/contract.ts, electron/main/external-agent/, electron/preload/external-agent-api.ts, src/pages/Setting/components/ExternalAgentConfig.tsx, src/locales/, README.md, README.en.md, docs/features/external-agent/README.md |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-SETTINGS-02 已在 ab031e0 提交并推送，核验见 records/i3/T-SETTINGS-02.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i3/T-SETTINGS-04.md |
| 集成版本 | 未提交工作树（基于 ab031e0） |

#### 实现要点

按 design.md「桌面版客户端与一键写入（变更 2026-10-13）」实现；变更依据见 changes/2026-10-13-desktop-clients.md。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SETTINGS-04-1 | unit | required | pnpm vitest run src/agent/external/client-configs.test.ts test/external-agent/client-config-writer.test.ts | - |
| V-SETTINGS-04-2 | integration | required | pnpm vitest run test/external-agent-settings.electron.test.ts（Claude 桌面端仅 stdio 与指引；写入预置的 claude_desktop_config.json、config.toml 后其他内容保留且有备份；损坏的 mcp.json 拒绝写入且不变；其他客户端逐项字段） | - |
| V-SETTINGS-04-3 | browser | required | 同上测试的 settings-claude-desktop-zh-light-1280、settings-other-fields-zh-light-1280、settings-claude-desktop-en-dark-900 截图审阅并修复复验 | - |

### T-SETTINGS-05 Cursor 桌面版一键添加

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-SETTINGS-03 |
| 验收 | AC-SETTINGS-03-6 |
| 依赖 | T-SETTINGS-04 |
| 写集 | src/agent/external/client-configs.ts, src/agent/external/contract.ts, electron/main/external-agent/index.ts, electron/preload/external-agent-api.ts, src/pages/Setting/components/ExternalAgentConfig.tsx, src/locales/, README.md, README.en.md, docs/features/external-agent/README.md |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-SETTINGS-04 已在同一工作树（基于 ab031e0，未提交）完成，核验见 records/i3/T-SETTINGS-04.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i3/T-SETTINGS-05.md |
| 集成版本 | 未提交工作树（基于 ab031e0） |

#### 实现要点

按 design.md「Cursor 桌面版一键添加（变更 2026-10-13 追加）」实现。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SETTINGS-05-1 | unit | required | pnpm vitest run src/agent/external/client-configs.test.ts（安装链接前缀、解码后与服务器项一致、中文路径） | - |
| V-SETTINGS-05-2 | integration | required | pnpm vitest run test/external-agent-settings.electron.test.ts（点「添加到 Cursor」后主进程打开的链接解码为当前地址与令牌；指引含 Customize） | - |
| V-SETTINGS-05-3 | browser | required | 审阅 settings-cursor-zh-light-1280 截图 | - |

### T-SETTINGS-06 Skill 通用安装目录更正

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-SETTINGS-04 |
| 验收 | AC-SETTINGS-04-1 |
| 依赖 | T-SETTINGS-01 |
| 写集 | src/agent/external/contract.ts, electron/main/external-agent/skill.ts, electron/main/external-agent/index.ts, src/pages/Setting/components/ExternalAgentConfig.tsx, src/locales/, docs/features/external-agent/README.md |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-SETTINGS-01 已在 ab031e0 提交并推送，核验见 records/i3/T-SETTINGS-01.md |
| 完成日期 | 2026-10-13 |
| 实施记录 | records/i3/T-SETTINGS-06.md |
| 集成版本 | 未提交工作树（基于 ab031e0） |

#### 实现要点

按 changes/2026-10-13-desktop-clients.md「更正：Skill 的通用安装目录」把第二个安装目标由 `~/.codex/skills` 改为通用的 `~/.agents/skills`。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-SETTINGS-06-1 | unit | required | pnpm vitest run test/external-agent/skill.test.ts（claude 与 agents 两个目标的路径、安装与覆盖） | - |
| V-SETTINGS-06-2 | integration | required | pnpm vitest run test/external-agent-settings.electron.test.ts（点「安装到通用目录」后 ~/.agents/skills/fusionkit-app/SKILL.md 存在且界面显示该路径，不创建 ~/.codex/skills） | - |
