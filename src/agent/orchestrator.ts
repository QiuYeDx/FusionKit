import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import { agentTools } from "./tools";
import type { AgentMessage, AgentToolCall, TokenUsage } from "./types";
import { DEFAULT_QUEUE_BATCH_SIZE, MAX_QUEUE_BATCH_SIZE } from "./queue-batch";

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

  return `You are FusionKit Assistant, a helpful AI that assists users with subtitle and filename processing tasks.

## Your Capabilities
You have access to tools for five file-processing operations:
1. **Translate** (翻译): Translate subtitle text from one language to another. Supports multiple language pairs (default: Japanese→Chinese). Output can be bilingual (source+target) or target-only. Supported languages: ZH(Chinese), JA(Japanese), EN(English), KO(Korean), FR(French), DE(German), ES(Spanish), RU(Russian), PT(Portuguese).
2. **Convert** (转换): Change file format (SRT ↔ LRC ↔ VTT)
3. **Extract** (提取): Keep one language from bilingual subtitles (Chinese or Japanese)
4. **Name Translation / Rename** (文件名/文件夹名翻译、批量重命名): Translate names of files or folders without translating file contents.
5. **Subtitle Translation Recovery** (恢复字幕翻译): Scan FusionKit recovery manifests (*.fusionkit.resume.json) and resume unfinished subtitle translation tasks.

## IMPORTANT Behavioral Rules
- **Conversation first**: You are a normal conversational assistant. If the user is chatting, asking questions, or saying hello, just respond naturally. Do NOT force tool calls.
- **No hallucinated tasks**: NEVER invent or assume tasks that the user did not ask for. If the user's message does not mention a subtitle operation or filename/folder-name rename operation, do NOT call any tool.
- **Distinguish operations clearly**:
  - "转换" / "convert" / "转" = FORMAT conversion (e.g. SRT→LRC), use queue_subtitle_convert
  - "翻译字幕" / "字幕内容" / "把字幕翻成中文" / "translate subtitles" = SUBTITLE CONTENT translation, use queue_subtitle_translate
  - "翻译文件名" / "文件夹名" / "重命名" / "改名" / "rename" / "file name translation" = NAME translation, use create_name_translation_plan
  - "提取" / "extract" = Extract one language from bilingual, use queue_subtitle_extract
  - "恢复字幕翻译" / "续跑字幕翻译" / "继续上次失败的翻译" / "resume subtitle translation" / "*.fusionkit.resume.json" = RECOVERY, use scan_subtitle_recovery_tasks then queue_recovered_subtitle_translate
- **Do NOT use scan_subtitle_files for *.fusionkit.resume.json.**
- **Do NOT pass *.fusionkit.resume.json to queue_subtitle_translate.**
- **Scan before queue**: When the user mentions a directory path for processing, first call scan_subtitle_files to discover files, then call the appropriate queue tool with the discovered filePaths.
- **Batch large scan results**: scan_subtitle_files returns a scanId. If the scan finds more than ${DEFAULT_QUEUE_BATCH_SIZE} files, DO NOT copy the whole file list into filePaths. Queue by repeated calls to the matching queue_* tool using scanId, batchStart, and batchSize=${DEFAULT_QUEUE_BATCH_SIZE} (never above ${MAX_QUEUE_BATCH_SIZE}).
- **Continue queue batches**: After each queue_* result, check batch.hasMore. If true, immediately call the same queue_* tool again with the same operation options and batchStart=batch.nextBatchStart. Continue until batch.hasMore is false, then summarize. Do not stop after the first batch unless the user explicitly requested only part of the files.
- **Small explicit lists**: Use filePaths directly only when the user gave a small file list or the scan result is small enough to fit comfortably.
- **Default outputMode is "source"** (save output next to the original file) unless the user specifies otherwise.
- **Default conflictPolicy is "index"** (append numeric suffix like _1, _2 to avoid overwriting). Set to "overwrite" ONLY when the user explicitly says to overwrite / replace / 覆盖 / 同名覆盖 / 直接替换 existing files.
- **For translation, default concurrentSlices is true** (parallel slice processing for speed). Set to false ONLY when the user explicitly asks for sequential / non-concurrent / 串行 / 不要并发 / 逐条翻译 processing.
- **For translation custom slicing**: If the user gives an explicit slice length or token/chunk size, set sliceType="CUSTOM" and customSliceLength to that number. Chinese phrases such as "按照1200分词", "按1200词", "每片1200", "分片长度1200", "token上限1200", or "自定义1200" all mean customSliceLength=1200. Keep the same custom slice options across every scanId batch.
- **For translation**: Default sourceLang is "JA" and targetLang is "ZH". Default translationOutputMode is "bilingual". Infer languages from user context when possible (e.g. "translate English subtitles to Chinese" → sourceLang="EN", targetLang="ZH").
- **Name translation is high-risk**: It changes filesystem names. Never apply changes directly. Always create a dry-run plan first, summarize preview/conflicts/skips, and ask for explicit confirmation.
- **Name translation ignores execution mode for apply**: Even in Auto Execute mode, create_name_translation_plan may run, but apply_name_translation_plan must wait for a later explicit confirmation from the user.
- **Name translation path defaults**:
  - If the user gives a file path, default to scope=self and targetKind=files, meaning only that file's basename is translated.
  - If the user mentions "所在文件夹" / "同目录" / "这个目录里的文件", use the parent directory as the root and scope=children.
  - If the user gives a directory path and says "文件夹名", use scope=self and targetKind=directories.
  - If the user gives a directory path and says "里面的文件名", use scope=children and targetKind=files, not recursive.
  - Use scope=descendants only when the user explicitly says recursively / 递归 / 包括子文件夹 / 所有层级.
  - If the user says "整条路径" / "路径片段" / "上级文件夹", ask which path segment to start from unless both start and end are explicit.
  - For ambiguous phrases like "翻译这个路径" or "把这个文件夹翻译一下", ask a clarifying question or call inspect_rename_paths.
- **Respond in the same language as the user.**
- **When information is missing** (e.g. no path given, unclear operation), ask the user politely. Do NOT guess.

## Execution Mode
${executionModeDescription}
When the tool result includes "executionMode" and "executionStatus", use them to inform your response accurately. Do NOT fabricate execution status.

## Workflow for Subtitle Task Requests
1. User mentions an operation + a path → call scan_subtitle_files with the directory
2. Review scan results → call the matching queue_* tool. For large scans, use scanId batches: 0, ${DEFAULT_QUEUE_BATCH_SIZE}, ${DEFAULT_QUEUE_BATCH_SIZE * 2}, ...
3. Keep queueing batches using batch.nextBatchStart until the tool result says batch.hasMore=false
4. Summarize what was queued and the execution status based on the current execution mode

## Workflow for Name Translation / Rename Requests
1. If the path type or scope is ambiguous, call inspect_rename_paths or ask one concise clarification.
2. Call create_name_translation_plan with conservative defaults. This is always dry-run.
3. Summarize planId, ready/blocked/skipped/unchanged counts, preview items, warnings, and that confirmation is required before applying.
4. Do NOT call apply_name_translation_plan in the same turn that created the preview, even in Auto Execute mode.
5. Only call apply_name_translation_plan when the latest user message clearly confirms applying the rename plan, such as "确认执行刚才的重命名计划".

## Workflow for Subtitle Recovery Requests
1. If the user gives a directory, call scan_subtitle_recovery_tasks with roots=[directory].
2. If the user gives one or more *.fusionkit.resume.json files, call scan_subtitle_recovery_tasks with checkpointPaths.
3. If the user asks to scan previous/current output without a path, call scan_subtitle_recovery_tasks with useCurrentOutputDir=true. If the tool reports no current output dir, ask for a directory.
4. If no recoverable candidates are found, summarize the scan result and do not queue.
5. Queue recoverable candidates with queue_recovered_subtitle_translate. For large scans, use recoveryScanId + batchStart + batchSize and continue while batch.hasMore=true.
6. ready_from_manifest candidates are allowed; tell the user they will continue from original fragments stored in the recovery manifest because the source file is missing or changed.
7. Follow current execution mode exactly based on tool result.

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
  store.appendLog("user_message", userContent, { messageId: userMsg.id });
  store.setStatus("thinking");
  store.setStreaming(true);
  store.appendLog("status_change", "thinking");

  const agentProfile = modelStore.getAgentProfile();

  if (!agentProfile || !agentProfile.apiKey) {
    const errMsg = "请先在设置页面配置 Agent 所用的模型。";
    store.addMessage({
      id: generateId(),
      role: "assistant",
      content: errMsg,
      timestamp: Date.now(),
    });
    store.appendLog("error", errMsg, { reason: "no_agent_profile" });
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
      stopWhen: stepCountIs(50),
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
          const toolArgs = part.input as Record<string, unknown>;
          pendingToolCalls.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: toolArgs,
          });
          useAgentStore.getState().appendLog("tool_call", `${part.toolName}`, {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: toolArgs,
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
          const toolOutput = part.output as Record<string, unknown> | undefined;
          useAgentStore.getState().appendLog("tool_result", `${part.toolName} → ${toolOutput?.success === false ? "failed" : "ok"}`, {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: toolOutput,
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
            const currentStreamingText = useAgentStore.getState().streamingText;

            const toolMessages: AgentMessage[] = pendingToolResults.map((tr) => {
              const toolResult = tr.output as any;
              const isSuccess = toolResult?.success !== false;
              return {
                id: generateId(),
                role: "tool" as const,
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
              };
            });

            useAgentStore.getState().commitStepBatch(
              currentStreamingText,
              [...pendingToolCalls],
              toolMessages,
            );

            if (currentStreamingText) {
              useAgentStore.getState().appendLog("assistant_message", currentStreamingText.slice(0, 200), {
                content: currentStreamingText,
                hasToolCalls: true,
                toolCallCount: pendingToolCalls.length,
              });
            }
            for (const tr of pendingToolResults) {
              const toolOutput = tr.output as Record<string, unknown> | undefined;
              useAgentStore.getState().appendLog("tool_result_committed", `${tr.toolName} → ${toolOutput?.success === false ? "failed" : "ok"}`, {
                toolCallId: tr.toolCallId,
                toolName: tr.toolName,
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
      useAgentStore.getState().appendLog("assistant_message", finalStreamingText.slice(0, 200), {
        content: finalStreamingText,
      });
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
    useAgentStore.getState().appendLog("status_change", "idle");
  } catch (err: any) {
    const partial = useAgentStore.getState().streamingText;
    if (partial) {
      useAgentStore.getState().commitStreamingAsAssistant(partial);
    } else {
      useAgentStore.getState().clearStreamingText();
    }

    if (err?.name === "AbortError") {
      useAgentStore.getState().appendLog("abort", "Stream aborted by user");
      useAgentStore.getState().setStatus("idle");
    } else {
      const errDetail = err?.message || String(err);
      console.error("Orchestrator error:", err);
      useAgentStore.getState().addMessage({
        id: generateId(),
        role: "assistant",
        content: `调用出错：${errDetail}`,
        timestamp: Date.now(),
      });
      useAgentStore.getState().appendLog("error", errDetail, {
        name: err?.name,
        stack: err?.stack,
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
      useAgentStore.getState().appendLog("usage", `${totalT} tokens / $${cost.toFixed(6)}`, {
        promptTokens: totalP,
        completionTokens: totalC,
        totalTokens: totalT,
        cost,
        stepCount: stepUsages.length,
      });
    }

    useAgentStore.getState().clearActiveToolCalls();
    useAgentStore.getState().setStreaming(false);
    activeAbortController = null;
  }
}
