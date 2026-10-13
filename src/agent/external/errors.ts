import useModelStore from "@/store/useModelStore";

/** A failure with a stable code the external agent can act on. */
export class ExternalToolError extends Error {
  constructor(public readonly code: string, public readonly detail?: Record<string, unknown>) { super(code); }
}

export interface ExternalToolContext {
  sessionId: string;
  client: { name: string; version: string };
  signal: AbortSignal;
}

/** Stops work once the external agent cancelled the call. */
export function checkActive(ctx: Pick<ExternalToolContext, "signal">): void {
  if (ctx.signal.aborted) throw new ExternalToolError("cancelled");
}

/** Configured API keys never leave FusionKit, not even inside an error message. */
export function redactSecrets(text: string): string {
  const { getAgentProfile, getTaskProfile } = useModelStore.getState();
  return [getAgentProfile()?.apiKey, getTaskProfile()?.apiKey].reduce<string>(
    (value, key) => key && key.trim() ? value.split(key).join("[redacted]") : value, text);
}
