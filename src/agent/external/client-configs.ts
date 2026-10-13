import type { ExternalConnectionInfo } from "./contract";

// ---------------------------------------------------------------------------
// Ready-to-paste configurations for MCP clients, written for this installation:
// its endpoint and token (HTTP), or its executable and bridge script (stdio).
// ---------------------------------------------------------------------------

export const EXTERNAL_CLIENTS = ["claude-code", "codex", "cursor", "json"] as const;
export type ExternalClient = (typeof EXTERNAL_CLIENTS)[number];
export type ExternalTransport = "http" | "stdio";
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

/** The bridge's command line: FusionKit's executable runs the script as Node. */
export function bridgeArgs(info: ExternalConnectionInfo): string[] {
  return [info.scriptPath, "--endpoint", info.endpointPath, "--launch", info.exePath, ...(info.appPath ? ["--app", info.appPath] : [])];
}

/** Shell words: quoted only when they need it (spaces in Windows paths, the header). */
const quote = (value: string) => /^[\w@%+=:,./\-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
/** TOML literal strings keep Windows backslashes as they are. */
function tomlString(value: string): string {
  if (!value.includes("'") && !/[\r\n]/.test(value)) return `'${value}'`;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

export function buildClientConfig(client: ExternalClient, transport: ExternalTransport, { url, token, info }: ClientConfigInput): ClientConfig {
  const authorization = `Bearer ${token}`;
  const args = bridgeArgs(info);
  if (client === "claude-code") {
    return {
      language: "shell",
      text: transport === "http"
        ? `claude mcp add --scope user --transport http ${SERVER_NAME} ${url} --header ${quote(`Authorization: ${authorization}`)}`
        : `claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 ${SERVER_NAME} -- ${[info.exePath, ...args].map(quote).join(" ")}`,
    };
  }
  if (client === "codex") {
    const lines = [`[mcp_servers.${SERVER_NAME}]`];
    if (transport === "http") lines.push(`url = ${tomlString(url)}`, `http_headers = { Authorization = ${tomlString(authorization)} }`);
    else lines.push(`command = ${tomlString(info.exePath)}`, `args = [${args.map(tomlString).join(", ")}]`, `env = { ELECTRON_RUN_AS_NODE = '1' }`);
    return { language: "toml", text: lines.join("\n") };
  }
  const server = transport === "http"
    ? { url, headers: { Authorization: authorization } }
    : { command: info.exePath, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
  return { language: "json", text: JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }, null, 2) };
}
