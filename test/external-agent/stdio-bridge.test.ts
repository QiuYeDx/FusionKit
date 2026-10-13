import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ExternalAgentHttpHost } from "../../electron/main/external-agent/http-host";
import { EndpointFile } from "../../electron/main/external-agent/endpoint-file";

const SCRIPT = path.resolve("resources/external-agent/fusionkit-mcp-stdio.cjs");
const TOKEN = "T".repeat(43);
const roots: string[] = [];
const hosts: ExternalAgentHttpHost[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function temp() { const root = await mkdtemp(path.join(os.tmpdir(), "fk-stdio-")); roots.push(root); return root; }
async function host(port = 0) {
  const value = new ExternalAgentHttpHost({ version: "1.0.0", callTool: async call => ({ ok: true, data: { echoed: call.tool, client: call.client.name } }) });
  hosts.push(value);
  const started = await value.start(port, TOKEN);
  if (!started.ok) throw new Error(started.error);
  return { host: value, port: started.port };
}
async function connect(args: string[], name = "stdio-client") {
  const client = new Client({ name, version: "1" });
  const stderr: string[] = [];
  const transport = new StdioClientTransport({ command: process.execPath, args: [SCRIPT, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } as Record<string, string>, stderr: "pipe" });
  transport.stderr?.on("data", chunk => stderr.push(String(chunk)));
  clients.push(client);
  await client.connect(transport);
  return { client, stderr };
}
const text = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);

describe("endpoint file", () => {
  it("is written while listening and removed afterwards", async () => {
    const root = await temp();
    const file = new EndpointFile(root);
    await file.publish({ url: "http://127.0.0.1:1/mcp", token: TOKEN, appVersion: "9" });
    expect(JSON.parse(await readFile(file.file, "utf8"))).toEqual({ version: 1, url: "http://127.0.0.1:1/mcp", token: TOKEN, appVersion: "9", pid: process.pid });
    await file.clear();
    expect(existsSync(file.file)).toBe(false);
    await file.publish({ url: "u", token: TOKEN, appVersion: "9" });
    file.clearSync();
    expect(existsSync(file.file)).toBe(false);
  });
});

describe("stdio bridge", () => {
  it("forwards the client's session to the running endpoint", async () => {
    const root = await temp();
    const { port } = await host();
    const endpoint = new EndpointFile(root);
    await endpoint.publish({ url: `http://127.0.0.1:${port}/mcp`, token: TOKEN, appVersion: "1" });
    const { client } = await connect(["--endpoint", endpoint.file]);
    expect(client.getServerVersion()?.name).toBe("fusionkit");
    expect((await client.listTools()).tools.length).toBeGreaterThan(5);
    expect(text(await client.callTool({ name: "get_fusionkit_status", arguments: {} }))).toEqual({ echoed: "get_fusionkit_status", client: "stdio-client" });
  });

  it("starts a new session by itself when FusionKit restarted", async () => {
    const root = await temp();
    const first = await host();
    const endpoint = new EndpointFile(root);
    await endpoint.publish({ url: `http://127.0.0.1:${first.port}/mcp`, token: TOKEN, appVersion: "1" });
    const { client, stderr } = await connect(["--endpoint", endpoint.file]);
    await first.host.stop();
    await host(first.port);
    expect(text(await client.callTool({ name: "list_studio_documents", arguments: {} }))).toMatchObject({ echoed: "list_studio_documents" });
    expect(stderr.join("")).toContain("session ended");
  });

  it("answers an error naming what to do when FusionKit cannot be reached", async () => {
    const root = await temp();
    await expect(connect(["--endpoint", path.join(root, "missing.json")])).rejects.toThrow(/FusionKit is not reachable/);
  });

  it("starts FusionKit without ELECTRON_RUN_AS_NODE and waits for its endpoint", async () => {
    const root = await temp();
    const { port } = await host();
    const endpointPath = path.join(root, "endpoint.json");
    const seen = path.join(root, "seen-env.txt");
    // Stands in for FusionKit: records its environment, then publishes the endpoint a moment later.
    const fake = path.join(root, "fake-fusionkit.cjs");
    await writeFile(fake, `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(seen)}, String(process.env.ELECTRON_RUN_AS_NODE ?? 'unset'));
setTimeout(() => fs.writeFileSync(${JSON.stringify(endpointPath)}, JSON.stringify({ version: 1, url: 'http://127.0.0.1:${port}/mcp', token: '${TOKEN}', pid: process.pid })), 800);`);
    const { client } = await connect(["--endpoint", endpointPath, "--launch", process.execPath, "--launch-arg", fake, "--wait-ms", "15000"]);
    expect(text(await client.callTool({ name: "get_fusionkit_status", arguments: {} }))).toMatchObject({ echoed: "get_fusionkit_status" });
    await vi.waitFor(async () => expect(await readFile(seen, "utf8")).toBe("unset"));
  });

  it("gives up after the wait when the launched app never publishes an endpoint", async () => {
    const root = await temp();
    const idle = path.join(root, "idle.cjs");
    await writeFile(idle, "");
    await expect(connect(["--endpoint", path.join(root, "never.json"), "--launch", process.execPath, "--launch-arg", idle, "--wait-ms", "1500"])).rejects.toThrow(/FusionKit is not reachable/);
  });
});
