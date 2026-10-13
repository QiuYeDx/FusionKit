import type { z } from "zod";
import { documentSummary } from "@/agent/modern-tools";
import type { DocumentPage } from "@/subtitle-studio/ipc-contract";
import type { EXTERNAL_TOOLS } from "../catalog";
import { ExternalToolError, type ExternalToolContext } from "../errors";
import { bounded, readCurrentPage } from "./studio";

type ReadInput = z.output<typeof EXTERNAL_TOOLS.read_studio_document.inputSchema>;

export function trackSummary(track: DocumentPage["translationTracks"][number]) {
  return {
    trackId: track.id, language: bounded(track.language, 35), ...(track.name ? { name: bounded(track.name, 100) } : {}),
    origin: track.origin ?? null, writtenBy: track.agent ? bounded(track.agent.name, 100) : null,
    // Only tracks an external agent made take write_studio_translations.
    writable: !!track.agent,
  };
}

export async function readStudioDocument(input: ReadInput, ctx: ExternalToolContext) {
  const page = await readCurrentPage(input.documentId, input.offset, ctx);
  const track = input.trackId ? page.translationTracks.find(item => item.id === input.trackId) : undefined;
  if (input.trackId && !track) throw new ExternalToolError("track_not_found");
  const cues = page.cues.slice(0, input.limit).map((cue, index) => {
    const entry = track?.entries[cue.id];
    return {
      cueId: cue.id, index: input.offset + index, startMs: cue.timing.startMs, endMs: cue.timing.endMs, text: cue.source.plain,
      ...(track ? { translation: entry ? { text: entry.text.plain, origin: entry.origin, reviewed: entry.reviewStatus === "reviewed", stale: entry.sourceRevision !== cue.sourceRevision } : null } : {}),
    };
  });
  const next = input.offset + cues.length;
  return {
    document: documentSummary(page.summary),
    tracks: page.translationTracks.map(trackSummary),
    offset: input.offset, nextOffset: cues.length && next < page.summary.cueCount ? next : null,
    cues,
  };
}
