import type { Tool, ToolCallOptions } from "ai";
import { compactToolOutput } from "./conversation-context";

export type AgentToolSet = Record<string, Tool<any, any>>;

export function abortError(): Error {
  const error = new Error("Agent turn was cancelled.");
  error.name = "AbortError";
  return error;
}

export function assertTurnActive(signal: AbortSignal, isCurrent = () => true): void {
  if (signal.aborted || !isCurrent()) throw abortError();
}

/** One turn owns one execution lane. Cache by call identity, never by user intent. */
export function createGuardedTools(
  source: AgentToolSet,
  context: {
    signal: AbortSignal;
    isCurrent: () => boolean;
    onCall?: (name: string, input: unknown, options: ToolCallOptions) => void;
    onResult?: (name: string, output: unknown, options: ToolCallOptions) => void;
  },
): AgentToolSet {
  let lane: Promise<unknown> = Promise.resolve();
  const calls = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  return Object.fromEntries(Object.entries(source).map(([name, definition]) => {
    if (!definition.execute) return [name, definition];
    const execute = definition.execute;
    return [name, {
      ...definition,
      execute: (input: unknown, options: ToolCallOptions) => {
        const fingerprint = JSON.stringify([name, input]);
        const previous = calls.get(options.toolCallId);
        if (previous) {
          return previous.fingerprint === fingerprint
            ? previous.result
            : Promise.resolve({ success: false, error: "Tool call ID was reused with different arguments." });
        }
        const scopedOptions = { ...options, abortSignal: context.signal };
        const result = lane.then(async () => {
          assertTurnActive(context.signal, context.isCurrent);
          context.onCall?.(name, input, scopedOptions);
          let output: unknown;
          try {
            output = await execute(input, scopedOptions);
          } catch (error) {
            // Preserve failure receipts, including cancellation, for the history ledger.
            output = { success: false, error: error instanceof Error ? error.message : String(error) };
          }
          context.onResult?.(name, output, scopedOptions);
          return compactToolOutput(output);
        });
        calls.set(options.toolCallId, { fingerprint, result });
        lane = result.catch(() => undefined);
        return result;
      },
    }];
  }));
}
