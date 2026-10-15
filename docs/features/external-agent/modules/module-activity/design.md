# 外部 Agent 接入：活动记录 设计

本模块需求均属 I5。

## 现状与约束

- 调用链路：`ExternalAgentHttpHost.callTool`（主进程，`electron/main/external-agent/http-host.ts`）→ `index.ts` 中的包装（只读档在这里直接返回 `read_only`）→ `RendererBridge.call` 发到窗口 → `installExternalAgentHost`（`src/agent/external/host.ts`）执行 `runExternalTool` → `api.respond({ callId, result })`。主进程知道每次调用的会话、客户端、工具与最终结果，包括窗口从未收到的调用；渲染端知道可读内容（`confirmed()` 的 `ConfirmationDisplay`）与放行方式。
- 现有“活动”：`src/agent/external/store.ts` 只在内存中为当前连接保留最近 50 次的工具名与成败，连接结束即丢弃；设置页的连接行显示最近一次。确认请求（`confirmations.ts`）同样只在内存。
- 所有写入工具都经 `confirmed(ctx, tool, display, execute, options)`；`approvalNeed()` 在“已放行”与“自动档”时都返回 `none`，需要区分。
- 延后执行：调用 45 秒内未决定时返回 `confirmation_pending`，之后用户允许才执行，结果经 `get_confirmation_result` 取回。
- 隐私：确认框条目中可能含字幕文字（拆分 / 插入的两半与新字幕），这些不得写入记录。
- 设置由主进程 `ExternalAgentSettingsStore` 保存（`settings.json`，zod 校验）。

## 方案与取舍

### 取舍：记录归主进程所有，渲染端补充（A-08）

只有主进程看得到全部调用（只读档拒绝、窗口不可用、超时在窗口之外发生），并且适合持久化；而可读摘要与放行方式只有渲染端知道。方案：主进程为每次调用建立记录（会话、客户端、工具、读写类别、时间、结果），渲染端在回答调用时附带一份“补充”（`activity`），主进程校验后合并；主进程不采信补充中的会话、客户端与工具。另一种做法（渲染端写全部记录）会漏掉窗口外的调用，且记录可被页面状态影响，未采用。

### 记录结构 `src/agent/external/activity.ts`（共享契约）

```ts
type ActivityApproval = "none" | "confirmed" | "session" | "auto" | "declined" | "expired" | "read_only";
type ActivityStatus = "ok" | "failed" | "declined" | "pending" | "cancelled" | "expired";
interface ActivityNote {                       // 渲染端补充，经 zod 校验（strict，长度上限）
  approval?: ActivityApproval;
  confirmationId?: string;                     // 等待确认时，用于稍后更新
  summary?: { action: ConfirmationAction; key: ConfirmationSummary; values: Record<string, string | number>;
              content?: "source" | "target" | "bilingual"; warning?: "overwrite";
              items?: { text: string; detail?: string; from?: string; tag?: ConfirmationItem["tag"] }[]; more?: number };
  result?: Record<string, number>;             // 写入条数、成功 / 跳过 / 失败、重命名数等
  target?: { documentId: string; documentName?: string };
  undo?: { kind: "rename"; journalId: string };
  outputs?: string[];                          // 写出的文件（最多 20）
}
interface ActivityRecord {                     // 主进程保存
  id: string; sessionId: string; client: { name: string; version: string };
  tool: string; access: "read" | "write" | "destructive";
  startedAt: number; endedAt?: number; status: ActivityStatus;
  error?: string; reason?: string;             // 错误代码；原因 ≤300 字
  approval?: ActivityApproval; note?: Omit<ActivityNote, "approval" | "confirmationId">;
  confirmationId?: string;
  undone?: boolean;                            // 用户从记录撤销了重命名
}
interface ActivitySession { id: string; client: { name: string; version: string }; connectedAt: number; endedAt?: number }
```

- 读写类别取自 `EXTERNAL_TOOLS[tool].access`；`destructive` 由补充的 `warning: "overwrite"` 或工具定义决定。
- 改动 = `access !== "read"`。问题 = `status ∈ {failed, declined, expired}` 或 `approval ∈ {declined, read_only, expired}`。
- 摘要条目只保留名称与路径类：动作为 `structure`、`translation` 的条目（字幕文字）在渲染端生成补充时丢弃，只留 `values`（文档名、条序号、时间、数量）。条目最多 20 项，文本各 300 字，其余计入 `more`。

### 渲染端补充 `src/agent/external/activity-note.ts`

- `ExternalToolContext` 增加 `note: ActivityNote`（可变对象，`runExternalTool` 为每次调用创建）。
- `confirmed()` 在判定后写入：`approval`（`none` 分为 `session`（已放行组）/ `auto`（自动档）/ `none`（读取或不需要确认））、`summary`（由 display 生成，按上条过滤条目）；用户允许 → `confirmed`；拒绝 → `declined`；过期 → `expired`；返回 `confirmation_pending` 时带 `confirmationId`。
- 延后的确认在 `decide()` 或过期时，渲染端调用 `api.reportActivity({ confirmationId, status, error?, result?, outputs?, undo? })`，主进程按 `confirmationId` 更新原记录（只能更新同一窗口发起、状态为 pending 的记录）。
- 结果与引用由宿主按工具从成功结果中提取（`deriveNote(tool, data)`，纯函数；延后执行的确认在完成时用同一函数），不在各工具内另写：写入译文（written、unchanged、document）、新建轨道与拆分 / 插入（document）、读取文档（document）、导入（imported、total，单个成功时 document）、转写（queued）、转换 / 提取（written、skipped、failed、outputs）、重命名（renamed、undo）、撤销重命名（restored）。导出的结果只有文件名，不提供输出路径。
- `runExternalTool(call, signal, registry, note)` 把补充写入宿主传入的 `note`；宿主 `api.respond({ callId, result, activity: note })`（为空时不附带）。

### 主进程记录与保存 `electron/main/external-agent/activity-log.ts`

- `ActivityLog`（目录同设置，文件 `activity.jsonl`）：每行一个事件 `{ t: "call", ...ActivityRecord }`、`{ t: "update", id, ... }`、`{ t: "session", ...ActivitySession }`、`{ t: "end", id, endedAt }`、`{ t: "undone", id }`。追加写入经串行队列；写失败只记一次控制台警告，不影响调用。
- 启动时 `load()`：逐行解析（坏行、超过 8 KB 的行跳过），折叠 update / end / undone，裁剪（30 天；改动 2000 条、读取 1000 条；没有记录且已结束超过 30 天的会话），有裁剪或折叠时以临时文件 + rename 重写整个文件。运行中超出上限 10% 时同样压缩。
- `index.ts` 的 `callTool` 包装：开始时记下时间与 id，调用结束后写一条 `call`；只读档拒绝直接写 `status: failed, error: read_only, approval: read_only`；`confirmation_pending` 写 `status: pending` 与补充里的 `confirmationId`；`cancelled` / `tool_timeout` / `fusionkit_window_unavailable` 照常记录。
- `RendererBridge.call` 改为解析出 `{ outcome, activity }`；`respond` 的 schema 增加可选 `activity`（`activityNoteSchema`），超长或不合法时丢弃补充、保留结果。补充不会发回外部客户端。
- 会话：`onSessionsChanged` 时与上次的会话集合比较，新会话写 `session`，消失的写 `end`。
- 推送：每次新增或更新后向窗口发送 `external-agent:activity`（记录本身），活动页面与指示据此实时更新。
- 通道（仅主窗口主框架，同现有 `reply()`）：`activityList({ sessionId?, filter: "changes" | "all" | "problems", before?, limit ≤ 200 })` → `{ records, next? }`；`activitySessions()` → 会话及其改动数、问题数、最近时间（当前连接标记 live）；`activityClear()`；`activityUndone(id)`（标记已从记录撤销重命名）；`reportActivity(update)`。
- 设置增加 `notices: boolean`（默认 true，`settings.json` 读取旧文件时补默认值），经 `updateSettings` 修改。

### 活动页面（UI 设计基准）

- 用户与流程：用户在外部 Agent 工作时或工作后，想知道“它刚才做了什么、改了哪里、出了什么问题”。入口：标题栏指示（最常用）、轻提示的「查看」、设置页入口。主操作：选连接 → 浏览改动 → 展开看细节 → 打开文档 / 撤销重命名 / 显示文件。失败恢复：文档已删除、撤销失败时就地说明。
- 参照：翻译资料页（`src/pages/TranslationKnowledge/index.tsx`）的 `ToolDetailLayout` + 左侧导航（`KnowledgeSidebar` 的 `NavigationRow`：`min-h-9 rounded-smooth-lg px-2.5 py-2 text-[13px]`，选中 `bg-muted font-medium`，右侧数字 11px tabular-nums）+ 右侧 `ToolPanel`；页头 `ToolPageHeader`（直接传入图标 `Bot` 与色调 `--tool-converter`，不加入工具目录；`ToolPageHeader` 的 meta 类型放宽为 `icon` + `toneVar`）。设置页连接行的文字层级（13px / xs / 11px）。
- 布局：`ToolDetailLayout`，`md:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[280px_minmax(0,1fr)]`。
  - 左侧（`ToolPanel` 标题“连接”）：第一行「全部连接」，随后每个连接一行：左侧状态点（当前连接绿色、已结束灰色），主文本客户端名（中间省略，完整名在 title），次行“已连接 12 分钟”或“10-14 10:05 结束”，右侧改动数；有问题时在改动数前加一个小的 destructive 圆点。列表在 `ScrollArea` 内（高度受视口约束）。面板底部一行 11px 灰字“保留最近 30 天”与 ghost 小按钮「清空记录」（`ConfirmDialog`）。<768px 时左侧变为页面顶部的 `Select`（连接选择）以节省纵向空间。
  - 右侧（`ToolPanel`）：标题区 = 连接概况（客户端名 + 版本 11px、状态与时长、当前信任档位文字；当前连接显示 outline 小按钮「断开」）+ 筛选（`SegmentedControl` size sm：改动 / 全部 / 有问题，带数字）。正文 = 时间线：按日分组的吸顶小标题（今天 / 昨天 / 日期），每条记录一行网格 `[时间 52px][图标 16px][内容 1fr][放行与结果]`：
    - 内容：一句可读文字（13px，最多两行，其余省略，展开后完整），次行 11px 灰字为工具的可读名 + 耗时。
    - 放行与结果：小标签（`Badge` variant outline / secondary / destructive 的现有样式）：“你已确认”“本次连接已放行”“自动档”“已拒绝”“只读档拒绝”“已过期”“等待你确认”“失败”；成功的读取不显示标签。
    - 点击行或按 Enter 展开（`aria-expanded`），展开区：条目列表（重命名 `旧名 → 新名` 旧名弱化；路径次行完整路径，`break-all`）、“另有 N 项”、结果数字、错误说明（已知错误代码用本地化说明，未知显示代码与原因）、操作按钮行（outline sm：「打开文档」「撤销这次重命名」「在文件夹中显示」）。
    - 底部“加载更早的记录”在滚动到底时自动触发（IntersectionObserver），失败时显示重试按钮。
  - 空状态：接入未开启 → 说明 + 「前往设置」；已开启无记录 → “外部 Agent 还没有调用过 FusionKit”；筛选后为空 → “这个连接没有改动”等。
- 组件：`ToolDetailLayout`、`ToolPageHeader`、`ToolPanel`、`ScrollArea`、`SegmentedControl`、`Badge`、`Button`、`ConfirmDialog`、`Select`、`Tooltip`、`toast`；图标 lucide（`FilePen`、`FileOutput`、`Files`、`PencilLine`、`Scissors`、`BookOpenText`、`AudioLines`、`Eye`、`ShieldX`）。
- 状态：加载中（骨架 3 行）、加载失败（重试）、实时追加（新记录在顶部短暂高亮，`motion-reduce` 时无动画）、展开 / 收起、操作进行中（按钮禁用并显示进度）、文档不存在、撤销失败 / 已撤销。
- 窄屏与滚动：页面整体滚动（与其他工具页一致），左侧列表在 lg 以上吸顶；时间线的吸顶日期标题相对页面滚动容器。长路径在展开区换行，不撑宽页面。
- 样本：两个连接（claude-code 当前、codex 已结束）、跨两天、写入 / 转换（含 3 个长路径）/ 重命名 25 项 / 只读档拒绝 / 拒绝 / 失败（tool_failed 长原因）/ 读取若干。

### 标题栏指示与轻提示

- `AppTitleBar`：在应用名胶囊左侧（间距 8px）放一个独立的小胶囊按钮（`app-region-no-drag`，h-7 同胶囊高度，`bg-background/60 backdrop-blur-md border`），内容：6px 状态点 + 客户端名（单个连接）或“N 个连接”，未查看数用小号数字徽标（`min-w-4 h-4 text-[10px] rounded-full bg-primary text-primary-foreground`）。状态点：空闲绿色；执行中绿色脉动（`animate-pulse`，reduced-motion 时静止）；有等待确认请求时琥珀色；无连接但有未查看数时灰色。应用名胶囊内原有圆点移除。Windows 悬停应用名胶囊时出现的窗口按钮不受影响。点击进入 `/external-agent?session=<id>`（优先有未查看改动的连接，其次当前连接）。
- 未查看数：渲染端 `useExternalActivityStore` 维护 `lastSeenAt`（本机 localStorage，按需读取失败时视为 0）与从主进程推送的记录中计算的 `unseen`（approval ∈ session/auto、status ok、改动类、时间晚于 lastSeenAt）；启动时由 `activityList` 补齐最近记录计算。进入活动页面（或页面可见时收到新记录）更新 lastSeenAt。
- 轻提示：收到满足上条的记录且设置 `notices` 为 true、且当前不在该连接的活动页面时，用 `sonner` 的 `toast(message, { id: "external-activity-<session>", action: 查看 })`；5 秒内同一连接的再次改动用同一 id 更新文案为合并计数。单条文案用记录的可读句子（如“claude-code 写入了 12 条译文”），多条为“claude-code 做了 N 项改动”。toast 不获取焦点。

### 设置页

- 连接行右侧在「断开」左边增加 ghost 小按钮「活动」（进入该连接的活动页）；“当前连接”标题行右侧加 link 样式「查看活动记录」。
- 信任档位区下方增加一行 `ToolSwitchRow` 风格的开关（标签 + 说明 + Switch）：“未询问就执行的改动显示提示”。

### 打开文档

字幕工作台读取 `?document=<id>`（与已有 `?view=` 同一处理）：确保处于文档视图，按 id 取文档摘要并调用现有的 `chooseDocument` 预览，随后从地址中移除该参数；文档不存在时 toast“文档已不存在”。

## 代码落点

| 位置 | 改动 |
| --- | --- |
| `src/agent/external/activity.ts`（新） | 记录、补充、通道载荷的类型与 zod schema；可读文案键的映射；改动 / 问题判定 |
| `src/agent/external/activity-note.ts`（新） | display → 补充（过滤条目）、放行方式判定 |
| `src/agent/external/contract.ts` | 通道名、`ExternalAgentApi` 增加活动方法与 `onActivity`；respond schema 增加 `activity`；设置增加 `notices` |
| `src/agent/external/errors.ts`、`host.ts`、`confirmations.ts`、`tools/*.ts` | `ctx.note`；宿主附带补充；确认写放行方式与延后结果上报；工具补充结果与引用 |
| `electron/main/external-agent/activity-log.ts`（新）、`index.ts`、`renderer-bridge.ts`、`settings-store.ts` | 记录与保存、通道、推送、会话开始 / 结束、补充解析、`notices` |
| `electron/preload/external-agent-api.ts` | 新方法与事件 |
| `src/agent/external/activity-store.ts`（新） | 渲染端：未查看数、执行中、推送订阅、轻提示 |
| `src/pages/ExternalAgentActivity/`（新） | 活动页面 |
| `src/App.tsx`、`src/constants/router.ts`、`src/pages/components/BottomNavigation.tsx`、`src/pages/Tools/_shared/ToolPageHeader.tsx`、`src/pages/Tools/_shared/toolMeta.ts` | 路由（不叠加 `pt-10`）、底栏名称、返回（回到上一页，无历史时到设置）、页头 meta 类型 |
| `src/agent/external/activity-text.ts`（新） | 页面与提示共用的可读文字：一句话、标签、结果数字、错误说明、耗时（英文单数用 `_one` 键） |
| `src/pages/AgentDock/ExternalAgentHost.tsx` | 安装活动订阅（提示中的“查看”跳转） |
| `src/pages/components/AppTitleBar.tsx` | 指示胶囊 |
| `src/pages/Setting/components/ExternalAgentConfig.tsx` | 入口与开关 |
| `src/pages/Tools/Subtitle/SubtitleStudio/index.tsx`、`navigation.ts` | `?document=` 打开文档 |
| `src/locales/*/setting.json` | `external_agent.activity.*` 文案（4 语言） |

`electron/main/index.ts` 与 `electron/preload/index.ts` 不需要改动（外部 Agent 模块自带注册与 preload 文件）；若改动则按 provenance 组合审计重新登记。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-ACTIVITY-01 | 记录结构、渲染端补充、主进程记录与保存 |
| R-ACTIVITY-02 | 活动页面、打开文档 |
| R-ACTIVITY-03 | 标题栏指示与轻提示 |
| R-ACTIVITY-04 | 设置页 |

## 验证与风险

- 隐私：单元测试对拆分 / 插入 / 写入译文的补充断言不含字幕文字；Electron 测试读取记录文件全文断言不含测试中写入的译文、令牌与参数原文。
- 合并正确性：主进程不采信补充中的会话 / 工具；伪造的 `confirmationId` 更新被拒绝（只更新 pending 且属于同一窗口的记录）。
- 容量：单元测试构造 3500 条记录与坏行、超长行，验证裁剪、折叠与重写；文件写入失败不影响调用结果。
- 性能：每次调用追加一行（异步队列）；活动页面分页读取，主进程在内存中保留折叠后的记录（上限约 3000 条）。
- UI：Electron 测试（静默窗口，临时用户数据，真实 MCP 客户端）生成活动页面、指示与提示截图（1280×860 浅色中文、900×700 深色英文，含长路径与多日样本），逐张审阅并修复复验。
