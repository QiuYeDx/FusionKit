# page 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。
元数据引用需求与 AC，不复制 AC 文本。命令约定同 [module-data/tasks.md](../module-data/tasks.md)，另加：
- `TSC` = `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`（I3 起全仓类型检查应为 0 错误）。
- `UI` = 先 `node node_modules/vite/bin/vite.js build --mode=test` 与 `node scripts/check-preload-bundle.mjs`，再以 `FUSIONKIT_KNOWLEDGE_E2E=1` 运行对应 Electron 测试（默认静默窗口，不抢焦点）。

## I3 设计基准（开工前确定）

- 参照：字幕工作台文档库（`StudioDocumentLibrary`：12px 外边距、行内 8px、4px 行间、37px 单行 footer）与现有资料页侧栏 `NavigationRow`；工具页统一壳层 `ToolDetailLayout` + `ToolPageHeader` + `ToolPanel`（SmoothCorners 16/0.72，标题栏 12px）。
- 信息层级：侧栏 = 选哪个资料集；主区 = 当前资料集的头部（名称、方向、说明、编辑与更多）→ 视图 Tab（术语 / 说明，`ClipPathTabs` rounded sm smoothCorners）→ 一个 `ToolPanel`（工具条：本集搜索 + 批量粘贴；多选时换成操作条）。
- 术语表：CSS grid 行（选择 28px / 原词 1fr / 译法 1fr / 要求 96px / 启用 44px / 更多 28px），行高按内容（单行约 36px），长文本自然换行、各列顶部对齐；新增行常驻表尾，与数据行同列。窄屏（< 640px）为两列，要求与开关进入第二行。
- 说明：要求、背景两个区块；条目正文 13px/20px 保留换行；「重要」用 outline 小徽标；新增框为自增高 Textarea（Ctrl/⌘+Enter）。
- 抽屉：Radix Dialog 右侧滑出，宽 400px（窄屏全宽），Header 52px / 正文 12px / 字段 16px，底部固定「保存 / 删除」。
- 状态样本：空库；短/长资料集名；短/长原词（80 字英文与不可断标识符）；单行/6 行说明；停用行；多选操作条；抽屉；保存失败；撤销提示；中/英；亮/暗；1280×800、1600×1000、390×844。
- 删除：直接执行，提示条 10 秒内可撤销（资料集删除先确认，显示条目数与受影响预设数）。

### T-PAGE-01 页面骨架、数据流、侧栏与资料集

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-PAGE-01, R-PAGE-04, R-PAGE-07 |
| 验收 | AC-PAGE-01-1, AC-PAGE-01-2, AC-PAGE-01-3, AC-PAGE-01-4, AC-PAGE-01-5, AC-PAGE-04-1, AC-PAGE-04-2, AC-PAGE-04-3, AC-PAGE-07-2 |
| 依赖 | T-DATA-04 |
| 写集 | src/pages/TranslationKnowledge/index.tsx, src/pages/TranslationKnowledge/model.ts, src/pages/TranslationKnowledge/labels.ts, src/pages/TranslationKnowledge/use-library.ts, src/pages/TranslationKnowledge/KnowledgeSidebar.tsx, src/pages/TranslationKnowledge/GlobalSearch.tsx, src/pages/TranslationKnowledge/CollectionHeader.tsx, src/pages/TranslationKnowledge/CollectionDialog.tsx, src/pages/TranslationKnowledge/agent-context.ts, src/pages/TranslationKnowledge/agent-context.test.ts, 旧文件删除（architecture §7.8）, test/translation-knowledge/labels.test.ts, test/translation-knowledge/ui-model.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-DATA-04：同一工作树，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i3/T-PAGE-01.md |
| 集成版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

#### 实现要点

按设计基准与 [design](design.md) 实现：`use-library.ts` 持有快照、保存（`saveRecords`）、删除（`deleteRecords` + 10 秒撤销 `restoreRecords`）、外部变更事件；侧栏一层导航；全局搜索；资料集对话框（新建默认上次方向）；空库引导；窄屏资料集下拉；Agent 上下文改为当前资料集、可见与选中条目。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-PAGE-01-1 | unit | required | VT test/translation-knowledge/ui-model.test.ts test/translation-knowledge/labels.test.ts src/pages/TranslationKnowledge/agent-context.test.ts | - |
| V-PAGE-01-2 | static | required | TSC | - |

### T-PAGE-02 术语表、新增行、抽屉与批量粘贴

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-PAGE-02 |
| 验收 | AC-PAGE-02-1, AC-PAGE-02-2, AC-PAGE-02-3, AC-PAGE-02-4, AC-PAGE-02-5, AC-PAGE-02-6 |
| 依赖 | T-PAGE-01 |
| 写集 | src/pages/TranslationKnowledge/TermTable.tsx, src/pages/TranslationKnowledge/EntryDrawer.tsx, src/pages/TranslationKnowledge/BulkTermPaste.tsx, src/pages/TranslationKnowledge/term-paste.ts, test/translation-knowledge/term-paste.test.ts, src/pages/TranslationKnowledge/knowledge-page.css, src/components/ui/switch.tsx（新增可选 aria-label / data-testid） |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-PAGE-01：同一工作树，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i3/T-PAGE-02.md |
| 集成版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

#### 实现要点

行内编辑（双击 / Enter 进入，Enter 或失焦保存，Esc 取消；失败回滚并提示刷新）；要求与启用即时保存；新增行回车保存、焦点回到原词；抽屉编辑别名、备注、匹配方式、区分大小写并显示来源；批量粘贴预览新增 / 相同 / 冲突，可选覆盖冲突，一次事务写入；每页 100 条。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-PAGE-02-1 | unit | required | VT test/translation-knowledge/term-paste.test.ts | - |
| V-PAGE-02-2 | browser | required | UI test/translation-knowledge/electron.test.ts（新增行、行内编辑、冲突回滚、即时切换、抽屉焦点回归、批量粘贴、300 条分页） | - |

### T-PAGE-03 说明

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-PAGE-03 |
| 验收 | AC-PAGE-03-1, AC-PAGE-03-2, AC-PAGE-03-3 |
| 依赖 | T-PAGE-01 |
| 写集 | src/pages/TranslationKnowledge/NoteList.tsx |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-PAGE-01：同一工作树，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i3/T-PAGE-03.md |
| 集成版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

#### 实现要点

要求 / 背景两区块；新增框 Ctrl/⌘+Enter 保存，可勾「重要」；行内编辑正文，空正文不可保存；启用开关即时生效。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-PAGE-03-1 | browser | required | UI test/translation-knowledge/electron.test.ts（说明新增、重要、编辑、空正文提示、停用样式） | - |

### T-PAGE-04 多选、移动与删除撤销

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-PAGE-04, R-PAGE-05 |
| 验收 | AC-PAGE-04-4, AC-PAGE-05-1, AC-PAGE-05-2, AC-PAGE-05-3, AC-PAGE-05-4, AC-PAGE-05-5 |
| 依赖 | T-PAGE-02, T-PAGE-03 |
| 写集 | src/pages/TranslationKnowledge/SelectionBar.tsx, src/pages/TranslationKnowledge/CollectionDeleteDialog.tsx, src/pages/TranslationKnowledge/use-library.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-PAGE-02：同一工作树，其验证通过后继续；T-PAGE-03：同一工作树，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i3/T-PAGE-04.md |
| 集成版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

#### 实现要点

选择框、Shift 范围选择、全选当前页；操作条：启用、停用、移动到（仅同方向资料集）、删除；删除后 10 秒撤销；资料集删除确认显示条目数与受影响预设数；撤销冲突时提示且不部分恢复。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-PAGE-04-1 | browser | required | UI test/translation-knowledge/collection-maintenance-electron.test.ts（改写：批量停用、移动、删除撤销、资料集删除撤销含预设引用、撤销冲突） | - |

### T-PAGE-05 导入与导出

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-PAGE-06 |
| 验收 | AC-PAGE-06-1, AC-PAGE-06-2, AC-PAGE-06-3 |
| 依赖 | T-PAGE-01 |
| 写集 | src/pages/TranslationKnowledge/Exchange.tsx, src/pages/TranslationKnowledge/KnowledgeSkillDownload.tsx |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-PAGE-01：同一工作树，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i3/T-PAGE-05.md |
| 集成版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

#### 实现要点

导入：选择或拖入 → 预览各资料集（新增 / 合并 / 副本 / 跳过）与冲突方式、预设是否导入 → 完成后跳到第一个导入的资料集；非 v2 文件显示不支持的版本。导出：勾选资料集（默认当前）、包含停用、包含相关预设 → 警告 → 保存。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-PAGE-05-1 | browser | required | UI test/translation-knowledge/consumer-ux-electron.test.ts（改写：拖入 v2 包预览与导入跳转、非 v2 拒绝、同 id 合并默认、导出警告与取消） | - |

### T-PAGE-06 引导、文案与渲染审查

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I3 |
| 需求 | R-PAGE-01, R-PAGE-07 |
| 验收 | AC-PAGE-07-1, AC-PAGE-01-5 |
| 依赖 | T-PAGE-02, T-PAGE-03, T-PAGE-04, T-PAGE-05 |
| 写集 | src/pages/TranslationKnowledge/KnowledgeTour.tsx, src/locales/, scripts/check-i18n-usage.mjs（新增 --unused 报告）, test/translation-knowledge/workspace-layout-electron.test.ts, test/translation-knowledge/skill-download-electron.test.ts, test/dialog-motion.electron.test.ts, test/dialog-content-motion.electron.test.ts, test/tool-navigation.electron.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-PAGE-02：同一工作树，其验证通过后继续；T-PAGE-03：同一工作树，其验证通过后继续；T-PAGE-04：同一工作树，其验证通过后继续；T-PAGE-05：同一工作树，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i3/T-PAGE-06.md |
| 集成版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

#### 实现要点

引导 3 步；knowledge.json 改为新页面键（四语一致）；删除只服务旧页面的 Electron 测试（bulk-review、entry-dialogs、entry-scope-motion），其余改写。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-PAGE-06-1 | browser | required | UI test/translation-knowledge/workspace-layout-electron.test.ts test/translation-knowledge/skill-download-electron.test.ts（引导 3 步、窄屏下拉、无横向滚动） | - |
| V-PAGE-06-2 | manual | required | 按设计基准的样本截图审查（方向→结构→细节→交互→适配），记录问题与复验 | - |
