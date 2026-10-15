# 外部 Agent 接入：活动记录 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。
元数据引用需求与 AC；不要复制 AC 文本。负责人可连续完成多个任务，但同一时刻只领一个。

### T-ACTIVITY-01 主进程记录与保存

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I5 |
| 需求 | R-ACTIVITY-01 |
| 验收 | AC-ACTIVITY-01-2, AC-ACTIVITY-01-4, AC-ACTIVITY-01-5 |
| 依赖 | - |
| 写集 | src/agent/external/activity.ts, src/agent/external/contract.ts, electron/main/external-agent/activity-log.ts, electron/main/external-agent/index.ts, electron/main/external-agent/renderer-bridge.ts, electron/main/external-agent/settings-store.ts, electron/preload/external-agent-api.ts, test/external-agent/activity-log.test.ts, test/external-agent/renderer-bridge.test.ts, test/external-agent/settings-store.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-15 |
| 实施记录 | records/i5/T-ACTIVITY-01.md |
| 集成版本 | - |

#### 实现要点

按 design.md「记录结构」「主进程记录与保存」实现：共享契约与 schema、`ActivityLog`（追加、折叠、裁剪、重写、清空、坏行）、调用包装（含只读档与窗口外的结果）、补充解析、会话开始 / 结束、通道与推送、`notices` 设置、preload。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ACTIVITY-01-1 | unit | required | node node_modules/vitest/vitest.mjs run test/external-agent：追加与读取、30 天与上限裁剪（3500 条）、坏行 / 超长行跳过、update / end / undone 折叠与重写、清空保留当前会话、写入失败不影响调用、补充不合法时丢弃、伪造 confirmationId 不被采信、只读档记录、`notices` 默认值与旧文件兼容 | - |
| V-ACTIVITY-01-2 | static | required | pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-ACTIVITY-02 渲染端补充与放行方式

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I5 |
| 需求 | R-ACTIVITY-01 |
| 验收 | AC-ACTIVITY-01-1, AC-ACTIVITY-01-2, AC-ACTIVITY-01-3, AC-ACTIVITY-01-5 |
| 依赖 | T-ACTIVITY-01 |
| 写集 | src/agent/external/activity-note.ts, src/agent/external/errors.ts, src/agent/external/host.ts, src/agent/external/store.ts, src/agent/external/confirmations.ts, src/agent/external/tools/, src/agent/external/activity-note.test.ts, src/agent/external/host.test.ts, src/agent/external/confirmations.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-ACTIVITY-01：同一工作树，主进程记录与通道测试通过后开发 |
| 完成日期 | 2026-10-15 |
| 实施记录 | records/i5/T-ACTIVITY-02.md |
| 集成版本 | - |

#### 实现要点

按 design.md「渲染端补充」实现：`ctx.note`、`confirmed()` 的放行方式与摘要（过滤字幕文字）、延后确认的结果上报、各工具的结果与引用、宿主附带补充。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ACTIVITY-02-1 | unit | required | node node_modules/vitest/vitest.mjs run src/agent/external：读取 / 你确认 / 已放行 / 自动档 / 拒绝 / 过期六种放行方式；拆分、插入、写入译文的补充不含字幕文字；条目上限与 more；延后确认允许 / 拒绝 / 过期的上报；转换、重命名、导出的结果与引用 | - |
| V-ACTIVITY-02-2 | static | required | pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-ACTIVITY-03 活动页面、标题栏指示、轻提示与设置入口

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I5 |
| 需求 | R-ACTIVITY-02, R-ACTIVITY-03, R-ACTIVITY-04 |
| 验收 | AC-ACTIVITY-02-1, AC-ACTIVITY-02-2, AC-ACTIVITY-02-3, AC-ACTIVITY-02-4, AC-ACTIVITY-02-5, AC-ACTIVITY-03-1, AC-ACTIVITY-03-2, AC-ACTIVITY-03-3, AC-ACTIVITY-03-4, AC-ACTIVITY-04-1, AC-ACTIVITY-04-2 |
| 依赖 | T-ACTIVITY-02 |
| 写集 | src/agent/external/activity-store.ts, src/agent/external/activity-store.test.ts, src/agent/external/activity-text.ts, src/agent/external/store.ts, src/pages/AgentDock/ExternalAgentHost.tsx, src/pages/ExternalAgentActivity/, src/App.tsx, src/constants/router.ts, src/pages/components/BottomNavigation.tsx, src/pages/components/AppTitleBar.tsx, src/pages/Tools/_shared/toolMeta.ts, src/pages/Tools/_shared/ToolPageHeader.tsx, src/pages/Setting/components/ExternalAgentConfig.tsx, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/pages/Tools/Subtitle/SubtitleStudio/navigation.ts, src/locales/, test/external-agent-activity.electron.test.ts, test/external-agent-settings.electron.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-ACTIVITY-02：同一工作树，补充与放行方式测试通过后开发 |
| 完成日期 | 2026-10-15 |
| 实施记录 | records/i5/T-ACTIVITY-03.md |
| 集成版本 | - |

#### 实现要点

按 design.md「活动页面（UI 设计基准）」「标题栏指示与轻提示」「设置页」「打开文档」实现；初版后真实渲染审查、修复并复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ACTIVITY-03-1 | unit | required | node node_modules/vitest/vitest.mjs run src/agent/external/activity-store.test.ts：未查看数（只计未询问的成功改动）、合并提示（5 秒内同一连接同一 id、计数）、在该连接活动页时不提示、`notices` 关闭不提示 | - |
| V-ACTIVITY-03-2 | browser | required | 运行 test/external-agent-activity.electron.test.ts（静默窗口、临时用户数据与临时目录，预置两天前的记录文件，真实 MCP 客户端）：指示出现与点击进入、已放行写入 3 次只出现一条合并提示与数字 3、查看后数字消失、筛选三种、实时追加、打开文档、撤销重命名、在文件夹中显示（读取主进程收到的路径）、只读档拒绝记录、重启后记录仍在、清空、记录文件不含译文与令牌、设置开关重启后保持、窗口不获取焦点 | - |
| V-ACTIVITY-03-3 | manual | required | 审阅上述测试生成的截图（活动页 1280×860 浅色中文与 900×700 深色英文、展开的转换 / 重命名 / 失败记录、空状态、标题栏指示三种状态、轻提示、设置页入口）：方向→结构→细节→交互→适配；修复后重拍复验 | - |
| V-ACTIVITY-03-4 | static | required | pnpm exec tsc --noEmit -p tsconfig.json；pnpm run i18n:check | - |

### T-ACTIVITY-04 I5 回归与文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I5 |
| 需求 | R-ACTIVITY-01, R-ACTIVITY-02, R-ACTIVITY-03, R-ACTIVITY-04 |
| 验收 | AC-ACTIVITY-01-1, AC-ACTIVITY-02-1, AC-ACTIVITY-03-1 |
| 依赖 | T-ACTIVITY-03 |
| 写集 | CHANGELOG.md, README.md, README.en.md, docs/TODO.md, docs/features/external-agent/, website/src/content.ts, .agents/skills/fusionkit-app/SKILL.md |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-ACTIVITY-03：同一工作树，活动页面端到端测试通过后回归 |
| 完成日期 | 2026-10-15 |
| 实施记录 | records/i5/T-ACTIVITY-04.md |
| 集成版本 | - |

#### 实现要点

外部 Agent 相关单元与 Electron 回归；CHANGELOG 0.5.0、README（中英）、外部 Agent README 验收清单、官网文案与 TODO。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ACTIVITY-04-1 | integration | required | node node_modules/vitest/vitest.mjs run src/agent test/external-agent --maxWorkers=4 --minWorkers=1；运行 test/external-agent*.electron.test.ts | - |
| V-ACTIVITY-04-2 | integration | required | 全量 node node_modules/vitest/vitest.mjs run --maxWorkers=4 --minWorkers=1（含 tsc、i18n:check、pretest 构建） | - |
