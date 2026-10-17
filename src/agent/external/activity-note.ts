import {
  ACTIVITY_ITEMS_KEPT,
  ACTIVITY_TEXT_ACTIONS,
  ACTIVITY_TEXT_LIMIT,
  type ActivityApproval,
  type ActivityNote,
  type ActivitySummary,
} from "./activity";
import type { ExternalToolDefinition } from "./catalog";
import type { ConfirmationDisplay } from "./confirmations";
import type { ExternalTrust } from "./contract";
import type { ExternalToolContext } from "./errors";

const clip = (value: string) => value.slice(0, ACTIVITY_TEXT_LIMIT);

/** The note this call adds to its activity record. */
export function noteOf(ctx: Pick<ExternalToolContext, "note">): ActivityNote {
  return (ctx as { note?: ActivityNote }).note ??= {};
}

/**
 * What the record says the call did, from the same display the dialog shows.
 * Rows of cue edits and translations are cue text: only their values are kept.
 */
export function summaryOf(display: ConfirmationDisplay): ActivitySummary {
  const values = Object.fromEntries(Object.entries(display.values).slice(0, 12)
    .map(([key, value]) => [key.slice(0, 40), typeof value === "string" ? clip(value) : value]));
  const rows = ACTIVITY_TEXT_ACTIONS.has(display.action) ? [] : display.items;
  const items = rows.slice(0, ACTIVITY_ITEMS_KEPT).map(item => ({
    text: clip(item.text), ...(item.detail ? { detail: clip(item.detail) } : {}), ...(item.from ? { from: clip(item.from) } : {}), ...(item.tag ? { tag: item.tag } : {}),
  }));
  return {
    action: display.action, key: display.summary, values,
    ...(display.content ? { content: display.content } : {}), ...(display.warning ? { warning: display.warning } : {}),
    ...(items.length ? { items } : {}), ...(rows.length > items.length ? { more: rows.length - items.length } : {}),
  };
}

/** How a call that did not ask was allowed. */
export function unaskedApproval(trust: ExternalTrust, definition: Pick<ExternalToolDefinition, "access">, granted: boolean): ActivityApproval {
  if (definition.access === "read") return "none";
  if (granted) return "session";
  return trust === "auto" ? "auto" : trust === "full" ? "full" : trust === "custom" ? "permitted" : "none";
}

type Data = Record<string, unknown>;
const record = (value: unknown): Data | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Data : undefined;
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
function documentOf(value: unknown): ActivityNote["target"] {
  const document = record(value);
  const id = typeof document?.documentId === "string" ? document.documentId : undefined;
  return id ? { documentId: id.slice(0, 200), ...(typeof document?.name === "string" ? { documentName: clip(document.name) } : {}) } : undefined;
}
const numbers = (entries: Record<string, unknown>) => {
  const kept = Object.fromEntries(Object.entries(entries).filter(([, value]) => count(value) !== undefined)) as Record<string, number>;
  return Object.keys(kept).length ? kept : undefined;
};

/** Result numbers and references the activity page acts on, read from a tool's result. */
export function deriveNote(tool: string, value: unknown): Pick<ActivityNote, "result" | "target" | "undo" | "outputs"> {
  const data = record(value);
  if (!data) return {};
  const target = documentOf(data.document);
  switch (tool) {
    case "read_studio_document":
    case "create_studio_translation_track":
    case "split_studio_cue":
    case "insert_studio_cue":
      return target ? { target } : {};
    case "write_studio_translations": {
      const result = numbers({ written: data.written, unchanged: data.unchanged });
      return { ...(result ? { result } : {}), ...(target ? { target } : {}) };
    }
    case "import_studio_subtitles": {
      const items = Array.isArray(data.items) ? data.items.map(record) : [];
      const imported = items.filter(item => item?.ok === true);
      const only = imported.length === 1 ? documentOf(imported[0]?.document) : undefined;
      const result = numbers({ imported: data.importedCount, total: data.total });
      return { ...(result ? { result } : {}), ...(only ? { target: only } : {}) };
    }
    case "start_studio_transcription": {
      const result = numbers({ queued: Array.isArray(data.tasks) ? data.tasks.length : undefined });
      return result ? { result } : {};
    }
    case "convert_subtitle_files":
    case "extract_subtitle_language": {
      const files = Array.isArray(data.files) ? data.files.map(record) : [];
      const skipped = files.filter(file => file?.skipped === true).length;
      const failed = files.filter(file => file && file.ok === false && file.skipped !== true).length;
      const outputs = files.map(file => typeof file?.output === "string" && file.output ? file.output.slice(0, 1000) : undefined)
        .filter((path): path is string => !!path).slice(0, ACTIVITY_ITEMS_KEPT);
      const result = numbers({ files: data.written, skipped, failed });
      return { ...(result ? { result } : {}), ...(outputs.length ? { outputs } : {}) };
    }
    case "rename_paths": {
      const result = numbers({ renamed: data.renamed });
      const journalId = typeof data.journalId === "string" ? data.journalId.slice(0, 200) : undefined;
      return { ...(result ? { result } : {}), ...(journalId ? { undo: { kind: "rename" as const, journalId } } : {}) };
    }
    case "undo_name_changes": {
      const result = numbers({ restored: data.restored });
      return result ? { result } : {};
    }
    default:
      return {};
  }
}

export const isEmptyNote = (note: ActivityNote) => Object.values(note).every(value => value === undefined);
