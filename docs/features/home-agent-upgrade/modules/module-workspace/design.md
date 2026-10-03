# HomeAgent 工作区设计

## I2 实施前 UI/UX 基准
依据 ../../records/review-i2-plan.md，完整保留当前密度、组件与聊天主线。待办在前，终态折叠为历史，数量和失败提示常显；最新失败不能被折叠吞掉。历史 prepared 文案改为已创建准备操作，计划标注上次更新与只填草稿的检查入口。receipt 采用紧凑数量摘要与可展开逐项结果；有限 tasks/items 投影覆盖转写真实状态。

空态导入与能力入口同行；导出使用 typed 结果的四语言反馈。Studio 导航只带 documents/transcription view hint 并由目标页消费；不添加任务定位承诺。模式和输入有 AX 名称、focus-visible，操作结果用短 polite 提示。日志只在初次打开或原本位于底部时跟随，读旧日志时显示回到最新。root 所有 QA 脚本与最后 Electron 验收；UI agent 不写脚本。具体验收矩阵见 R-WORKSPACE-02 与 T-WORKSPACE-04。

历史“最新结果/失败”按动作实际状态更新时间排序；兼容没有 updatedAt 的旧展示 fixture 时退回创建次序。该时间仅描述显示顺序，不参与确认授权。

Electron 复审确认无模型导入后的固定底部区高于原 pb-44 预留；用 ResizeObserver 测量 composer.offsetHeight，使消息底部留白和回到底部按钮位置随真实高度变化，兼容提示/反馈/多行输入。稳定截图在 Motion 过渡完成后验收，不能以过渡帧或按钮聚焦前的日志 scrollTop 作为最终布局基准。

本文负责本轮首页的规划进度、能力发现、操作确认与执行回执。跨模块业务契约以 runtime/tools 模块及对应 TypeScript 类型为准。

## 现状与约束

首页目前已有单列对话、草稿、输入历史、停止生成、滚动跟随、模式选择、会话导入导出与日志。保留这些工作流与对话壳层。工具回执目前依靠 JSON 字段猜测展示，历史调用一律标为成功；首页也没有可持久化计划的展示和完整能力发现入口。

用户要求先设计后开发、补全经典和最新工具，不再新增实验性工具。工具分类取自 `src/pages/Tools/index.tsx`，本模块只消费 tools 模块给出的能力目录，不自行扩大分类。已有名称翻译入口保持兼容。

本轮设计依据为 `.agents/skills/fusionkit-ui-design/SKILL.md` 及其 `references/visual-contract.md`，实施与审稿流程采用 `qiuye-ui-quality`；真实 Electron 证据遵循项目 pitfall 中 FK-PIT-0001、0002、0009、0014。设计阶段阅读代码作为参照，尚未将其冒充渲染验收。

## 方案与取舍

### 用户任务与信息层级

主流程为：输入目标或拖入文件 → 看清支持能力与执行模式 → Agent 制定和更新步骤 → 阅读明确操作摘要 → 根据模式确认本次准备好的动作 → 获得执行状态及结果去向 → 必要时打开对应工具继续处理。

保留宽度 `max-w-2xl` 的对话列与现有底部输入区。新增区域按消息阅读顺序呈现：对话消息、当前计划、准备好的动作/结果、输入区。规划与回执使用完整对话列宽，普通用户/助手气泡沿用原样；不增加固定侧栏和第二个独立页面滚动区。计划不是新的固定顶部面板，避免挤占窄窗正文。

空状态的提示由旧三条字幕操作扩展为包含最新工作台的实际任务示例，并提供“可用工具”入口。输入区的能力入口在有对话时仍可达。目录可在 ScrollableDialog 内浏览；由业务目录决定列表，UI 翻译名称和说明。

### 计划面板

独立 `AgentPlanPanel` 接收 `AgentSession.plan`。其结构为目标、`已完成/总步骤` 摘要、可折叠步骤列表；目标自然换行，步骤序号/状态图标与正文顶部对齐。步骤状态为 `pending / in_progress / completed / blocked`，用图标与文字共同表达，不仅依赖色彩。正在进行的步骤轻度高亮，已完成显示勾选，受阻显示原因。没有计划时不出现占位框。

计划是运行时状态的只读投影；不从模型 Markdown 中提取计划，也不以工具成功次数推断步骤完成。`dependsOn` 是运行时契约，UI 不猜测或重新组织顺序。点击折叠仅改变本地展示，不能改动实际任务。重载后遵守 runtime 恢复状态，不显示没有执行主体的永久加载动画。

### 能力目录

独立 `AgentCapabilities` 使用能力模块的目录。紧凑列表每项展示名称、简短作用及支持程度/操作去向，提供对应工具页导航。分类不与任务成功状态混淆；导航可用不意味着任意数据已获执行权限。UI 不请求额外网络能力和麦克风，也不展示本轮未接入的实验性工具。目录入口具备文字或可访问名称，键盘可打开并恢复焦点。

### 待确认与结果

独立 `AgentPreparedActions` 仅展示当前 `sessionId` 的 action。逐项展示可信 `title / summary / toolKey` 与状态；`ready` 提供确认和取消，`running` 防止重复提交，`completed` 给出完成回执，`failed` 展示可换行错误与必要下一步，`dismissed` 明确未执行。动作范围由 prepared-action 记录决定，不能使用整个 store 的任务数替代。

确认调用 `confirmAction(id)`，取消调用 `dismissAction(id)`；组件不创建第二套业务执行逻辑。失败后保留摘要，是否重试由 service 的状态契约决定；不将“失败”按钮直接重新提交而绕过服务。所有操作均来自可信 store，不让模型任意 Markdown payload 获得执行权限。

旧执行 widget 也遵守同一边界：普通历史与助手 Markdown 使用只读操作 context，只允许有限工具页导航；底部真实待执行卡使用绑定当前会话及 pending 对象身份的独立 context。名称翻译仅允许匹配当前 planId 的成功工具结果获得操作 context，显示可信 live summary，并在点击时再次校验当前 plan 对象、planId、流式与已处理状态。渲染中的旧卡片不能借用另一批新任务的执行权限；`widget-actions.test.ts` 对这些授权边界独立验证。

历史工具调用通过 call ID 查找对应 tool result：失败显示失败，确实成功才显示完成；仍在流式运行的调用显示进行中，没有匹配结果的历史调用显示未完成。使用 HomeAgent 局部组件以避免改动共享 Markdown widget 影响其他页面。技术参数与原始结果可折叠查看，默认优先呈现操作摘要，不用大块 JSON 主导对话。

20 个已注册工具使用有限的四语言可读名称，技术函数名留在展开详情中。准备动作以有限 `summaryKey / summaryValues` 在渲染时翻译，切换界面语言后仍能看清准确文件范围；“加入任务队列”与任务处理完成分开表达。输入区工具栏保持与输入框相邻的普通文档流，避免从空状态进入对话时共享布局动画把工具栏投影到结果卡片上。

### 视觉与组件

复用 `Button` 的 `ghost / outline / default` 与 `size="sm"`、`Badge` 的 `outline`、`src/components/ui/accordion.tsx` 的细线箭头与键盘行为、`ScrollableDialog` 的统一正文滚动。新面板采用 `SmoothCorners` radius 16/smoothing 0.72 或一致的轻边框表面，语义 token 取 `background / card / muted / border / foreground / muted-foreground`。

面板外围 12px、列表行内 8px、离散行间 4px、块间 12px，避免统计项再各套一层卡片。靠角按钮到相邻两边的实际间距需等距，最终以渲染与几何测量复核。已有输入模式 selector 的 pill 语义保留，不转换为视图 Tab。新增功能不引入新字体、主题或依赖。

长目标、步骤、错误信息和操作摘要自然换行，外壳与内容列都允许收缩；技术长字符串采用局部 `overflow-wrap:anywhere`，不靠全局 overflow hidden 掩盖。786px 真实窄窗口里动作按钮可换行，保持主要动作可见；新增计划不改变 App ScrollArea 的滚动归属。减少动态效果偏好下取消新增旋转/位移动效，状态更新不用花哨过渡。

新增文案及 HomeAgent 所属名称翻译 widget 的用户可见文字覆盖 `zh / en / ja / zh-Hant`。工具名、状态名使用有限映射，避免任意动态 key。按钮、输入 placeholder、aria-label 和 title 同样纳入校验。

## 代码落点

- `src/pages/HomeAgent/index.tsx`：组件组合、输入区入口、call ID 结果状态映射与配置门禁。
- `src/pages/HomeAgent/components/AgentPlanPanel.tsx`：结构化计划展示。
- `src/pages/HomeAgent/components/AgentCapabilities.tsx`：能力目录与导航。
- `src/pages/HomeAgent/components/AgentPreparedActions.tsx`：当前会话操作确认与回执。
- `src/pages/HomeAgent/components/AgentToolCall.tsx`：真实调用状态及折叠参数。
- `src/pages/HomeAgent/components/AgentToolResult.tsx`、`action-error.ts`：有界结果摘要、实际任务状态、正确工具去向与已知失败说明。
- `src/pages/HomeAgent/widget-actions.ts`、`widget-actions.test.ts`：展示 context 与可信执行 context 隔离，以及会话、对象身份和 planId 边界测试。
- `src/pages/HomeAgent/components/NameTranslationPlanWidget.tsx`、`SessionLogViewer.tsx`：本轮契约兼容和文案。
- `src/locales/{zh,en,ja,zh-Hant}/home.json`：四语言有限键集。
- `scripts/home-agent-qa.mjs`：隔离 Electron 渲染与交互验收。

`src/agent/types.ts`、会话 store、目录和准备动作 store 由对应模块负责人维护，本模块不并行改动；共享 Markdown widget 目录不属于本模块写集。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-WORKSPACE-02 | 活动操作优先、历史和上次计划语义、空态导入、失败与阶段投影、有限导航、键盘焦点与日志阅读锚点、隔离Electron复验 |
| R-WORKSPACE-01 | 保留对话主流程，结构化计划、真实工具状态、能力发现及当前会话确认回执组成统一工作区；四语言与真实 Electron 验收闭环。 |

## 验证与风险

1. 先完成 TypeScript 类型检查、项目 Agent 相关测试与 `pnpm run i18n:check`。根 `vite build --mode=test` 同时构建 renderer/main/preload，随后执行 preload bundle check；不打包安装程序、不更新依赖。
2. QA 使用当前 test build 与独立 `--user-data-dir` 启动 Electron，在 `/#/` 首页运行；只在隔离 profile 写入 fixture 或拦截测试响应，不读取/修改用户实际会话和模型密钥。不以浏览器 mock 代替 Electron 验收。
3. 隔离历史 fixture 包含四步骤长目标、已完成/受阻/待处理混合状态、对应成功/失败工具调用、无结果历史调用、长中英混合文件名与无空格错误文本。脚本直接灌入隔离 profile，不将其记作会话导入 UI 测试。另通过真实 preload 服务导入本轮 SRT fixture，使用本地合成 SSE 驱动计划与准备动作，验证取消不入队、确认只启动指定任务；本地合成翻译响应完成该真实隔离任务，不涉及用户文件或外部模型质量。
4. 1280×860 浅色中文与 786×660 深色英文为核心矩阵；另检查日文/繁中关键入口和状态。主题写入后 reload 并确认 `html.dark`，截图前等待 `.app-loading-wrap` 与 `#app-loading-style` 全部消失。
5. 实际打开能力目录、展开/收起计划、检查错误回执、测试无配置发送门禁和停止状态；检查 keyboard focus、可访问名称、按钮禁用和错误文本。若测试使用程序构造状态，证据说明其不证明真实模型或业务服务已执行。
6. 测量对话/弹窗无横向溢出、最后回执不被固定 composer/导航遮挡、动作到卡片相邻边的留白；准备动作截图前断言工具栏底边到输入区上边距在 0–40px，模式选择器/发送按钮与输入区纵向中心对齐，并连续四次采样保持稳定，避免空态进入会话时错位或捕捉到输入胶囊过渡中间帧。滚动必须操作 `[data-slot="scroll-area-viewport"]`，用户向上阅读时更新不会强拉到底。
7. 亲自打开最终截图，按方向、信息结构、密度、边距、长文本、交互和窄窗顺序审阅，修复发现的问题并重跑受影响状态。生成截图本身不算审阅通过。
8. 脚本 finally 关闭 Electron，并确认本轮 profile 对应进程退出；不关闭用户原有实例。证据保存于 `test-results/home-agent/`，记录命令、最终文件快照及限制。

主要风险：现有首页依赖固定输入区与 App 内部 ScrollArea，新增内容需复核滚动和底部遮挡；持久化计划和导入旧会话由 runtime 负责清理中断状态；新 action 契约需在当前共享工作树实际可用后联调，不能仅凭协作消息宣布集成通过。
