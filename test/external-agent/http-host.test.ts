import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExternalAgentHttpHost, guardRequest } from "../../electron/main/external-agent/http-host";
import { EXTERNAL_TOOLS } from "../../src/agent/external/catalog";
import type { ExternalToolOutcome } from "../../src/agent/external/contract";

const TOKEN = "A".repeat(43);
const hosts: ExternalAgentHttpHost[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const host of hosts.splice(0)) await host.stop();
});

async function startHost(options: Partial<ConstructorParameters<typeof ExternalAgentHttpHost>[0]> = {}) {
  const callTool = vi.fn(async (): Promise<ExternalToolOutcome> => ({ ok: true, data: { answered: true } }));
  const host = new ExternalAgentHttpHost({ version: "9.9.9", callTool, ...options });
  hosts.push(host);
  const started = await host.start(0, TOKEN);
  if (!started.ok) throw new Error(started.error);
  return { host, callTool: (options.callTool ?? callTool) as typeof callTool, port: started.port, url: new URL(`http://127.0.0.1:${started.port}/mcp`) };
}

async function connect(url: URL, name = "test-client") {
  const client = new Client({ name, version: "1.2.3" });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

function raw(port: number, options: { path?: string; method?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: options.path ?? "/mcp", method: options.method ?? "POST", headers: options.headers }, response => {
      let body = ""; response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}
const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
const jsonHeaders = (port: number, extra: Record<string, string> = {}) => ({
  Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extra,
});

describe("guardRequest", () => {
  const expected = { port: 47361, token: TOKEN };
  const headers = { host: "127.0.0.1:47361", authorization: `Bearer ${TOKEN}` };
  it("accepts the loopback host with the token on /mcp", () => {
    expect(guardRequest({ url: "/mcp", headers }, expected)).toEqual({ ok: true });
    expect(guardRequest({ url: "/mcp?x=1", headers: { ...headers, host: "localhost:47361" } }, expected)).toEqual({ ok: true });
  });
  it("refuses other paths, browser origins, foreign hosts and wrong tokens", () => {
    expect(guardRequest({ url: "/", headers }, expected)).toEqual({ ok: false, status: 404 });
    expect(guardRequest({ url: "/mcp", headers: { ...headers, origin: "http://localhost:47361" } }, expected)).toEqual({ ok: false, status: 403 });
    expect(guardRequest({ url: "/mcp", headers: { ...headers, origin: "null" } }, expected)).toEqual({ ok: false, status: 403 });
    expect(guardRequest({ url: "/mcp", headers: { ...headers, host: "evil.example:47361" } }, expected)).toEqual({ ok: false, status: 403 });
    expect(guardRequest({ url: "/mcp", headers: { ...headers, host: "127.0.0.1:1" } }, expected)).toEqual({ ok: false, status: 403 });
    expect(guardRequest({ url: "/mcp", headers: { host: headers.host } }, expected)).toEqual({ ok: false, status: 401 });
    expect(guardRequest({ url: "/mcp", headers: { ...headers, authorization: `Bearer ${"B".repeat(43)}` } }, expected)).toEqual({ ok: false, status: 401 });
    expect(guardRequest({ url: "/mcp", headers: { ...headers, authorization: "Bearer short" } }, expected)).toEqual({ ok: false, status: 401 });
    expect(guardRequest({ url: "/mcp", headers }, { port: 47361, token: "" })).toEqual({ ok: false, status: 401 });
  });
});

describe("external agent MCP endpoint", () => {
  it("introduces itself, lists the catalog with hints and forwards validated calls", async () => {
    const changed = vi.fn();
    const { host, url, callTool } = await startHost({ onSessionsChanged: changed });
    const { client } = await connect(url);
    expect(client.getServerVersion()).toMatchObject({ name: "fusionkit", version: "9.9.9" });
    expect(client.getInstructions()).toContain("FusionKit");
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(Object.keys(EXTERNAL_TOOLS).sort());
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations).toMatchObject({ readOnlyHint: expect.any(Boolean), destructiveHint: expect.any(Boolean) });
    }
    expect(host.sessionSummaries()).toEqual([expect.objectContaining({ client: { name: "test-client", version: "1.2.3" } })]);
    expect(changed).toHaveBeenCalled();

    const result = await client.callTool({ name: "list_studio_documents", arguments: { query: "ep01" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ answered: true });
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      tool: "list_studio_documents", sessionId: host.sessionSummaries()[0].id, client: { name: "test-client", version: "1.2.3" },
      arguments: { query: "ep01", offset: 0, limit: 20, format: "all", status: "all" },
    }), expect.any(AbortSignal));
  });

  it("answers bad arguments itself and refuses unknown tools", async () => {
    const { url, callTool } = await startHost();
    const { client } = await connect(url);
    const result = await client.callTool({ name: "list_studio_documents", arguments: { limit: 500 } });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as { text: string }[])[0].text);
    expect(body.error).toBe("invalid_arguments");
    expect(body.issues[0]).toMatch(/^limit:/);
    expect(callTool).not.toHaveBeenCalled();
    await expect(client.callTool({ name: "rm_rf", arguments: {} })).rejects.toThrow(/Unknown tool/);
  });

  it("returns failures as isError with the stable code", async () => {
    const { url } = await startHost({ callTool: async () => ({ ok: false, error: "fusionkit_window_unavailable" }) });
    const { client } = await connect(url);
    const result = await client.callTool({ name: "get_fusionkit_status", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ error: "fusionkit_window_unavailable" });
  });

  it("refuses missing tokens, browser origins, foreign hosts, other paths and oversized bodies", async () => {
    const { port } = await startHost({ maxBodyBytes: 2048 });
    const noToken = await raw(port, { headers: { ...jsonHeaders(port), Authorization: "" }, body: initialize });
    expect(noToken.status).toBe(401);
    expect(noToken.headers["www-authenticate"]).toMatch(/^Bearer/);
    expect((await raw(port, { headers: jsonHeaders(port, { Origin: "https://evil.example" }), body: initialize })).status).toBe(403);
    expect((await raw(port, { headers: jsonHeaders(port, { Host: `attacker.test:${port}` }), body: initialize })).status).toBe(403);
    expect((await raw(port, { path: "/", headers: jsonHeaders(port), body: initialize })).status).toBe(404);
    expect((await raw(port, { headers: jsonHeaders(port), body: JSON.stringify({ padding: "x".repeat(4096) }) })).status).toBe(413);
    const ok = await raw(port, { headers: jsonHeaders(port), body: initialize });
    expect(ok.status).toBe(200);
    expect(ok.headers["mcp-session-id"]).toBeTruthy();
  });

  it("caps concurrent sessions and forgets closed or idle ones", async () => {
    let now = 1_000;
    const { host, port, url } = await startHost({ maxSessions: 2, sessionIdleMs: 10_000, now: () => now });
    const first = await connect(url, "first");
    await connect(url, "second");
    const third = await raw(port, { headers: jsonHeaders(port), body: initialize });
    expect(third.status).toBe(503);
    expect(third.body).toContain("too_many_sessions");

    const firstId = first.transport.sessionId!;
    await first.transport.terminateSession();
    const afterDelete = await raw(port, { headers: jsonHeaders(port, { "mcp-session-id": firstId, "mcp-protocol-version": "2025-06-18" }), body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    expect(afterDelete.status).toBe(404);
    expect(host.sessionSummaries().map(session => session.client.name)).toEqual(["second"]);

    now += 20_000;
    host.sweep();
    await vi.waitFor(() => expect(host.sessionSummaries()).toEqual([]));
  });

  it("passes a client's cancellation to the running call", async () => {
    let seen: AbortSignal | undefined;
    const { url } = await startHost({ callTool: (_call, signal) => new Promise(resolve => { seen = signal; signal.addEventListener("abort", () => resolve({ ok: false, error: "cancelled" })); }) });
    const { client } = await connect(url);
    const controller = new AbortController();
    const pending = client.callTool({ name: "get_fusionkit_status", arguments: {} }, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(seen!.aborted).toBe(true));
  });

  it("stops listening when stopped and reports a port that is taken", async () => {
    const { host, port } = await startHost();
    const other = new ExternalAgentHttpHost({ version: "1", callTool: async () => ({ ok: true, data: null }) });
    hosts.push(other);
    expect(await other.start(port, TOKEN)).toEqual({ ok: false, error: "port_in_use" });
    await host.stop();
    await expect(raw(port, { headers: jsonHeaders(port), body: initialize })).rejects.toThrow();
  });
});
