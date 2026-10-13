import { describeIssues, EXTERNAL_TOOLS, isExternalToolName, type ExternalToolName } from "./catalog";
import type { ExternalAgentApi, ExternalToolCall, ExternalToolOutcome } from "./contract";
import { ExternalToolError, redactSecrets, type ExternalToolContext } from "./errors";
import { useExternalAgentStore } from "./store";
import { forgetEndedSessions } from "./confirmations";
import { EXTERNAL_TOOL_IMPLEMENTATIONS, type ExternalToolImplementations } from "./tools";

/** Runs one call; every failure becomes a stable code with bounded, redacted detail. */
export async function runExternalTool(call: ExternalToolCall, signal: AbortSignal, registry: Partial<ExternalToolImplementations>): Promise<ExternalToolOutcome> {
  if (!isExternalToolName(call.tool) || !registry[call.tool]) return { ok: false, error: "unknown_tool" };
  const name: ExternalToolName = call.tool;
  const parsed = EXTERNAL_TOOLS[name].inputSchema.safeParse(call.arguments ?? {});
  if (!parsed.success) return { ok: false, error: "invalid_arguments", detail: { issues: describeIssues(parsed.error) } };
  const ctx: ExternalToolContext = { sessionId: call.sessionId, client: call.client, signal };
  try {
    if (signal.aborted) return { ok: false, error: "cancelled" };
    const run = registry[name] as (input: unknown, ctx: ExternalToolContext) => Promise<unknown>;
    const data = await run(parsed.data, ctx);
    if (signal.aborted) return { ok: false, error: "cancelled" };
    return { ok: true, data };
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return { ok: false, error: "cancelled" };
    if (error instanceof ExternalToolError) return { ok: false, error: error.code, ...(error.detail ? { detail: error.detail } : {}) };
    const reason = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 600);
    return { ok: false, error: "tool_failed", detail: { reason } };
  }
}

/**
 * Listens for external agents' tool calls from the main process, runs them and
 * answers. Returns the function that stops listening.
 */
export function installExternalAgentHost(given?: ExternalAgentApi | null,
  registry: Partial<ExternalToolImplementations> = EXTERNAL_TOOL_IMPLEMENTATIONS): () => void {
  const api = given === undefined ? (typeof window === "undefined" ? undefined : window.externalAgent) : given;
  if (!api) return () => {};
  const running = new Map<string, AbortController>();
  const stopStatus = api.onStatus((status) => {
    useExternalAgentStore.getState().setStatus(status);
    forgetEndedSessions(new Set(status.sessions.map((session) => session.id)));
  });
  const stopCancel = api.onCancel(({ callId }) => running.get(callId)?.abort());
  const stopCall = api.onCall((call) => {
    const controller = new AbortController();
    running.set(call.callId, controller);
    void runExternalTool(call, controller.signal, registry).then(async (result) => {
      running.delete(call.callId);
      useExternalAgentStore.getState().record(call.sessionId, { callId: call.callId, tool: call.tool, ok: result.ok, ...(!result.ok ? { error: result.error } : {}), at: Date.now() });
      try { await api.respond({ callId: call.callId, result }); }
      catch { /* The main process already gave up on this call. */ }
    });
  });
  void api.getStatus().then((result) => { if (result.ok) useExternalAgentStore.getState().setStatus(result.value); }).catch(() => undefined);
  api.ready();
  return () => {
    stopCall(); stopCancel(); stopStatus();
    for (const controller of running.values()) controller.abort();
    running.clear();
  };
}
