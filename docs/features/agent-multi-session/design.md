# agent-multi-session 设计

需求见 [requirements.md](requirements.md)。本文只写当前增量 I1 的方案。

## 现状与约束

基线 `5cf4dba`。与会话有关的代码与它们对「当前会话」的依赖：

| 位置 | 现状 | 多会话后的问题 |
| --- | --- | --- |
| `src/store/agent/useAgentStore.ts` | 单个 `session` 加平铺的 `isStreaming / streamingText / activeToolCalls / tokenStats / sessionLog / pendingExecution / pendingNameTranslationPlan`；`resetSession` 整体替换；`persist` 只存 `executionMode` | 需要按会话分槽，且后台会话也要能被写入 |
| `src/agent/orchestrator.ts` | 模块级唯一 `activeTurn`；`ownsTurn` = 「活动回合且当前会话没变」；订阅到会话 id 变化即 abort；`queuedEvents` 只投递给当前会话 | 切换会话会中断回复；只能一个会话运行 |
| `src/agent/tool-executor.ts` | `executionFence` 与输出目录缓存以「当前会话 id」为准；`handlePostQueue` 写当前会话的 `pendingExecution`；读取用户原话用当前会话的消息；会话切换时清空缓存 | 后台回合的工具会读到/写到别的会话 |
| `src/agent/modern-tools.ts` | `context()` 取当前会话 id，`check()` 发现切换即 `agent_session_changed` | 同上 |
| `src/agent/planning-tools.ts` | `updatePlan` 写当前会话 | 同上 |
| `src/agent/prepared-actions.ts` | 确认/注册要求 `sessionId === 当前会话`；会话切换时作废其他会话的待确认操作 | 切回原会话时卡片已失效 |
| `src/agent/pipeline-watch.ts` | 当前会话变了就停止观察 | 切走后收不到转写完成回报 |
| `src/agent/session-io.ts`、`session-schema.ts` | 导出当前会话；导入替换当前会话；`event.kind` 枚举漏了 `revision_applied` | 含修订事件的会话导出即失败（既有缺陷，持久化后会让该会话无法保存） |
| `src/pages/HomeAgent/index.tsx`、`conversation.tsx`、`AgentDock/index.tsx` 等 | 全部订阅平铺字段 `state.session` 等 | 若改成按 id 取，所有消费方都要改 |

约束：安全模型不降级（授权只来自本会话用户亲手输入；界面事件不是授权；授权不跨重启）；主进程只接受应用自身主框架的调用；预加载包体检查；UI 测试静默窗口；中英文案齐全。

## 方案与取舍

### 1. 状态模型：会话槽 + 当前会话投影

`useAgentStore` 改为：

```ts
interface SessionSlot {
  session: AgentSession;          // 增加可选 title / titleSource / pinned
  isStreaming: boolean; streamingText: string; activeToolCalls: AgentToolCall[];
  tokenStats: TokenStats; sessionLog: AgentLogEntry[];
  pendingExecution: PendingExecution | null;
  pendingNameTranslationPlan: PendingNameTranslationPlan | null;
  unread: boolean;
}
interface AgentStore extends ActiveProjection {     // 投影：与旧字段同名
  activeSessionId: string;
  slots: Record<string, SessionSlot>;               // 已加载到内存的会话
  catalog: Record<string, AgentSessionMeta>;        // 全部已保存会话的目录（含未加载）
  executionMode: ExecutionMode;                     // 仍为全局，仍是唯一 persist 字段
  forSession(id): SessionActions;                   // 绑定到指定会话的同名动作
  // 旧动作保留原签名，作用于当前会话：addMessage、setStatus、updatePlan…
  createSession / activateSession / removeSession / renameSession / setPinned / clearAllSessions …
}
```

关键取舍：**保留平铺字段，作为当前会话槽的投影**。每次写某个槽时，若它是当前会话，同时更新同名平铺字段；切换会话时整体换投影。这样 HomeAgent、AgentDock、ConversationFeed、TokenStatsBar、SessionLogViewer、App 交接动画、ModelConfig 等十余处 UI 订阅一行不改，回归面集中在 store 与 orchestrator。代价是同一数据有两份引用，统一由内部 `patchSlot(id, fn)` 写入，禁止直接 `set` 平铺字段（单元测试覆盖投影一致性）。

另一个方案是让 UI 用 `useActiveSlot(selector)` 读槽、删除平铺字段：更「干净」，但要改所有消费方与 50 余处测试，收益只是少一份引用，不采用。

`forSession(id)` 返回与旧动作同名的绑定动作（addMessage、commitStepBatch、appendStreamingText、setStatus、updatePlan、interruptPlan、setPendingExecution、recordUsage、appendLog…）。orchestrator 与工具一律用 `forSession(turnSessionId)` 写；旧的无参动作等于 `forSession(activeSessionId)`，供 UI 使用。写一个不存在（已删除）的槽是空操作。

会话目录 `catalog` 只放列表所需元数据：

```ts
interface AgentSessionMeta {
  id: string; title: string; titleSource: "auto" | "generated" | "manual";
  pinned: boolean; createdAt: number; updatedAt: number;
  messageCount: number; preview: string;   // 最近一条用户/助手文字，截 120 字
  unreadable?: boolean;                    // 文件损坏，只能删除
}
```

已加载槽的元数据由槽实时推导并回写目录；未加载的会话只在目录里。运行中/未读状态只在槽里（运行态不落盘）。

空会话：`createSession()` 若当前会话已是空会话则直接返回它（AC-01-4）；空会话不入目录、不落盘；从空会话切走时删除该槽。

`updatedAt` 只在消息、计划变化时更新；`setStatus`、标题、置顶、未读、切换不改它，避免列表因查看或整理而跳动。

输入草稿：新增 `src/agent/session-drafts.ts`（内存 Map，按会话 id）。主页与面板在当前会话变化时把输入框内容存入旧会话、取出新会话的草稿（AC-01-3）。草稿不落盘，与现状「重载即清空」一致。

### 2. 回合与并发

orchestrator 由单个 `activeTurn` 改为 `turns: Map<sessionId, AgentTurn>`：

- `handleUserMessage(text, sessionId = 当前会话)`；`runTurn(sessionId, message)`：该会话已有回合则返回（事件则入该会话的队列）；不同会话可并行。
- `ownsTurn = turns.get(sid) === turn && 槽仍存在`。订阅改为「槽被删除即 abort」，不再因切换会话而 abort。
- 回合内所有写入经 `forSession(sid)`；系统提示词按 `sid` 构造（计划、准备好的操作、执行确认、重命名计划都取该会话的）。页面上下文仍在回合开始时固定。
- `abortCurrentStream()` 只停止当前会话；新增 `abortSessionTurn(id)` 与 `abortAllTurns()`（删除/清空用）。
- `queuedEvents` 改为按会话的队列；某会话回合结束后只取它自己的下一条。
- 后台会话提交助手消息时置 `unread = true`；`activateSession` 清除。
- 回合结束（正常、出错、停止）立即请求持久化刷新该会话；首次成功回合后触发标题生成（见第 5 节）。

**工具如何知道自己属于哪个会话**：新增 `src/agent/turn-context.ts`，orchestrator 在回合开始时 `bindTurnSession(turn.controller.signal, sid)`（WeakMap）。`createGuardedTools` 已把每次工具调用的 `abortSignal` 统一为回合的 signal，工具执行函数原本就收到这个 signal，于是 `sessionOfSignal(signal)` 即得会话 id，不必改动 AI SDK 工具签名。没有 signal 的直接调用（单测）回退到当前会话。

据此修改：

| 位置 | 改法 |
| --- | --- |
| `tool-executor.ts` `executionFence` | 以 `sessionOfSignal(signal)` 为准；判定「signal 已中止或该会话已删除」 |
| `tool-executor.ts` 读用户原话（覆盖意图、输入路径、重命名确认、自定义切片） | 读该会话槽的消息 |
| `tool-executor.ts` `handlePostQueue` | 新增 sessionId 参数，写该会话的 `pendingExecution` |
| `tool-executor.ts` 输出目录缓存 | 条目已带 sessionId；清理时机由「切换会话」改为「会话被删除」 |
| `modern-tools.ts` `context()` / `run()` | 同上；`check()` 在会话删除时抛 `agent_session_changed`（沿用错误码，免增文案） |
| `planning-tools.ts` | `forSession(sessionOfSignal(options.abortSignal)).updatePlan` |
| `prepared-actions.ts` | 注册/确认要求「会话存在」而非「是当前会话」；删除会话时作废其 ready 操作；日志写入所属会话；不再在切换时作废 |
| `pipeline-watch.ts` | 会话被删除才停止；完成后 `reportUiEvent(event, sessionId)` |
| `reportUiEvent(event, sessionId = 当前会话)` | 卡片（准备好的操作、执行确认、重命名计划）按卡片所属会话上报；页面事件（Studio 修订）仍报给当前会话 |
| `useAgentStore` `confirmNameTranslationPlan` | `isCurrent` 改为「该槽的 pending 仍是本次认领的对象」 |

并发的风险与处理：
- 两个后台回合同时弹原生选择器：Electron 对话框各自模态，用户逐个处理；选择器标题沿用工具原文案。概率低，不加全局锁（加锁会让一个会话因另一个会话等待选择而卡住）。
- 执行模式是全局的：后台回合按工具执行时的模式处理，与单会话时「回合中途改模式」的行为一致。
- 准备好的操作上限 `MAX_READY_ACTIONS = 12` 仍为全局，防止多会话无限堆积待确认授权。

### 3. 本地持久化

**格式**：每个会话一个文件 `userData/agent-sessions/<id>.json`，内容就是导出格式 `SessionExportData`（`version: 1`），`session` 中新增可选 `title`、`titleSource`、`pinned`。会话文件可直接被导入；旧版本应用导入时 zod 会剥离未知字段。另有 `index.json`（`{ version: 1, sessions: AgentSessionMeta[] }`）供启动时列表，不必解析每个大文件。

**主进程**（`electron/main/agent-sessions/`）：`AgentSessionRepository` + IPC，通道前缀 `agent-sessions:`，`list / load / save / remove / clear`。

- 所有操作排进同一条 Promise 队列，保证索引读改写不交错。
- `save({ meta, content })`：校验 id（`^[A-Za-z0-9_-]{1,100}$`）、meta（zod，标题 ≤ 200 字等）、内容 ≤ 8 MiB、能 JSON 解析且 `session.id === meta.id`；用 `electron/main/translation/atomic-file.ts` 的 `atomicWriteUtf8File` 写会话文件，再原子写索引。
- `list()`：读索引并与目录核对：索引中文件已不存在的条目去掉；有文件无条目的，解析该文件补条目，解析失败标 `unreadable`。索引缺失或损坏时全量重建。
- `load(id)`：校验 id 与大小后返回字符串；渲染进程用 `parseSessionJson` 校验（与导入同一把尺子）。
- `remove(id)`、`clear()`：删文件、更新索引。
- 调用方限制同 `web-lookup`：`BrowserWindow.fromWebContents(sender)` 且来自主框架，否则 `{ ok: false, error: "agent_sessions_blocked" }`。

**预加载**：`electron/preload/agent-sessions-api.ts` 暴露冻结的 `window.agentSessions`，契约放 `src/agent/session-store-contract.ts`（通道名、类型、结果联合），旧版通用 `ipcRenderer` 桥拒绝该前缀（同 `assertLegacyWebLookupChannelAllowed`）。

**渲染进程**（`src/agent/session-persistence.ts`）：
- 启动时 `list()` 填入 `catalog`；当前会话为新空会话（AC-04-6）。
- 订阅 store：某槽的 `session`、`tokenStats`、`sessionLog` 引用或标题/置顶变化，且有消息时，为该会话安排 800 ms 去抖保存；回合结束、重命名、置顶时立即保存。同一会话的保存串行，只发最新快照。
- 序列化前若超过 8 MiB，先丢弃最旧的日志条目的 `data` 明细，再丢弃最旧日志条目，仍超限则报 `too_large`。
- 失败只记录到槽的 `saveError` 并在侧栏底部显示不打断的提示，含重试；会话仍在内存可用（AC-04-5）。
- 打开未加载的会话：`load` → `parseSessionJson` → 槽化（保持原 id；`status` 置 idle；计划中 `in_progress` 改 `pending`；`pendingExecution`、`pendingNameTranslationPlan` 为空——授权不跨重启）。失败则在目录里标 `unreadable` 并提示。
- 主进程不可用（单测、旧预加载）时降级为仅内存，不报错。

修复既有缺陷：`session-schema.ts` 的 `event.kind` 补上 `revision_applied`，并加入覆盖所有 `AgentUiEventKind` 与 `AgentLogEntryType` 的往返测试，防止以后新增种类时持久化失效。

已加载会话在本次运行中不卸载（典型会话远小于上限）；若之后发现内存问题，再按最近使用卸载空闲槽。记为风险，不预先实现。

### 4. 会话管理与导入导出

- `renameSession(id, title)`：去首尾空白、合并空白、≤ 80 字；空串视为取消；`titleSource = "manual"`。
- `setPinned(id, pinned)`；`removeSession(id)`：先 `abortSessionTurn`，作废其准备好的操作与缓存授权，删除槽、目录条目与文件；若删的是当前会话，切到新空会话。
- `clearAllSessions()`：`abortAllTurns()`，作废全部准备好的操作，`clear()` 磁盘，重置为一个新空会话。
- 导出：`exportSession(id = 当前)`，未加载的会话先加载；文件名沿用 `agent-session-<创建时间>.json`。
- 导入：`importSession()` 解析后**新建**一个会话槽（新 id，保留文件中的标题；没有标题时按首条用户消息截取，`titleSource = "auto"`），切换过去并立即保存；执行模式仍强制 `queue_only`（现有规则）。
- 列表排序与分组（纯函数 `groupSessions(metas, now, query)`，单测覆盖）：置顶组按 `updatedAt` 降序；其余按本地日期分「今天 / 昨天 / 近 7 天 / 更早」；搜索对标题与摘要做不区分大小写的包含匹配，搜索时仍保留分组。

### 5. 标题

`src/agent/session-title.ts`：

- `excerptTitle(text)`：取首个非空行，合并空白，按字素（`Intl.Segmenter`，不可用时按码点）截到 24 个字素，超出加「…」。用户发出会话首条**亲手输入**的消息时设置，`titleSource = "auto"`（AC-06-1）。
- `generateSessionTitle(sid)`：条件为 `titleSource === "auto"`、本运行中未尝试过、回合正常结束且有助手文字。用当前 Agent 配置与适配器 `streamTurn` 发一个**不带工具**、`maxSteps = 1`、`maxOutputTokens = 60`、20 s 超时的请求。指令以固定前缀 `You name conversations.` 开头（端到端模拟服务据此识别），输入为首条用户消息与首轮助手文字（各截 1000 字）。要求用用户的语言给出不超过 20 个字符的标题，不加引号与句末标点。
- 清洗：去引号、书名号外的包裹符号、句末标点与换行，截到 32 个字素；为空或全为标点即失败。
- 写入前再查一次 `titleSource`：已是 `manual` 则丢弃（AC-06-3）。成功则 `titleSource = "generated"`。
- 用量：以 `recordUsage(..., { keepContext: true })` 计入该会话累计 token 与费用，不改 `lastPromptTokens`（上下文占用条只反映对话本身）；日志记 `usage`。
- 失败、超时、会话被删除：保留截取标题，日志记 `status_change: title_failed`，不打扰用户；首轮失败或被停止的会话在之后第一次成功回合再尝试一次（AC-06-4）。

为什么用 Agent 模型而不是任务模型：用户明确要求；且这是 Agent 会话的附属请求，配置齐全时一定可用。

### 6. 界面设计基准

设计流程：本节按 `qiuye-ui-quality`（`C:\Users\Administrator\.claude\skills\qiuye-ui-quality\SKILL.md`）先定参照与空间关系，实施前读了其 `references/failure-catalog.md` 的 A、B1、C、D、F/F1 条目；初版后按其审稿顺序截图审查。

**用户与流程**：同一个人反复使用；典型规模几个到几百个会话；主要操作是「新建」「回到刚才那个会话」「找到某次处理某部作品的会话」，次要是重命名、置顶、删除。会话列表是导航，不是主工作区：在主页上它不能挤占对话栏，在悬浮面板里它必须按需出现。

**视觉参照**：
- 主页对话栏：`src/pages/HomeAgent/index.tsx`，内容列 `max-w-2xl mx-auto`（672 px），工具栏按钮 `h-7 rounded-full text-xs text-muted-foreground/60`。
- 悬浮面板：`src/pages/AgentDock/index.tsx`，平滑圆角 `smoothCorners(20, 0.72)`、头部 `DockIconButton`（`size-7 rounded-md`，Tooltip 350 ms）。
- 列表行：字幕工作台文档列表（`ce93424` 改版后的 ScrollArea 列表）的行高与悬停表面。
- 组件：`components/ui/scroll-area.tsx`、`input.tsx`、`dropdown-menu.tsx`（行内菜单）、`popover.tsx`（面板切换器）、`dialog.tsx`（删除/清空确认）、`tooltip.tsx`、`qiuye-ui/smooth-corners`。图标用 lucide：`SquarePen`（新对话）、`PanelLeftClose / PanelLeftOpen`（收起/展开）、`Search`、`Pin`、`MoreHorizontal`、`Pencil`、`Upload`（导出，沿用现有导出图标）、`Trash2`、`Loader2`。

**主页侧栏布局**：
- 位置：`fixed left-4 top-14 bottom-4`，宽 248 px；在标题栏下方，底部导航居中不会与之相交（最窄常驻宽度 1000 px 时，底部导航左缘约在 338 px，侧栏右缘 264 px）。常驻展开时，主页对话内容居中于侧栏右侧的空间（见下文「内容随侧栏居中」）；交接动画读取的是对话栏的实际位置，所以仍然准确。
- 常驻阈值：内容居中于侧栏右侧后，`窗口宽 − 264 ≥ 672 + 2 × 32` ⇒ 窗口宽 ≥ 1000 px 时常驻（原按整窗居中推出 1216 px，2026-10-12 用户确认下调）；否则收起为左上角的两个图标按钮（展开侧栏、新对话），展开时以浮层出现，带与悬浮面板一致的阴影，点外部/Esc/选中会话关闭，焦点回到触发按钮。宽屏下用户可手动收起，偏好存 `localStorage("fusionkit-agent-sidebar-collapsed")`，读写包 try/catch。
- 展开/收起为容器变形（2026-10-12 用户反馈后改，按 motion-recipes Case 7 策略 A）：收起态与展开态是同一个容器 `agent-sessions-shell`。收起时它只包住两个按钮（76×44），展开时以无回弹 spring（0.42 s）长成 248 px 宽的列表，收起时缩回原处。「新对话」「展开/收起」两个按钮始终是同一组元素，固定在容器右上角，随容器边缘连续移到列表头部再移回；展开/收起图标在同一按钮内交叉淡化。这样达到共享元素过渡的效果，又不用 `layoutId` 的缩放投影，文字和边框不会变形。背景与边框层随容器淡入（0.16 s），收起时延后 0.16 s 再淡出。标题、搜索和列表展开时延后 0.08 s 淡入并下移 4 px 归位，收起时先在 0.12 s 内淡出；内容宽度固定，由容器裁切，不随宽度重排。宽屏收起与窄屏浮层用同一个容器，区别只在阴影、遮罩与高度。
- 按钮 Tooltip：点击后，以及 FusionKit 把焦点移回按钮时（Esc 关闭浮层），在指针离开按钮前不显示 Tooltip。
- 内容随侧栏居中（2026-10-12 用户反馈后加）：侧栏常驻展开时，主页的欢迎视图、消息栏、底部输入区与「回到底部」按钮整体右移 (16 + 248) / 2 = 132 px，居中于侧栏右侧的剩余空间；收起后回到窗口中心。移动量是一个共享的 MotionValue（`src/pages/HomeAgent/home-layout.ts` 的 `homeContentShift`），由侧栏用与容器相同的 spring 驱动，两者同步。使用 `x` 而不是改 padding，以免与欢迎视图已有的 `layout` 动画冲突。窄屏浮层浮在页面之上，不移动内容。底部导航与标题栏属于全局外壳，仍按窗口居中。从悬浮面板回到主页的交接动画按 `predictHomeContentShift` 预测右移后的目标位置。
- 表面：常驻时为安静的面板——`bg-background`、`border border-border/60`、平滑圆角 16 / 0.72、无阴影，避免与对话栏抢视觉；浮层时同一表面加阴影。
- 结构（自上而下）：头部 40 px（「会话」`text-sm font-medium` + 右侧新对话、收起两个 `size-7` 图标按钮，靠右上角的按钮到面板上、右内边界等距 8 px）；搜索框 `h-8`，左侧放大镜，与行左缘对齐；ScrollArea 列表填满剩余高度；底部仅在保存失败时出现提示条（文案 + 重试）。
- 分组标题：`text-xs text-muted-foreground`，与行文字左缘对齐，组间距 12 px。
- 行：高 32 px，`px-2.5`，平滑圆角 10，行间 2 px（离散项，避免当前项与相邻悬停项连成一块，见 F 条）；标题 `text-[13px]` 单行省略，`min-w-0`；当前会话 `bg-accent text-foreground font-medium`，悬停 `bg-accent/60`；完整标题通过 Tooltip（延迟 500 ms，与行左对齐、`max-w-72`、`overflow-wrap:anywhere`）与 `aria-label` 提供。
- 行尾 20 px 固定槽：运行中 `Loader2 size-3.5 animate-spin`、未读 `size-1.5 rounded-full bg-primary`、置顶不另加图标（已在置顶组）；悬停或键盘聚焦时同一槽换成 `MoreHorizontal` 菜单按钮，标题宽度不变、不跳动。菜单项：重命名、置顶/取消置顶、导出、删除（destructive 色，前有分隔线）。
- 重命名：行内变为 `Input h-7`，全选原标题；Enter/失焦提交，Esc 取消，空串视为取消。
- 删除确认：小型 Dialog 卡片（标题「删除这个会话？」、说明含会话标题且写明不可恢复、右下「取消」「删除」），正在回复的会话说明会先停止回复。
- 空状态：无历史会话时列表区显示一行 `text-xs text-muted-foreground`「还没有会话记录」；搜索无结果显示「没有匹配的会话」。

**悬浮面板切换器**：头部标题区（原「FusionKit Agent」）变为按钮：会话标题（空会话显示「新对话」）+ `ChevronDown`，副标题仍为页面上下文；有其他会话运行中或未读时，箭头旁显示 `size-1.5` 圆点。点开 `Popover`（宽 288 px、最大高 360 px，`align="start"`），内容为搜索框 + 「新对话」行 + 与侧栏同一组件的紧凑列表（行高 30 px，不显示行内菜单，管理操作在主页侧栏完成，切换器只负责找到并切换）。原头部「重置」按钮改为 `SquarePen` 新对话，无需二次确认。

**主页工具栏**：「新对话」改为 `SquarePen` 图标 + 文案，点击即新建，不再二次确认；导出、导入、日志按钮保持，作用于当前会话；导入改为新建会话。

**设置 → Agent**（`src/pages/Setting/components/AgentConfig.tsx`）：新增「会话记录」行：已保存会话数 + 「清空全部会话」按钮（outline、destructive 文字），Dialog 二次确认。

**状态与窄屏**：
- 列表状态：empty / nonempty / 搜索无结果 / 加载会话中（行尾显示 `Loader2`，加载失败的行显示为灰色并带「无法读取」）/ 保存失败提示。
- 行状态组合：当前 + 运行中、当前 + 悬停相邻、未读 + 悬停（菜单按钮替代圆点）、重命名中。
- 最小窗口 786×540：窗口宽度小于 900 px 时底部导航会伸到浮层下方，浮层改为止于导航上方（`bottom-[60px]`），不遮挡导航；此时列表区至少完整显示 7 行（渲染审查实测，原定 8 行在不遮挡导航的前提下放不下）。
- reduced-motion：容器尺寸直接切换，内容只做透明度过渡。

**验收样本**：20 个会话，含今天/昨天/近 7 天/更早各若干、2 个置顶；标题样本含很短（「你好」）、中文长句、中英混合、无空格长串 `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.srt`；一个运行中、一个未读、一个无法读取。

## 代码落点

| 文件 | 变更 |
| --- | --- |
| `src/agent/types.ts` | `AgentSession` 增可选 `title / titleSource / pinned`；`AgentSessionMeta`、`AgentTitleSource` |
| `src/agent/session-schema.ts` | 新字段（可选）；`event.kind` 补 `revision_applied` |
| `src/store/agent/useAgentStore.ts` | 会话槽、投影、`forSession`、会话管理动作 |
| `src/agent/turn-context.ts`（新） | signal → 会话 id |
| `src/agent/orchestrator.ts` | 按会话的回合、事件队列、停止、标题触发、持久化刷新 |
| `src/agent/guarded-tools.ts` | 不变（已统一 signal），仅补测试 |
| `src/agent/tool-executor.ts`、`modern-tools.ts`、`planning-tools.ts`、`knowledge-tools.ts`、`prepared-actions.ts`、`pipeline-watch.ts` | 以回合会话为准，见第 2 节表 |
| `src/agent/session-io.ts` | 按 id 导出；导入为新会话 |
| `src/agent/session-store-contract.ts`（新） | IPC 契约 |
| `src/agent/session-persistence.ts`（新） | 启动加载、去抖保存、打开会话、失败状态 |
| `src/agent/session-title.ts`（新） | 截取与生成标题 |
| `src/agent/session-list.ts`（新） | 分组、排序、搜索纯函数 |
| `src/agent/session-drafts.ts`（新） | 按会话的输入草稿 |
| `electron/main/agent-sessions/repository.ts`、`index.ts`（新） | 存储与 IPC |
| `electron/main/index.ts` | 注册 IPC |
| `electron/preload/agent-sessions-api.ts`（新）、`electron/preload/index.ts`、`electron/preload/legacy-ipc-bridge.ts` | 暴露 API、拒绝旧桥访问 |
| `src/vite-env.d.ts` | `window.agentSessions` 类型 |
| `src/pages/HomeAgent/SessionSidebar.tsx`（新）、`src/pages/HomeAgent/components/SessionList.tsx`（新） | 侧栏与共用列表 |
| `src/pages/HomeAgent/index.tsx` | 挂侧栏、草稿切换、新对话语义、导入导出 |
| `src/pages/HomeAgent/conversation.tsx`、`components/AgentPreparedActions.tsx`、`widget-actions.ts` | 事件按卡片所属会话上报 |
| `src/pages/AgentDock/index.tsx` | 头部切换器、新对话按钮、草稿切换 |
| `src/pages/Setting/components/AgentConfig.tsx` | 清空全部会话 |
| `src/main.tsx` 或 `src/App.tsx` | 启动时初始化会话目录 |
| `src/locales/{zh,en}/home.json`、`setting.json` | 文案 |
| `test/agent-sessions.electron.test.ts`（新）及现有 agent 端到端测试 | 新流程；模拟服务应答标题请求 |

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-SESSION-01 | 第 1 节会话槽与投影、空会话规则、`session-drafts` |
| R-SESSION-02 | 第 2 节按会话回合、停止、未读；侧栏运行中/未读标识 |
| R-SESSION-03 | 第 2 节 `turn-context` 与工具改法表、准备好的操作与流水线回报、删除作废 |
| R-SESSION-04 | 第 3 节文件格式、主进程仓库、去抖保存、加载与失败降级、schema 修复 |
| R-SESSION-05 | 第 4 节管理动作、导入导出、分组搜索；第 6 节行内菜单、删除确认、设置清空 |
| R-SESSION-06 | 第 5 节截取、生成、手动优先、用量计入 |
| R-SESSION-07 | 第 6 节侧栏常驻/浮层、面板切换器、工具栏与键盘可达 |

## 验证与风险

- **单元**：store 投影一致性与后台写入；orchestrator 两会话并发、切换不中断、停止只影响本会话、删除即中止、事件按会话排队；工具以回合会话读写（覆盖意图/输入路径/计划/执行确认）；准备好的操作切换不作废、删除作废；流水线回报归属；仓库原子写、id 校验、大小上限、索引重建与损坏文件；schema 往返全部事件与日志种类；标题截取/清洗/手动优先/失败重试；分组搜索。命令 `pnpm vitest run <文件>`（单测不需要 pretest 构建）。
- **端到端（Electron，静默窗口，本地模拟 Responses 接口）**：新建/切换/草稿、后台回复与并发、停止、运行中与未读标识、重命名/置顶/搜索/删除、导入导出、重启后恢复与卡片失效、标题生成与手动优先、窄窗口浮层、悬浮面板切换器、设置清空。现有 agent 端到端测试的模拟服务改为识别 `You name conversations.` 前缀的标题请求并单独应答，避免占用其预设回复队列。
- **渲染审查**：主页 1440×900 与 1000×700、最小 786×540，浅/深色，中/英文；悬浮面板在字幕工作台；样本见第 6 节。截图实际查看，按方向→结构→细节→交互→适配记录问题、修复、复验。
- **回归**：`pnpm run pretest` 后跑完整 `pnpm test`，对照已知既有失败（`tool-spacing` 等）。`pnpm i18n:check`、`tsc`。

风险：
1. 投影双写出错导致 UI 与槽不一致——所有写入经 `patchSlot`，单测断言每个动作后投影等于当前槽。
2. 遗漏某处「当前会话」依赖，后台回合读写到前台会话——实施时全仓 grep `session.id`、`getState().session` 与 `useAgentStore.subscribe`，逐一归类并在 tasks 记录；并发端到端测试用两个会话交叉验证。
3. 标题请求打乱现有端到端测试的模拟回复顺序——统一识别前缀；新增断言标题请求不带工具。
4. 磁盘写入频率：去抖 800 ms + 回合结束一次，流式文本不进入持久化字段（只在回合步骤提交时变化），写入次数与消息提交次数同阶。
5. 应用强退可能丢失最近不到 1 秒的变化——接受，已在 AC-04-3 写明。
