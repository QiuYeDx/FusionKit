import type { z } from "zod";
import { documentSummary } from "@/agent/modern-tools";
import { cueHistory } from "@/services/subtitle-studio/cue-history";
import type { SubtitleText } from "@/subtitle-studio/domain";
import type { EXTERNAL_TOOLS } from "../catalog";
import { confirmed } from "../confirmations";
import { ExternalToolError, type ExternalToolContext } from "../errors";
import { agentText, bounded, readPageAt, rememberRevision, studioApi, unwrapStudio, withCurrentRevision } from "./studio";

type CreateInput = z.output<typeof EXTERNAL_TOOLS.create_studio_translation_track.inputSchema>;
type WriteInput = z.output<typeof EXTERNAL_TOOLS.write_studio_translations.inputSchema>;

export async function createStudioTranslationTrack(input: CreateInput, ctx: ExternalToolContext) {
  const page = await readPageAt(input.documentId, input.revision, ctx);
  const agentName = bounded(ctx.client.name.trim() || "external agent", 100);
  const name = input.name ?? agentName;
  return confirmed(ctx, "create_studio_translation_track", {
    action: "translation", summary: "create_track",
    values: { document: page.summary.origin.displayName, track: name, language: input.language }, items: [{ text: name, detail: `${page.summary.origin.displayName} · ${input.language}` }],
  }, () => withCurrentRevision(input.documentId, ctx, async () => {
    const created = unwrapStudio(await studioApi().createAgentTranslationTrack({
      documentId: input.documentId, revision: input.revision, language: input.language, ...(input.name ? { name: input.name } : {}), agent: { name: agentName },
    }));
    rememberRevision(created.summary);
    return { trackId: created.trackId, revision: created.summary.revision, document: documentSummary(created.summary) };
  }));
}

export async function writeStudioTranslations(input: WriteInput, ctx: ExternalToolContext) {
  // Every text is checked before anything is written or asked.
  const targets: Record<string, SubtitleText> = {};
  const problems: { cueId: string; problem: string }[] = [];
  for (const item of input.translations) {
    const checked = agentText(item.text);
    if ("problem" in checked) problems.push({ cueId: item.cueId, problem: checked.problem });
    else targets[item.cueId] = checked.text;
  }
  if (problems.length) {
    throw new ExternalToolError("invalid_translation_text", { problems: problems.slice(0, 50),
      hint: "empty = no text; markup = contains < or >; characters = control characters; too_long = over 64 KiB. Nothing was written." });
  }
  const page = await readPageAt(input.documentId, input.revision, ctx);
  const track = page.translationTracks.find(item => item.id === input.trackId);
  if (!track) throw new ExternalToolError("track_not_found");
  if (!track.agent) throw new ExternalToolError("track_not_writable", { hint: "Create your own track with create_studio_translation_track." });
  const texts = Object.values(targets).map(text => text.plain);
  return confirmed(ctx, "write_studio_translations", {
    action: "translation", summary: "write_translations",
    values: { count: texts.length, document: page.summary.origin.displayName, track: track.name ?? track.language }, items: texts.map(text => ({ text })),
  }, () => withCurrentRevision(input.documentId, ctx, async () => {
    let result;
    try {
      result = unwrapStudio(await studioApi().editCues({ documentId: input.documentId, revision: input.revision, operation: { kind: "agent", trackId: input.trackId, targets } }));
    } catch (error) {
      if (error instanceof ExternalToolError && error.code === "invalid_input") {
        throw new ExternalToolError("invalid_input", { hint: "Every cueId must come from read_studio_document for this document." });
      }
      throw error;
    }
    rememberRevision(result.summary);
    // One undo step in Subtitle Studio, like an edit made on the page.
    if (result.changed) cueHistory.record(input.documentId, input.revision, result.summary.revision, { label: "agent", count: result.changed, operation: result.undo });
    return { revision: result.summary.revision, written: result.changed, unchanged: texts.length - result.changed, document: documentSummary(result.summary) };
  }));
}
