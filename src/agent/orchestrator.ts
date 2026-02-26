import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import { getToolDescriptionsForLLM } from "./tool-registry";
import { executeTool } from "./tool-executor";
import type { AgentMessage } from "./types";

// ---------------------------------------------------------------------------
// Orchestrator — 对话优先、按需调用工具、多轮循环
// ---------------------------------------------------------------------------

const MAX_TOOL_ROUNDS = 20;

function buildSystemPrompt(): string {
  const { executionMode } = useAgentStore.getState();

  const executionModeDescription = {
    queue_only:
      'Current execution mode: **Queue Only** — tasks are only added to the queue. The user will start them manually from the tool page. After queuing, tell the user: "已将任务加入队列，请前往对应工具页手动启动。"',
    ask_before_execute:
      'Current execution mode: **Ask Before Execute** — tasks are added to the queue, then the user will be asked via UI whether to execute immediately. After queuing, tell the user: "已将任务加入队列，请在下方确认是否立即执行。"',
    auto_execute:
      'Current execution mode: **Auto Execute** — tasks are added to the queue and automatically started. After queuing, tell the user: "已将任务加入队列并自动开始执行。"',
  }[executionMode];

  return `You are FusionKit Assistant, a helpful AI that assists users with subtitle file processing tasks.

## Your Capabilities
You have access to tools for three subtitle operations:
1. **Translate** (翻译): Translate subtitle text into another language
2. **Convert** (转换): Change file format (SRT ↔ LRC ↔ VTT)
3. **Extract** (提取): Keep one language from bilingual subtitles (Chinese or Japanese)

## IMPORTANT Behavioral Rules
- **Conversation first**: You are a normal conversational assistant. If the user is chatting, asking questions, or saying hello, just respond naturally. Do NOT force tool calls.
- **No hallucinated tasks**: NEVER invent or assume tasks that the user did not ask for. If the user's message does not mention any subtitle operation, do NOT call any tool.
- **Distinguish operations clearly**:
  - "转换" / "convert" / "转" = FORMAT conversion (e.g. SRT→LRC), use queue_subtitle_convert
  - "翻译" / "translate" = LANGUAGE translation, use queue_subtitle_translate
  - "提取" / "extract" = Extract one language from bilingual, use queue_subtitle_extract
- **Scan before queue**: When the user mentions a directory path for processing, first call scan_subtitle_files to discover files, then call the appropriate queue tool with the discovered filePaths.
- **Default outputMode is "source"** (save output next to the original file) unless the user specifies otherwise.
- **Respond in the same language as the user.**
- **When information is missing** (e.g. no path given, unclear operation), ask the user politely. Do NOT guess.

## Execution Mode
${executionModeDescription}
When the tool result includes "executionMode" and "executionStatus", use them to inform your response accurately. Do NOT fabricate execution status.

## Workflow for Task Requests
1. User mentions an operation + a path → call scan_subtitle_files with the directory
2. Review scan results → call the matching queue_* tool with discovered file paths
3. Summarize what was queued and the execution status based on the current execution mode

## Workflow for Non-Task Messages
Just respond naturally. Talk about the app, answer questions, or have a friendly conversation.`;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 处理用户输入。
 * 流程：用户消息 → LLM → (可能多轮 tool-call 循环) → 最终文本回复
 */
export async function handleUserMessage(userContent: string): Promise<void> {
  const store = useAgentStore.getState();
  const modelStore = useModelStore.getState();

  const userMsg: AgentMessage = {
    id: generateId(),
    role: "user",
    content: userContent,
    timestamp: Date.now(),
  };
  store.addMessage(userMsg);
  store.setStatus("thinking");
  store.setStreaming(true);

  const model = modelStore.model;
  const apiKey = modelStore.getApiKeyByType(model);
  const endPoint = modelStore.getModelUrlByType(model);
  const modelKey = modelStore.getModelKeyByType(model);

  if (!apiKey) {
    store.addMessage({
      id: generateId(),
      role: "assistant",
      content: "请先在设置页面配置 API Key。",
      timestamp: Date.now(),
    });
    store.setStatus("error");
    store.setStreaming(false);
    return;
  }

  try {
    await runAgentLoop(endPoint, apiKey, modelKey);
    store.setStatus("idle");
  } catch (err: any) {
    console.error("Orchestrator error:", err);
    store.addMessage({
      id: generateId(),
      role: "assistant",
      content: `调用出错：${err?.message || String(err)}`,
      timestamp: Date.now(),
    });
    store.setStatus("error");
  } finally {
    store.setStreaming(false);
  }
}

// ---------------------------------------------------------------------------
// 多轮 Agent 循环：LLM 回复 → 有 tool_calls 则执行并再次请求 → 直到纯文本
// ---------------------------------------------------------------------------

async function runAgentLoop(
  endPoint: string,
  apiKey: string,
  modelKey: string
): Promise<void> {
  const store = useAgentStore.getState;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const messages = buildLLMMessages(store().session.messages);
    const response = await callLLM(endPoint, apiKey, modelKey, messages);

    const choice = response?.choices?.[0];
    if (!choice) {
      store().addMessage({
        id: generateId(),
        role: "assistant",
        content: "模型返回了空响应，请稍后重试。",
        timestamp: Date.now(),
      });
      return;
    }

    const assistantContent = choice.message?.content || "";
    const toolCalls: any[] | undefined = choice.message?.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      if (assistantContent) {
        store().addMessage({
          id: generateId(),
          role: "assistant",
          content: assistantContent,
          timestamp: Date.now(),
        });
      }
      return;
    }

    // 有 tool_calls：先记录 assistant 消息（含 rawToolCalls）
    store().addMessage({
      id: generateId(),
      role: "assistant",
      content: assistantContent,
      timestamp: Date.now(),
      rawToolCalls: toolCalls,
    });

    // 依次执行每个 tool call，并将结果作为 tool 消息加入
    for (const tc of toolCalls) {
      const toolName = tc.function?.name;
      let toolArgs: unknown;
      try {
        toolArgs = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        toolArgs = {};
      }

      const result = await executeTool(toolName, toolArgs);

      store().addMessage({
        id: generateId(),
        role: "tool",
        content: JSON.stringify(result.data ?? result.error, null, 2),
        timestamp: Date.now(),
        toolResult: {
          callId: tc.id,
          toolName,
          success: result.success,
          data: result.data,
          error: result.error,
        },
      });
    }

    // 继续循环：LLM 将看到 tool 结果，决定是否继续调用工具或给出最终回复
  }

  // 超出最大轮次，给出兜底回复
  store().addMessage({
    id: generateId(),
    role: "assistant",
    content: "操作步骤过多，已停止自动执行。请检查结果或重新描述需求。",
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// 构建 LLM 消息序列
// ---------------------------------------------------------------------------

function buildLLMMessages(
  sessionMessages: AgentMessage[]
): Array<Record<string, any>> {
  const msgs: Array<Record<string, any>> = [
    { role: "system", content: buildSystemPrompt() },
  ];

  for (const m of sessionMessages) {
    if (m.role === "tool") {
      msgs.push({
        role: "tool",
        content: m.content,
        tool_call_id: m.toolResult?.callId,
      });
    } else if (
      m.role === "assistant" &&
      m.rawToolCalls &&
      m.rawToolCalls.length > 0
    ) {
      msgs.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.rawToolCalls,
      });
    } else {
      msgs.push({ role: m.role, content: m.content });
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// LLM API 调用
// ---------------------------------------------------------------------------

async function callLLM(
  endPoint: string,
  apiKey: string,
  modelKey: string,
  messages: Array<Record<string, any>>
): Promise<any> {
  const tools = getToolDescriptionsForLLM();

  const body: Record<string, any> = {
    model: modelKey,
    messages,
    temperature: 0.3,
    max_tokens: 4096,
  };

  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(endPoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API error ${response.status}: ${text}`);
  }

  return response.json();
}
