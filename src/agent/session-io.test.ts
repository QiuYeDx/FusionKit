import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionExportData } from "./types";
import { MAX_SESSION_BYTES, parseSessionJson } from "./session-schema";

const mocks = vi.hoisted(() => ({ getSessionExportData: vi.fn(), restoreSession: vi.fn(), invoke: vi.fn() }));
vi.mock("@/store/agent/useAgentStore", () => ({ default: { getState: () => mocks } }));
import { exportSession, importSession } from "./session-io";

function fixture(): SessionExportData {
  return {
    version: 1, exportedAt: 1, executionMode: "queue_only",
    session: { id: "source", messages: [{ id: "user", role: "user", content: "Hello", timestamp: 1 }], status: "idle", createdAt: 1, updatedAt: 1 },
    tokenStats: { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, totalCost: 0, stepCount: 0, lastPromptTokens: 0, interactions: [] }, sessionLog: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { ipcRenderer: { invoke: mocks.invoke } });
  mocks.getSessionExportData.mockReturnValue(fixture());
  mocks.invoke.mockResolvedValue({ success: true });
});

describe("session archive export contract", () => {
  it("saves a complete archive that the same importer can restore", async () => {
    expect(await exportSession()).toEqual({ success: true });
    const [channel, saved] = mocks.invoke.mock.calls[0];
    expect(channel).toBe("save-session-file");
    expect(saved.defaultName).toMatch(/^agent-session-.*\.json$/);
    expect(parseSessionJson(saved.content)).toEqual(fixture());
    mocks.invoke.mockResolvedValue({ success: true, content: saved.content });
    expect(await importSession()).toEqual({ success: true });
    expect(mocks.restoreSession).toHaveBeenCalledWith(fixture());
  });

  it("rejects UTF-8 overflow even when its character count is below 8 MiB", async () => {
    const data = fixture();
    data.session.messages = Array.from({ length: 10 }, (_, i) => ({ id: `u${i}`, role: "user", content: "中".repeat(300_000), timestamp: 1 }));
    expect(JSON.stringify(data, null, 2).length).toBeLessThan(MAX_SESSION_BYTES);
    mocks.getSessionExportData.mockReturnValue(data);
    expect(await exportSession()).toEqual({ success: false, errorCode: "too_large" });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(data.session.messages[0].content).toHaveLength(300_000);
  });

  it("allows the exact byte boundary and rejects the next byte without saving", async () => {
    const data = fixture();
    data.session.messages = Array.from({ length: 9 }, (_, i) => ({ id: `u${i}`, role: "user", content: "x".repeat(900_000), timestamp: 1 }));
    let padding = MAX_SESSION_BYTES - new TextEncoder().encode(JSON.stringify(data, null, 2)).byteLength;
    for (const message of data.session.messages) {
      const amount = Math.min(padding, 1_000_000 - message.content.length);
      message.content += "x".repeat(amount);
      padding -= amount;
    }
    mocks.getSessionExportData.mockReturnValue(data);
    expect(await exportSession()).toEqual({ success: true });
    expect(new TextEncoder().encode(mocks.invoke.mock.calls[0][1].content).byteLength).toBe(MAX_SESSION_BYTES);
    mocks.invoke.mockClear();
    data.session.messages[2].content += "x";
    expect(await exportSession()).toEqual({ success: false, errorCode: "too_large" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each(["schema", "circular"])("does not save invalid %s data", async (kind) => {
    const data = fixture();
    if (kind === "schema") data.tokenStats.totalTokens = -1;
    else (data as unknown as Record<string, unknown>).circular = data;
    mocks.getSessionExportData.mockReturnValue(data);
    expect(await exportSession()).toEqual({ success: false, errorCode: "invalid" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([{ success: false }, { success: false, cancelled: true }])("recognizes native dialog cancellation %#", async result => {
    mocks.invoke.mockResolvedValue(result);
    expect(await exportSession()).toEqual({ success: false, cancelled: true });
  });

  it("separates save failure from cancellation", async () => {
    mocks.invoke.mockRejectedValue(new Error("disk full"));
    expect(await exportSession()).toEqual({ success: false, errorCode: "save_failed" });
    mocks.invoke.mockResolvedValue({ success: false, cancelled: false, error: "disk full" });
    expect(await exportSession()).toEqual({ success: false, errorCode: "save_failed" });
  });
});
