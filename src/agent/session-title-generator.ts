import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import { isAgentProfileApiFormatSupported } from "./api-format-capability";
import { ChatCompletionsAgentAdapter } from "./runtime/chat-completions-agent-adapter";
import { ResponsesAgentAdapter } from "./runtime/responses-agent-adapter";
import { cleanGeneratedTitle } from "./session-title";
import { isTypedUserMessage } from "./user-intent-authority";

// ---------------------------------------------------------------------------
// After the first reply, the agent model names the conversation in a few words.
// One small request without tools; a title the user typed always wins.
// ---------------------------------------------------------------------------

/** Mock model servers in end-to-end tests answer requests that start with this. */
export const TITLE_INSTRUCTIONS_PREFIX = "You name conversations.";
const TITLE_INSTRUCTIONS = `${TITLE_INSTRUCTIONS_PREFIX} Read the user's first message and the assistant's first reply in a subtitle and translation app, and answer with only a short title for the conversation: in the language of the user's message, at most 20 characters (Chinese/Japanese) or 6 words, no quotes, no ending punctuation, no explanation.`;
const TIMEOUT_MS = 20_000;
const EXCERPT = 1000;

/** Tried once per session while the app runs; a failed first reply does not use the attempt up. */
const attempted = new Set<string>();
let chatAdapter: ChatCompletionsAgentAdapter | undefined;
let responsesAdapter: ResponsesAgentAdapter | undefined;

export function resetSessionTitleAttempts(): void {
  attempted.clear();
}

/** Names the session when it still has the title cut from its first message. Never throws. */
export function generateSessionTitle(sessionId: string): Promise<void> {
  const slot = useAgentStore.getState().slots[sessionId];
  if (!slot || attempted.has(sessionId)) return Promise.resolve();
  const { session } = slot;
  if (!session.title || (session.titleSource ?? "auto") !== "auto") return Promise.resolve();
  const firstIndex = session.messages.findIndex(isTypedUserMessage);
  const first = session.messages[firstIndex];
  const reply = session.messages.slice(firstIndex + 1).find((message) => message.role === "assistant" && message.content.trim());
  if (!first || !reply) return Promise.resolve();
  const profile = useModelStore.getState().getAgentProfile();
  if (!profile?.apiKey || !isAgentProfileApiFormatSupported(profile)) return Promise.resolve();
  attempted.add(sessionId);
  return run(sessionId, profile, `First message:\n${first.content.slice(0, EXCERPT)}\n\nFirst reply:\n${reply.content.slice(0, EXCERPT)}`);
}

async function run(sessionId: string, profile: NonNullable<ReturnType<ReturnType<typeof useModelStore.getState>["getAgentProfile"]>>, content: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const unsubscribe = useAgentStore.subscribe((state) => { if (!state.slots[sessionId]) controller.abort(); });
  const store = () => useAgentStore.getState().forSession(sessionId);
  try {
    const request = { profile, system: TITLE_INSTRUCTIONS, tools: {}, temperature: 0.3, maxOutputTokens: 60, abortSignal: controller.signal, maxSteps: 1 };
    const result = (profile.apiFormat ?? "chat_completions") === "responses"
      ? (responsesAdapter ??= new ResponsesAgentAdapter()).streamTurn({ ...request, messages: [{ id: "title", role: "user", content, timestamp: Date.now() }] })
      : (chatAdapter ??= new ChatCompletionsAgentAdapter()).streamTurn({ ...request, messages: [{ role: "user", content }] });
    let text = "";
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += part.text;
      else if (part.type === "finish-step" && typeof part.usage?.inputTokens === "number") {
        usage = { promptTokens: part.usage.inputTokens, completionTokens: part.usage.outputTokens ?? 0,
          totalTokens: part.usage.totalTokens ?? part.usage.inputTokens + (part.usage.outputTokens ?? 0) };
      } else if (part.type === "error") throw part.error;
      else if (part.type === "finish" && part.reason !== "completed") throw new Error(`title_${part.reason}`);
    }
    if (!usage) {
      const total = await result.usage.catch(() => undefined);
      if (total?.inputTokens !== undefined) usage = { promptTokens: total.inputTokens, completionTokens: total.outputTokens ?? 0,
        totalTokens: total.totalTokens ?? total.inputTokens + (total.outputTokens ?? 0) };
    }
    if (!useAgentStore.getState().slots[sessionId]) return;
    if (usage) {
      const cost = (usage.promptTokens * profile.tokenPricing.inputTokensPerMillion + usage.completionTokens * profile.tokenPricing.outputTokensPerMillion) / 1_000_000;
      // Counted with the session's spending, but it is not part of the conversation's context.
      store().recordUsage({ ...usage, cost, stepCount: 0, lastPromptTokens: usage.promptTokens }, { keepContext: true });
      store().appendLog("usage", `title: ${usage.totalTokens} tokens / $${cost.toFixed(6)}`, { source: "session_title", ...usage, cost });
    }
    const title = cleanGeneratedTitle(text);
    if (!title) throw new Error("title_empty");
    const current = useAgentStore.getState().slots[sessionId]?.session;
    // The user named it meanwhile: their name stays.
    if (!current || (current.titleSource ?? "auto") !== "auto") return;
    store().setTitle(title, "generated");
  } catch (error) {
    const reason = controller.signal.aborted ? "title_timeout_or_cancelled" : error instanceof Error ? error.message : String(error);
    store().appendLog("status_change", "title_failed", { reason: profile.apiKey ? reason.split(profile.apiKey).join("[redacted]").slice(0, 300) : reason.slice(0, 300) });
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}
