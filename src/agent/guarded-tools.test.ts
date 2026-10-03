import { describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { createGuardedTools } from "./guarded-tools";

const options = (toolCallId: string) => ({ toolCallId, messages: [] });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("turn-owned tool lane", () => {
  it("serializes tools, deduplicates a call ID, and forwards the turn signal", async () => {
    const gate = deferred();
    const controller = new AbortController();
    const execute = vi.fn(async (input, context) => {
      expect(context.abortSignal).toBe(controller.signal);
      if (input.value === "first") await gate.promise;
      return { success: true, data: input.value };
    });
    const tools = createGuardedTools({ run: tool({ inputSchema: z.object({ value: z.string() }), execute }) }, { signal: controller.signal, isCurrent: () => true });
    const first = tools.run.execute!({ value: "first" }, options("a"));
    const duplicate = tools.run.execute!({ value: "first" }, options("a"));
    const second = tools.run.execute!({ value: "second" }, options("b"));
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(duplicate).toBe(first);
    gate.resolve();
    await Promise.all([first, duplicate, second]);
    expect(execute.mock.calls.map(([input]) => input.value)).toEqual(["first", "second"]);
    await expect(tools.run.execute!({ value: "changed" }, options("a"))).resolves.toMatchObject({ success: false });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("cancels queued admission while preserving the admitted operation receipt", async () => {
    const gate = deferred();
    const controller = new AbortController();
    const execute = vi.fn(async () => { await gate.promise; return { success: true, data: { taskId: "accepted" } }; });
    const onResult = vi.fn();
    const tools = createGuardedTools({ run: tool({ inputSchema: z.object({}), execute }) }, { signal: controller.signal, isCurrent: () => true, onResult });
    const first = tools.run.execute!({}, options("a"));
    const second = tools.run.execute!({}, options("b"));
    const rejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort(); gate.resolve();
    await expect(first).resolves.toMatchObject({ data: { taskId: "accepted" } });
    await rejected;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("rejects stale owners before running and makes ordinary failure recoverable", async () => {
    let current = false;
    const execute = vi.fn(async (): Promise<{ success: boolean }> => { throw new Error("tool failed"); });
    const tools = createGuardedTools({ run: tool({ inputSchema: z.object({}), execute }) }, { signal: new AbortController().signal, isCurrent: () => current });
    await expect(tools.run.execute!({}, options("stale"))).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
    current = true;
    await expect(tools.run.execute!({}, options("new"))).resolves.toEqual({ success: false, error: "tool failed" });
  });

  it("keeps the raw receipt while bounding output returned to the model", async () => {
    const output = { success: false, error: "x".repeat(40_000), data: { ids: Array.from({ length: 2000 }, (_, i) => `id-${i}`) } };
    const onResult = vi.fn();
    const tools = createGuardedTools({ run: tool({ inputSchema: z.object({}), execute: async () => output }) }, { signal: new AbortController().signal, isCurrent: () => true, onResult });
    const result = await tools.run.execute!({}, options("a"));
    expect(result).toMatchObject({ success: false, truncated: true });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
    expect(onResult.mock.calls[0][1]).toBe(output);
  });
});
