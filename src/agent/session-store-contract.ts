import { z } from "zod";

/**
 * Agent sessions saved in the application data folder, one JSON file per session in the
 * export format, plus an index for the session list. Only the app's own window may use it.
 */
export const AGENT_SESSIONS_CHANNEL_PREFIX = "agent-sessions:";
export const AGENT_SESSIONS_CHANNELS = {
  list: "agent-sessions:list",
  load: "agent-sessions:load",
  save: "agent-sessions:save",
  remove: "agent-sessions:remove",
  clear: "agent-sessions:clear",
} as const;

/** The same limit as an exported session file. */
export const MAX_STORED_SESSION_BYTES = 8 * 1024 * 1024;
/** Safe as a file name on every platform, never a path. */
export const agentSessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

const time = z.number().finite().nonnegative().max(8_640_000_000_000_000);
export const agentSessionMetaSchema = z.object({
  id: agentSessionIdSchema,
  title: z.string().max(200),
  titleSource: z.enum(["auto", "generated", "manual"]),
  pinned: z.boolean(),
  createdAt: time,
  updatedAt: time,
  messageCount: z.number().int().nonnegative().max(1_000_000),
  preview: z.string().max(400),
  unreadable: z.boolean().optional(),
}).strict();
export type StoredAgentSessionMeta = z.infer<typeof agentSessionMetaSchema>;

export const saveAgentSessionRequestSchema = z.object({ meta: agentSessionMetaSchema, content: z.string() }).strict();
export type SaveAgentSessionRequest = z.infer<typeof saveAgentSessionRequestSchema>;

export type AgentSessionsError =
  | "agent_sessions_blocked"
  | "agent_session_invalid"
  | "agent_session_too_large"
  | "agent_session_not_found"
  | "agent_session_unreadable"
  | "agent_session_write_failed";

export type AgentSessionsResult<T> = { ok: true; value: T } | { ok: false; error: AgentSessionsError };

export interface AgentSessionsApi {
  list(): Promise<AgentSessionsResult<StoredAgentSessionMeta[]>>;
  /** The saved file's text; the renderer validates it like an imported file. */
  load(id: string): Promise<AgentSessionsResult<string>>;
  save(request: SaveAgentSessionRequest): Promise<AgentSessionsResult<null>>;
  remove(id: string): Promise<AgentSessionsResult<null>>;
  clear(): Promise<AgentSessionsResult<null>>;
}
