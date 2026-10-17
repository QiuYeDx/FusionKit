import { z } from "zod";

// ---------------------------------------------------------------------------
// External agent activity — what FusionKit remembers about each call an
// external agent made. The main process owns the records (it sees every call,
// including those refused before the window is involved) and keeps them on
// disk; the window adds a readable summary and how the call was allowed.
// Never stored: tool arguments, cue text, translations, tokens or API keys.
// ---------------------------------------------------------------------------

export const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Changes (writes, including failed and declined ones) kept at most. */
export const ACTIVITY_CHANGE_LIMIT = 2000;
/** Reads are kept apart so they cannot push changes out. */
export const ACTIVITY_READ_LIMIT = 1000;
export const ACTIVITY_LINE_LIMIT_BYTES = 8 * 1024;
export const ACTIVITY_ITEMS_KEPT = 20;
export const ACTIVITY_TEXT_LIMIT = 300;
export const ACTIVITY_PAGE_LIMIT = 200;

export const ACTIVITY_ACTIONS = ["import", "translation", "structure", "export", "transcription", "knowledge", "files", "rename"] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];
export const ACTIVITY_SUMMARY_KEYS = ["import", "create_track", "write_translations", "split_cue", "insert_cue_before", "insert_cue_after",
  "convert_source", "convert_directory", "extract_source", "extract_directory", "rename_paths", "undo_rename", "export_source", "export_choose",
  "transcription", "knowledge"] as const;
export type ActivitySummaryKey = (typeof ACTIVITY_SUMMARY_KEYS)[number];
/** Confirmation rows whose text is cue text; only their values are remembered. */
export const ACTIVITY_TEXT_ACTIONS: ReadonlySet<ActivityAction> = new Set(["structure", "translation"]);

/**
 * none: a read, or nothing needed asking; confirmed: the user allowed it in the dialog;
 * session: allowed earlier for the rest of this connection; auto: the auto trust level ran it;
 * full: the full-access level ran it; permitted: a custom permission allowed it;
 * declined / expired: the user said no or never decided; read_only: refused by the trust level;
 * not_permitted: refused by a custom permission.
 */
export const activityApprovalSchema = z.enum(["none", "confirmed", "session", "auto", "full", "permitted", "declined", "expired", "read_only", "not_permitted"]);
export type ActivityApproval = z.infer<typeof activityApprovalSchema>;
export const activityStatusSchema = z.enum(["ok", "failed", "declined", "pending", "cancelled", "expired"]);
export type ActivityStatus = z.infer<typeof activityStatusSchema>;
export type ActivityAccess = "read" | "write" | "destructive";

const text = z.string().max(ACTIVITY_TEXT_LIMIT);
const value = z.union([z.string().max(ACTIVITY_TEXT_LIMIT), z.number().finite()]);
const id = z.string().min(1).max(200);

export const activityItemSchema = z.object({
  text,
  detail: text.optional(),
  from: text.optional(),
  tag: z.enum(["collection", "term", "rule", "context"]).optional(),
}).strict();
export type ActivityItem = z.infer<typeof activityItemSchema>;

export const activitySummarySchema = z.object({
  action: z.enum(ACTIVITY_ACTIONS),
  key: z.enum(ACTIVITY_SUMMARY_KEYS),
  values: z.record(z.string().max(40), value).refine(record => Object.keys(record).length <= 12),
  content: z.enum(["source", "target", "bilingual"]).optional(),
  warning: z.literal("overwrite").optional(),
  items: z.array(activityItemSchema).max(ACTIVITY_ITEMS_KEPT).optional(),
  more: z.number().int().min(0).optional(),
}).strict();
export type ActivitySummary = z.infer<typeof activitySummarySchema>;

/** What the window adds to a call it answered. */
export const activityNoteSchema = z.object({
  approval: activityApprovalSchema.optional(),
  confirmationId: id.optional(),
  summary: activitySummarySchema.optional(),
  result: z.record(z.string().max(40), z.number().finite()).refine(record => Object.keys(record).length <= 12).optional(),
  target: z.object({ documentId: id, documentName: text.optional() }).strict().optional(),
  undo: z.object({ kind: z.literal("rename"), journalId: id }).strict().optional(),
  outputs: z.array(z.string().min(1).max(1000)).max(ACTIVITY_ITEMS_KEPT).optional(),
  /** A failure's reason, already redacted; the code comes from the call's result. */
  reason: text.optional(),
}).strict();
export type ActivityNote = z.infer<typeof activityNoteSchema>;

/** A call that waited for the user, settled later. */
export const activityUpdateSchema = z.object({
  confirmationId: id,
  status: z.enum(["ok", "failed", "declined", "expired"]),
  error: z.string().min(1).max(100).optional(),
  note: activityNoteSchema.omit({ approval: true, confirmationId: true, summary: true }).optional(),
}).strict();
export type ActivityUpdate = z.infer<typeof activityUpdateSchema>;

export interface ActivityClient { name: string; version: string }

export interface ActivityRecord {
  id: string;
  sessionId: string;
  client: ActivityClient;
  tool: string;
  access: ActivityAccess;
  startedAt: number;
  endedAt?: number;
  status: ActivityStatus;
  /** A failure's stable code. */
  error?: string;
  approval?: ActivityApproval;
  confirmationId?: string;
  note?: Omit<ActivityNote, "approval" | "confirmationId">;
  /** The user undid this rename from the activity page. */
  undone?: boolean;
}

export interface ActivitySession {
  id: string;
  client: ActivityClient;
  connectedAt: number;
  endedAt?: number;
}

export interface ActivitySessionSummary extends ActivitySession {
  live: boolean;
  changes: number;
  problems: number;
  lastAt?: number;
}

export const activityFilterSchema = z.enum(["changes", "all", "problems"]);
export type ActivityFilter = z.infer<typeof activityFilterSchema>;
export const activityListRequestSchema = z.object({
  sessionId: id.optional(),
  filter: activityFilterSchema,
  /** Records that started before this (exclusive), for the next page. */
  before: z.object({ at: z.number().finite(), id }).strict().optional(),
  limit: z.number().int().min(1).max(ACTIVITY_PAGE_LIMIT).optional(),
}).strict();
export type ActivityListRequest = z.infer<typeof activityListRequestSchema>;
export interface ActivityListPage { records: ActivityRecord[]; next?: { at: number; id: string } }

export const isChange = (record: Pick<ActivityRecord, "access">) => record.access !== "read";
export const isProblem = (record: Pick<ActivityRecord, "status" | "approval">) =>
  record.status === "failed" || record.status === "declined" || record.status === "expired"
  || record.approval === "declined" || record.approval === "read_only" || record.approval === "not_permitted" || record.approval === "expired";
/** A change that ran without anyone being asked. */
export const ranUnasked = (record: Pick<ActivityRecord, "access" | "status" | "approval">) =>
  isChange(record) && record.status === "ok" && (record.approval === "session" || record.approval === "auto" || record.approval === "full" || record.approval === "permitted");

export function matchesFilter(record: ActivityRecord, filter: ActivityFilter): boolean {
  if (filter === "changes") return isChange(record);
  if (filter === "problems") return isProblem(record);
  return true;
}

/** Newest first; ties broken by id so paging is stable. */
export function compareNewestFirst(a: Pick<ActivityRecord, "startedAt" | "id">, b: Pick<ActivityRecord, "startedAt" | "id">): number {
  return b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}
