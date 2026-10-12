# page 设计

I3 开始前按 frontend-quality 补齐渲染审查样本与具体数值，并调用 `qiuye-ui-quality` 做设计基准与渲染审查。以下是已确定的结构、组件与状态方案，供评审。

## 现状与约束

- 现页面（`src/pages/TranslationKnowledge/index.tsx`，613 行）的结构：
  - 侧栏：方案与风格、内容对象、全部资料、资料集、待确认、更多管理、导入导出、Skill、前往工作台；
  - 主区：三个标签加列表；
  - 编辑：模态对话框（条目编辑 4 个标签页、详情、目录编辑）。
- 可复用：`ToolDetailLayout` / `ToolPageHeader` / `ToolPanel`（工具页统一框架）、`ClipPathTabs`、`KnowledgeScrollList`（ScrollArea 封装）、`DialogTransition`、`useToolFileDropTarget`、`ErrorNotice`、`Pagination`、shadcn `Table` / `Checkbox` / `Switch` / `Select` / `DropdownMenu` / `Popover` / `Tooltip`、`sonner` toast。
- 已知坑（项目记忆）：
  - `rounded-2xl` token 失效，改用 SmoothCorners 或显式圆角；
  - Radix ScrollArea 内容是 `display: table`，截断需要给 `viewportProps` 的 className 加上 `[&>div]:!block`。

## 方案与取舍

### 用户与主流程

- 用户：做字幕翻译的个人用户；中频使用，每次翻译新作品前整理，翻译中随手补充。
- 首要操作：在某个资料集里快速增改术语。次要操作：写要求和背景、导入导出、整理（停用、移动、删除）。
- 主流程：
  1. 选中或新建资料集；
  2. 在术语表新增行连续录入；
  3. 切到说明写一两条要求；
  4. 去工作台勾选。

### 布局（宽屏 ≥ 1024px）

```
┌ ToolPageHeader：翻译资料 · 一句说明                                        (?) 引导 ┐
├ 侧栏 240/280px ───────────┬ 主区 ───────────────────────────────────────────────────┤
│ 🔍 搜索全部资料            │ 绝区零                         日语 → 简体中文   [✎][⋯]  │
│ ───────────────────────── │ 资料集说明（一行，超长省略，悬停看全部）                │
│ 📁 绝区零          31     │ [ 术语 31 ] [ 说明 4 ]                                  │
│    日→中                   │ ┌ ToolPanel ─────────────────────────────────────────┐ │
│ 📁 主播 A          12     │ │ 🔍 在本资料集中搜索          [批量粘贴]            │ │
│ ＋ 新建资料集              │ │ ☐ 原词        译法          要求    启用   ⋯       │ │
│ ▸ 已归档 (2)               │ │ ☐ checkpoint  存档点        必须    ●     ⋯       │ │
│ ───────────────────────── │ │ ☐ boss        首领          优先    ○ 已停用 ⋯     │ │
│ ⬇ 导入   ⬆ 导出            │ │ ＋ [原词……]  [译法……]      优先    ↵ 添加          │ │
│ 🧩 保存资料编写 Skill      │ │ 第 1/1 页                                          │ │
│ → 前往字幕工作台           │ └────────────────────────────────────────────────────┘ │
└───────────────────────────┴─────────────────────────────────────────────────────────┘
多选时，ToolPanel 顶部换成操作条：已选 3 项 · 启用 · 停用 · 移动到… · 删除 · 取消
抽屉（右侧 400px，Sheet 形态，覆盖主区右侧，不遮挡侧栏）：原词 / 译法 / 要求 / 别名（标签输入）/ 备注 / 匹配方式 / 区分大小写 / 来源（只读）/ 删除
```

- 窄屏（< 768px）：侧栏收为主区顶部的资料集 `Select` 加搜索按钮；表格列压缩为「原词 / 译法」两列，要求和开关移到行内第二行；抽屉宽度占满。
- 滚动归属：页面整体滚动；表格不单独设置固定高度（沿用现在去掉嵌套滚动的做法）；侧栏资料集列表超过 12 项时在列表内滚动。

### 组件与状态

| 组件 | 文件 | 复用 / 变体 | 状态 |
| --- | --- | --- | --- |
| 侧栏 | `KnowledgeSidebar.tsx`（重写） | 沿用 `NavigationRow`；`ToolPanel` | 加载中、空、有资料集、选中、已归档展开 |
| 全局搜索 | `GlobalSearch.tsx`（新） | `Popover` + `Input`；结果按资料集分组，最多 50 条 | 空查询、无结果、有结果；键盘上下选择、回车跳转 |
| 资料集头部 | `CollectionHeader.tsx`（新） | `DropdownMenu` | 普通、已归档（显示「已归档」徽标与取消归档按钮） |
| 术语表 | `TermTable.tsx`（新） | shadcn `Table`、`Select`（size sm）、`Switch`、`Checkbox` | 空、有数据、编辑中单元格、保存中（行内小 spinner）、保存失败（单元格红框 + 提示）、停用行、多选 |
| 新增行 | `TermTable` 内 | `Input` h-8 | 空、可提交、提交中、失败（保留输入） |
| 说明 | `NoteList.tsx`（新） | 两个区块各一个列表，`Textarea` 自增高 | 空（显示示例提示）、有数据、编辑中、多选 |
| 抽屉 | `EntryDrawer.tsx`（新） | `Dialog` 的侧滑变体，没有就基于 Radix Dialog 加 motion 实现 | 打开、保存中、失败、焦点回归 |
| 资料集对话框 | `CollectionDialog.tsx`（新） | `KnowledgeDialog`（现有） | 新建、编辑、方向变更提示 |
| 删除确认 / 撤销 | `DeleteUndo.tsx`（新） | `AlertDialog` 风格的 `KnowledgeDialog` + `sonner` toast（带动作按钮） | 确认中、撤销可用 10 秒、撤销失败 |
| 批量粘贴 | `BulkTermPaste.tsx`（改） | 现有预览逻辑 `term-paste.ts` | 解析、预览（新增 / 相同 / 冲突）、提交 |
| 导入 / 导出 | `Exchange.tsx`（重写） | `KnowledgeDialog` | 预览（含版本不符的拒绝）、决定、提交中、完成、过期 |
| 引导 | `KnowledgeTour.tsx`（改） | 现有 tour 组件 | 3 步 |

- **数据流**：页面持有 `snapshot`。保存一律走 `saveRecords`，成功后用返回的快照替换本地快照，同时广播 `KNOWLEDGE_CHANGED_EVENT`（沿用）。行内编辑做乐观显示，失败时回滚该单元格。
- **键盘**：
  - 表格内 ↑↓ 移动行焦点，Enter 编辑，Esc 取消；
  - 新增行内 Tab 在原词 → 译法 → 要求之间移动，Enter 提交；
  - 多选支持 Shift 加点击的范围选择。
- **文案**：用户可见的叫法统一为「资料集、术语、说明、要求、背景、启用 / 停用、预设」，不出现「条目、方案、对象、采纳、审核」。

### 渲染审查样本（I3 验证计划使用）

- 资料集名：短（「绝区零」）和长（「资料集 1 · 长名称与日中翻译方向的测试资料集合」）；
- 术语：短，加上长原词（约 80 字的英文长词组和不可断的长标识符）；
- 说明：单行与 6 行；
- 语言：中文 / 英文；主题：亮 / 暗；视口：1280×800、1600×1000、390×844；
- 状态：空库、多选操作条、抽屉打开、保存失败、撤销提示。

## 代码落点

architecture §7.8 中的全部文件，加上 `src/locales/*/knowledge.json`。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-PAGE-01 | 布局、侧栏、全局搜索、窄屏 |
| R-PAGE-02 | 术语表、新增行、抽屉、批量粘贴 |
| R-PAGE-03 | 说明 |
| R-PAGE-04 | 资料集头部、资料集对话框 |
| R-PAGE-05 | 多选操作条、删除确认 / 撤销 |
| R-PAGE-06 | 导入 / 导出 |
| R-PAGE-07 | 引导、agent-context |
| R-PAGE-08 | 文案扫描脚本 |

## 验证与风险

- Electron e2e（静默窗口）：重写 `test/translation-knowledge/electron.test.ts`、`workspace-layout-electron`、`materials-layout-electron`、`consumer-ux-electron`、`skill-download-electron`；删除 `bulk-review`、`collection-maintenance`、`entry-dialogs`、`entry-scope-motion`、`formal`（或改写为新流程）。
- 截图审查覆盖上述样本；修复后复验。
- 风险：行内编辑与乐观更新在 revision 冲突时容易出错。对策：每次保存都携带该行当前 revision；失败后回滚，并提示「资料已在别处修改，已刷新」，同时自动刷新快照。
