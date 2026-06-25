# FusionKit 工具详情页 UI 统一 Execution Plan

> 日期：2026-06-25
> Feature Slug：`tool_detail_page_ui_standardization`
> 对应设计文档：`docs/tool-detail-page-ui-standardization-final-design.md`
> 范围：从字幕 AI 翻译页反向提取共享 UI，统一字幕转换、字幕提取、文件名翻译和长文本翻译详情页。
> 当前状态：设计已定稿，实施尚未开始。

---

## 1. 每次开发会话的使用方式

每次实现会话开始前，Agent 必须按顺序完成：

1. 完整阅读 `docs/tool-detail-page-ui-standardization-final-design.md`。
2. 完整阅读本执行计划。
3. 检查第 5 节进度台账和第 7 节依赖关系。
4. 认领一个最小可闭环工作包；只有强耦合且能在同一会话完整验证时，才同时认领多个工作包。
5. 检查 `git status --short`，保留用户现有改动，不覆盖无关文件。
6. 在编辑前声明：
   - 本次认领的工作包；
   - 预期改动文件；
   - 验证命令；
   - 明确不涉及的范围。

每次实现会话结束前必须：

1. 运行工作包要求的最小验证，或准确记录无法运行的原因。
2. 更新第 5 节进度台账。
3. 在 `docs/tool-detail-page-ui-standardization_implementation_records/` 新增或更新实施记录。
4. 只有代码、视觉、测试、文档和台账均符合工作包验收口径，才标记为 `已完成`。
5. 如果实现证明 Final Design 的假设不成立，先更新 Final Design，或创建 `feat/` / `fix/` 文档，不能静默偏离。
6. 写明下一次建议认领的工作包、遗留风险和验证缺口。
7. 回答用户前结束本次会话启动的全部 Vite、Electron 或其他前端服务进程。

不得把聊天上下文作为唯一交接信息；下一位 Agent 应只依赖设计文档、执行计划、实施记录和代码即可继续。

---

## 2. 状态规则

工作包状态只允许使用：

- `未开始`
- `进行中`
- `已完成`
- `阻塞`
- `废弃`

状态解释：

- `未开始`：尚未产生实现或验证工作。
- `进行中`：已修改代码或开展验证，但尚未满足完整验收口径。
- `已完成`：实现、验证、实施记录和台账已经闭环。
- `阻塞`：存在明确外部阻塞，当前会话无法继续推进。
- `废弃`：经设计更新确认不再实施，必须记录替代方案或原因。

禁止因为“主要 JSX 已经迁移”就提前标记完成。视觉基准未核对、前端进程未关闭、实施记录未写入时，工作包仍应为 `进行中`。

---

## 3. 总体推进原则

### 3.1 先保护基准，再扩大复用

推进顺序必须是：

1. 固化字幕 AI 翻译页的视觉基准和验收方式。
2. 从基准页提取共享组件，并让基准页视觉不变。
3. 使用字幕转换和字幕提取验证抽象不是单页特化。
4. 收敛文件名翻译页的外层布局和面板语法。
5. 分阶段迁移长文本翻译页。
6. 删除旧视觉组件并完成全页面回归。

长文本翻译页不能反向影响字幕 AI 翻译页的设计语言。

### 3.2 每个工作包保持可运行

- 不允许先大面积删除旧组件，再跨多个会话补新组件。
- 新组件应与对应消费者在同一工作包落地，避免长期存在无验证脚手架。
- 同一页面迁移未完成时，应保持 TypeScript 可编译和页面可打开。
- 如需阶段性兼容旧组件，必须在台账记录删除它的后续工作包。

### 3.3 视觉变更与业务变更分离

本功能原则上只修改视觉和组件组织。

若发现业务 bug：

- 不在当前 UI 工作包中顺手修改；
- 在 `docs/fix/` 或现有功能对应的 `fix/` 目录记录；
- 只有该 bug 阻塞 UI 迁移验证时，才创建独立 `FIX-*` 工作包。

### 3.4 抽象门槛

只有满足以下条件才抽取共享组件：

- 至少两个页面存在相同结构或稳定视觉语法；
- API 主要由 `children` / slot 组成；
- 不需要读取业务 store；
- 不需要理解业务状态枚举；
- 组件 API 比原始 JSX 更容易理解。

任务行若无法满足这些条件，应保留在业务页面，只复用 `ToolPanel`。

---

## 4. 里程碑

| 里程碑 | 达成条件 |
| --- | --- |
| M0 基准冻结 | `PRE-001` 完成，基准截图、尺寸、主题和可访问状态检查方式明确 |
| M1 共享骨架成立 | `UI-001` 完成，字幕 AI 翻译页使用共享组件且视觉无回归 |
| M2 字幕同族验证 | `UI-002`、`UI-003` 完成，三个字幕页不再复制核心页面壳、配置面板、上传区和任务面板结构 |
| M3 非字幕工具收敛 | `UI-004` 完成，文件名翻译页使用相同页面壳和紧凑面板语法 |
| M4 长文本统一 | `TEXT-001` 至 `TEXT-004` 完成，长文本翻译页使用基准视觉且业务能力不变 |
| M5 清理与发布验收 | `CLEAN-001`、`QA-001`、`QA-002` 完成，旧组件清理、自动化验证和视觉矩阵闭环 |

---

## 5. 进度台账

| ID | 状态 | 完成日期 | 标题 | 关键变更文件 | 验证 | 实施记录 | 未决问题 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PRE-001 | 未开始 | — | 视觉基准与验收合同冻结 | 基准页源码、实施记录 | Electron 默认/最小窗口，Light/Dark，DOM/可访问状态检查 | — | 需记录字幕 AI 翻译页基准，不改产品代码 |
| UI-001 | 未开始 | — | 共享紧凑骨架与字幕 AI 翻译页迁移 | `_shared/ui/*`、`SubtitleTranslator/index.tsx` | `tsc`、i18n、build、Electron 前后对比 | — | 依赖 PRE-001 |
| UI-002 | 未开始 | — | 字幕转换页迁移与文件入口组合件 | `_shared/ui/*`、`SubtitleConverter/index.tsx` | `tsc`、build、默认/最小窗口视觉核对 | — | 依赖 UI-001 |
| UI-003 | 未开始 | — | 字幕提取页迁移与抽象复核 | `_shared/ui/*`、`SubtitleLanguageExtractor/index.tsx` | `tsc`、build、三个字幕页对比 | — | 依赖 UI-002；决定是否需要 TaskRowShell |
| UI-004 | 未开始 | — | 文件名翻译页布局与面板统一 | `NameTranslator/index.tsx`、`components/*.tsx` | rename 测试、tsc、build、Electron 视觉核对 | — | 依赖 UI-001；建议在 UI-003 后实施 |
| TEXT-001 | 未开始 | — | 长文本配置栏迁移 | `TextTranslator/components/ConfigPanel.tsx`、`_shared/ui/*` | text 相关测试、i18n、tsc、build、配置状态核对 | — | 依赖 UI-003 |
| TEXT-002 | 未开始 | — | 长文本工作区入口与任务面板骨架迁移 | `TextTranslator/index.tsx`、`TaskPanel.tsx`、`_shared/ui/*` | text 相关测试、tsc、build、文件选择状态核对 | — | 依赖 TEXT-001 |
| TEXT-003 | 未开始 | — | 长文本任务行、状态、统计和操作收敛 | `TextTranslator/components/TaskPanel.tsx`、`_shared/ui/*` | text 相关测试、i18n、tsc、build、任务状态矩阵 | — | 依赖 TEXT-002 |
| TEXT-004 | 未开始 | — | 长文本恢复、响应式与多语言视觉回归 | `TextTranslator/*`、`src/locales/*/text.json` | 恢复路径、786×540、Light/Dark、zh/en/ja | — | 依赖 TEXT-003 |
| CLEAN-001 | 未开始 | — | 旧视觉组件、漂移 class 与文档收口 | `_shared/ui/*`、设计/执行计划 | `rg`、i18n、tsc、build、git diff check | — | 依赖 UI-004、TEXT-004 |
| QA-001 | 未开始 | — | 自动化回归与静态合同验收 | 相关测试、文档 | `pnpm test`、`pnpm run i18n:check`、`pnpm build` | — | 依赖 CLEAN-001 |
| QA-002 | 未开始 | — | 五个工具页 Electron 视觉验收 | 实施记录、必要的 fix 文件 | 5 页面 × 3 尺寸 × 2 主题，多语言抽样 | — | 依赖 QA-001 |

---

## 6. 工作包详情

## PRE-001：视觉基准与验收合同冻结

目标：在抽取共享组件前，将字幕 AI 翻译页当前视觉和可用状态记录为迁移基准。

实施范围：

- 使用开发 Electron 打开字幕 AI 翻译页。
- 记录以下窗口尺寸：
  - 默认 1080×786；
  - 最小 786×540；
  - 宽屏 1440px 左右。
- 检查 Light / Dark。
- 记录关键视觉合同：
  - 页面容器；
  - 320px 配置栏；
  - 配置面板头；
  - 上传区；
  - 摘要行；
  - 任务卡头；
  - 空状态；
  - 任务行；
  - 统计条。
- 记录当前 Tour 对视觉核对的影响；基准截图前应跳过或关闭 Tour。
- 将核对结果写入实施记录，不修改产品代码。

验收口径：

- 实施记录包含窗口尺寸、主题、页面状态和观察结论。
- 后续 UI 工作包可以明确判断“视觉无回归”。
- 视觉核对使用 Electron，而不是缺少 preload 的普通浏览器页面。
- 本次启动的 Vite/Electron 进程在会话结束前已关闭。

建议验证：

```text
git status --short
git diff --check
```

---

## UI-001：共享紧凑骨架与字幕 AI 翻译页迁移

目标：建立第一批共享视觉组件，并让字幕 AI 翻译页成为首个消费者。

实施范围：

- 重写 `ToolDetailLayout` 为 320px 基准双栏。
- 新增：
  - `ToolConfigPanel`
  - `ToolPanel`
  - `ToolConfigDivider`
  - `ToolFileDropZone`
  - `ToolSummaryLine`
- 将 `ToolField` 调整为 11px muted 标签和紧凑间距。
- 调整 `InfoHint` 和 `ToolOutputPathPicker` 的紧凑尺寸。
- 更新 `_shared/ui/index.ts`。
- 迁移字幕 AI 翻译页：
  - 页面外壳；
  - 配置卡；
  - 上传区；
  - 参数摘要；
  - 任务面板；
  - 保留原任务行、状态、handler、Tour target 和弹窗。

不涉及：

- 不修改 subtitle store、service、IPC 或任务类型。
- 不抽取通用业务任务状态。
- 本包不强制抽取 `ToolTaskRowShell`。

验收口径：

- 基准页迁移前后视觉无明显差异。
- 页面不再手写核心页面容器、双栏、配置 Card 和任务 Card 结构。
- Tour 仍能找到原 target。
- 所有字幕翻译操作和禁用条件保持不变。
- 1080×786 和 786×540 下无横向页面滚动。

建议验证：

```text
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

视觉验证必须在 Electron 中完成，并在回答前关闭服务进程。

---

## UI-002：字幕转换页迁移与文件入口组合件

目标：验证共享组件可支持第二个字幕工具，而不是字幕翻译页专用封装。

实施范围：

- 字幕格式转换页使用：
  - `ToolDetailLayout`
  - `ToolConfigPanel`
  - `ToolPanel`
  - `ToolConfigDivider`
  - `ToolField`
  - `ToolFileDropZone`
  - `ToolSummaryLine`
- 保留转换页特有字段、任务状态、任务详情和编辑弹窗。
- 若 `ToolFileDropZone` 在第二个消费者中暴露 API 问题，可在本包调整，但必须保持字幕翻译页视觉不变。

验收口径：

- 转换页与字幕翻译页共享页面和面板视觉语法。
- 文件格式、默认时长、去媒体后缀、输出路径、冲突策略行为不变。
- 上传 `.lrc/.srt/.vtt` 的 accept 和批量行为不变。
- 任务行、进度、编辑、打开位置、删除和全部开始行为不变。

建议验证：

```text
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

---

## UI-003：字幕提取页迁移与抽象复核

目标：完成三个字幕同族页面迁移，并基于三个真实消费者复核共享 API。

实施范围：

- 字幕语言提取页使用统一页面壳、配置面板、上传区、摘要行和任务面板。
- 保留保留语言、输出路径、冲突策略和提取任务逻辑。
- 对比三个字幕任务行，决定：
  - 是否新增轻量 `ToolTaskRowShell`；
  - 或明确任务行继续由业务页面拥有。
- 删除因三个页面迁移产生的重复辅助 class 或私有 wrapper。

验收口径：

- 三个字幕页核心外壳不再复制。
- 共享组件没有字幕专属 store、状态枚举或 i18n。
- 若不抽取任务行，实施记录必须说明拒绝过度抽象的原因。
- 三个页面的 Tour、拖放、编辑、任务进度和空状态保持可用。

建议验证：

```text
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

---

## UI-004：文件名翻译页布局与面板统一

目标：让不同工作流的工具页复用统一视觉语法，证明抽象没有绑定字幕任务模型。

实施范围：

- `NameTranslator/index.tsx` 使用统一 `ToolDetailLayout`，左栏从 340px 收敛为 320px。
- `PathPickerPanel`、`OptionsPanel` 使用 `ToolConfigPanel` 或共享紧凑面板。
- `PlanPreviewTable`、`ApplySummaryPanel` 使用 `ToolPanel`。
- 保留预览表格、风险确认、回滚、Agent planId 加载等业务专属结构。
- 调整最小窗口下表格和按钮布局，禁止整页横向滚动。

不涉及：

- 不修改扫描、翻译、apply、journal 或 rollback 业务逻辑。
- 不把 rename plan 转成通用 task 类型。

验收口径：

- 页面外壳和面板标题、间距、字号与字幕基准一致。
- 预览、编辑、跳过、验证、应用和回滚行为不变。
- 既有 rename 测试通过。

建议验证：

```text
pnpm exec vitest run src/store/tools/rename/useNameTranslatorStore.test.ts src/services/rename/nameTranslationPlanner.test.ts
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

---

## TEXT-001：长文本配置栏迁移

目标：将长文本翻译左栏改为字幕基准的紧凑配置面板，同时保留全部配置能力。

实施范围：

- `ConfigPanel.tsx` 改用：
  - `ToolConfigPanel`
  - `ToolField`
  - `ToolConfigDivider`
  - `ToolConfigDisclosure`
  - `InfoHint`
  - `ToolOutputPathPicker`
- 配置顺序按 Final Design 第 7.2 节执行。
- 核心设置常驻：
  - 语言；
  - 输出内容；
  - 执行模式；
  - 项目模式；
  - 切片 Token；
  - 并发数；
  - 输出设置。
- 只将提示工程高级字段放入紧凑 Disclosure。
- 上下文预算继续显示百分比、已需 Token、模型上下文和超限状态。

不涉及：

- 不修改 preferences 类型、默认值或持久化 key。
- 不修改 prepare/start 校验规则。
- 不迁移右侧工作区。

验收口径：

- 左栏宽度、标题、标签、控件高度和分隔与字幕基准一致。
- 所有原配置可编辑且 disabled 条件不变。
- Parallel/Sequential、Independent/Ordered、双语模式条件渲染不变。
- Select/Popover/Disclosure 内容不被裁剪。

建议验证：

```text
pnpm exec vitest run src/type/textTranslation.test.ts src/services/text/textTranslatorExecutionService.test.ts
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

---

## TEXT-002：长文本工作区入口与任务面板骨架迁移

目标：建立与字幕基准一致的右栏首屏结构。

实施范围：

- 上传区移出默认大 Card，改用 `ToolFileDropZone`。
- 新增 `ToolSummaryLine`，展示文件数、项目模式、执行模式、输出模式和模型状态。
- `TaskPanel` 外层改用 `ToolPanel`。
- 文件顺序列表进入任务面板 body。
- 卡头放置准备、开始、取消、恢复、工作区、清空和打开输出操作。
- 操作按钮使用紧凑尺寸并允许换行。

不涉及：

- 本包不完成任务行和指标卡的最终视觉迁移。
- 不改变文件读取、排序、prepare/start/cancel handler。

验收口径：

- 右栏首屏结构与字幕页一致：上传区 → 摘要行 → 任务面板。
- 单文件、多文件、拖放、选择和清除行为不变。
- 主要/次要按钮的可用条件与迁移前一致。
- 786×540 下卡头不造成整页横向滚动。

建议验证：

```text
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

---

## TEXT-003：长文本任务行、状态、统计和操作收敛

目标：移除长文本页独立指标小卡和底部两层操作区，完成工作区主体视觉统一。

实施范围：

- 当前任务和批量任务使用字幕任务行视觉：
  - 状态点；
  - 13px 主标题；
  - 10px 状态 Badge；
  - 11px 次级信息；
  - 行内图标操作；
  - 运行时 1px 进度条；
  - 可展开详情。
- 使用 `ToolStatBar` 替换 `ToolStatGrid` / `ToolStat`。
- 状态、阶段、文件数、分段数进入第一统计条。
- Token、成本、编码、置信度按信息层级进入次级摘要、详情或第二统计条。
- 删除 `TaskPanel` 对 `ToolActionBar` 和 `TooltipIconButton` 的依赖。
- 保留错误、无模型、Markdown 限制等 Alert。

验收口径：

- 空、准备中、等待、运行、完成、部分完成、失败、取消状态均有文本和颜色反馈。
- 进度、Token、成本和输出路径未丢失。
- 恢复、工作区、清空、打开输出等操作仍可达。
- 不再显示七个独立指标小卡。

建议验证：

```text
pnpm exec vitest run test/text-translation src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

---

## TEXT-004：长文本恢复、响应式与多语言视觉回归

目标：完成长文本迁移后的状态和桌面窗口收口。

实施范围：

- 验证 RecoveryDialog 打开、刷新、恢复、重启、删除和打开工作区。
- 检查 active task 与 queued task 切换。
- 检查最小窗口下：
  - 配置栏单列；
  - 卡头按钮换行；
  - 文件列表；
  - 路径截断；
  - Alert；
  - 弹窗。
- 检查 Light / Dark。
- 检查 `zh`、`en`、`ja`，必要时同步 `zh-Hant` 文案 key。
- 只修复迁移导致的 UI 问题，不修改任务协议。

验收口径：

- Final Design 第 8 节状态矩阵全部核对。
- 786×540、1080×786、1440px 宽度无明显布局回归。
- 多语言按钮和标题不溢出。
- 前端服务进程全部关闭。

建议验证：

```text
pnpm exec vitest run test/text-translation src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

---

## CLEAN-001：旧视觉组件、漂移 class 与文档收口

目标：删除迁移后无引用的旧视觉体系，防止未来新页面继续使用。

实施范围：

- 使用 `rg` 检查并按实际引用删除：
  - `ToolSection.tsx`
  - `ToolStat.tsx`
  - `ToolActionBar.tsx`
- 若部分内部逻辑已迁入新组件，确认只有一个公开语义。
- 清理 `_shared/ui/index.ts` 导出。
- 清理详情页残留的 340px 双栏和默认大 Card 标题样式。
- 检查无引用 i18n key；只有确认四语言均无引用时才删除。
- 更新 Final Design 的“计划文件”描述为真实结果。
- 更新本执行计划台账。

验收口径：

- `rg` 不再发现生产代码引用旧组件。
- 新工具详情页只有一套公开页面壳和面板语法。
- 不误删其他非工具页使用的基础组件或文案。

建议验证：

```text
rg "ToolSection|ToolStatGrid|ToolStat|ToolActionBar|TooltipIconButton" src
rg "lg:grid-cols-\\[340px_minmax\\(0,1fr\\)\\]" src/pages/Tools
rg "CardTitle className=\"text-base\"" src/pages/Tools
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

---

## QA-001：自动化回归与静态合同验收

目标：确认 UI 统一没有破坏现有工具业务。

实施范围：

- 运行完整测试。
- 运行 i18n、TypeScript 和完整 build。
- 检查共享组件边界：
  - 不读取 store；
  - 不调用 IPC；
  - 不内置工具业务文案；
  - 不依赖字幕或长文本状态类型。
- 检查工作区无意外生成物。
- 如发现回归，新增 `FIX-*` 工作包，不直接把 QA 标记完成。

验收口径：

- 完整自动化验证通过，或所有既有失败有可复现记录且确认与本功能无关。
- 设计、代码、执行计划和实施记录一致。

验证：

```text
pnpm test
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
git status --short
```

---

## QA-002：五个工具页 Electron 视觉验收

目标：完成最终产品视觉验收并关闭本功能。

实施范围：

- 在 Electron 中验证：
  - 字幕 AI 翻译；
  - 字幕格式转换；
  - 字幕语言提取；
  - 批量文件名翻译；
  - 长文本翻译。
- 尺寸：
  - 786×540；
  - 1080×786；
  - 1440px 左右宽屏。
- 主题：
  - Light；
  - Dark。
- 多语言抽样：
  - zh；
  - en；
  - ja；
  - zh-Hant 至少执行 i18n 静态检查。
- 检查页面头、320px 配置栏、面板标题、字段、上传区、任务卡头、空状态、任务行、统计条和底部导航。
- 发现问题时创建独立 `fix/` 文档和 `FIX-*` 工作包。

验收口径：

- 五个页面属于同一视觉体系。
- 字幕 AI 翻译页没有因抽象产生可见退化。
- 长文本翻译全部既有入口仍可达。
- 所有视觉问题已修复或明确记录为后续范围。
- 本次启动的全部前端服务和 Electron 进程已结束。

建议验证：

```text
pnpm run i18n:check
pnpm build
git diff --check
```

---

## 7. 依赖关系

```text
PRE-001
  -> UI-001
      -> UI-002
          -> UI-003
              -> TEXT-001
                  -> TEXT-002
                      -> TEXT-003
                          -> TEXT-004

UI-001
  -> UI-004

UI-004 + TEXT-004
  -> CLEAN-001
      -> QA-001
          -> QA-002
```

推荐严格按主链推进。

`UI-004` 可以在 `UI-003` 与 `TEXT-001` 之间实施；不建议与长文本迁移并行修改 `_shared/ui`，避免共享组件 API 同时漂移。

---

## 8. 不可违反约束

1. 字幕 AI 翻译页是唯一视觉基准。
2. 共享组件不得读取任一 Zustand store。
3. 共享组件不得调用 `window.ipcRenderer`。
4. 共享组件不得内置工具业务 i18n key 或默认中文文案。
5. 不得创建依赖大量 boolean props 的万能工具页组件。
6. 不得将字幕、转换、提取、文件名和长文本任务强制统一为一个业务类型。
7. 不得修改长文本翻译 IPC、持久化和任务状态合同。
8. 不得修改文件名翻译 apply、journal 和 rollback 安全合同。
9. 不得为了共享组件迁移破坏原 Tour target。
10. 不得让页面重新出现 340px 左栏或默认大 `CardHeader` 视觉。
11. 不得先删除旧组件再跨会话补齐消费者。
12. 删除文件前必须使用 `rg` 检查生产代码、测试和文档引用。
13. 普通浏览器缺少 Electron preload，不能作为最终交互验收环境。
14. 每次回答用户前必须关闭该会话启动的前端服务和 Electron 进程。

---

## 9. 验证分层

### 9.1 每个 UI 工作包

```text
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

按涉及领域补充最小测试。

### 9.2 长文本工作包

```text
pnpm exec vitest run test/text-translation src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

### 9.3 文件名工作包

```text
pnpm exec vitest run src/store/tools/rename/useNameTranslatorStore.test.ts src/services/rename/nameTranslationPlanner.test.ts
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

### 9.4 发布前

```text
pnpm test
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
git status --short
```

视觉验证必须记录：

- 页面；
- 窗口尺寸；
- 主题；
- 语言；
- 状态；
- 发现与结论；
- 已确认服务进程关闭。

---

## 10. 实施记录模板

每个会话结束前，在：

```text
docs/tool-detail-page-ui-standardization_implementation_records/
```

新增：

```text
YYYY-MM-DD_<工作包ID>_<short-title>.md
```

内容模板：

````markdown
# 工作包 <ID>：<标题>

## 基本信息

- 日期：
- 状态：已完成 / 部分完成 / 阻塞
- 对应执行计划工作包：

## 本次实现内容

-

## 修改文件

-

## 接口或数据结构变化

-

## 视觉核对

- 页面：
- 窗口尺寸：
- 主题：
- 语言：
- 页面状态：
- 结果：

## 验证结果

执行命令：

```text

```

结果：

-

## 前端进程清理

- 启动过的服务：
- 结束方式：
- 结束后进程确认：

## 未完成事项

-

## 下一步建议

-
````

---

## 11. Feat/Fix 文档规则

验收或实现过程中如发现新需求或回归：

- 新增能力写入：
  - `docs/feat/YYYY-MM-DD_tool_detail_page_ui_standardization_<short-title>.md`
- 缺陷修复写入：
  - `docs/fix/YYYY-MM-DD_tool_detail_page_ui_standardization_<short-title>.md`

文档至少包括：

- 观察到的行为；
- 根因或设计缺口；
- 预期行为；
- 受影响文件；
- 实现摘要；
- 验证命令和结果；
- 是否改变 Final Design 合同。

如果合同发生变化，必须同步更新 Final Design 和本执行计划。

---

## 12. 下一步建议

下一次实现会话优先认领 `PRE-001`：

1. 在 Electron 中冻结字幕 AI 翻译页的视觉基准；
2. 记录默认、最小和宽屏尺寸；
3. 关闭 Tour 后检查 Light/Dark；
4. 写入第一份实施记录；
5. 结束所有前端进程。

完成 `PRE-001` 后再认领 `UI-001`，开始共享组件和基准页迁移。
