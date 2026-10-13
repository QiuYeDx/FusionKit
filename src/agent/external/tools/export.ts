import type { z } from "zod";
import { defaultExportFormat } from "@/subtitle-studio/export-defaults";
import type { ExportOptions, ExportPlanSummary } from "@/subtitle-studio/export-contract";
import type { EXTERNAL_TOOLS } from "../catalog";
import { confirmed } from "../confirmations";
import { checkActive, ExternalToolError, type ExternalToolContext } from "../errors";
import { readPageAt, studioApi, unwrapStudio, withCurrentRevision } from "./studio";

type ExportInput = z.output<typeof EXTERNAL_TOOLS.export_studio_document.inputSchema>;

/** The Studio export dialog's defaults, with the agent's choices. */
export function exportOptions(input: ExportInput, origin: { format: string; displayName: string }, trackId: string | undefined): ExportOptions {
  const format = input.format === "auto" ? defaultExportFormat(origin) : input.format;
  return {
    mode: input.content, format, ...(input.content !== "source" && trackId ? { trackId } : {}),
    fileNameSuffix: { mode: "none" }, order: input.order, encoding: "utf-8", bom: false, newline: "lf",
    incomplete: input.incomplete, conflictPolicy: input.conflict, stripMediaExt: true,
    // LRC lines have no end; other formats take the next line's start (and 2 s for the last).
    missingEnd: format === "lrc" ? { mode: "block" } : { mode: "next-start", finalDurationMs: 2000 },
  };
}

const issueList = (plan: ExportPlanSummary) => plan.issues.map(issue => ({ code: issue.code, count: issue.count, blocking: issue.blocking }));

export async function exportStudioDocument(input: ExportInput, ctx: ExternalToolContext) {
  const page = await readPageAt(input.documentId, input.revision, ctx);
  let trackId = input.trackId;
  if (input.content !== "source") {
    trackId ??= page.translationTracks.at(-1)?.id;
    if (!trackId) throw new ExternalToolError("no_translation_track", { hint: "Create and fill a track first, or export content=source." });
    if (!page.translationTracks.some(track => track.id === trackId)) throw new ExternalToolError("track_not_found");
  }
  const options = exportOptions(input, page.summary.origin, trackId);
  const plan = async () => {
    const value = unwrapStudio(await studioApi().planExport({ documentId: input.documentId, revision: input.revision, options }));
    checkActive(ctx);
    if (!value.planId || value.issues.some(issue => issue.blocking)) throw new ExternalToolError("export_blocked", { issues: issueList(value) });
    if (input.destination === "source_directory" && value.sourceLocation?.status !== "ready") {
      throw new ExternalToolError("source_directory_unavailable", { hint: "The original file's folder is not available; use destination choose_location." });
    }
    return value;
  };
  const preview = await withCurrentRevision(input.documentId, ctx, plan);
  const overwrite = input.conflict === "overwrite";
  return confirmed(ctx, "export_studio_document", {
    action: "export", summary: input.destination === "source_directory" ? "export_source" : "export_choose",
    values: { document: page.summary.origin.displayName, format: options.format.toUpperCase(), file: preview.fileName }, content: input.content,
    items: [{ text: preview.fileName }], ...(overwrite ? { warning: "overwrite" as const } : {}),
  }, () => withCurrentRevision(input.documentId, ctx, async () => {
    // Planned again: the user may have taken a while, and plans belong to the moment they were made.
    const current = await plan();
    const accepted = current.issues.filter(issue => issue.confirmation).map(issue => issue.code);
    const result = unwrapStudio(await studioApi().exportDocument({ documentId: input.documentId, revision: input.revision, planId: current.planId!, acceptedLosses: accepted,
      destination: input.destination === "source_directory" ? "source-directory" : "choose-location" }));
    if (!result) throw new ExternalToolError("export_cancelled_by_user");
    return { fileName: result.fileName, revision: result.revision, partial: result.partial, content: result.mode, format: options.format,
      destination: input.destination, acceptedLosses: current.issues.filter(issue => issue.confirmation).map(issue => ({ code: issue.code, count: issue.count })) };
  }), { destructive: overwrite });
}
