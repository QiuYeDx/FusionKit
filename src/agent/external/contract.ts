import { z } from "zod";
import type { ActivityListPage, ActivityListRequest, ActivityRecord, ActivitySessionSummary, ActivityUpdate } from "./activity";

// ---------------------------------------------------------------------------
// External agent bridge — what the main process, the preload and the renderer
// share. External agents (Claude Code, Codex...) reach FusionKit over MCP on the
// loopback interface; the main process forwards their tool calls to the window.
// ---------------------------------------------------------------------------

export const EXTERNAL_AGENT_CHANNEL_PREFIX = "external-agent:";
export const EXTERNAL_AGENT_CHANNELS = {
  getSettings: "external-agent:get-settings",
  updateSettings: "external-agent:update-settings",
  regenerateToken: "external-agent:regenerate-token",
  getStatus: "external-agent:get-status",
  closeSession: "external-agent:close-session",
  /** A confirmation waits: flash the taskbar entry if the window is not focused. */
  requestAttention: "external-agent:request-attention",
  connectionInfo: "external-agent:connection-info",
  installSkill: "external-agent:install-skill",
  skillStatus: "external-agent:skill-status",
  writeClientConfig: "external-agent:write-client-config",
  clientConfigStatus: "external-agent:client-config-status",
  revealClientConfig: "external-agent:reveal-client-config",
  /** Opens a client's own install link (Cursor). */
  openClientInstall: "external-agent:open-client-install",
  /** The activity record: pages of calls, connections, clearing, a rename undone from the page. */
  activityList: "external-agent:activity-list",
  activitySessions: "external-agent:activity-sessions",
  activityClear: "external-agent:activity-clear",
  activityUndone: "external-agent:activity-undone",
  /** Main → window pushes. */
  status: "external-agent:status",
  /** A call recorded or updated, or the record cleared. */
  activity: "external-agent:activity",
  call: "external-agent:call",
  cancel: "external-agent:cancel",
  /** Window → main. */
  ready: "external-agent:ready",
  respond: "external-agent:respond",
  /** A call that waited for the user settled later. */
  reportActivity: "external-agent:report-activity",
} as const;

export const DEFAULT_EXTERNAL_AGENT_PORT = 47361;
export const MAX_EXTERNAL_SESSIONS = 8;
export const EXTERNAL_SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
export const EXTERNAL_READY_WAIT_MS = 15_000;
export const EXTERNAL_CALL_TIMEOUT_MS = 150_000;
export const EXTERNAL_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * read_only: reads only; confirm_writes: writes ask in FusionKit; auto: writes run, destructive ones still ask;
 * full: everything runs without asking; custom: each operation follows its own permission below.
 */
export const externalTrustSchema = z.enum(["read_only", "confirm_writes", "auto", "full", "custom"]);
export type ExternalTrust = z.infer<typeof externalTrustSchema>;

/** One permission code per operation that changes something; overwrite_files also applies to any call that replaces files. */
export const EXTERNAL_PERMISSION_CODES = [
  "import_studio_subtitles", "create_studio_translation_track", "write_studio_translations",
  "split_studio_cue", "insert_studio_cue", "export_studio_document", "start_studio_transcription",
  "prepare_knowledge_changes", "convert_subtitle_files", "extract_subtitle_language",
  "rename_paths", "undo_name_changes", "overwrite_files",
] as const;
export type ExternalPermissionCode = typeof EXTERNAL_PERMISSION_CODES[number];
/** deny: refused; ask: the user confirms in FusionKit; allow: runs without asking. */
export const externalPermissionSchema = z.enum(["deny", "ask", "allow"]);
export type ExternalPermission = z.infer<typeof externalPermissionSchema>;
export type ExternalPermissions = Record<ExternalPermissionCode, ExternalPermission>;
const ASKED_IN_AUTO: ReadonlySet<ExternalPermissionCode> = new Set(["prepare_knowledge_changes", "rename_paths", "undo_name_changes", "overwrite_files"]);
/** Custom starts where auto is: writes run; knowledge changes, renames and overwrites ask. */
export const DEFAULT_EXTERNAL_PERMISSIONS: ExternalPermissions = Object.fromEntries(
  EXTERNAL_PERMISSION_CODES.map(code => [code, ASKED_IN_AUTO.has(code) ? "ask" : "allow"])) as ExternalPermissions;
export const isExternalPermissionCode = (value: string): value is ExternalPermissionCode => (EXTERNAL_PERMISSION_CODES as readonly string[]).includes(value);
/** Unknown codes are dropped and missing ones take their default, so one bad entry never resets the rest. */
export const externalPermissionsSchema = z.record(z.string(), z.unknown()).transform((raw): ExternalPermissions => {
  const result = { ...DEFAULT_EXTERNAL_PERMISSIONS };
  for (const code of EXTERNAL_PERMISSION_CODES) {
    const parsed = externalPermissionSchema.safeParse(raw[code]);
    if (parsed.success) result[code] = parsed.data;
  }
  return result;
});
const externalPermissionsUpdateSchema = z.object(Object.fromEntries(EXTERNAL_PERMISSION_CODES.map(code => [code, externalPermissionSchema.optional()])) as
  Record<ExternalPermissionCode, z.ZodOptional<typeof externalPermissionSchema>>).strict();

export const externalPortSchema = z.number().int().min(1024).max(65535);
export const externalTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const externalAgentSettingsSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  port: externalPortSchema,
  /** Empty until access is first enabled. */
  token: z.union([externalTokenSchema, z.literal("")]),
  trust: externalTrustSchema,
  /** What each operation may do in the custom level; kept when another level is chosen. */
  permissions: externalPermissionsSchema,
  /** Show a notice when a change ran without asking. */
  notices: z.boolean(),
}).strict();
export type ExternalAgentSettings = z.output<typeof externalAgentSettingsSchema>;

export const DEFAULT_EXTERNAL_AGENT_SETTINGS: ExternalAgentSettings = {
  version: 1, enabled: false, port: DEFAULT_EXTERNAL_AGENT_PORT, token: "", trust: "confirm_writes", permissions: DEFAULT_EXTERNAL_PERMISSIONS, notices: true,
};

export const externalAgentSettingsUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  port: externalPortSchema.optional(),
  trust: externalTrustSchema.optional(),
  /** Changes only the codes given. */
  permissions: externalPermissionsUpdateSchema.optional(),
  notices: z.boolean().optional(),
}).strict();
export type ExternalAgentSettingsUpdate = z.input<typeof externalAgentSettingsUpdateSchema>;

export interface ExternalClientInfo { name: string; version: string }

export interface ExternalSessionSummary {
  id: string;
  client: ExternalClientInfo;
  connectedAt: number;
  lastActiveAt: number;
}

export type ExternalAgentErrorCode = "port_in_use" | "listen_failed";

export interface ExternalAgentStatus {
  enabled: boolean;
  state: "stopped" | "running" | "error";
  port: number;
  url?: string;
  error?: ExternalAgentErrorCode;
  trust: ExternalTrust;
  /** Enforced only when trust is custom; the defaults apply when absent. */
  permissions?: ExternalPermissions;
  sessions: ExternalSessionSummary[];
}

/** What the settings page needs to write client configurations for this installation. */
export interface ExternalConnectionInfo {
  /** FusionKit's executable (Electron's in development). */
  exePath: string;
  /** The stdio bridge script. */
  scriptPath: string;
  endpointPath: string;
  /** Only in development: the app folder Electron is started with. */
  appPath?: string;
  platform: string;
}

/** claude: ~/.claude/skills (Claude Code); agents: the shared ~/.agents/skills (Codex, Cursor and other agents). */
export type ExternalSkillTarget = "claude" | "agents";
export interface ExternalSkillStatus { target: ExternalSkillTarget; path: string; installed: boolean; current: boolean }

/** A desktop client's own MCP configuration file and whether FusionKit is in it. */
export interface ExternalClientConfigStatus { client: "claude-desktop" | "codex" | "cursor"; path: string; exists: boolean; configured: boolean }
export interface ExternalClientConfigWrite { client: "claude-desktop" | "codex" | "cursor"; path: string; backupPath?: string }

export type ExternalResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** One tool call from an external agent, as the window receives it. */
export interface ExternalToolCall {
  callId: string;
  sessionId: string;
  client: ExternalClientInfo;
  tool: string;
  arguments: Record<string, unknown>;
}

export const externalToolOutcomeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(100), detail: z.record(z.string(), z.unknown()).optional() }).strict(),
]);
export type ExternalToolOutcome = z.infer<typeof externalToolOutcomeSchema>;

export const externalToolResponseSchema = z.object({
  callId: z.string().min(1).max(100),
  result: externalToolOutcomeSchema,
  /** What FusionKit remembers about the call; never sent back to the agent. */
  activity: z.unknown().optional(),
}).strict();
export type ExternalToolResponse = z.infer<typeof externalToolResponseSchema>;

export type ExternalActivityEvent = { type: "record"; record: ActivityRecord } | { type: "cleared" };

/** What the window sees as `window.externalAgent`. */
export interface ExternalAgentApi {
  getSettings(): Promise<ExternalResult<ExternalAgentSettings>>;
  updateSettings(update: ExternalAgentSettingsUpdate): Promise<ExternalResult<ExternalAgentSettings>>;
  regenerateToken(): Promise<ExternalResult<ExternalAgentSettings>>;
  getStatus(): Promise<ExternalResult<ExternalAgentStatus>>;
  closeSession(sessionId: string): Promise<ExternalResult<null>>;
  connectionInfo(): Promise<ExternalResult<ExternalConnectionInfo>>;
  installSkill(target: ExternalSkillTarget): Promise<ExternalResult<ExternalSkillStatus>>;
  skillStatus(): Promise<ExternalResult<ExternalSkillStatus[]>>;
  writeClientConfig(request: { client: ExternalClientConfigStatus["client"]; transport: "http" | "stdio" }): Promise<ExternalResult<ExternalClientConfigWrite>>;
  clientConfigStatus(): Promise<ExternalResult<ExternalClientConfigStatus[]>>;
  revealClientConfig(client: ExternalClientConfigStatus["client"]): Promise<ExternalResult<null>>;
  openClientInstall(request: { client: "cursor"; transport: "http" | "stdio" }): Promise<ExternalResult<null>>;
  onStatus(listener: (status: ExternalAgentStatus) => void): () => void;
  onCall(listener: (call: ExternalToolCall) => void): () => void;
  onCancel(listener: (cancel: { callId: string }) => void): () => void;
  ready(): void;
  requestAttention(): void;
  respond(response: ExternalToolResponse): Promise<void>;
  activityList(request: ActivityListRequest): Promise<ExternalResult<ActivityListPage>>;
  activitySessions(): Promise<ExternalResult<ActivitySessionSummary[]>>;
  activityClear(): Promise<ExternalResult<null>>;
  activityUndone(id: string): Promise<ExternalResult<ActivityRecord | null>>;
  reportActivity(update: ActivityUpdate): void;
  onActivity(listener: (event: ExternalActivityEvent) => void): () => void;
}
