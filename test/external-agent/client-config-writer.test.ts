import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clientConfigPath, clientConfigStatus, mergeJsonConfig, mergeTomlConfig, writeClientConfig, type ConfigLocation } from "../../electron/main/external-agent/client-config-writer";
import { codexTable, jsonServerEntry } from "../../src/agent/external/client-configs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function location(platform: NodeJS.Platform = "win32"): Promise<ConfigLocation> {
  const home = await mkdtemp(path.join(os.tmpdir(), "fk-client-config-")); roots.push(home);
  return { home, appData: path.join(home, "AppData", "Roaming"), platform };
}
const input = { url: "http://127.0.0.1:47361/mcp", token: "A".repeat(43),
  info: { exePath: "C:\\Program Files\\FusionKit\\FusionKit.exe", scriptPath: "C:\\Program Files\\FusionKit\\resources\\external-agent\\fusionkit-mcp-stdio.cjs", endpointPath: "C:\\Users\\Me\\AppData\\Roaming\\FusionKit\\external-agent\\endpoint.json", platform: "win32" } };

describe("client configuration files", () => {
  it("knows where each desktop client keeps its configuration", async () => {
    const win = await location("win32");
    expect(clientConfigPath("claude-desktop", win)).toBe(path.join(win.home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"));
    expect(clientConfigPath("codex", win)).toBe(path.join(win.home, ".codex", "config.toml"));
    expect(clientConfigPath("codex", { ...win, codexHome: path.join(win.home, "custom") })).toBe(path.join(win.home, "custom", "config.toml"));
    expect(clientConfigPath("cursor", win)).toBe(path.join(win.home, ".cursor", "mcp.json"));
    const mac = await location("darwin");
    expect(clientConfigPath("claude-desktop", mac)).toBe(path.join(mac.home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
  });

  it("adds FusionKit to an existing JSON config, keeps the rest, backs it up, and replaces its own entry next time", async () => {
    const where = await location();
    const file = clientConfigPath("claude-desktop", where);
    await mkdir(path.dirname(file), { recursive: true });
    const original = JSON.stringify({ globalShortcut: "Ctrl+Space", mcpServers: { filesystem: { command: "npx", args: ["-y", "fs"] } } }, null, 2);
    await writeFile(file, original);
    const result = await writeClientConfig("claude-desktop", { json: jsonServerEntry("stdio", input) }, where);
    expect(result).toEqual({ client: "claude-desktop", path: file, backupPath: `${file}.fusionkit-backup` });
    expect(await readFile(`${file}.fusionkit-backup`, "utf8")).toBe(original);
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written).toEqual({ globalShortcut: "Ctrl+Space", mcpServers: { filesystem: { command: "npx", args: ["-y", "fs"] },
      fusionkit: { command: input.info.exePath, args: expect.arrayContaining(["--endpoint", "--launch"]), env: { ELECTRON_RUN_AS_NODE: "1" } } } });
    await writeClientConfig("claude-desktop", { json: { command: "other" } }, where);
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")).mcpServers)).toEqual(["filesystem", "fusionkit"]);
    expect((await clientConfigStatus("claude-desktop", where))).toEqual({ client: "claude-desktop", path: file, exists: true, configured: true });
  });

  it("creates a missing file and folder without a backup", async () => {
    const where = await location();
    const result = await writeClientConfig("cursor", { json: jsonServerEntry("http", input) }, where);
    expect(result.backupPath).toBeUndefined();
    expect(JSON.parse(await readFile(result.path, "utf8"))).toEqual({ mcpServers: { fusionkit: { url: input.url, headers: { Authorization: `Bearer ${input.token}` } } } });
    expect(await clientConfigStatus("codex", where)).toMatchObject({ exists: false, configured: false });
  });

  it("leaves a file it cannot read untouched", async () => {
    const where = await location();
    const file = clientConfigPath("cursor", where);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ broken");
    await expect(writeClientConfig("cursor", { json: {} }, where)).rejects.toThrow("config_unreadable");
    expect(await readFile(file, "utf8")).toBe("{ broken");
    expect(() => mergeJsonConfig(JSON.stringify({ mcpServers: [] }), {})).toThrow("config_unreadable");
    expect(() => mergeJsonConfig("[1]", {})).toThrow("config_unreadable");
  });

  it("replaces only FusionKit's table in Codex's config.toml", async () => {
    const existing = ['model = "gpt-5"', "", "[mcp_servers.linear]", 'url = "https://mcp.linear.app/mcp"', "", "[mcp_servers.fusionkit]", "url = 'http://old'", "", "[mcp_servers.fusionkit.env]", 'X = "1"', "", "[profiles.fast]", 'model = "o4"', ""].join("\n");
    const merged = mergeTomlConfig(existing, codexTable("http", input));
    expect(merged).toContain("[mcp_servers.linear]");
    expect(merged).toContain("[profiles.fast]\nmodel = \"o4\"");
    expect(merged).not.toContain("http://old");
    expect(merged).not.toContain("[mcp_servers.fusionkit.env]");
    expect(merged.match(/\[mcp_servers\.fusionkit\]/g)).toHaveLength(1);
    expect(merged.endsWith(`${codexTable("http", input)}\n`)).toBe(true);
    expect(mergeTomlConfig(undefined, "[mcp_servers.fusionkit]")).toBe("[mcp_servers.fusionkit]\n");
    const where = await location();
    const result = await writeClientConfig("codex", { toml: codexTable("stdio", input) }, where);
    expect(await readFile(result.path, "utf8")).toContain("env = { ELECTRON_RUN_AS_NODE = '1' }");
    expect(await clientConfigStatus("codex", where)).toMatchObject({ configured: true });
  });
});
