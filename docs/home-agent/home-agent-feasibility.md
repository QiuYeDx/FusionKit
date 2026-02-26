# FusionKit 首页升级为对话式 Agent 应用：可行性研究与实施方案

## 1. 目标定义

将当前 `Home` 首页改造为“对话式 Agent 工作台”，支持用户用自然语言下达任务，由 AI 自主决定：

- 调用哪个工具（字幕翻译 / 格式转换 / 语言提取）。
- 选择哪些文件进入哪个工具的任务队列。
- 在目录级范围内递归发现文件、识别哪些文件值得处理。
- 灵活理解“多目录 + 多文件 + 混合指定”的目标集合，并智能处理冲突。
- 自动补全合理参数，并将任务加入对应进度列表。
- 在必要时向用户追问，避免误操作。

核心诉求可归纳为：**“自然语言意图 -> 工具调用计划 -> 可执行任务队列 -> 可追踪进度”**。

---

## 2. 基于现有代码的现状调研

### 2.1 当前架构能力（已具备）

1. **路由和首页结构清晰**
   - 首页路由在 `src/App.tsx` 的 `path="/"`，当前页面组件是 `src/pages/Home.tsx`。
   - 改造入口明确，不影响 `tools/about/setting` 主导航结构。

2. **工具层已具备参数化调用能力**
   - 字幕翻译通过 `window.ipcRenderer.invoke("translate-subtitle", task)` 执行，具备并发、进度、失败、重试机制。
   - 字幕格式转换通过 `convert-subtitle` IPC 调用。
   - 字幕语言提取通过 `extract-subtitle-language` IPC 调用。
   - 主进程能力集中在：
     - `electron/main/translation/*`
     - `electron/main/conversion/*`
     - `electron/main/extraction/*`

3. **模型配置与代理能力可复用**
   - 模型配置和 API Key 已在 `src/store/useModelStore.ts`。
   - 代理配置已在 `src/store/useProxyStore.ts` 和 `electron/main/proxy.ts`，可复用于 Agent 请求链路。

4. **文件路径与本地能力已经打通**
   - 通过 `window.electronUtils.getPathForFile(file)` 获取文件绝对路径（`src/utils/filePath.ts`）。
   - 这对“AI 自动决定文件分配”非常关键。

5. **多语言体系成熟**
   - `i18next` 体系完整（`src/i18n/*` + `src/locales/*`），首页改造后可保持三语一致体验。

### 2.2 关键缺口（需要补齐）

1. **任务队列能力不统一**
   - 字幕翻译使用 Zustand 全局队列（`useSubtitleTranslatorStore`）。
   - 转换/提取仍是页面内 `useState` 本地任务列表，无法被首页 Agent 直接注入任务。

2. **缺少“工具注册层”**
   - 目前是“页面按钮直接调用 IPC”，没有统一 Tool Schema（参数定义、约束、默认值、可见性）。

3. **缺少 Agent 规划循环**
   - 还没有对话上下文管理、工具调用决策、参数填充、置信度追问等机制。

4. **缺少目录级发现与筛选能力**
   - 当前以手动上传为主，缺少“按目录递归扫描 -> 过滤 -> 候选清单确认”的能力。
   - 无法支持“处理某系统目录下所有字幕文件”这类高效率指令。

---

## 3. 可行性结论

### 结论：高可行（建议分阶段落地）

原因：

- 现有三类工具都已具备稳定的“输入参数 -> 执行 -> 返回结果/进度”能力。
- Electron IPC 主干已成熟，适合承载 Agent 工具执行层。
- 模型、代理、通知、i18n、UI 组件都可复用。

真正的工作重点不在“能不能做”，而在于：

- 如何统一任务数据模型（让 Agent 可稳定写入任务队列）。
- 如何设计工具调用约束（防止 AI 误调用/误参数）。
- 如何做“可确认”的执行体验（避免黑箱自动化带来的误操作）。

---

## 4. 架构方案对比

| 方案 | 描述 | 优点 | 风险/不足 | 适配度 |
| --- | --- | --- | --- | --- |
| A. Renderer 内 Agent 编排 + 现有 IPC 执行 | 对话、推理、工具决策在前端；执行走 Main IPC | 开发最快；改造最小；便于 UI 联动 | 需要严格约束 tool-call；前端状态复杂 | 高 |
| B. Main 进程 Agent 编排 + Renderer 展示 | Agent 核心在主进程；前端只做渲染 | 安全边界更清晰；状态集中 | IPC 面更大；开发复杂度更高 | 中 |
| C. 外部服务 Agent 编排 | 云端编排，本地仅做执行器 | 可扩展性高，便于跨端复用 | 隐私、网络依赖、运维成本上升 | 中低 |

### 推荐路线

优先采用 **A（前端编排 + 主进程执行）**，并保持接口可演进到 B：

- 先快速实现可用 MVP。
- 后续如需更强安全边界，再将 Planner 下沉到 Main。

---

## 5. 推荐目标架构（本项目最匹配）

```text
用户对话输入
   ↓
Home Agent UI（新首页）
   ↓
Agent Orchestrator（意图识别 + 工具选择 + 参数生成）
   ↓
Directory Discovery（目录递归扫描 + 文件元数据索引 + 预筛选）
   ↓
Tool Registry（Schema + 校验 + 默认值策略）
   ↓
Task Hub（统一任务模型，写入各工具队列）
   ↓
Tool Adapter（翻译/转换/提取）
   ↓
Electron Main IPC 执行
   ↓
进度/结果事件回传
   ↓
对话时间线 + 各工具进度列表同步更新
```

---

## 6. “AI 自动决定文件与参数”的落地机制

### 6.1 文件选择策略（升级为“多目标混合指定”）

目标是让 Agent 能理解并执行这类复杂指令：

- “处理 A、B 两个目录下所有字幕，并额外包含 `x.srt` 和 `y.lrc`。”
- “处理 `Downloads` 下字幕，但排除 `archive` 子目录，再加上桌面的 `final.srt`。”
- “目录里都处理，`old` 子目录不要；`old/keep_this.srt` 例外保留。”

建议采用“**目标解析 -> 授权校验 -> 扫描扩展 -> 统一筛选 -> 可编辑清单**”流程。

### 6.1.1 目标集合模型（支持多目录 + 多文件 + 混合）

建议引入统一结构：

```ts
type TargetSet = {
  includeDirectories: string[];
  includeFiles: string[];
  excludeDirectories: string[];
  excludeFiles: string[];
  includeGlobs: string[];
  excludeGlobs: string[];
  recursive: boolean;
  maxDepth?: number;
};
```

说明：

1. `includeDirectories`：可同时包含多个目录。
2. `includeFiles`：可同时包含多个绝对路径文件。
3. 目录和文件可混合存在，最终统一去重合并。
4. `exclude*` 用于快速排除子目录或文件。

### 6.1.2 智能解析与冲突处理规则

Agent 处理多目标输入时，按以下步骤执行：

1. **自然语言解析**
   - 从对话里抽取目录、文件、排除项、扩展名限制、时间范围等约束。
2. **权限与路径校验**
   - 校验每个目录/文件是否已授权，未授权时逐项请求授权或让用户改路径。
3. **目录扩展扫描**
   - 对 `includeDirectories` 递归扫描字幕文件，并保留来源目录标记。
4. **显式文件并入**
   - 将 `includeFiles` 直接加入候选，即使不在目录内也可参与处理。
5. **冲突消解与优先级**
   - 默认优先级建议：`excludeFiles` > `includeFiles` > `excludeDirectories/excludeGlobs` > `includeDirectories/includeGlobs`。
   - 可选策略：若用户明确“文件优先于目录排除”，则允许 `includeFiles` 覆盖目录排除。
6. **结果分流**
   - 生成 `candidateList` 与 `excludedList`，并给出每条排除原因。
7. **歧义追问**
   - 当路径不明确或条件冲突时，Agent 必须追问，而不是擅自猜测。

### 6.1.3 目录级筛选判定建议

为了让 Agent 的“哪些文件值得处理”更稳定，建议将判定分层：

1. **硬规则层（确定性）**
   - 文件类型是否匹配、大小范围、路径黑白名单、输出是否已存在。
2. **启发式层（可解释）**
   - 文件名包含关键词（`translated` / `zh-only` / `final` 等）可推测已处理状态。
3. **内容抽样层（按需）**
   - 对少量样本读取前 N 行判断是否双语、是否已是目标格式。
4. **LLM 判别层（最后使用）**
   - 仅在规则无法判定时调用模型，且要写出判定理由。

### 6.1.4 清单确认与二次筛选（可编辑）

Agent 应在对话中展示“拟处理列表 + 排除理由”，用户可继续说：

- “移除 `xxx` 子目录”
- “保留最近 20 个文件”
- “把 `abc.srt` 去掉”
- “再加上 `~/Desktop/manual_fix.srt`”

Agent 根据增删指令实时更新候选清单，并给出变更摘要（新增/移除数量和明细）。

### 6.2 参数补全策略（重点）

优先级建议：

1. 用户明确给定参数（最高优先）。
2. 当前会话上下文（上一轮确认的偏好）。
3. 目录上下文默认值（最近一次扫描目录集合、常用排除目录）。
4. 工具默认值（来自现有设置页/store）。
5. 若关键参数缺失且存在风险，触发追问。

### 6.3 入队策略

建议提供三种执行模式：

- **草案模式（默认）**：AI 先生成“目录扫描结果 + 任务草案”，用户确认后入队。
- **确认即执行模式**：用户确认清单后自动开始全部任务。
- **自动执行模式（显式开启）**：Agent 在每轮筛选后直接入队（适合批量自动化场景）。

### 6.4 安全边界与权限模型（目录场景必备）

支持目录级自治后，必须增加权限与防误操作边界：

1. **目录/文件授权白名单**
   - Agent 只能访问用户已授权的目录或文件路径，不允许越权访问任意路径。
2. **系统敏感目录保护**
   - 默认禁止扫描高风险路径（如系统目录、应用安装目录、隐藏系统目录），除非用户明确二次确认。
3. **分级读取**
   - 第一步只读元数据；第二步仅对候选文件做内容抽样；第三步执行时才完整读取。
4. **可审计性**
   - 每次扫描记录：扫描根目录、过滤条件、命中数量、排除原因、用户确认动作。

---

## 7. 关键实现节点（按落地顺序）

### 阶段 0：统一任务模型（必须先做）

目标：把“翻译/转换/提取”都抽象成统一任务实体，支持首页注入。

建议新增：

- `TaskKind`: `subtitle.translate | subtitle.convert | subtitle.extract`
- `TaskLifecycle`: `draft | queued | running | success | failed | canceled`
- `TaskSource`: `home-agent | tool-page | api`
- `TaskDiscovery`: `manual-upload | directory-scan | history-reuse`
- `TaskTargetRef`: `targetSetId`, `sourceDirectory`, `explicitFile`

### 阶段 1：抽离转换/提取的任务 store（关键）

现状中转换/提取在页面内部 `useState`，建议迁移到：

- `src/store/tools/subtitle/useSubtitleConverterStore.ts`
- `src/store/tools/subtitle/useSubtitleExtractorStore.ts`

目标：让首页 Agent 与工具页面共享同一任务源。

### 阶段 2：构建 Tool Registry + 参数校验层

新增建议：

- `src/agent/tool-registry.ts`：声明每个工具的 `name/description/schema`.
- `src/agent/tool-schemas.ts`：参数 Zod Schema。
- `src/agent/tool-executor.ts`：把合法入参转换成任务并入队。
- `src/agent/discovery-engine.ts`：多目录扫描、候选筛选、排除原因生成。
- `src/agent/target-resolver.ts`：混合目标解析、冲突消解、权限检查。

### 阶段 3：实现首页 Agent Orchestrator

新增建议：

- `src/agent/orchestrator.ts`
- `src/store/agent/useAgentStore.ts`
- `src/pages/HomeAgent/index.tsx`（替换当前 `Home` 内容）

核心能力：

- 对话上下文管理。
- 调用 LLM 产出 tool-call。
- 校验、追问、执行、状态回写。

### 阶段 4：进度可视化与可解释性

首页必须显示：

- Agent 计划（为什么选这个工具）。
- 待执行任务列表（文件 + 参数 + 目标目录）。
- 实时进度和失败原因。

### 阶段 5：鲁棒性与测试闭环

- 参数越权保护。
- 失败重试与补偿策略。
- E2E 自动化验证（真实拖拽文件 + 多轮对话）。

---

## 8. 推荐技术栈与开源库

### 8.1 强烈推荐（优先）

1. **Zod**
   - 用途：工具参数 schema、LLM 输出校验、默认值注入。
   - 理由：可把“AI 输出不确定性”收敛为确定结构。

2. **Vercel AI SDK（`ai` + 对应 provider 包）**
   - 用途：流式对话、tool calling、UI 集成。
   - 理由：前端集成体验好，适合本项目 React + Electron。

3. **Zustand（沿用）**
   - 用途：Agent 状态、任务总线、会话上下文。
   - 理由：当前项目已在用，迁移成本最低。

4. **p-limit**
   - 用途：控制 Agent 发起任务或工具执行并发。
   - 理由：避免批量任务瞬时触发导致资源抖动。

5. **fast-glob / tinyglobby（二选一）**
   - 用途：目录递归扫描字幕文件。
   - 理由：性能和可控性都优于手写递归遍历。

### 8.2 可选增强（按需）

1. **LangGraph.js**
   - 用途：复杂多步推理（例如“先转格式再翻译再提取”链式规划）。
   - 适用：当流程编排明显复杂时再引入。

2. **Dexie（IndexedDB）**
   - 用途：会话历史、文件引用、任务快照持久化。
   - 适用：希望重启应用后恢复 Agent 上下文。

3. **Pino**
   - 用途：主进程结构化日志。
   - 适用：追踪 tool-call 失败与线上问题。

4. **MSW / Nock**
   - 用途：模型接口和 IPC mock 测试。
   - 适用：提高回归测试稳定性。

5. **chokidar**
   - 用途：可选的目录监听与增量刷新（长会话时自动发现新文件）。
   - 适用：需要“扫描后持续监控目录变化”的增强场景。

---

## 9. 建议的工具定义（示例）

```ts
type ToolDefinition = {
  name: string;
  description: string;
  schema: ZodSchema<any>;
  execute: (args: any) => Promise<ToolResult>;
};
```

建议优先做 7 个工具（MVP）：

1. `resolve_processing_targets`
   - 入参：`userInstruction`, `conversationContext`
   - 出参：`targetSet`（含多目录、多文件、排除项、冲突提示）

2. `scan_subtitle_files_in_targets`
   - 入参：`targetSet`（支持多目录并包含显式文件）
   - 出参：`discoveredFiles[]`

3. `build_processing_candidates`
   - 入参：`discoveredFiles[]`, `intent`, `policy`
   - 出参：`candidateList[]`, `excludedList[]`（含原因）

4. `apply_candidate_filters`
   - 入参：`candidateList[]`, `userPatch`（移除目录/文件、数量限制、时间过滤）
   - 出参：`filteredCandidates[]`

5. `queue_subtitle_translate_tasks`
   - 入参：`files[]`, `sliceType`, `outputMode`, `outputDir`, `conflictPolicy`
6. `queue_subtitle_convert_tasks`
   - 入参：`files[]`, `to`, `defaultDurationMs`, `stripMediaExt`, `outputMode`, `outputDir`, `conflictPolicy`
7. `queue_subtitle_extract_tasks`
   - 入参：`files[]`, `keep`, `outputMode`, `outputDir`, `conflictPolicy`

---

## 10. 与现有代码的映射（关键文件清单）

### 10.1 重点改造文件（已有）

- `src/pages/Home.tsx`（将被 Agent 首页替代）
- `src/pages/Tools/Subtitle/SubtitleConverter/index.tsx`（任务状态需抽离）
- `src/pages/Tools/Subtitle/SubtitleLanguageExtractor/index.tsx`（任务状态需抽离）
- `src/store/tools/subtitle/useSubtitleTranslatorStore.ts`（作为统一队列设计参考）
- `electron/main/index.ts`（新增 Agent IPC 注册入口）
- `src/vite-env.d.ts`（如新增 preload API 需补类型）

### 10.2 建议新增文件

- `src/pages/HomeAgent/index.tsx`
- `src/components/agent/*`（消息、计划卡片、任务草案卡片）
- `src/store/agent/useAgentStore.ts`
- `src/store/tools/subtitle/useSubtitleConverterStore.ts`
- `src/store/tools/subtitle/useSubtitleExtractorStore.ts`
- `src/agent/tool-registry.ts`
- `src/agent/tool-schemas.ts`
- `src/agent/orchestrator.ts`
- `src/agent/file-context.ts`
- `src/agent/discovery-engine.ts`
- `src/agent/target-resolver.ts`
- `src/agent/filter-rules.ts`
- `src/agent/candidate-review.ts`
- `electron/main/fs/ipc.ts`（目录扫描 / 文件元信息读取）
- `docs/home-agent-feasibility.md`（本文）

---

## 11. 风险与控制策略

### 11.1 风险：AI 误调用工具或参数错误

控制：

- 严格 schema 校验（Zod）。
- 不合法参数直接拒绝并要求重试规划。
- 高风险操作（覆盖写入、批量 > N 文件）必须二次确认。

### 11.2 风险：文件选错导致误处理

控制：

- 目录扫描结果必须先形成“候选 + 排除”双清单，并展示排除理由。
- 支持用户对文件/目录做二次筛选（移除、保留、限制条数）。
- 默认草案模式，不直接执行；自动执行需显式开启。
- 对系统敏感目录增加强确认与告警文案。

### 11.3 风险：多目标指令歧义或冲突

控制：

- 对同一轮中“包含/排除冲突”的路径做高亮并展示消解结果。
- 冲突策略固定且可配置（例如“排除优先”），并在 UI 明示当前策略。
- 路径模糊、相对路径不确定、软链接跳转等场景必须追问确认。

### 11.4 风险：目录扫描性能与卡顿

控制：

- 大目录采用分批扫描与分页展示，避免一次性渲染全部结果。
- 增加扫描上限（文件数/目录深度/总大小）与中断能力。
- 扫描任务独立于 UI 渲染，必要时下沉主进程或 worker。

### 11.5 风险：成本不可控（翻译模型调用）

控制：

- 复用现有 token 预估逻辑（`estimate-subtitle-tokens`）。
- 增加“本次计划预计费用”展示和预算阈值提醒。

### 11.6 风险：可观察性不足

控制：

- 每轮 tool-call 记录：输入摘要、校验结果、执行状态、耗时。
- 失败日志结构化，支持导出诊断。

---

## 12. 测试策略（建议）

### 单元测试（Vitest）

- 工具参数 schema 校验。
- 参数默认值填充逻辑。
- 多目录+多文件混合输入解析与冲突消解逻辑。
- 文件筛选规则（按扩展名/目录规则/用户二次指令）。
- 候选与排除清单生成逻辑（含排除原因可解释性）。

### 集成测试

- 模拟 LLM 输出 tool-call -> 校验 -> 入队 -> 执行回调。
- 模拟“多目录 + 多文件 + 排除项”混合指令解析全链路。
- 模拟“目录扫描 -> 候选生成 -> 用户二筛 -> 入队”全链路。
- 异常流程：空文件、无输出目录、模型配置缺失、IPC 报错。

### E2E 测试（Playwright）

- 首页上传文件 -> 对话下达任务 -> 生成计划 -> 确认执行 -> 观察进度。
- 首页输入目录指令 -> 递归扫描 -> 清单确认/移除子目录 -> 执行。
- 首页输入“多个目录 + 多个文件 + 排除规则”-> 清单更新 -> 执行。
- 多工具串联任务（例如“先转 SRT 再提取中文”）。

---

## 13. 里程碑与预估工期（单人）

| 里程碑 | 目标 | 预估 |
| --- | --- | --- |
| M0 | 任务模型与边界设计（含目录权限模型） | 1 天 |
| M1 | 转换/提取 store 抽离 + 统一任务总线 | 2 - 3 天 |
| M2 | 目录扫描与候选筛选引擎 | 2 - 3 天 |
| M3 | Tool Registry + 校验层（含 discovery tools） | 1 - 2 天 |
| M4 | 首页对话 UI + Agent 编排 MVP | 2 - 3 天 |
| M5 | 进度回流、失败处理、可解释性完善 | 1 - 2 天 |
| M6 | 测试、回归、文档补齐 | 1 - 2 天 |

**总计：约 10 - 16 天（目录级能力会增加实现与测试复杂度）**。

---

## 14. MVP 验收标准（建议）

满足以下条件即可进入可用状态：

- 首页支持“上传文件”与“目录指令扫描”两种入口。
- Agent 能在三种字幕工具中自动选择并生成任务草案。
- Agent 能递归扫描目录并给出“候选 + 排除原因”双清单。
- Agent 能同时处理多个目录与多个文件的混合输入，并正确处理冲突。
- 用户可在对话中二次筛选（移除文件/目录、限制数量）并实时更新清单。
- Agent 能将任务写入对应工具的进度列表（至少翻译 + 转换 + 提取）。
- 用户可在执行前确认/修改关键参数。
- 执行过程中可看到实时进度、失败原因与重试入口。
- 全链路支持中文/英文/日文文案。

---

## 15. 最终建议

这次改造**不建议直接“一步到位做全自动黑箱 Agent”**，建议采用：

1. **先统一任务总线**（解决架构基础问题）。
2. **再做可确认的 Agent 草案执行**（先可控，再自动）。
3. **最后演进到多步自治编排**（跨工具链式处理）。

按这个顺序推进，能够最大化复用 FusionKit 现有代码资产，同时把风险和返工成本降到最低。

---

## 16. v2 架构重构（2026-02-26 补充）

v1 实现（基于上述第 7~9 节方案）完成后，经实际使用发现以下根本性问题，触发了架构重构。

### 16.1 v1 存在的问题

| # | 问题 | 影响 |
| --- | --- | --- |
| 1 | System Prompt 过于激进（"CRITICAL: Act immediately"、"NEVER reply with a question"） | 用户闲聊时 LLM 强行调用工具，臆想不存在的任务并报错 |
| 2 | Orchestrator 只支持一轮 follow-up | scan → queue 多步链路无法在一次对话中完成 |
| 3 | 7 个工具、schema 深度嵌套（TargetSet 10 字段、DiscoveredFile 6 字段） | LLM 极易生成错误参数，Zod 校验频繁失败 |
| 4 | `resolve_processing_targets` 是空壳 stub | 注册但返回占位文本，误导 LLM 调用 |
| 5 | 无非任务对话路径 | 普通聊天触发异常流程 |

根本原因：**将 Agent 设计为"工具调用管线"而非"对话助手"**。原方案假设每轮对话都会产出任务，但实际使用中大量对话是闲聊、提问、确认，不涉及任何工具调用。

### 16.2 v2 设计原则

1. **对话优先，工具按需**：LLM 默认作为普通对话助手；只在用户明确表达任务意图且信息充分时才调用工具。
2. **参数极简**：工具 schema 尽量扁平，LLM 只需提供路径字符串数组等最少信息，不需要构造复杂嵌套对象。
3. **多轮自动循环**：orchestrator 支持最多 N 轮 tool-call 循环，LLM 自主决定何时停止。
4. **不臆想**：system prompt 明确"信息不足时追问，不要猜测"。

### 16.3 架构对比

```text
v1（7 工具、单轮 follow-up、强制 tool-call）:
  用户消息 → LLM(强制 tool-call) → 执行 1 轮 → LLM 总结 → 结束
  问题：闲聊报错、链路断裂、参数错误

v2（4 工具、多轮循环、对话优先）:
  用户消息 → LLM(自由决策)
    ├→ 无任务意图 → 纯文本回复 → 直接展示，结束
    └→ 有任务意图 → tool_calls → 执行 → 结果送回 LLM → 循环 → 最终回复
```

### 16.4 工具变更

| v1 工具（7 个） | v2 工具（4 个） | 变更说明 |
| --- | --- | --- |
| `resolve_processing_targets` | 删除 | 空壳 stub，目标解析由 LLM system prompt 承担 |
| `scan_subtitle_files_in_targets` | `scan_subtitle_files` | 移除嵌套 TargetSet，入参简化为 `{ directories, extensions?, recursive? }` |
| `build_processing_candidates` | 删除 | 中间筛选步骤不必要，LLM 自然语言能力替代 |
| `apply_candidate_filters` | 删除 | 同上 |
| `queue_subtitle_translate_tasks` | `queue_subtitle_translate` | `files: DiscoveredFile[]` → `filePaths: string[]` |
| `queue_subtitle_convert_tasks` | `queue_subtitle_convert` | 同上 |
| `queue_subtitle_extract_tasks` | `queue_subtitle_extract` | 同上 |

### 16.5 文件变更

| 文件 | 变更 |
| --- | --- |
| `src/agent/tool-schemas.ts` | 重写：7 嵌套 schema → 4 扁平 schema |
| `src/agent/tool-registry.ts` | 重写：7 → 4 工具 |
| `src/agent/tool-executor.ts` | 重写：接收路径字符串替代嵌套对象 |
| `src/agent/orchestrator.ts` | 重写：对话优先 prompt + 多轮循环 |
| `src/agent/types.ts` | 精简：324 → ~40 行 |
| `src/store/agent/useAgentStore.ts` | 精简：188 → ~60 行 |
| `src/pages/HomeAgent/index.tsx` | 优化：移除 PlanCard，改进工具结果展示 |
| `src/agent/discovery-engine.ts` | **删除** |
| `src/agent/filter-rules.ts` | **删除** |
| `src/agent/target-resolver.ts` | **删除** |

### 16.6 对原方案的偏差说明

1. **第 7 节"7 个工具"简化为 4 个**：目录发现与筛选相关的 3 个中间工具（resolve_processing_targets、build_processing_candidates、apply_candidate_filters）被移除。实践证明 LLM 在处理这些中间环节时频繁出错，且这些步骤可以由 LLM 的语义理解能力自然完成。
2. **第 5 节的 Directory Discovery 层取消独立模块**：扫描逻辑内联到 tool-executor 中直接调用 IPC，不再维护独立的 discovery-engine 和 filter-rules。
3. **Task Hub / Plan 概念暂时移除**：v1 中的 AgentPlan、UnifiedTask、TaskLifecycle 等 20+ 类型在 MVP 阶段过度设计，v2 简化为直接向各工具 store 注入任务。
4. **第 6.1 节的 TargetSet 不再暴露给 LLM**：原设计让 LLM 构造完整的 TargetSet 对象，实际测试中 LLM 难以正确填充 10 个字段。v2 改为 LLM 只提供目录路径列表，扫描和筛选由 executor 内部处理。

这些偏差均在不影响最终能力的前提下，显著降低了 LLM 出错概率和开发维护成本。后续如需恢复高级筛选能力（如排除规则、glob 模式），可以在 v2 基础上渐进增加工具参数，而非回退到 v1 的复杂管线。
