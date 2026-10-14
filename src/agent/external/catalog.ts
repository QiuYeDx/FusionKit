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
export type ExternalApprovalGroup = "studio_import" | "studio_translation" | "studio_structure" | "studio_export" | "studio_transcription" | "classic_files";

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
const classicPaths = z.array(z.string().min(1).max(4096).refine(value => !value.includes("\0"))).min(1).max(50);

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
  split_studio_cue: {
    title: "Split a cue",
    description: "Split one cue of a Subtitle Studio document in two, when it holds two sentences. Give the words the second part starts with, copied exactly from the cue's source text "
      + "(and occurrence when they appear more than once). splitMs (milliseconds) is when the second part starts; leave it out to use the word timing of a transcript or the share of the text. "
      + "This changes the cues every track shares: other tracks keep their translation on the first part, marked as made for an older source. "
      + "translations splits the translation on your own track the same way. Returns the new revision, the new cue's id, splitMs and how it was chosen. "
      + "One undoable edit in Subtitle Studio; may ask the user in FusionKit first (they can allow structure changes for the rest of this connection).",
    inputSchema: z.object({
      documentId: id,
      revision,
      cueId: id,
      splitBefore: z.string().min(1).max(200).describe("The text the second part starts with, as it appears in the cue's source text."),
      occurrence: z.number().int().min(1).max(100).optional().describe("Which appearance of splitBefore, from 1, when it appears more than once."),
      splitMs: z.number().int().min(0).max(86_400_000).optional(),
      translations: z.object({ trackId: id, first: shortText(20000), second: shortText(20000) }).strict().optional()
        .describe("The two parts of the translation on a track you created with create_studio_translation_track."),
    }).strict(),
    access: "write",
    group: "studio_structure",
  },
  insert_studio_cue: {
    title: "Insert a cue",
    description: "Insert a new cue before or after one in a Subtitle Studio document, when a line is missing. Times are in milliseconds: the start may not be before the start of the cue "
      + "before it or after the start of the cue after it; endMs may be null only in LRC documents (or next to a cue without an end); a transcript's lines end within its media. "
      + "Plain text only, no < or >. translation writes its translation on your own track. Returns the new revision and the new cue's id. "
      + "One undoable edit in Subtitle Studio; may ask the user in FusionKit first (they can allow structure changes for the rest of this connection).",
    inputSchema: z.object({
      documentId: id,
      revision,
      cueId: id.describe("The cue to insert next to."),
      position: z.enum(["before", "after"]),
      startMs: z.number().int().min(0).max(86_400_000),
      endMs: z.number().int().min(0).max(86_400_000).nullable(),
      text: shortText(20000),
      translation: z.object({ trackId: id, text: shortText(20000) }).strict().optional(),
    }).strict(),
    access: "write",
    group: "studio_structure",
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
  convert_subtitle_files: {
    title: "Convert subtitle files",
    description: "Convert subtitle files to another format (SRT, VTT, LRC, ASS, SSA, SBV) with FusionKit's subtitle converter, without Subtitle Studio. "
      + "paths are absolute files or folders (recursive includes subfolders); files are read as UTF-8, at most 200 per call. The output goes next to each file, or to outputDirectory. "
      + "conflict indexed adds a number to an existing name; overwrite replaces it (always confirmed by the user). Files already in the target format are skipped. "
      + "Returns each file's output path or error. May ask the user in FusionKit first (they can allow conversions for the rest of this connection).",
    inputSchema: z.object({
      paths: classicPaths,
      to: z.enum(["srt", "vtt", "lrc", "ass", "ssa", "sbv"]),
      recursive: z.boolean().default(false),
      outputDirectory: z.string().min(1).max(4096).optional().describe("An absolute folder; by default each output goes next to its file."),
      conflict: z.enum(["indexed", "overwrite"]).default("indexed"),
      lrcLastDurationMs: z.number().int().min(100).max(60_000).default(2000).describe("From LRC: how long the last line lasts, since LRC has no end times."),
    }).strict(),
    access: "write",
    group: "classic_files",
    mayDestroy: true,
  },
  extract_subtitle_language: {
    title: "Extract one language from bilingual subtitles",
    description: "Keep one language of bilingual subtitle files (two languages in each cue) and write a new file in the same format, with FusionKit's language extractor. "
      + "Works best for Chinese and Japanese. paths, recursive, outputDirectory and conflict work as in convert_subtitle_files. "
      + "Returns each file's output path or error. May ask the user in FusionKit first (they can allow this for the rest of this connection).",
    inputSchema: z.object({
      paths: classicPaths,
      keep: z.enum(["zh", "ja", "en", "ko", "fr", "de", "es", "ru", "pt"]),
      recursive: z.boolean().default(false),
      outputDirectory: z.string().min(1).max(4096).optional(),
      conflict: z.enum(["indexed", "overwrite"]).default("indexed"),
    }).strict(),
    access: "write",
    group: "classic_files",
    mayDestroy: true,
  },
  get_classic_tasks: {
    title: "Classic tool tasks",
    description: "Read the tasks the user queued in FusionKit's classic tool pages (subtitle translator, converter, language extractor): file name, status, progress, "
      + "output path when done and the error when failed. Queued or running is not finished. Read only.",
    inputSchema: z.object({ tool: z.enum(["all", "subtitle_translator", "subtitle_converter", "subtitle_extractor"]).default("all") }).strict(),
    access: "read",
  },
  inspect_name_paths: {
    title: "Inspect files and folders to rename",
    description: "List files and folders for renaming: path, current name, kind and an identity that rename_paths needs. includeChildren also lists everything inside folders "
      + "(at most 2000 entries). Protected system paths and missing paths come back in rejected. Read only.",
    inputSchema: z.object({
      paths: classicPaths,
      includeChildren: z.boolean().default(false),
      includeHidden: z.boolean().default(false),
    }).strict(),
    access: "read",
  },
  rename_paths: {
    title: "Rename files and folders",
    description: "Rename files and folders to names you give, for example names you translated yourself (FusionKit uses no model for this). "
      + "Use path, kind and identity from inspect_name_paths; newName is the new name only (with the extension for files), never a path. At most 500 per call. "
      + "FusionKit checks the names first (illegal characters, names that already exist, two entries with one name, entries changed since inspection) and returns the issues without renaming anything. "
      + "Then the user always confirms the list in FusionKit; renaming runs deepest first and rolls back on failure. Returns a journalId for undo_name_changes.",
    inputSchema: z.object({
      items: z.array(z.object({ path: z.string().min(1).max(4096), kind: z.enum(["file", "directory"]), identity: z.string().min(1).max(128), newName: z.string().max(255) }).strict())
        .min(1).max(500).refine(items => new Set(items.map(item => item.path)).size === items.length, "Each path may appear once."),
    }).strict(),
    access: "write",
    confirm: "always",
  },
  undo_name_changes: {
    title: "Undo a rename",
    description: "Put back the names a rename_paths call changed, by its journalId. The user always confirms in FusionKit.",
    inputSchema: z.object({ journalId: z.string().min(1).max(128) }).strict(),
    access: "write",
    confirm: "always",
  },
  open_fusionkit_page: {
    title: "Show a FusionKit page",
    description: "Switch FusionKit's window to a page so the user can see your work: home, subtitle_studio (studioView documents or transcription), "
      + "translation_knowledge, settings, or a classic tool page (subtitle_translator, subtitle_converter, subtitle_extractor, name_translator, local_subtitle_transcriber, text_translator). Changes no data.",
    inputSchema: z.object({
      page: z.enum(["home", "subtitle_studio", "translation_knowledge", "settings", "subtitle_translator", "subtitle_converter", "subtitle_extractor", "name_translator", "local_subtitle_transcriber", "text_translator"]),
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
