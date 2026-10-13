import { z } from "zod";
import { PROPOSAL_LIMITS } from "@/translation-knowledge/proposal";

// ---------------------------------------------------------------------------
// The tools FusionKit offers external agents over MCP. Defined once here: the
// main process lists and validates them, the window validates again and runs
// them. Only zod and pure contracts may be imported.
// ---------------------------------------------------------------------------

/** read: changes nothing; write: changes FusionKit data or starts work, undoable or cancellable; destructive: replaces files. */
export type ExternalToolAccess = "read" | "write" | "destructive";
/** Writes of one kind a user may allow for the rest of a connection. */
export type ExternalApprovalGroup = "studio_import" | "studio_translation" | "studio_export" | "studio_transcription";

export interface ExternalToolDefinition {
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  access: ExternalToolAccess;
  /** Writes allowed together for a connection; absent for reads and always-confirmed tools. */
  group?: ExternalApprovalGroup;
  /** The user confirms every call, in every trust level. */
  confirm?: "always";
  /** Some calls of this tool replace files (the MCP hint is static). */
  mayDestroy?: boolean;
}

const page = (limit = 20, max = 50) => ({
  offset: z.number().int().min(0).max(100000).default(0).describe("Index of the first item to return."),
  limit: z.number().int().min(1).max(max).default(limit).describe(`How many items to return, at most ${max}.`),
});
const id = z.string().uuid();
const revision = z.number().int().positive().safe().describe("The document's current revision, from list_studio_documents or read_studio_document.");
const paths = z.array(z.string().min(1).max(4096).refine(value => !value.includes("\0"))).min(1).max(20);
const languagePair = z.object({ source: z.string().trim().min(2).max(35), target: z.string().trim().min(2).max(35) }).strict();
const knowledgeRef = z.union([z.object({ id }).strict(), z.object({ ref: z.string().trim().min(1).max(40) }).strict()]);
const shortText = (length: number) => z.string().max(length);

export const EXTERNAL_TOOLS = {
  get_fusionkit_status: {
    title: "FusionKit status",
    description: "Read FusionKit's current state: app version, interface language, the page on screen, your permission level (trust), "
      + "whether FusionKit's own AI models are configured (you do not need them to translate: you write translations yourself), "
      + "and Subtitle Studio counts (documents, running translation/transcription tasks). Call this first. Read only.",
    inputSchema: z.object({}).strict(),
    access: "read",
  },
  list_studio_documents: {
    title: "List Subtitle Studio documents",
    description: "Search the Subtitle Studio library, where FusionKit keeps imported subtitles and transcribed media. "
      + "Returns each document's documentId and revision (needed by every tool that reads or changes a document), name, format, cue count, "
      + "translation status and any running task. Results are paged: pass nextOffset as offset for the next page. Read only.",
    inputSchema: z.object({
      ...page(),
      query: z.string().max(200).default("").describe("Words that must appear in the document name. Empty lists everything."),
      format: z.enum(["all", "srt", "lrc", "vtt", "ass", "ssa", "sbv", "media"]).default("all").describe("media = documents transcribed from audio/video."),
      status: z.enum(["all", "untranslated", "translated", "active", "attention"]).default("all")
        .describe("active = a task is running; attention = a task failed or needs a decision."),
    }).strict(),
    access: "read",
  },
  read_studio_document: {
    title: "Read a Subtitle Studio document",
    description: "Read a document's cues (subtitle lines) in pages of up to 100: cueId, index, start/end time in milliseconds and source text, "
      + "plus its translation tracks (trackId, language, name, whether you can write to it). Pass trackId to also get that track's translation of each cue "
      + "(origin, reviewed, stale = made for an older source text). Use cueIds from here with write_studio_translations. Read only.",
    inputSchema: z.object({
      documentId: id,
      offset: z.number().int().min(0).max(100000).default(0).describe("Index of the first cue."),
      limit: z.number().int().min(1).max(100).default(100).describe("How many cues, at most 100."),
      trackId: id.optional().describe("A translation track whose text to include."),
    }).strict(),
    access: "read",
  },
  import_studio_subtitles: {
    title: "Import subtitles into Subtitle Studio",
    description: "Import subtitle files (SRT, LRC, VTT, ASS, SSA, SBV) into Subtitle Studio from absolute paths on this computer. "
      + "A folder gives its subtitle files in name order (subfolders only with recursive=true), up to 100 files. "
      + "Returns the new documents' documentId and revision. May ask the user in FusionKit first. Does not translate.",
    inputSchema: z.object({
      paths: paths.describe("Absolute file or folder paths."),
      recursive: z.boolean().default(false),
      encoding: z.enum(["utf-8", "gb18030", "shift_jis", "utf-16le"]).default("utf-8"),
    }).strict(),
    access: "write",
    group: "studio_import",
  },
  create_studio_translation_track: {
    title: "Create a translation track",
    description: "Create an empty translation track on a Subtitle Studio document for translations you write yourself with write_studio_translations. "
      + "Returns trackId and the document's new revision. The user sees it in Subtitle Studio, marked as written by you. May ask the user in FusionKit first.",
    inputSchema: z.object({
      documentId: id,
      revision,
      language: z.string().trim().min(1).max(35).describe("Target language tag, such as zh, zh-Hant, en, ja."),
      name: z.string().trim().min(1).max(100).optional().describe("Track name shown to the user; defaults to your client name."),
    }).strict(),
    access: "write",
    group: "studio_translation",
  },
  write_studio_translations: {
    title: "Write translations",
    description: "Write your translations of cues onto a track you created with create_studio_translation_track, up to 200 cues per call. "
      + "They are stored as unreviewed AI translations of the current source text; each call is one undoable edit in Subtitle Studio. "
      + "Plain text only: no < or > characters, use a line break for multi-line cues. If any text is invalid nothing is written. "
      + "Returns the document's new revision for the next call. May ask the user in FusionKit first (they can allow the rest of this connection).",
    inputSchema: z.object({
      documentId: id,
      revision,
      trackId: id,
      translations: z.array(z.object({ cueId: id, text: z.string().max(20000) }).strict()).min(1).max(200)
        .refine(items => new Set(items.map(item => item.cueId)).size === items.length, "Each cueId may appear once."),
    }).strict(),
    access: "write",
    group: "studio_translation",
  },
  export_studio_document: {
    title: "Export a subtitle file",
    description: "Write a Subtitle Studio document to a subtitle file: content source, target (one translation track) or bilingual; "
      + "format auto keeps the document's format (LRC for audio transcripts, SRT for video). destination source_directory saves next to the original file; "
      + "choose_location opens a save dialog in FusionKit for the user. conflict indexed adds a number to an existing name; overwrite replaces it "
      + "(always confirmed by the user). Returns the file name and any accepted losses.",
    inputSchema: z.object({
      documentId: id,
      revision,
      content: z.enum(["source", "target", "bilingual"]).default("bilingual"),
      trackId: id.optional().describe("The translation track for target or bilingual; defaults to the newest track."),
      format: z.enum(["auto", "srt", "lrc", "vtt", "ass", "ssa", "sbv"]).default("auto"),
      order: z.enum(["source-first", "target-first"]).default("source-first").describe("Line order in bilingual files."),
      incomplete: z.enum(["source-fallback", "skip", "block"]).default("source-fallback")
        .describe("Cues without a current translation: use the source text, leave them out, or refuse to export."),
      destination: z.enum(["source_directory", "choose_location"]).default("source_directory"),
      conflict: z.enum(["indexed", "overwrite"]).default("indexed"),
    }).strict(),
    access: "write",
    group: "studio_export",
    mayDestroy: true,
  },
  start_studio_transcription: {
    title: "Transcribe audio or video locally",
    description: "Transcribe audio/video files into Subtitle Studio with FusionKit's installed local speech model (no cloud, no API key). "
      + "Paths are absolute files or folders (a folder gives its media files in name order; subfolders only with recursive=true), at most 100 files. "
      + "FusionKit's automatic translation and export stay off for this batch. Returns task ids: follow them with get_studio_tasks(kind=transcription); "
      + "each finished task becomes a Studio document. May ask the user in FusionKit first.",
    inputSchema: z.object({
      paths: paths.describe("Absolute file or folder paths."),
      recursive: z.boolean().default(false),
      modelId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional().describe("An installed model id; defaults to Studio's setting."),
      language: z.string().trim().min(2).max(32).regex(/^(?:auto|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/).optional().describe("Spoken language, or auto."),
    }).strict(),
    access: "write",
    group: "studio_transcription",
  },
  get_studio_tasks: {
    title: "Subtitle Studio task progress",
    description: "Read Subtitle Studio translation or transcription tasks and their progress. Queued or running tasks are not finished. Read only.",
    inputSchema: z.object({ ...page(), kind: z.enum(["translation", "transcription"]).default("translation") }).strict(),
    access: "read",
  },
  search_translation_knowledge: {
    title: "Search translation materials",
    description: "Search the user's translation materials (glossaries): every word of the query must match an entry's wording, aliases, note or text, "
      + "or the name or description of its collection (one per work, streamer or topic). Filter by collection, kind, language pair or enabled state. "
      + "Use the terms when you translate. Read only.",
    inputSchema: z.object({
      ...page(),
      query: z.string().max(200).default(""),
      collectionId: id.optional(),
      kind: z.enum(["all", "term", "context", "rule"]).default("all"),
      languagePair: z.object({ source: z.string().max(35).optional(), target: z.string().max(35).optional() }).strict().optional(),
      enabled: z.enum(["all", "enabled", "disabled"]).default("all"),
      includeArchived: z.boolean().default(false),
    }).strict(),
    access: "read",
  },
  list_translation_knowledge_catalog: {
    title: "List translation material collections",
    description: "List the translation materials catalog: collections (one per work, streamer or topic, with language pair and entry counts) and presets "
      + "(named sets of collections). Use it to find the glossary for a work, or where new entries belong. Read only.",
    inputSchema: z.object({ ...page(), includeArchived: z.boolean().default(false) }).strict(),
    access: "read",
  },
  prepare_knowledge_changes: {
    title: "Propose translation material changes",
    description: "Propose changes to the user's translation materials: create collections, create or edit term/rule/context entries, disable or enable entries. "
      + "The user always reviews them in FusionKit; confirmed entries are saved and enabled. Find the collection with list_translation_knowledge_catalog first; "
      + "when none fits, create one named after the work with its languagePair and point to it with {ref}. Edits, disables and enables need the entry's id and revision. "
      + "Terms take the exact source wording and the target wording. basis: user_stated, user_revision, document (read from the subtitles), "
      + "agent_inferred (your own knowledge), web (with url). evidence: a short supporting quote.",
    inputSchema: z.object({
      languagePair: languagePair.optional(),
      collections: z.array(z.object({ ref: z.string().trim().min(1).max(40), name: shortText(200), description: shortText(1000).optional(),
        languagePair: languagePair.optional() }).strict()).max(PROPOSAL_LIMITS.collections).optional(),
      entries: z.array(z.object({
        action: z.enum(["create", "update", "disable", "enable"]), entryId: id.optional(), revision: z.number().int().positive().safe().optional(),
        collection: knowledgeRef.optional(), kind: z.enum(["term", "rule", "context"]).optional(),
        source: shortText(500).optional(), target: shortText(500).optional(), aliases: z.array(shortText(200)).max(10).optional(), note: shortText(500).optional(),
        strength: z.enum(["preferred", "required", "keep_source"]).optional(),
        text: shortText(2000).optional(), required: z.boolean().optional(),
        basis: z.enum(["user_stated", "user_revision", "document", "agent_inferred", "web"]),
        evidence: shortText(600).optional(), url: shortText(2000).optional(), urlTitle: shortText(300).optional(),
      }).strict()).max(PROPOSAL_LIMITS.entries).optional(),
    }).strict().refine(value => (value.collections?.length ?? 0) + (value.entries?.length ?? 0) > 0, "Prepare at least one collection or entry.") as unknown as z.ZodObject,
    access: "write",
    confirm: "always",
  },
  get_confirmation_result: {
    title: "Wait for the user's confirmation",
    description: "When a tool returned confirmation_pending, the user has not decided yet in FusionKit. Call this with its confirmationId to wait (up to about 45 seconds) "
      + "for the decision; it returns the original tool's result once allowed, declined_by_user, confirmation_expired, or confirmation_pending again. Read only.",
    inputSchema: z.object({ confirmationId: z.string().min(1).max(100) }).strict(),
    access: "read",
  },
  open_fusionkit_page: {
    title: "Show a FusionKit page",
    description: "Switch FusionKit's window to a page so the user can see your work: home, subtitle_studio (studioView documents or transcription), "
      + "translation_knowledge or settings. Changes no data.",
    inputSchema: z.object({
      page: z.enum(["home", "subtitle_studio", "translation_knowledge", "settings"]),
      studioView: z.enum(["documents", "transcription"]).optional(),
    }).strict(),
    access: "read",
  },
} as const satisfies Record<string, ExternalToolDefinition>;

export type ExternalToolName = keyof typeof EXTERNAL_TOOLS;

export function isExternalToolName(name: string): name is ExternalToolName {
  return Object.prototype.hasOwnProperty.call(EXTERNAL_TOOLS, name);
}

export function externalToolDefinition(name: ExternalToolName): ExternalToolDefinition {
  return EXTERNAL_TOOLS[name];
}

/** MCP behaviour hints derived from access, so a client can ask its user before writes. */
export function externalToolAnnotations(definition: Pick<ExternalToolDefinition, "access" | "mayDestroy">) {
  return {
    readOnlyHint: definition.access === "read",
    destructiveHint: definition.access === "destructive" || !!definition.mayDestroy,
    idempotentHint: definition.access === "read",
    openWorldHint: false,
  };
}

/** The tools/list entries: JSON Schema of what a caller may send. */
export function describeExternalTools() {
  return Object.entries(EXTERNAL_TOOLS).map(([name, definition]) => ({
    name,
    title: definition.title,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.inputSchema, { io: "input", target: "draft-7", unrepresentable: "any" }) as { type: "object"; [key: string]: unknown },
    annotations: { title: definition.title, ...externalToolAnnotations(definition) },
  }));
}

/** At most ten "path: message" lines a model can correct its call from. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 10).map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`);
}
