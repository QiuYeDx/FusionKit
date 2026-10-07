import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null },
}));

import { NAME_TRANSLATION_CHANNELS } from "../../src/name-translation/contract";
import {
  collectDescendants,
  inspectPaths,
  isProtectedPath,
  listDirectory,
  type PlatformContext,
} from "../../electron/main/name-translation/fs-listing";
import {
  buildSystemPrompt,
  parseTranslationOutput,
  translateNames,
} from "../../electron/main/name-translation/translator";
import { setupNameTranslationIPC } from "../../electron/main/name-translation/ipc";
import { ModelRuntimeClientError } from "../../electron/main/ai/model-runtime-errors";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fk-name-svc-"));
  roots.push(root);
  const context: PlatformContext = {
    platform: process.platform,
    homeDir: path.join(root, "home"),
    tempDir: path.join(root, "tmp"),
    env: {},
  };
  return { root, context };
}

describe("name translation listing", () => {
  it("lists folders first in natural order and hides dot-files unless asked", async () => {
    const { root, context } = await workspace();
    await fs.mkdir(path.join(root, "b-folder"));
    for (const name of ["ep10.txt", "ep2.txt", ".secret"]) await fs.writeFile(path.join(root, name), "");
    const listing = await listDirectory(root, false, context);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["b-folder", "ep2.txt", "ep10.txt"]);
    const withHidden = await listDirectory(root, true, context);
    expect(withHidden.entries.map((entry) => entry.name)).toContain(".secret");
    const capped = await listDirectory(root, true, context, 2);
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.entries).toHaveLength(2);
  });

  it("collects all descendants grouped by directory and respects the limit", async () => {
    const { root, context } = await workspace();
    await fs.mkdir(path.join(root, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(root, "a", "b", "c.txt"), "");
    await fs.writeFile(path.join(root, "a", "d.txt"), "");
    const all = await collectDescendants(root, false, context);
    expect(all.total).toBe(4);
    expect(all.truncated).toBe(false);
    expect(all.directories.map((listing) => path.relative(root, listing.path))).toEqual(["", "a", path.join("a", "b")]);
    const limited = await collectDescendants(root, false, context, 2);
    expect(limited.truncated).toBe(true);
    expect(limited.total).toBe(2);
  });

  it("rejects missing, protected and temporary drag proxy paths", async () => {
    const { root, context } = await workspace();
    await fs.writeFile(path.join(root, "ok.txt"), "");
    const winContext: PlatformContext = { ...context, platform: "win32", tempDir: root };
    const dropped = await inspectPaths([path.join(root, "ok.txt")], "drop", winContext);
    expect(dropped.rejected).toEqual([{ path: path.join(root, "ok.txt"), reason: "temp_proxy" }]);
    const picked = await inspectPaths(
      [path.join(root, "ok.txt"), path.join(root, "ok.txt"), path.join(root, "nope"), path.join(root, "node_modules")],
      "picker",
      context,
    );
    expect(picked.entries.map((entry) => entry.name)).toEqual(["ok.txt"]);
    expect(picked.rejected.map((entry) => entry.reason)).toEqual(["missing", "protected"]);
    expect(isProtectedPath(context.homeDir, context)).toBe(true);
    expect(isProtectedPath(path.join(context.homeDir, "Downloads"), context)).toBe(false);
    expect(isProtectedPath("C:\\Windows\\System32\\x", { ...context, platform: "win32", env: { SystemRoot: "C:\\Windows" } })).toBe(process.platform === "win32");
  });
});

describe("name translation model output", () => {
  it("parses wrapped JSON and reports missing or duplicated ids", () => {
    const text = '<think>plan</think>```json\n{"items":[{"id":"1","name":"Episode 1"},{"id":"2","name":"A"},{"id":"2","name":"B"},{"id":"9","name":"x"}]}\n```';
    expect(parseTranslationOutput(text, ["1", "2", "3"])).toEqual({
      items: [{ id: "1", name: "Episode 1" }],
      failedIds: ["2", "3"],
    });
    expect(parseTranslationOutput('Sure! {"items":[{"id":1,"name":"One"}]} done', ["1"]).items).toEqual([{ id: "1", name: "One" }]);
    expect(parseTranslationOutput("not json", ["1"]).failedIds).toEqual(["1"]);
  });

  it("builds prompts with languages and user requirements", async () => {
    expect(buildSystemPrompt("JA", "ZH", "人名保留罗马音")).toContain("Japanese into Simplified Chinese");
    expect(buildSystemPrompt("auto", "EN", "人名保留罗马音")).toContain("人名保留罗马音");
    const send = vi.fn(async () => ({ content: '{"items":[{"id":"1","name":"第1集"}]}', apiFormat: "chat_completions" as const }));
    const result = await translateNames(
      {
        requestId: "r",
        model: { apiKey: "k", modelKey: "m", endpoint: "https://example.invalid" },
        sourceLang: "auto",
        targetLang: "ZH",
        items: [{ id: "1", name: "第1話", kind: "file", context: "アニメ" }],
      },
      new AbortController().signal,
      send,
    );
    expect(result.items).toEqual([{ id: "1", name: "第1集" }]);
    const call = send.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(call.messages[1]!.content).toContain('"folder":"アニメ"');
  });
});

describe("name translation IPC", () => {
  function setup(options: Parameters<typeof setupNameTranslationIPC>[0] = {}) {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<any>>();
    setupNameTranslationIPC({
      ...options,
      journalDir: path.join(os.tmpdir(), `fk-name-ipc-${Date.now()}`),
      ipc: { handle: (channel: string, handler: any) => void handlers.set(channel, handler) } as any,
    });
    return handlers;
  }

  it("registers every channel of the public contract", () => {
    const handlers = setup();
    expect([...handlers.keys()].sort()).toEqual(Object.values(NAME_TRANSLATION_CHANNELS).sort());
  });

  it("rejects malformed requests and maps model failures", async () => {
    const handlers = setup({
      sendModelText: async () => {
        throw new ModelRuntimeClientError("http_unauthorized", "bad key", false, { status: 401 });
      },
    });
    const invalid = await handlers.get(NAME_TRANSLATION_CHANNELS.apply)!({}, { items: [] });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const translated = await handlers.get(NAME_TRANSLATION_CHANNELS.translate)!({}, {
      requestId: "r1",
      model: { apiKey: "k", modelKey: "m", endpoint: "https://example.invalid" },
      sourceLang: "auto",
      targetLang: "EN",
      items: [{ id: "1", name: "名前", kind: "file" }],
    });
    expect(translated).toMatchObject({ ok: false, error: { code: "model_auth" } });
  });

  it("cancels every in-flight batch of a request", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const handlers = setup({
      sendModelText: (request) =>
        new Promise((_resolve, reject) => {
          started();
          request.signal?.addEventListener("abort", () => reject(new ModelRuntimeClientError("aborted", "aborted", false)));
        }),
    });
    const pending = handlers.get(NAME_TRANSLATION_CHANNELS.translate)!({}, {
      requestId: "r2",
      model: { apiKey: "k", modelKey: "m", endpoint: "https://example.invalid" },
      sourceLang: "auto",
      targetLang: "EN",
      items: [{ id: "1", name: "名前", kind: "file" }],
    });
    await startedPromise;
    await expect(handlers.get(NAME_TRANSLATION_CHANNELS.cancelTranslate)!({}, { requestId: "r2" })).resolves.toMatchObject({ ok: true, data: { cancelled: true } });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
});
