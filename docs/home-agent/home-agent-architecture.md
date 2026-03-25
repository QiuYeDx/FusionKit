# HomeAgent 实现解析：基于 AI SDK 的对话式 Agent 应用

> 本文档面向希望学习「如何用 Vercel AI SDK 开发一个 Agent 应用」的开发者。  
> 以 FusionKit 项目中的 **HomeAgent** 为实例，完整拆解从架构设计到代码实现的每一层。

---

## 目录

1. [项目背景与目标](#1-项目背景与目标)
2. [技术栈概览](#2-技术栈概览)
3. [整体架构](#3-整体架构)
4. [核心数据流（一次完整对话的全过程）](#4-核心数据流一次完整对话的全过程)
5. [分层实现详解](#5-分层实现详解)
   - 5.1 [类型层 — types.ts](#51-类型层--typests)
   - 5.2 [工具 Schema 层 — tool-schemas.ts](#52-工具-schema-层--tool-schemasts)
   - 5.3 [工具注册层 — tools.ts](#53-工具注册层--toolsts)
   - 5.4 [工具执行层 — tool-executor.ts](#54-工具执行层--tool-executorts)
   - 5.5 [编排层 — orchestrator.ts](#55-编排层--orchestratorts)
   - 5.6 [状态管理层 — useAgentStore.ts](#56-状态管理层--useagentstorets)
   - 5.7 [UI 层 — HomeAgent/index.tsx](#57-ui-层--homeagentindextsx)
6. [关键设计决策](#6-关键设计决策)
7. [AI SDK 核心 API 用法](#7-ai-sdk-核心-api-用法)
8. [执行模式机制](#8-执行模式机制)
9. [Token 统计与成本追踪](#9-token-统计与成本追踪)
10. [从 v1 到 v2 的架构演进教训](#10-从-v1-到-v2-的架构演进教训)
11. [文件清单速查](#11-文件清单速查)

---

## 1. 项目背景与目标

FusionKit 是一个 **Electron + React** 桌面应用，提供字幕文件处理三大功能：

| 功能 | 说明 |
|------|------|
| 翻译（Translate） | 将字幕文本翻译为其他语言 |
| 格式转换（Convert） | 在 SRT / LRC / VTT 格式之间互转 |
| 语言提取（Extract） | 从双语字幕中提取单一语言（中文/日文） |

**HomeAgent** 的目标是将首页升级为「对话式 Agent 工作台」——用户通过自然语言描述需求，AI 自动识别意图、扫描文件、将任务加入对应工具的执行队列。

核心链路：**自然语言意图 → 工具调用决策 → 文件扫描 → 任务入队 → 可追踪执行**。

---

## 2. 技术栈概览

| 技术 | 角色 | 版本 |
|------|------|------|
| **AI SDK** (`ai`) | LLM 调用、流式传输、工具循环 | ^6.0.0 |
| **@ai-sdk/openai-compatible** | 接入 OpenAI 兼容 API（DeepSeek 等） | ^1.0.0 |
| **Zod** | 工具参数 Schema 定义与校验 | ^4.3.6 |
| **Zustand** | 全局状态管理（会话、Token 统计、执行模式） | ^5.0.3 |
| **React 19** | UI 渲染 | 19.1.1 |
| **Electron** | 桌面应用壳 + 主进程 IPC（文件读写、目录扫描） | ^33.2.0 |
| **Vite** | 构建工具 | ^5.4.11 |
| **Tailwind CSS** | 样式 | ^4.1.11 |
| **Motion (Framer Motion)** | 动画 | ^12.23.24 |

---

## 3. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         UI 层                                   │
│  HomeAgent/index.tsx                                            │
│  ┌───────────┐ ┌──────────────┐ ┌───────────────────────────┐  │
│  │ 对话输入框 │ │ 消息气泡列表 │ │ 工具调用/结果/确认卡片    │  │
│  └─────┬─────┘ └──────┬───────┘ └──────────┬────────────────┘  │
│        │               │                    │                   │
├────────┼───────────────┼────────────────────┼───────────────────┤
│        ▼               ▲                    ▲                   │
│  状态管理层 (Zustand)                                           │
│  useAgentStore.ts                                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ session (messages, status)                               │   │
│  │ isStreaming / streamingText / activeToolCalls             │   │
│  │ executionMode / pendingExecution                         │   │
│  │ tokenStats (累计 token 用量与费用)                        │   │
│  └──────────────────────────────────────┬───────────────────┘   │
│                                         │                       │
├─────────────────────────────────────────┼───────────────────────┤
│                                         ▼                       │
│  编排层 (Orchestrator)                                          │
│  orchestrator.ts                                                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ handleUserMessage(text)                                  │   │
│  │  1. 构建 System Prompt（动态感知执行模式）               │   │
│  │  2. 调用 AI SDK streamText()                             │   │
│  │  3. 消费 fullStream：text-delta / tool-call / tool-result│   │
│  │  4. 多轮自动循环（最多 20 步）                           │   │
│  │  5. Token 统计 → recordUsage                             │   │
│  └────────────────────────┬─────────────────────────────────┘   │
│                           │                                     │
├───────────────────────────┼─────────────────────────────────────┤
│                           ▼                                     │
│  工具注册层                                                      │
│  tools.ts                                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ agentTools = {                                           │   │
│  │   scan_subtitle_files        → executeScan()             │   │
│  │   queue_subtitle_translate   → executeQueueTranslate()   │   │
│  │   queue_subtitle_convert     → executeQueueConvert()     │   │
│  │   queue_subtitle_extract     → executeQueueExtract()     │   │
│  │ }                                                        │   │
│  └────────────────────────┬─────────────────────────────────┘   │
│                           │                                     │
│  工具 Schema 层            │  工具执行层                         │
│  tool-schemas.ts           │  tool-executor.ts                  │
│  ┌─────────────────┐      │  ┌──────────────────────────┐      │
│  │ Zod schemas ×4  │◄─────┤  │ executeScan()            │      │
│  │ (扁平、LLM友好) │      │  │ executeQueueTranslate()  │      │
│  └─────────────────┘      │  │ executeQueueConvert()    │      │
│                           └──│ executeQueueExtract()    │      │
│                              │ handlePostQueue()        │      │
│                              └────────────┬─────────────┘      │
│                                           │                     │
├───────────────────────────────────────────┼─────────────────────┤
│                                           ▼                     │
│  业务 Store 层                                                   │
│  ┌────────────────────┐ ┌────────────────────┐ ┌──────────────┐│
│  │TranslatorStore     │ │ConverterStore      │ │ExtractorStore││
│  │(翻译任务队列)       │ │(转换任务队列)       │ │(提取任务队列) ││
│  └────────┬───────────┘ └────────┬───────────┘ └──────┬───────┘│
│           │                      │                     │        │
├───────────┼──────────────────────┼─────────────────────┼────────┤
│           ▼                      ▼                     ▼        │
│  Electron IPC 执行层                                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ window.ipcRenderer.invoke("scan-directory", ...)         │   │
│  │ window.ipcRenderer.invoke("read-file-head", ...)         │   │
│  │ window.ipcRenderer.invoke("translate-subtitle", ...)     │   │
│  │ window.ipcRenderer.invoke("convert-subtitle", ...)       │   │
│  │ window.ipcRenderer.invoke("extract-subtitle-language")   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 核心数据流（一次完整对话的全过程）

以用户输入 *"把 /Users/me/subs 目录下的字幕翻译成中文"* 为例：

```
用户输入
  │
  ▼
① handleUserMessage("把 /Users/me/subs 目录下的字幕翻译成中文")
  │
  ├─ 创建 user 消息 → addMessage()
  ├─ setStatus("thinking"), setStreaming(true)
  │
  ▼
② 构建 AI SDK 调用参数
  │
  ├─ buildSystemPrompt()     → 生成含执行模式描述的 system prompt
  ├─ buildModelMessages()    → 将 AgentMessage[] 转换为 ModelMessage[]
  ├─ createModel()           → 用 @ai-sdk/openai-compatible 创建模型实例
  │
  ▼
③ streamText({ model, system, messages, tools, stopWhen: stepCountIs(20) })
  │
  │  AI SDK 内部开始 LLM 调用，返回 fullStream 异步迭代器
  │
  ▼
④ 第 1 步：LLM 决定调用 scan_subtitle_files
  │
  ├─ fullStream 产出 tool-input-start → UI 显示工具加载状态
  ├─ fullStream 产出 tool-call        → 记录 pendingToolCalls
  │     args: { directories: ["/Users/me/subs"], recursive: true }
  │
  ├─ AI SDK 自动执行 executeScan()
  │     └─ IPC: scan-directory → 返回 [{absolutePath, fileName, ...}, ...]
  │
  ├─ fullStream 产出 tool-result      → 记录 pendingToolResults
  ├─ fullStream 产出 finish-step      → 提交 assistant 消息 + tool 结果消息到 store
  │
  ▼
⑤ 第 2 步：LLM 看到扫描结果，决定调用 queue_subtitle_translate
  │
  ├─ tool-call: { filePaths: [...], sliceType: "NORMAL", outputMode: "source" }
  │
  ├─ AI SDK 自动执行 executeQueueTranslate()
  │     ├─ 逐文件读取内容 (IPC: read-file-head)
  │     ├─ 估算 token 费用
  │     ├─ 调用 translatorStore.addTask() 加入队列
  │     └─ handlePostQueue() → 根据执行模式决定后续动作
  │
  ├─ tool-result → 返回 { queuedCount, totalFiles, executionMode, executionStatus }
  ├─ finish-step → 提交到 store
  │
  ▼
⑥ 第 3 步：LLM 生成最终文字总结
  │
  ├─ text-delta → appendStreamingText() → UI 实时显示流式文字
  ├─ finish-step → commitStreamingAsAssistant()
  │
  ▼
⑦ 流结束
  │
  ├─ setStatus("idle"), setStreaming(false)
  ├─ recordUsage() → 更新 tokenStats
  └─ 如果是 ask_before_execute 模式 → UI 显示 PendingExecutionCard
```

---

## 5. 分层实现详解

### 5.1 类型层 — `types.ts`

**文件**: `src/agent/types.ts`（约 97 行）

这是整个 Agent 系统的类型基础，定义了所有核心数据结构：

```typescript
// 消息角色
type AgentMessageRole = "user" | "assistant" | "system" | "tool";

// 消息实体 — 对话中的每一条消息
interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  timestamp: number;
  toolResult?: AgentToolResult;   // tool 消息才有
  toolCalls?: AgentToolCall[];    // assistant 消息可能有
}

// 工具调用记录
interface AgentToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

// 会话状态机
type AgentSessionStatus = "idle" | "thinking" | "streaming" | "error";

// 执行模式（三选一）
type ExecutionMode = "queue_only" | "ask_before_execute" | "auto_execute";
```

**设计要点**：

- `AgentMessage` 同时承载了 user / assistant / tool 三种角色的消息，通过 `role` 区分。
- assistant 消息可以同时包含 `content`（文字）和 `toolCalls`（工具调用），这对应 LLM 的 function calling 输出。
- 会话状态是简单的状态机：`idle → thinking → streaming → idle`（或 `error`）。

---

### 5.2 工具 Schema 层 — `tool-schemas.ts`

**文件**: `src/agent/tool-schemas.ts`（约 90 行）

用 **Zod** 定义每个工具的入参结构。这些 Schema 有双重作用：
1. **告诉 LLM** 每个工具需要哪些参数（AI SDK 会将 Zod Schema 转为 JSON Schema 发送给 LLM）。
2. **校验 LLM 输出** 的参数是否合法。

```typescript
// 示例：扫描工具的 Schema
const scanSubtitleFilesSchema = z.object({
  directories: z.array(z.string()).min(1)
    .describe("Absolute directory paths to scan"),
  extensions: z.array(z.string()).default(["LRC", "SRT", "VTT"])
    .describe("File extensions to include"),
  recursive: z.boolean().default(true)
    .describe("Scan subdirectories"),
});
```

**设计原则（从 v1 失败中总结）**：

| 原则 | 说明 |
|------|------|
| **扁平化** | 不使用嵌套对象。LLM 填充深层嵌套结构容易出错。 |
| **给默认值** | 尽量用 `.default()` 减少 LLM 需要决策的参数数量。 |
| **用 `.describe()`** | 每个字段都有英文描述，帮助 LLM 理解参数含义。 |
| **入参最少化** | LLM 只需提供路径字符串数组，复杂逻辑由 executor 内部处理。 |

---

### 5.3 工具注册层 — `tools.ts`

**文件**: `src/agent/tools.ts`（约 55 行）

使用 AI SDK 的 `tool()` 函数将 Schema 和执行函数组装为工具对象，导出供 `orchestrator.ts` 使用。

```typescript
import { tool } from "ai";

export const agentTools = {
  scan_subtitle_files: tool({
    description: "Scan directories for subtitle files...",
    inputSchema: scanSubtitleFilesSchema,
    execute: async (args) => executeScan(args),
  }),
  queue_subtitle_translate: tool({ /* ... */ }),
  queue_subtitle_convert:   tool({ /* ... */ }),
  queue_subtitle_extract:   tool({ /* ... */ }),
};
```

**AI SDK `tool()` 的三要素**：

| 属性 | 作用 |
|------|------|
| `description` | 告诉 LLM 这个工具做什么，LLM 据此决定是否调用 |
| `inputSchema` | Zod Schema，AI SDK 自动转为 JSON Schema 传给 LLM |
| `execute` | 工具被调用时实际执行的异步函数 |

工具命名约定：`scan_*` 用于查询，`queue_*` 用于将任务加入队列。LLM 通过 `description` 判断应该先 scan 再 queue。

---

### 5.4 工具执行层 — `tool-executor.ts`

**文件**: `src/agent/tool-executor.ts`（约 369 行）

这是工具的**实际业务逻辑**所在。每个 `execute*` 函数负责与 Electron IPC 和业务 Store 交互。

#### 5.4.1 扫描工具 `executeScan()`

```
入参: { directories: string[], extensions: string[], recursive: boolean }
  │
  ▼
遍历每个目录 → IPC: scan-directory → 获取文件列表
  │
  ▼
去重(deduplicateByPath) → 返回 { files, totalCount, scannedDirectories }
```

#### 5.4.2 入队工具 `executeQueueTranslate()` (其他两个类似)

```
入参: { filePaths: string[], sliceType, outputMode, outputDir }
  │
  ▼
逐文件处理:
  ├─ readFileContent(filePath)       → IPC: read-file-head
  ├─ estimateSubtitleTokensFast()    → 快速估算费用
  ├─ translatorStore.addTask({...})  → 写入 Zustand 任务队列
  └─ estimateSubtitleTokens()        → 异步精确估算(后台更新)
  │
  ▼
handlePostQueue(storeType, queuedCount, result) → 根据执行模式决定后续
```

#### 5.4.3 执行模式处理 `handlePostQueue()`

这是执行模式的核心分发点：

```typescript
function handlePostQueue(storeType, queuedCount, result) {
  switch (executionMode) {
    case "auto_execute":
      executeTasksInStores([storeType]);  // 立即执行
      // result.data += { executionStatus: "started" }
      break;
    case "ask_before_execute":
      setPendingExecution({...});  // 设置待确认状态
      // result.data += { executionStatus: "pending_confirmation" }
      break;
    case "queue_only":
      // result.data += { executionStatus: "queued_only" }
      break;
  }
}
```

返回值中的 `executionMode` 和 `executionStatus` 会随 tool-result 传给 LLM，让 LLM 准确描述当前执行状态。

---

### 5.5 编排层 — `orchestrator.ts`

**文件**: `src/agent/orchestrator.ts`（约 378 行）

这是整个 Agent 的**大脑**，负责将用户输入转化为 LLM 调用，并处理完整的流式响应。

#### 5.5.1 动态 System Prompt

```typescript
function buildSystemPrompt(): string {
  const { executionMode } = useAgentStore.getState();
  // 根据当前执行模式生成不同的指导文案
  return `You are FusionKit Assistant...
    ## Behavioral Rules
    - Conversation first: 普通对话不要调用工具
    - No hallucinated tasks: 不要臆想任务
    - Scan before queue: 先扫描再入队
    - When information is missing, ask politely
    ## Execution Mode
    ${executionModeDescription}  // 动态注入
    ...`;
}
```

**System Prompt 设计要点**：

| 要点 | 说明 |
|------|------|
| 对话优先 | 明确告诉 LLM 它首先是对话助手，不是工具调用机器 |
| 不臆想 | 禁止 LLM 在用户没有提到任务时自行调用工具 |
| 区分操作 | 详细说明"翻译"和"转换"的区别，避免 LLM 混淆 |
| 先扫描再入队 | 引导 LLM 遵循 scan → queue 的工作流 |
| 执行模式感知 | 让 LLM 知道当前模式，准确告知用户执行状态 |
| 语言跟随 | 要求 LLM 用用户的语言回复 |

#### 5.5.2 `handleUserMessage()` 主流程

这是最核心的函数，分为以下阶段：

**阶段 1：准备**
```typescript
// 1. 创建用户消息并加入 store
store.addMessage(userMsg);
store.setStatus("thinking");
store.setStreaming(true);

// 2. 检查模型配置
const agentProfile = modelStore.getAgentProfile();
if (!agentProfile?.apiKey) { /* 提示配置 */ return; }

// 3. 创建 AI 模型实例
const aiModel = createModel(endPoint, apiKey, modelKey);
```

**阶段 2：发起流式调用**
```typescript
const result = streamText({
  model: aiModel,
  system: buildSystemPrompt(),
  messages: modelMessages,      // 历史消息转为 AI SDK 格式
  tools: agentTools,            // 注册的 4 个工具
  stopWhen: stepCountIs(20),    // 最多 20 轮工具循环
  temperature: 0.3,             // 低温度 → 更确定性的输出
  maxOutputTokens: 4096,
  abortSignal: activeAbortController.signal,  // 支持中止
});
```

**阶段 3：消费流**

这是最关键的部分。`fullStream` 是一个异步迭代器，会逐步产出以下事件：

```typescript
for await (const part of result.fullStream) {
  switch (part.type) {
    case "text-delta":
      // LLM 正在输出文字 → 实时追加到 streamingText
      appendStreamingText(part.text);
      break;

    case "tool-input-start":
      // LLM 开始构造工具参数 → UI 显示加载指示器
      setActiveToolCalls([...active, { toolCallId, toolName, args: {} }]);
      break;

    case "tool-call":
      // LLM 完成了一个工具调用的参数构造
      // AI SDK 会自动执行 tool.execute()
      pendingToolCalls.push({ toolCallId, toolName, args });
      break;

    case "tool-result":
      // 工具执行完成，得到返回值
      pendingToolResults.push({ toolCallId, toolName, output });
      break;

    case "finish-step":
      // 一个"步骤"结束（可能是文字步骤或工具步骤）
      // 如果有工具调用 → 提交 assistant 消息 + tool 结果消息
      // 然后 AI SDK 自动将结果送回 LLM，开始下一轮
      if (pendingToolCalls.length > 0) {
        commitStreamingAsAssistant(text, toolCalls);
        for (const tr of pendingToolResults) {
          addMessage({ role: "tool", content: ..., toolResult: ... });
        }
      }
      break;

    case "error":
      throw part.error;
  }
}
```

**阶段 4：收尾**
```typescript
// 提交最终的文字回复
commitStreamingAsAssistant(finalStreamingText);
setStatus("idle");

// 统计 token 用量和费用
recordUsage({ promptTokens, completionTokens, cost, ... });
setStreaming(false);
```

#### 5.5.3 消息格式转换 `buildModelMessages()`

AI SDK 使用 `ModelMessage` 格式，与自定义的 `AgentMessage` 不同。此函数做转换：

```
AgentMessage(role: "user")      → ModelMessage(role: "user", content: text)
AgentMessage(role: "assistant") → ModelMessage(role: "assistant", content: [text?, tool-call*])
AgentMessage(role: "tool")      → ModelMessage(role: "tool", content: [tool-result])
```

关键点：assistant 消息如果包含 `toolCalls`，必须转为 AI SDK 的 `tool-call` content part 格式，否则 LLM 无法正确理解历史上下文中的工具调用。

#### 5.5.4 中止机制

```typescript
let activeAbortController: AbortController | null = null;

export function abortCurrentStream(): void {
  activeAbortController?.abort();
  activeAbortController = null;
}
```

用户点击停止按钮 → 调用 `abortCurrentStream()` → AbortController 发出中止信号 → `streamText` 停止 → catch 块中判断 `AbortError` → 状态设为 `idle`（不算错误）。

---

### 5.6 状态管理层 — `useAgentStore.ts`

**文件**: `src/store/agent/useAgentStore.ts`（约 209 行）

使用 **Zustand** 管理所有 Agent 相关状态。

#### 状态结构

```typescript
interface AgentStore {
  // 会话
  session: AgentSession;          // { id, messages[], status, timestamps }

  // 流式状态
  isStreaming: boolean;            // 是否正在流式传输
  streamingText: string;           // 当前正在接收的文字（逐字追加）
  activeToolCalls: AgentToolCall[]; // 当前正在执行的工具调用列表

  // 执行模式
  executionMode: ExecutionMode;    // 持久化到 localStorage
  pendingExecution: PendingExecution | null; // ask_before_execute 的待确认信息

  // Token 统计
  tokenStats: TokenStats;          // 累计 token 用量与费用
}
```

#### 关键方法

| 方法 | 作用 |
|------|------|
| `addMessage(msg)` | 向会话追加消息 |
| `setStatus(status)` | 更新会话状态机 |
| `appendStreamingText(delta)` | 追加流式文字片段 |
| `commitStreamingAsAssistant(text, toolCalls?)` | 将累积的流式文字提交为正式 assistant 消息 |
| `resetSession()` | 重置整个会话（清空消息、统计、待确认执行） |
| `setExecutionMode(mode)` | 切换执行模式并持久化 |
| `confirmExecution()` | 确认待执行任务 → 调用各 store 的 `startAllTasks()` |
| `recordUsage(data)` | 记录一次交互的 token 用量和费用 |

#### 持久化策略

- `executionMode` → `localStorage`（用户偏好）
- `session` / `tokenStats` → 内存（刷新即重置，不持久化对话历史）

#### `executeTasksInStores()` 导出函数

```typescript
export function executeTasksInStores(stores: TaskStoreType[]): void {
  for (const storeType of stores) {
    switch (storeType) {
      case "translate": useSubtitleTranslatorStore.getState().startAllTasks(); break;
      case "convert":   useSubtitleConverterStore.getState().startAllTasks(); break;
      case "extract":   useSubtitleExtractorStore.getState().startAllTasks(); break;
    }
  }
}
```

这是 Agent 与业务 Store 之间的桥梁。`auto_execute` 和 `confirmExecution` 都通过它触发实际执行。

---

### 5.7 UI 层 — `HomeAgent/index.tsx`

**文件**: `src/pages/HomeAgent/index.tsx`（约 958 行）

#### 页面结构

```
HomeAgent
├── 空状态（无消息时）
│   ├── Logo + 同心圆动画
│   ├── 标题和描述
│   ├── 未配置模型的警告 Banner
│   └── 建议操作 Pills（快捷输入模板）
│
├── 消息列表（有消息时）
│   ├── MessageBubble × N
│   │   ├── 用户消息（右侧蓝色气泡）
│   │   ├── 助手消息（左侧灰色气泡）
│   │   └── 工具消息（缩进的结果卡片）
│   ├── ToolCallBubble（正在执行的工具调用）
│   ├── StreamingTextContent（流式文字 + 闪烁光标）
│   └── PendingExecutionCard（待确认执行卡片）
│
└── 底部输入区
    ├── TokenStatsBar（上下文占用进度条 + Popover 详情）
    ├── 新建对话按钮
    └── 输入胶囊
        ├── CapsuleModeSelector（执行模式下拉）
        ├── 文字输入框
        └── 发送/停止按钮
```

#### 核心组件说明

**`MessageBubble`** — 消息渲染
- `role: "user"` → 右侧蓝色气泡 + 用户图标
- `role: "assistant"` → 左侧灰色气泡 + 机器人图标
  - 如果有 `toolCalls` → 额外渲染 `ToolCallBubble`
- `role: "tool"` → 缩进的结果卡片（成功绿色 / 失败红色）

**`StreamingTextContent`** — 流式文字动画
- 使用 `useRef` 将文字增量分段，每段应用 `streaming-fade-in` CSS 动画
- 末尾有闪烁光标，用 `motion.span` 的 `layoutId` 保持位置连续性

**`PendingExecutionCard`** — 执行确认卡片
- 仅在 `ask_before_execute` 模式下出现
- 显示各 store 的待执行任务数量
- 提供「立即执行」和「稍后执行」按钮
- 支持跳转到对应工具页面查看详情

**`TokenStatsBar`** — 实时 Token 统计
- 底部紧凑显示：上下文占用百分比 + 输入/输出 token 数 + 累计费用
- 点击展开 Popover 显示详细统计、每轮交互记录、模型信息
- 上下文进度条根据占用率变色（绿 → 黄 → 红）

**`CapsuleModeSelector`** — 执行模式选择器
- 嵌入输入框左侧的紧凑 Select 下拉
- 三个选项：仅添加任务 / 询问后执行 / 自动执行
- 每个选项有图标和国际化文案

---

## 6. 关键设计决策

### 6.1 为什么选择前端编排（而非主进程编排）？

| 考量 | 前端编排 | 主进程编排 |
|------|----------|------------|
| 开发速度 | 快 — 直接复用 React 状态 | 慢 — 需要大量 IPC 通信 |
| UI 实时性 | 好 — 流式数据直接驱动 UI | 需要通过事件桥接 |
| 复杂度 | 低 | 高 |
| 安全边界 | 弱（渲染进程可访问所有 API） | 强 |

结论：MVP 阶段选择前端编排，保持接口可演进到主进程。

### 6.2 为什么 LLM 不直接执行任务，而是"入队"？

1. **可预览**：用户可以在工具页面查看即将执行的任务。
2. **可取消**：入队后执行前，用户有机会修改或取消。
3. **可批量**：多个任务统一管理，支持并发控制。
4. **可追踪**：任务进度通过 Store 管理，有完整的状态机。

### 6.3 为什么用 `streamText` 而不是 `generateText`？

- `streamText` 提供**流式传输**，用户能看到 LLM 逐字输出，体验更好。
- `streamText` 的 `fullStream` 提供细粒度事件（`text-delta`, `tool-call`, `tool-result`, `finish-step`），方便实现实时 UI 更新。
- `streamText` 同样支持自动工具循环（`stopWhen` 参数），不需要手动实现循环。

### 6.4 为什么 `stopWhen: stepCountIs(20)` 设为 20 步？

一个典型的 scan → queue 链路需要 3 步（scan + queue + 总结），允许 20 步留出充足空间应对：
- 多目录分次扫描
- 多工具串联（先转换再翻译）
- LLM 决定追问用户后再继续

---

## 7. AI SDK 核心 API 用法

### 7.1 `streamText()` — 流式 LLM 调用

```typescript
import { streamText, stepCountIs } from "ai";

const result = streamText({
  model: aiModel,                    // 模型实例
  system: "...",                     // System Prompt
  messages: modelMessages,           // 历史消息
  tools: agentTools,                 // 注册的工具集合
  stopWhen: stepCountIs(20),         // 最多 20 轮工具循环
  temperature: 0.3,
  maxOutputTokens: 4096,
  abortSignal: controller.signal,    // 支持中止
});
```

### 7.2 `tool()` — 工具定义

```typescript
import { tool } from "ai";
import { z } from "zod";

const myTool = tool({
  description: "工具描述（LLM 据此判断是否调用）",
  inputSchema: z.object({
    path: z.string().describe("文件路径"),
    format: z.enum(["SRT", "LRC"]).default("SRT"),
  }),
  execute: async (args) => {
    // args 已经过 Zod 校验，类型安全
    return { success: true, data: "..." };
  },
});
```

### 7.3 `fullStream` — 流事件类型

| 事件类型 | 触发时机 | 用途 |
|----------|----------|------|
| `text-delta` | LLM 输出了一段文字 | 追加到 UI 的流式文字区域 |
| `tool-input-start` | LLM 开始构造工具参数 | 显示工具加载指示器 |
| `tool-call` | LLM 完成工具参数构造 | 记录工具调用，AI SDK 自动执行 |
| `tool-result` | 工具 execute 函数返回 | 记录执行结果 |
| `finish-step` | 一个步骤结束 | 提交消息到 store，包含 usage 信息 |
| `error` | 发生错误 | 抛出异常进入 catch |

### 7.4 `createOpenAICompatible()` — 接入兼容 API

```typescript
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const provider = createOpenAICompatible({
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-...",
  name: "fusionkit-provider",
});

const model = provider("deepseek-chat"); // 返回模型实例
```

支持任何 OpenAI API 兼容的服务（DeepSeek、本地 Ollama 等）。

### 7.5 `ModelMessage` 格式

AI SDK 使用自己的消息格式，需要从业务消息转换：

```typescript
// 纯文字消息
{ role: "user", content: "翻译这些字幕" }
{ role: "assistant", content: "好的，我来帮你处理" }

// 带工具调用的 assistant 消息
{
  role: "assistant",
  content: [
    { type: "text", text: "让我先扫描目录..." },
    { type: "tool-call", toolCallId: "call_1", toolName: "scan_subtitle_files", input: {...} },
  ],
}

// 工具结果消息
{
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: "call_1", toolName: "scan_subtitle_files", output: {...} },
  ],
}
```

---

## 8. 执行模式机制

HomeAgent 支持三种执行模式，控制任务入队后的行为：

```
┌─────────────────┐    ┌──────────────────────┐    ┌──────────────────┐
│   queue_only    │    │ ask_before_execute   │    │  auto_execute    │
│   仅添加任务     │    │ 询问后执行            │    │  自动执行         │
├─────────────────┤    ├──────────────────────┤    ├──────────────────┤
│ 任务入队        │    │ 任务入队              │    │ 任务入队          │
│      ↓          │    │      ↓                │    │      ↓            │
│ 不做额外操作    │    │ 显示确认卡片          │    │ 立即执行          │
│      ↓          │    │      ↓                │    │ startAllTasks()  │
│ 用户手动前往    │    │ 用户点击"立即执行"    │    │      ↓            │
│ 工具页启动      │    │      ↓                │    │ 自动开始处理     │
│                 │    │ startAllTasks()       │    │                  │
└─────────────────┘    └──────────────────────┘    └──────────────────┘
```

**数据流**：
1. `useAgentStore.executionMode` 持久化在 `localStorage`
2. `buildSystemPrompt()` 动态感知当前模式，告诉 LLM 该如何描述执行状态
3. `handlePostQueue()` 在每个 queue 工具执行后检查模式并分发
4. UI 通过 `CapsuleModeSelector` 切换，通过 `PendingExecutionCard` 确认

---

## 9. Token 统计与成本追踪

### 数据结构

```typescript
interface TokenStats {
  totalPromptTokens: number;       // 累计输入 token
  totalCompletionTokens: number;   // 累计输出 token
  totalTokens: number;             // 累计总 token
  totalCost: number;               // 累计费用 (USD)
  stepCount: number;               // 累计 LLM 调用次数
  lastPromptTokens: number;        // 最后一步的输入 token（反映上下文窗口占用）
  interactions: InteractionTokenRecord[]; // 每轮交互的详细记录
}
```

### 统计时机

在 `orchestrator.ts` 的 `finally` 块中：

```typescript
// 1. 从每个 finish-step 事件收集 usage
stepUsages.push({
  promptTokens: u.inputTokens,
  completionTokens: u.outputTokens,
  totalTokens: u.totalTokens,
});

// 2. 汇总并计算费用
const cost = (totalP * pricing.inputTokensPerMillion +
              totalC * pricing.outputTokensPerMillion) / 1_000_000;

// 3. 写入 store
recordUsage({ promptTokens, completionTokens, cost, stepCount, lastPromptTokens });
```

### UI 展示

`TokenStatsBar` 组件在输入框上方紧凑显示：
- 上下文占用进度条（根据 `lastPromptTokens / contextWindowSize` 计算百分比）
- 输入/输出 token 总量
- 累计费用
- 点击展开 Popover 查看详细统计和每轮记录

---

## 10. 从 v1 到 v2 的架构演进教训

### v1 的问题（失败经验）

| 问题 | 原因 | 后果 |
|------|------|------|
| LLM 闲聊时强行调用工具 | System Prompt 写了 "CRITICAL: Act immediately" | 用户说"你好"时 LLM 臆想出不存在的任务 |
| 工具参数频繁校验失败 | 7 个工具、10+ 字段的嵌套 Schema | LLM 很难正确填充深层嵌套对象 |
| 多步链路无法完成 | 只支持 1 轮工具调用 | scan 和 queue 无法在一次对话中串联 |
| 有空壳工具 | `resolve_processing_targets` 注册但返回占位文本 | LLM 被误导去调用无效工具 |

### v2 的修正原则

| 原则 | 实践 |
|------|------|
| **对话优先，工具按需** | System Prompt 强调"普通对话就正常回复，不要调用工具" |
| **参数极简** | 7 工具 → 4 工具，嵌套对象 → 扁平字符串数组 |
| **多轮自动循环** | AI SDK 的 `stopWhen: stepCountIs(20)` 自动处理 |
| **不注册空壳工具** | 只注册有实际 execute 实现的工具 |
| **不臆想** | "When information is missing, ask the user politely. Do NOT guess." |

### 可提炼的普适经验

1. **System Prompt 不要用强制语气**。"CRITICAL"、"ALWAYS"、"NEVER" 等词会让 LLM 过度激进。
2. **工具 Schema 越简单越好**。LLM 填参数的能力有限，嵌套超过 2 层就容易出错。
3. **先做最小可用工具集**。4 个扁平工具远比 7 个复杂工具稳定。
4. **不要假设 LLM 每次都会调用工具**。必须有"不调用工具也能正常工作"的路径。
5. **利用 AI SDK 的自动循环**。不要自己写 while 循环管理多步工具调用。

---

## 11. 文件清单速查

| 文件路径 | 职责 | 行数 |
|----------|------|------|
| `src/agent/types.ts` | 类型定义（消息、会话、执行模式、Token 统计） | ~97 |
| `src/agent/tool-schemas.ts` | 4 个工具的 Zod 入参 Schema | ~90 |
| `src/agent/tools.ts` | AI SDK `tool()` 工具注册 | ~55 |
| `src/agent/tool-executor.ts` | 工具执行逻辑（IPC 调用、入队、执行模式处理） | ~369 |
| `src/agent/orchestrator.ts` | 编排核心（System Prompt、streamText、流处理） | ~378 |
| `src/store/agent/useAgentStore.ts` | Zustand 状态管理（会话、流式、执行模式、Token） | ~209 |
| `src/pages/HomeAgent/index.tsx` | UI 页面（对话界面、消息渲染、Token 统计栏） | ~958 |
| `src/store/useModelStore.ts` | 模型配置管理（API Key、端点、定价） | ~180 |
| `src/constants/model.ts` | 模型常量（默认 URL、定价、上下文窗口推断） | ~103 |

---

> **总结**：HomeAgent 的架构清晰地分为 **类型 → Schema → 注册 → 执行 → 编排 → 状态 → UI** 七层。核心驱动力是 AI SDK 的 `streamText()` 函数——它接管了 LLM 调用、工具循环、流式传输等复杂逻辑，让开发者只需关注 System Prompt 设计、工具 Schema 定义、和执行函数实现。v1 到 v2 的演进也证明了一个重要经验：**Agent 应用的关键不在于工具数量和 Schema 复杂度，而在于 Prompt 设计和参数简约性**。
