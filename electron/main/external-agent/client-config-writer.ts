import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SERVER_NAME, type WritableClient } from "../../../src/agent/external/client-configs";

export interface ConfigLocation { home: string; appData: string; platform: NodeJS.Platform; codexHome?: string }

/** Where each client keeps its MCP configuration. Tests point HOME elsewhere. */
export function defaultLocation(): ConfigLocation {
  const override = process.env.FUSIONKIT_EXTERNAL_AGENT_HOME;
  if (override) return { home: override, appData: path.join(override, "AppData", "Roaming"), platform: process.platform };
  const home = os.homedir();
  return { home, appData: process.env.APPDATA || path.join(home, "AppData", "Roaming"), platform: process.platform, codexHome: process.env.CODEX_HOME || undefined };
}

export function clientConfigPath(client: WritableClient, location: ConfigLocation = defaultLocation()): string {
  if (client === "codex") return path.join(location.codexHome || path.join(location.home, ".codex"), "config.toml");
  if (client === "cursor") return path.join(location.home, ".cursor", "mcp.json");
  // Claude Desktop (the chat app); its local Code sessions read the same file.
  const folder = location.platform === "win32" ? path.join(location.appData, "Claude")
    : location.platform === "darwin" ? path.join(location.home, "Library", "Application Support", "Claude")
      : path.join(location.home, ".config", "Claude");
  return path.join(folder, "claude_desktop_config.json");
}

export class ConfigUnreadable extends Error { constructor() { super("config_unreadable"); } }

/** Sets `mcpServers.fusionkit`, keeping everything else in the file as it was. */
export function mergeJsonConfig(text: string | undefined, entry: Record<string, unknown>): string {
  let config: Record<string, unknown> = {};
  if (text && text.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new ConfigUnreadable(); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ConfigUnreadable();
    config = parsed as Record<string, unknown>;
  }
  const servers = config.mcpServers ?? {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new ConfigUnreadable();
  return `${JSON.stringify({ ...config, mcpServers: { ...(servers as Record<string, unknown>), [SERVER_NAME]: entry } }, null, 2)}\n`;
}

const OWN_TABLE = new RegExp(`^\\s*\\[mcp_servers\\.(?:${SERVER_NAME}|"${SERVER_NAME}")(?:\\.[^\\]]+)?\\]\\s*(?:#.*)?$`);
const ANY_TABLE = /^\s*\[/;

/** Replaces the `[mcp_servers.fusionkit]` table (and its sub-tables) with the new one, at the end. */
export function mergeTomlConfig(text: string | undefined, table: string): string {
  const lines = (text ?? "").replace(/^﻿/, "").split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (ANY_TABLE.test(line)) skipping = OWN_TABLE.test(line);
    if (!skipping) kept.push(line);
  }
  const rest = kept.join("\n").replace(/\s+$/, "");
  return `${rest ? `${rest}\n\n` : ""}${table}\n`;
}

export function hasFusionkitEntry(client: WritableClient, text: string): boolean {
  if (client === "codex") return text.split(/\r?\n/).some(line => OWN_TABLE.test(line));
  try {
    const servers = (JSON.parse(text.replace(/^﻿/, "")) as { mcpServers?: Record<string, unknown> }).mcpServers;
    return !!servers && typeof servers === "object" && SERVER_NAME in servers;
  } catch { return false; }
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export interface ClientConfigWriteResult { client: WritableClient; path: string; backupPath?: string }

/**
 * Writes FusionKit's entry into a client's own configuration file. Only that entry
 * changes; the previous file is kept as `<file>.fusionkit-backup`; a file that cannot
 * be read as its format is left alone.
 */
export async function writeClientConfig(client: WritableClient, content: { json?: Record<string, unknown>; toml?: string },
  location: ConfigLocation = defaultLocation()): Promise<ClientConfigWriteResult> {
  const file = clientConfigPath(client, location);
  const previous = await readOptional(file);
  const next = client === "codex" ? mergeTomlConfig(previous, content.toml ?? "") : mergeJsonConfig(previous, content.json ?? {});
  await mkdir(path.dirname(file), { recursive: true });
  let backupPath: string | undefined;
  if (previous !== undefined) {
    backupPath = `${file}.fusionkit-backup`;
    await copyFile(file, backupPath);
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, next, "utf8");
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return { client, path: file, ...(backupPath ? { backupPath } : {}) };
}

export async function clientConfigStatus(client: WritableClient, location: ConfigLocation = defaultLocation()) {
  const file = clientConfigPath(client, location);
  const text = await readOptional(file).catch(() => undefined);
  return { client, path: file, exists: text !== undefined, configured: text !== undefined && hasFusionkitEntry(client, text) };
}
