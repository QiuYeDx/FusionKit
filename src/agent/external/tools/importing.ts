import type { z } from "zod";
import { documentSummary } from "@/agent/modern-tools";
import type { EXTERNAL_TOOLS } from "../catalog";
import { confirmed, pathItem } from "../confirmations";
import { ExternalToolError, type ExternalToolContext } from "../errors";
import { bounded, rememberRevision, studioApi, unwrapStudio } from "./studio";

type ImportInput = z.output<typeof EXTERNAL_TOOLS.import_studio_subtitles.inputSchema>;

export async function importStudioSubtitles(input: ImportInput, ctx: ExternalToolContext) {
  return confirmed(ctx, "import_studio_subtitles", { action: "import", summary: "import", values: { count: input.paths.length }, items: input.paths.map(pathItem) }, async () => {
    const result = unwrapStudio(await studioApi().importSubtitlePaths({ encoding: input.encoding, paths: input.paths, ...(input.recursive ? { recursive: true } : {}) }));
    if (!result.items.length) throw new ExternalToolError("no_subtitles_found");
    const items = result.items.slice(0, 100).map(item => {
      if (!item.ok) return { ok: false, name: bounded(item.fileName), error: item.error };
      rememberRevision(item.document);
      return { ok: true, document: documentSummary(item.document) };
    });
    return { importedCount: result.items.filter(item => item.ok).length, total: result.items.length, items, truncated: result.items.length > 100 };
  });
}
