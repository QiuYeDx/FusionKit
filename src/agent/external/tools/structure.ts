import type { z } from "zod";
import { documentSummary } from "@/agent/modern-tools";
import { cueHistory } from "@/services/subtitle-studio/cue-history";
import { LIMITS, type SubtitleText } from "@/subtitle-studio/domain";
import type { DocumentPage } from "@/subtitle-studio/ipc-contract";
import { editedText, type CueEditOperation } from "@/subtitle-studio/cue-edit-contract";
import { insertTimeProblem, splitHalves, splitOffsetAt } from "@/subtitle-studio/cue-split";
import type { EXTERNAL_TOOLS } from "../catalog";
import { confirmed } from "../confirmations";
import { checkActive, ExternalToolError, type ExternalToolContext } from "../errors";
import { agentText, readPageAt, rememberRevision, studioApi, unwrapStudio, withCurrentRevision } from "./studio";

type SplitInput = z.output<typeof EXTERNAL_TOOLS.split_studio_cue.inputSchema>;
type InsertInput = z.output<typeof EXTERNAL_TOOLS.insert_studio_cue.inputSchema>;
type Cue = DocumentPage["cues"][number];

/** 00:01:02.300, as Subtitle Studio shows times. */
export function clock(ms: number): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

/**
 * The cue a split or insert adds, read from the edit's undo: undoing an insert deletes the new cue,
 * and undoing a split starts by deleting it.
 */
export function addedCueId(undo: CueEditOperation): string | undefined {
  const first = undo.kind === "batch" ? undo.operations[0] : undo;
  return first?.kind === "delete" ? first.cueIds[0] : undefined;
}

/**
 * A cue at the agent's revision, with its position, the cues on both sides and the document's
 * translation tracks. Pages are read in order until the cue turns up.
 */
async function locateCue(documentId: string, revision: number, cueId: string, ctx: ExternalToolContext) {
  const read = (offset: number) => studioApi().readDocumentPage({ documentId, revision, offset }).then(unwrapStudio);
  let page = await readPageAt(documentId, revision, ctx);
  const total = page.summary.cueCount;
  for (let offset = 0; offset < total; offset += LIMITS.pageSize) {
    if (offset !== page.offset) { page = await read(offset); checkActive(ctx); }
    const position = page.cues.findIndex(cue => cue.id === cueId);
    if (position < 0) continue;
    const index = page.offset + position;
    const at = async (target: number): Promise<Cue | undefined> => {
      if (target < 0 || target >= total) return undefined;
      if (target >= page.offset && target < page.offset + page.cues.length) return page.cues[target - page.offset];
      const other = await read(Math.floor(target / LIMITS.pageSize) * LIMITS.pageSize);
      checkActive(ctx);
      return other.cues[target - other.offset];
    };
    return { page, cue: page.cues[position], index, previous: await at(index - 1), next: await at(index + 1) };
  }
  throw new ExternalToolError("cue_not_found", { hint: "Use a cueId from read_studio_document for this revision." });
}

/** A translation for the agent's own track: checked text, or why it cannot be written. */
function ownTrackText(page: DocumentPage, trackId: string, values: string[]): SubtitleText[] {
  const track = page.translationTracks.find(item => item.id === trackId);
  if (!track) throw new ExternalToolError("track_not_found");
  if (!track.agent) throw new ExternalToolError("track_not_writable", { hint: "Create your own track with create_studio_translation_track." });
  return values.map(value => {
    const checked = agentText(value);
    if ("problem" in checked) throw new ExternalToolError("invalid_translation_text", { problem: checked.problem });
    return checked.text;
  });
}

async function applyStructure(documentId: string, revision: number, operation: CueEditOperation, label: "split" | "insert") {
  const result = unwrapStudio(await studioApi().editCues({ documentId, revision, operation }));
  rememberRevision(result.summary);
  // One undo step in Subtitle Studio, like a split or insert made on the page.
  cueHistory.record(documentId, revision, result.summary.revision, { label, count: 1, operation: result.undo });
  return result;
}

export async function splitStudioCue(input: SplitInput, ctx: ExternalToolContext) {
  const { page, cue, index } = await locateCue(input.documentId, input.revision, input.cueId, ctx);
  const offset = splitOffsetAt(cue.source.plain, input.splitBefore, input.occurrence);
  if (offset === null) {
    throw new ExternalToolError("invalid_split", { hint: "splitBefore must be text the second part starts with, found once in the cue's source text (or pass occurrence), and both parts must keep some text." });
  }
  const [first, second] = splitHalves(cue.source.plain, offset);
  const end = cue.timing.endMs;
  let splitMs: number, basis: "words" | "proportional" | "given";
  if (input.splitMs !== undefined) {
    if (input.splitMs <= cue.timing.startMs || (end !== null && input.splitMs >= end)) throw new ExternalToolError("invalid_time", { hint: "splitMs must be after the cue's start and before its end." });
    splitMs = input.splitMs; basis = "given";
  } else {
    ({ splitMs, basis } = unwrapStudio(await studioApi().suggestCueSplit({ documentId: input.documentId, revision: input.revision, cueId: cue.id, offset })));
    checkActive(ctx);
  }
  const targets = input.translations ? ownTrackText(page, input.translations.trackId, [input.translations.first, input.translations.second]) : undefined;
  return confirmed(ctx, "split_studio_cue", {
    action: "structure", summary: "split_cue",
    values: { document: page.summary.origin.displayName, number: index + 1, time: clock(splitMs) },
    items: [
      { text: first, detail: `${clock(cue.timing.startMs)} → ${clock(splitMs)}` },
      { text: second, detail: `${clock(splitMs)} → ${end === null ? "…" : clock(end)}` },
    ],
  }, () => withCurrentRevision(input.documentId, ctx, async () => {
    const result = await applyStructure(input.documentId, input.revision, { kind: "split", cueId: cue.id, splitMs,
      sources: [editedText(cue.source, first), editedText(cue.source, second)],
      ...(targets ? { trackId: input.translations!.trackId, targets: targets as [SubtitleText, SubtitleText] } : {}) }, "split");
    return { revision: result.summary.revision, cueId: addedCueId(result.undo), splitMs, basis, document: documentSummary(result.summary) };
  }));
}

export async function insertStudioCue(input: InsertInput, ctx: ExternalToolContext) {
  const { page, cue, index, previous, next } = await locateCue(input.documentId, input.revision, input.cueId, ctx);
  const checked = agentText(input.text);
  if ("problem" in checked) throw new ExternalToolError("invalid_text", { problem: checked.problem });
  const format = page.summary.origin.format;
  const media = format === "media" && "durationMs" in page.summary.origin ? page.summary.origin.durationMs : undefined;
  const before = input.position === "after" ? cue : previous, after = input.position === "after" ? next : cue;
  const problem = insertTimeProblem({ startMs: input.startMs, endMs: input.endMs, previousStartMs: before?.timing.startMs, nextStartMs: after?.timing.startMs,
    allowUnknownEnd: format !== "media" && (format === "lrc" || cue.timing.endMs === null), mediaDurationMs: media });
  if (problem) throw new ExternalToolError("invalid_time", { problem });
  const target = input.translation ? ownTrackText(page, input.translation.trackId, [input.translation.text])[0] : undefined;
  const time = `${clock(input.startMs)} → ${input.endMs === null ? "…" : clock(input.endMs)}`;
  return confirmed(ctx, "insert_studio_cue", {
    action: "structure", summary: input.position === "after" ? "insert_cue_after" : "insert_cue_before",
    values: { document: page.summary.origin.displayName, number: index + 1, time },
    items: [{ text: checked.text.plain, detail: target ? `${time} · ${target.plain}` : time }],
  }, () => withCurrentRevision(input.documentId, ctx, async () => {
    const result = await applyStructure(input.documentId, input.revision, { kind: "insert", cueId: cue.id, position: input.position,
      timing: { startMs: input.startMs, endMs: input.endMs }, source: checked.text, ...(target ? { trackId: input.translation!.trackId, target } : {}) }, "insert");
    return { revision: result.summary.revision, cueId: addedCueId(result.undo), document: documentSummary(result.summary) };
  }));
}
