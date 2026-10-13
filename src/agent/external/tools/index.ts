import type { z } from "zod";
import type { EXTERNAL_TOOLS, ExternalToolName } from "../catalog";
import type { ExternalToolContext } from "../errors";
import { readStudioDocument } from "./document";
import { exportStudioDocument } from "./export";
import { importStudioSubtitles } from "./importing";
import { listTranslationKnowledgeCatalog, prepareKnowledgeChanges, searchTranslationKnowledge } from "./knowledge";
import { getConfirmationResult, openFusionkitPage } from "./navigation";
import { getFusionkitStatus } from "./status";
import { listStudioDocuments } from "./studio-documents";
import { getStudioTasks } from "./tasks";
import { startStudioTranscription } from "./transcription";
import { createStudioTranslationTrack, writeStudioTranslations } from "./translation";

export type ExternalToolImplementations = {
  [K in ExternalToolName]: (input: z.output<(typeof EXTERNAL_TOOLS)[K]["inputSchema"]>, ctx: ExternalToolContext) => Promise<unknown>;
};

export const EXTERNAL_TOOL_IMPLEMENTATIONS: ExternalToolImplementations = {
  get_fusionkit_status: getFusionkitStatus,
  list_studio_documents: listStudioDocuments,
  read_studio_document: readStudioDocument,
  import_studio_subtitles: importStudioSubtitles,
  create_studio_translation_track: createStudioTranslationTrack,
  write_studio_translations: writeStudioTranslations,
  export_studio_document: exportStudioDocument,
  start_studio_transcription: startStudioTranscription,
  get_studio_tasks: getStudioTasks,
  search_translation_knowledge: searchTranslationKnowledge,
  list_translation_knowledge_catalog: listTranslationKnowledgeCatalog,
  prepare_knowledge_changes: prepareKnowledgeChanges,
  get_confirmation_result: getConfirmationResult,
  open_fusionkit_page: openFusionkitPage,
};
