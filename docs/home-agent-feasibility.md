# FusionKit 首页升级为对话式 Agent 应用：可行性研究与实施方案

## 1. 目标定义

将当前 `Home` 首页改造为“对话式 Agent 工作台”，支持用户用自然语言下达任务，由 AI 自主决定：

- 调用哪个工具（字幕翻译 / 格式转换 / 语言提取）。
- 选择哪些文件进入哪个工具的任务队列。
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

4. **缺少全局可复用的文件上下文池**
   - 当前文件上传主要在工具页面内处理，首页 Agent 无法直接复用同一批文件上下文。

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

### 6.1 文件选择策略（重点）

Agent 不应直接“猜文件”，应基于可见上下文做决策：

1. 用户在首页上传/拖入文件（形成候选池）。
2. 记录文件元信息：`name/ext/path/size/hash/preview`。
3. Agent 只允许在候选池中选文件，不可访问未知路径。
4. 当匹配不唯一时，必须追问确认（例如“全部 srt 还是仅最近 3 个？”）。

### 6.2 参数补全策略（重点）

优先级建议：

1. 用户明确给定参数（最高优先）。
2. 当前会话上下文（上一轮确认的偏好）。
3. 工具默认值（来自现有设置页/store）。
4. 若关键参数缺失且存在风险，触发追问。

### 6.3 入队策略

建议提供两种执行模式：

- **草案模式（默认）**：AI 先把任务加入 `NotStarted`，用户点确认开始。
- **自动执行模式**：AI 生成计划后立即开始（需显式开启）。

---

## 7. 关键实现节点（按落地顺序）

### 阶段 0：统一任务模型（必须先做）

目标：把“翻译/转换/提取”都抽象成统一任务实体，支持首页注入。

建议新增：

- `TaskKind`: `subtitle.translate | subtitle.convert | subtitle.extract`
- `TaskLifecycle`: `draft | queued | running | success | failed | canceled`
- `TaskSource`: `home-agent | tool-page | api`

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

建议最少先做 3 个工具（MVP）：

1. `queue_subtitle_translate_tasks`
   - 入参：`files[]`, `sliceType`, `outputMode`, `outputDir`, `conflictPolicy`
2. `queue_subtitle_convert_tasks`
   - 入参：`files[]`, `to`, `defaultDurationMs`, `stripMediaExt`, `outputMode`, `outputDir`, `conflictPolicy`
3. `queue_subtitle_extract_tasks`
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

- 只允许从用户显式上传的候选池选择。
- 执行前展示文件清单 + 参数摘要。
- 默认草案模式，不直接执行。

### 11.3 风险：成本不可控（翻译模型调用）

控制：

- 复用现有 token 预估逻辑（`estimate-subtitle-tokens`）。
- 增加“本次计划预计费用”展示和预算阈值提醒。

### 11.4 风险：可观察性不足

控制：

- 每轮 tool-call 记录：输入摘要、校验结果、执行状态、耗时。
- 失败日志结构化，支持导出诊断。

---

## 12. 测试策略（建议）

### 单元测试（Vitest）

- 工具参数 schema 校验。
- 参数默认值填充逻辑。
- 文件筛选规则（按扩展名/用户指令）。

### 集成测试

- 模拟 LLM 输出 tool-call -> 校验 -> 入队 -> 执行回调。
- 异常流程：空文件、无输出目录、模型配置缺失、IPC 报错。

### E2E 测试（Playwright）

- 首页上传文件 -> 对话下达任务 -> 生成计划 -> 确认执行 -> 观察进度。
- 多工具串联任务（例如“先转 SRT 再提取中文”）。

---

## 13. 里程碑与预估工期（单人）

| 里程碑 | 目标 | 预估 |
| --- | --- | --- |
| M0 | 任务模型与边界设计 | 0.5 - 1 天 |
| M1 | 转换/提取 store 抽离 + 统一任务总线 | 2 - 3 天 |
| M2 | Tool Registry + 校验层 | 1 - 2 天 |
| M3 | 首页对话 UI + Agent 编排 MVP | 2 - 3 天 |
| M4 | 进度回流、失败处理、可解释性完善 | 1 - 2 天 |
| M5 | 测试、回归、文档补齐 | 1 - 2 天 |

**总计：约 7.5 - 13 天（视功能深度和测试覆盖而定）**。

---

## 14. MVP 验收标准（建议）

满足以下条件即可进入可用状态：

- 首页可上传文件并对话下达任务。
- Agent 能在三种字幕工具中自动选择并生成任务草案。
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
