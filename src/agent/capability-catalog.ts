import { LOCAL_SUBTITLE_TRANSCRIBER_ROUTE } from "@/constants/router";

export type AgentCapabilityKey = "subtitleStudio" | "translationKnowledge" | "translator" | "converter" | "extractor" | "localSubtitleTranscriber" | "nameTranslator";
export interface AgentCapability {
  readonly toolKey: AgentCapabilityKey;
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly route: string;
  readonly operations: readonly string[];
}

/** Product scope follows the catalog's featured/classic sections, not page readiness. */
export const AGENT_CAPABILITIES = [
  { toolKey: "subtitleStudio", titleKey: "studio:title", descriptionKey: "tools:field_desc.subtitle_studio", route: "/tools/subtitle/studio",
    operations: ["list_studio_documents", "import_studio_subtitles", "prepare_studio_translation", "prepare_studio_transcription", "get_studio_tasks"] },
  { toolKey: "translationKnowledge", titleKey: "knowledge:title", descriptionKey: "tools:catalog.knowledge_description", route: "/tools/translation-knowledge", operations: ["search_translation_knowledge"] },
  { toolKey: "translator", titleKey: "tools:fields.subtitle_translator", descriptionKey: "tools:field_desc.subtitle_translator", route: "/tools/subtitle/translator", operations: ["queue_subtitle_translate", "scan_subtitle_recovery_tasks", "queue_recovered_subtitle_translate", "get_classic_subtitle_tasks"] },
  { toolKey: "converter", titleKey: "tools:fields.subtitle_formatter", descriptionKey: "tools:field_desc.subtitle_formatter", route: "/tools/subtitle/converter", operations: ["scan_subtitle_files", "queue_subtitle_convert", "get_classic_subtitle_tasks"] },
  { toolKey: "extractor", titleKey: "tools:fields.subtitle_language_extractor", descriptionKey: "tools:field_desc.subtitle_language_extractor", route: "/tools/subtitle/extractor", operations: ["scan_subtitle_files", "queue_subtitle_extract", "get_classic_subtitle_tasks"] },
  { toolKey: "localSubtitleTranscriber", titleKey: "tools:fields.local_subtitle_transcriber", descriptionKey: "tools:field_desc.local_subtitle_transcriber", route: LOCAL_SUBTITLE_TRANSCRIBER_ROUTE, operations: ["get_local_transcription_status", "configure_local_transcription"] },
  { toolKey: "nameTranslator", titleKey: "tools:fields.name_translator", descriptionKey: "tools:field_desc.name_translator", route: "/tools/rename/name-translator", operations: ["inspect_rename_paths", "create_name_translation_plan", "apply_name_translation_plan"] },
] as const satisfies readonly AgentCapability[];
