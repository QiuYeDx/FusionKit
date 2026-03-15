import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import { agentTools } from "./tools";
import type { AgentMessage, AgentToolCall, TokenUsage } from "./types";

// ---------------------------------------------------------------------------
// Orchestrator — AI SDK streamText 驱动的对话 + 工具循环
// ---------------------------------------------------------------------------

let activeAbortController: AbortController | null = null;

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
 * 创建 OpenAI 兼容的 AI SDK model 实例
 */
function createModel(endPoint: string, apiKey: string, modelKey: string) {
  const baseURL = endPoint.replace(/\/chat\/completions\/?$/, "");
  const provider = createOpenAICompatible({
    baseURL,
    apiKey,
    name: "fusionkit-provider",
  });
  return provider(modelKey);
}

/**
 * 将 AgentMessage[] 转换为 AI SDK ModelMessage[] 格式
 */
function buildModelMessages(sessionMessages: AgentMessage[]): ModelMessage[] {
  const msgs: ModelMessage[] = [];

  for (const m of sessionMessages) {
    if (m.role === "user") {
      msgs.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        msgs.push({
          role: "assistant",
          content: [
            ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
            ...m.toolCalls.map((tc) => ({
              type: "tool-call" as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.args,
            })),
          ],
        });
      } else {
        msgs.push({ role: "assistant", content: m.content });
      }
    } else if (m.role === "tool" && m.toolResult) {
      const output = m.toolResult.success === false
        ? { type: "error-text" as const, value: m.toolResult.error ?? "Unknown error" }
        : { type: "json" as const, value: m.toolResult.data ?? null };

      msgs.push({
        role: "tool",
        content: [
          {
            type: "tool-result" as const,
            toolCallId: m.toolResult.callId,
            toolName: m.toolResult.toolName,
            output,
          },
        ],
      });
    }
  }

  return msgs;
}

/**
 * 中止当前正在进行的流式请求
 */
export function abortCurrentStream(): void {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
}

/**
 * 处理用户输入。
 * 流程：用户消息 → streamText（自动工具循环 + 流式传输）→ 实时更新 UI
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

  const agentProfile = modelStore.getAgentProfile();

  if (!agentProfile || !agentProfile.apiKey) {
    store.addMessage({
      id: generateId(),
      role: "assistant",
      content: "请先在设置页面配置 Agent 所用的模型。",
      timestamp: Date.now(),
    });
    store.setStatus("error");
    store.setStreaming(false);
    return;
  }

  const { apiKey, baseUrl: endPoint, modelKey } = agentProfile;
  const pricing = agentProfile.tokenPricing;
  const stepUsages: TokenUsage[] = [];

  activeAbortController = new AbortController();

  try {
    const latestMessages = useAgentStore.getState().session.messages;
    const modelMessages = buildModelMessages(latestMessages);
    const aiModel = createModel(endPoint, apiKey, modelKey);

    const result = streamText({
      model: aiModel,
      system: buildSystemPrompt(),
      messages: modelMessages,
      tools: agentTools,
      stopWhen: stepCountIs(20),
      temperature: 0.3,
      maxOutputTokens: 4096,
      abortSignal: activeAbortController.signal,
    });

    const pendingToolCalls: AgentToolCall[] = [];
    const pendingToolResults: Array<{
      toolCallId: string;
      toolName: string;
      output: unknown;
    }> = [];
    let hasStartedStreaming = false;

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta": {
          if (!hasStartedStreaming) {
            hasStartedStreaming = true;
            useAgentStore.getState().setStatus("streaming");
          }
          useAgentStore.getState().appendStreamingText(part.text);
          break;
        }

        case "tool-input-start": {
          const active = useAgentStore.getState().activeToolCalls;
          if (!active.some((tc) => tc.toolCallId === part.id)) {
            useAgentStore.getState().setActiveToolCalls([
              ...active,
              {
                toolCallId: part.id,
                toolName: part.toolName,
                args: {},
              },
            ]);
          }
          break;
        }

        case "tool-call": {
          pendingToolCalls.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.input as Record<string, unknown>,
          });
          const active = useAgentStore.getState().activeToolCalls;
          const existing = active.find((tc) => tc.toolCallId === part.toolCallId);
          if (existing) {
            useAgentStore.getState().setActiveToolCalls(
              active.map((tc) =>
                tc.toolCallId === part.toolCallId
                  ? { ...tc, args: part.input as Record<string, unknown> }
                  : tc
              )
            );
          } else {
            useAgentStore.getState().setActiveToolCalls([
              ...active,
              {
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                args: part.input as Record<string, unknown>,
              },
            ]);
          }
          break;
        }

        case "tool-result": {
          pendingToolResults.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output,
          });
          break;
        }

        case "finish-step": {
          const rawPart = part as Record<string, any>;
          const u = rawPart.usage;
          if (u && typeof u.inputTokens === "number") {
            stepUsages.push({
              promptTokens: u.inputTokens,
              completionTokens: u.outputTokens ?? 0,
              totalTokens: u.totalTokens ?? 0,
            });
          }

          if (pendingToolCalls.length > 0) {
            useAgentStore.getState().clearActiveToolCalls();
            const currentStreamingText = useAgentStore.getState().streamingText;
            useAgentStore.getState().commitStreamingAsAssistant(
              currentStreamingText,
              [...pendingToolCalls]
            );

            for (const tr of pendingToolResults) {
              const toolResult = tr.output as any;
              const isSuccess = toolResult?.success !== false;
              useAgentStore.getState().addMessage({
                id: generateId(),
                role: "tool",
                content: JSON.stringify(
                  toolResult?.data ?? toolResult?.error ?? toolResult,
                  null,
                  2
                ),
                timestamp: Date.now(),
                toolResult: {
                  callId: tr.toolCallId,
                  toolName: tr.toolName,
                  success: isSuccess,
                  data: toolResult?.data ?? toolResult,
                  error: toolResult?.error,
                },
              });
            }

            pendingToolCalls.length = 0;
            pendingToolResults.length = 0;
            hasStartedStreaming = false;
          }
          break;
        }

        case "error": {
          throw part.error;
        }
      }
    }

    const finalStreamingText = useAgentStore.getState().streamingText;
    if (finalStreamingText) {
      useAgentStore.getState().commitStreamingAsAssistant(finalStreamingText);
    }

    if (stepUsages.length === 0) {
      try {
        const u = await result.usage;
        if (u && typeof u.inputTokens === "number") {
          stepUsages.push({
            promptTokens: u.inputTokens,
            completionTokens: u.outputTokens ?? 0,
            totalTokens: u.totalTokens ?? 0,
          });
        }
      } catch { /* silent */ }
    }

    useAgentStore.getState().setStatus("idle");
  } catch (err: any) {
    const partial = useAgentStore.getState().streamingText;
    if (partial) {
      useAgentStore.getState().commitStreamingAsAssistant(partial);
    } else {
      useAgentStore.getState().clearStreamingText();
    }

    if (err?.name === "AbortError") {
      useAgentStore.getState().setStatus("idle");
    } else {
      console.error("Orchestrator error:", err);
      useAgentStore.getState().addMessage({
        id: generateId(),
        role: "assistant",
        content: `调用出错：${err?.message || String(err)}`,
        timestamp: Date.now(),
      });
      useAgentStore.getState().setStatus("error");
    }
  } finally {
    if (stepUsages.length > 0) {
      const lastStep = stepUsages[stepUsages.length - 1];
      const totalP = stepUsages.reduce((s, u) => s + u.promptTokens, 0);
      const totalC = stepUsages.reduce((s, u) => s + u.completionTokens, 0);
      const totalT = stepUsages.reduce((s, u) => s + u.totalTokens, 0);
      const cost =
        (totalP * pricing.inputTokensPerMillion +
          totalC * pricing.outputTokensPerMillion) /
        1_000_000;
      useAgentStore.getState().recordUsage({
        promptTokens: totalP,
        completionTokens: totalC,
        totalTokens: totalT,
        cost,
        stepCount: stepUsages.length,
        lastPromptTokens: lastStep.promptTokens,
      });
    }

    useAgentStore.getState().clearActiveToolCalls();
    useAgentStore.getState().setStreaming(false);
    activeAbortController = null;
  }
}
