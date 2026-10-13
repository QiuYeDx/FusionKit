import { describe, expect, it } from "vitest";
import { bridgeArgs, buildClientConfig, EXTERNAL_CLIENTS } from "./client-configs";

const TOKEN = "abcDEF0123456789abcDEF0123456789abcDEF01234";
const url = "http://127.0.0.1:47361/mcp";
const installed = { exePath: "C:\\Program Files\\FusionKit\\FusionKit.exe", scriptPath: "C:\\Program Files\\FusionKit\\resources\\external-agent\\fusionkit-mcp-stdio.cjs",
  endpointPath: "C:\\Users\\Me\\AppData\\Roaming\\FusionKit\\external-agent\\endpoint.json", platform: "win32" };
const development = { ...installed, exePath: "C:\\repo\\node_modules\\electron\\dist\\electron.exe", appPath: "C:\\repo" };

/** Just enough TOML for the snippets: a table header and key = literal/array/inline-table lines. */
function parseToml(text: string) {
  const [header, ...lines] = text.split("\n");
  expect(header).toBe("[mcp_servers.fusionkit]");
  const literal = (value: string) => { expect(value).toMatch(/^'[^']*'$/); return value.slice(1, -1); };
  return Object.fromEntries(lines.map(line => {
    const [, key, value] = /^(\w+) = (.+)$/.exec(line)!;
    if (value.startsWith("[")) return [key, value.slice(1, -1).split(", ").map(literal)];
    if (value.startsWith("{")) { const [, inner, raw] = /^\{ (\w+) = (.+) \}$/.exec(value)!; return [key, { [inner]: literal(raw) }]; }
    return [key, literal(value)];
  }));
}

describe("client configurations", () => {
  it("gives Claude Code a user-scoped command for HTTP and for the bridge", () => {
    expect(buildClientConfig("claude-code", "http", { url, token: TOKEN, info: installed })).toEqual({ language: "shell",
      text: `claude mcp add --scope user --transport http fusionkit ${url} --header "Authorization: Bearer ${TOKEN}"` });
    expect(buildClientConfig("claude-code", "stdio", { url, token: TOKEN, info: installed }).text)
      .toBe(`claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 fusionkit -- "${installed.exePath}" "${installed.scriptPath}" --endpoint "${installed.endpointPath}" --launch "${installed.exePath}"`);
  });

  it("writes Codex TOML that keeps Windows paths literally", () => {
    expect(parseToml(buildClientConfig("codex", "http", { url, token: TOKEN, info: installed }).text)).toEqual({ url, http_headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(parseToml(buildClientConfig("codex", "stdio", { url, token: TOKEN, info: development }).text)).toEqual({
      command: development.exePath, args: bridgeArgs(development), env: { ELECTRON_RUN_AS_NODE: "1" } });
    expect(bridgeArgs(development)).toEqual([development.scriptPath, "--endpoint", development.endpointPath, "--launch", development.exePath, "--app", "C:\\repo"]);
    expect(bridgeArgs(installed)).not.toContain("--app");
  });

  it("writes valid mcp.json for Cursor and other clients", () => {
    for (const client of ["cursor", "json"] as const) {
      expect(JSON.parse(buildClientConfig(client, "http", { url, token: TOKEN, info: installed }).text)).toEqual({ mcpServers: { fusionkit: { url, headers: { Authorization: `Bearer ${TOKEN}` } } } });
      expect(JSON.parse(buildClientConfig(client, "stdio", { url, token: TOKEN, info: installed }).text)).toEqual({ mcpServers: { fusionkit: {
        command: installed.exePath, args: bridgeArgs(installed), env: { ELECTRON_RUN_AS_NODE: "1" } } } });
    }
  });

  it("falls back to escaped TOML strings for paths with apostrophes", () => {
    const odd = { ...installed, exePath: "C:\\Users\\O'Neil\\FusionKit.exe" };
    expect(buildClientConfig("codex", "stdio", { url, token: TOKEN, info: odd }).text).toContain(`command = "C:\\\\Users\\\\O'Neil\\\\FusionKit.exe"`);
    expect(EXTERNAL_CLIENTS).toEqual(["claude-code", "codex", "cursor", "json"]);
  });
});
