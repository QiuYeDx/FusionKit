import type { ExternalConnectionInfo } from "./contract";

// ---------------------------------------------------------------------------
// Ready-to-paste configurations for MCP clients, written for this installation:
// its endpoint and token (HTTP), or its executable and bridge script (stdio).
// ---------------------------------------------------------------------------

export const EXTERNAL_CLIENTS = ["claude-code", "claude-desktop", "codex", "cursor", "json"] as const;
export type ExternalClient = (typeof EXTERNAL_CLIENTS)[number];
export type ExternalTransport = "http" | "stdio";
/** Clients configured through a file FusionKit can write the entry into. */
export const WRITABLE_CLIENTS = ["claude-desktop", "codex", "cursor"] as const;
export type WritableClient = (typeof WRITABLE_CLIENTS)[number];
export const SERVER_NAME = "fusionkit";

export interface ClientConfig {
  language: "shell" | "toml" | "json";
  text: string;
}

export interface ClientConfigInput {
  url: string;
  token: string;
  info: ExternalConnectionInfo;
}

/**
 * Claude Desktop reaches local servers only by starting a command: its custom
 * connectors connect from Anthropic's cloud and cannot see 127.0.0.1.
 */
export function clientTransports(client: ExternalClient): ExternalTransport[] {
  return client === "claude-desktop" ? ["stdio"] : ["http", "stdio"];
}

export function isWritableClient(client: ExternalClient): client is WritableClient {
  return (WRITABLE_CLIENTS as readonly string[]).includes(client);
}

/** The bridge's command line: FusionKit's executable runs the script as Node. */
export function bridgeArgs(info: ExternalConnectionInfo): string[] {
  return [info.scriptPath, "--endpoint", info.endpointPath, "--launch", info.exePath, ...(info.appPath ? ["--app", info.appPath] : [])];
}

/** The `mcpServers.fusionkit` value of JSON-configured clients. */
export function jsonServerEntry(transport: ExternalTransport, { url, token, info }: ClientConfigInput): Record<string, unknown> {
  return transport === "http"
    ? { url, headers: { Authorization: `Bearer ${token}` } }
    : { command: info.exePath, args: bridgeArgs(info), env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** Shell words: quoted only when they need it (spaces or backslashes in Windows paths, the header). */
const quote = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
/** TOML literal strings keep Windows backslashes as they are. */
function tomlString(value: string): string {
  if (!value.includes("'") && !/[\r\n]/.test(value)) return `'${value}'`;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

/** The `[mcp_servers.fusionkit]` table Codex reads from config.toml. */
export function codexTable(transport: ExternalTransport, { url, token, info }: ClientConfigInput): string {
  const lines = [`[mcp_servers.${SERVER_NAME}]`];
  if (transport === "http") lines.push(`url = ${tomlString(url)}`, `http_headers = { Authorization = ${tomlString(`Bearer ${token}`)} }`);
  else lines.push(`command = ${tomlString(info.exePath)}`, `args = [${bridgeArgs(info).map(tomlString).join(", ")}]`, `env = { ELECTRON_RUN_AS_NODE = '1' }`);
  return lines.join("\n");
}

export function buildClientConfig(client: ExternalClient, transport: ExternalTransport, input: ClientConfigInput): ClientConfig {
  const { url, token, info } = input;
  if (client === "claude-code") {
    return {
      language: "shell",
      text: transport === "http"
        ? `claude mcp add --scope user --transport http ${SERVER_NAME} ${url} --header ${quote(`Authorization: Bearer ${token}`)}`
        : `claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 ${SERVER_NAME} -- ${[info.exePath, ...bridgeArgs(info)].map(quote).join(" ")}`,
    };
  }
  if (client === "codex") return { language: "toml", text: codexTable(transport, input) };
  // Claude Desktop starts local servers only; whatever transport was asked, it gets the bridge.
  const entry = jsonServerEntry(client === "claude-desktop" ? "stdio" : transport, input);
  return { language: "json", text: JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2) };
}

export const CURSOR_INSTALL_PREFIX = "cursor://anysphere.cursor-deeplink/mcp/install?";

/** Base64 of UTF-8 text, alike in the window and in Node (paths may hold any characters). */
function base64Utf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Cursor's own install link: opening it shows Cursor's prompt to add the server. */
export function cursorInstallLink(transport: ExternalTransport, input: ClientConfigInput): string {
  const config = base64Utf8(JSON.stringify(jsonServerEntry(transport, input)));
  return `${CURSOR_INSTALL_PREFIX}name=${SERVER_NAME}&config=${encodeURIComponent(config)}`;
}

/** Field by field, for clients whose settings are a form rather than a file. */
export function connectionFields(transport: ExternalTransport, { url, token, info }: ClientConfigInput): { key: string; value: string }[] {
  return transport === "http"
    ? [{ key: "url", value: url }, { key: "header", value: `Authorization: Bearer ${token}` }]
    : [{ key: "command", value: info.exePath }, { key: "args", value: bridgeArgs(info).map(quote).join(" ") }, { key: "env", value: "ELECTRON_RUN_AS_NODE=1" }];
}
