/**
 * Exact translation keys for call sites that TypeScript cannot prove finite.
 *
 * Selectors are `src-relative-file#argument-expression`. Expressions are
 * whitespace-insensitive. Entries are deliberately exact: wildcards and
 * prefix-only exemptions are rejected by the checker, and a selector that no
 * longer matches an unresolved call fails as stale. The listed keys are the
 * reviewed finite runtime contract; reachability of every listed value cannot
 * be inferred from the manifest itself.
 */
const SUBTITLE_LANGUAGE_KEYS = [
  "subtitle:translator.languages.ZH",
  "subtitle:translator.languages.JA",
  "subtitle:translator.languages.EN",
  "subtitle:translator.languages.KO",
  "subtitle:translator.languages.FR",
  "subtitle:translator.languages.DE",
  "subtitle:translator.languages.ES",
  "subtitle:translator.languages.RU",
  "subtitle:translator.languages.PT",
];

/** Page names the assistant may show or send: the home page, registered pages and catalog routes. */
const AGENT_PAGE_TITLE_KEYS = [
  "home:agent_title",
  "studio:title",
  "knowledge:title",
  "tools:fields.subtitle_translator",
  "tools:fields.subtitle_formatter",
  "tools:fields.subtitle_language_extractor",
  "tools:fields.local_subtitle_transcriber",
  "tools:fields.name_translator",
  "tools:fields.text_translator",
  "common:menu.tools",
  "common:menu.setting",
];

/** Languages a workflow template names in its prompt: the target, spoken and kept language choices. */
const TEMPLATE_LANGUAGE_KEYS = [
  "home:templates.lang.ZH",
  "home:templates.lang.ZH_HANT",
  "home:templates.lang.JA",
  "home:templates.lang.EN",
  "home:templates.lang.KO",
];

const TEMPLATE_SEPARATOR_KEYS = [
  "home:templates.separator.dash",
  "home:templates.separator.paren",
  "home:templates.separator.bracket",
  "home:templates.separator.underscore",
  "home:templates.separator.space",
];

/** Questions of the help page's topics (every section but quick start and system requirements). */
const HELP_TOPIC_TITLE_KEYS = [
  "help:sections.cannot_open.mac_unverified_title",
  "help:sections.cannot_open.mac_damaged_title",
  "help:sections.cannot_open.windows_title",
  "help:sections.cannot_open.after_update_title",
  "help:sections.models_and_cost.key_title",
  "help:sections.models_and_cost.deepseek_title",
  "help:sections.models_and_cost.token_title",
  "help:sections.models_and_cost.privacy_title",
  "help:sections.models_and_cost.other_title",
  "help:sections.download_failed.source_title",
  "help:sections.download_failed.safe_title",
  "help:sections.download_failed.check_title",
  "help:sections.transcription_failed.vc_title",
  "help:sections.transcription_failed.disk_title",
  "help:sections.transcription_failed.gpu_title",
  "help:sections.transcription_failed.cpu_title",
  "help:sections.proxy.system_title",
  "help:sections.proxy.clash_title",
  "help:sections.proxy.custom_title",
];

/** Answers of the same topics. */
const HELP_TOPIC_BODY_KEYS = [
  "help:sections.cannot_open.mac_unverified_body",
  "help:sections.cannot_open.mac_damaged_body",
  "help:sections.cannot_open.mac_damaged_note",
  "help:sections.cannot_open.windows_body",
  "help:sections.cannot_open.after_update_body",
  "help:sections.models_and_cost.key_body",
  "help:sections.models_and_cost.deepseek_body",
  "help:sections.models_and_cost.token_body",
  "help:sections.models_and_cost.privacy_body",
  "help:sections.models_and_cost.other_body",
  "help:sections.download_failed.source_body",
  "help:sections.download_failed.safe_body",
  "help:sections.download_failed.check_body",
  "help:sections.transcription_failed.vc_body",
  "help:sections.transcription_failed.disk_body",
  "help:sections.transcription_failed.gpu_body",
  "help:sections.transcription_failed.cpu_body",
  "help:sections.proxy.system_body",
  "help:sections.proxy.clash_body",
  "help:sections.proxy.custom_body",
  "help:sections.proxy.test_body",
  "help:sections.external_agent.body",
];

export const I18N_USAGE_MANIFEST = [
  {
    // Export content and same-name policy of a prepared transcription pipeline (automatic-export-contract).
    selector: "src/pages/HomeAgent/components/AgentPreparedActions.tsx#`home:pipeline_content_${values.exportContent}`",
    keys: ["home:pipeline_content_bilingual", "home:pipeline_content_target", "home:pipeline_content_source"],
  },
  {
    selector: "src/pages/HomeAgent/components/AgentPreparedActions.tsx#`home:pipeline_conflict_${values.exportConflict}`",
    keys: ["home:pipeline_conflict_indexed", "home:pipeline_conflict_overwrite"],
  },
  {
    selector: "src/agent/orchestrator.ts#key",
    keys: AGENT_PAGE_TITLE_KEYS,
  },
  {
    selector: "src/agent/navigation-tools.ts#key",
    keys: AGENT_PAGE_TITLE_KEYS,
  },
  {
    selector: "src/pages/AgentDock/index.tsx#titleKey",
    keys: AGENT_PAGE_TITLE_KEYS,
  },
  {
    selector: "src/pages/AgentDock/index.tsx#item.labelKey",
    keys: ["studio:agent.suggest_fix", "studio:agent.suggest_terms", "studio:agent.suggest_summary", "home:dock.suggest.translator.first", "home:dock.suggest.translator.second", "home:dock.suggest.converter.first", "home:dock.suggest.converter.second", "home:dock.suggest.extractor.first", "home:dock.suggest.extractor.second", "home:dock.suggest.transcriber.first", "home:dock.suggest.transcriber.second", "home:dock.suggest.names.first", "home:dock.suggest.names.second"],
  },
  {
    selector: "src/pages/AgentDock/index.tsx#item.promptKey",
    keys: ["studio:agent.suggest_fix_prompt", "studio:agent.suggest_terms_prompt", "studio:agent.suggest_summary_prompt", "home:dock.suggest.translator.first_prompt", "home:dock.suggest.translator.second_prompt", "home:dock.suggest.converter.first_prompt", "home:dock.suggest.converter.second_prompt", "home:dock.suggest.extractor.first_prompt", "home:dock.suggest.extractor.second_prompt", "home:dock.suggest.transcriber.first_prompt", "home:dock.suggest.transcriber.second_prompt", "home:dock.suggest.names.first_prompt", "home:dock.suggest.names.second_prompt"],
  },
  {
    selector: "src/pages/HomeAgent/conversation.tsx#opt.labelKey",
    keys: [
      "home:execution_mode_queue_only",
      "home:execution_mode_ask_before_execute",
      "home:execution_mode_auto_execute",
    ],
  },
  {
    // The classic and experimental tool tiles of the tools catalog (src/pages/Tools/index.tsx).
    selector: "src/pages/Tools/ToolTile.tsx#item.titleKey",
    keys: [
      "tools:fields.subtitle_translator",
      "tools:fields.subtitle_formatter",
      "tools:fields.subtitle_language_extractor",
      "tools:fields.local_subtitle_transcriber",
      "tools:fields.name_translator",
      "tools:fields.text_translator",
    ],
  },
  {
    selector: "src/pages/Tools/ToolTile.tsx#item.descKey",
    keys: [
      "tools:field_desc.subtitle_translator",
      "tools:field_desc.subtitle_formatter",
      "tools:field_desc.subtitle_language_extractor",
      "tools:field_desc.local_subtitle_transcriber",
      "tools:field_desc.name_translator",
      "tools:field_desc.text_translator",
    ],
  },
  {
    // Only tiles with translateChips pass their chips through t; the others are literal format names.
    selector: "src/pages/Tools/ToolTile.tsx#chip",
    keys: [
      "tools:chips.local_offline",
      "tools:chips.local_batch_formats",
      "tools:chips.name_translator_files",
      "tools:chips.name_translator_safe",
      "tools:chips.text_translator_txt",
      "tools:chips.text_translator_markdown",
    ],
  },
  {
    selector: "src/pages/components/BottomNavigation.tsx#label",
    keys: ["common:menu.home", "common:menu.tools", "common:menu.about", "common:menu.setting"],
  },
  {
    selector: "src/pages/components/BottomNavigation.tsx#currentToolName",
    keys: [
      "common:menu.tools",
      "common:menu.subtitle.translator",
      "common:menu.subtitle.converter",
      "common:menu.subtitle.extractor",
      "common:menu.rename.name_translator",
      "common:menu.text.translator",
    ],
  },
  {
    selector: "src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx#lang.labelKey",
    keys: SUBTITLE_LANGUAGE_KEYS,
  },
  {
    selector: "src/pages/Tools/Subtitle/SubtitleLanguageExtractor/index.tsx#lang.labelKey",
    keys: SUBTITLE_LANGUAGE_KEYS,
  },
  {
    // Language codes reach lang() only from the target, spoken (never "auto" there) and keep selects.
    selector: "src/agent/prompt-templates.ts#K(`lang.${code}`)",
    keys: TEMPLATE_LANGUAGE_KEYS,
  },
  {
    selector: "src/agent/prompt-templates.ts#K(`separator.${text(values,\"separator\")||\"dash\"}`)",
    keys: TEMPLATE_SEPARATOR_KEYS,
  },
  {
    // Form fields of the workflow templates (src/agent/prompt-templates.ts).
    selector: "src/pages/HomeAgent/components/PromptTemplates.tsx#field.labelKey",
    keys: [
      "home:templates.field.folder",
      "home:templates.field.recursive",
      "home:templates.field.target",
      "home:templates.field.spoken",
      "home:templates.field.subtitle_layout",
      "home:templates.field.format",
      "home:templates.field.rename_after",
      "home:templates.field.to_format",
      "home:templates.field.overwrite",
      "home:templates.field.name_kind",
      "home:templates.field.name_layout",
      "home:templates.field.separator",
      "home:templates.field.keep",
    ],
  },
  {
    selector: "src/pages/HomeAgent/components/PromptTemplates.tsx#field.hintKey",
    keys: [
      "home:templates.field.folder_hint",
      "home:templates.field.rename_after_hint",
      "home:templates.field.overwrite_hint",
    ],
  },
  {
    selector: "src/pages/HomeAgent/components/PromptTemplates.tsx#option.labelKey",
    keys: [
      "home:templates.lang.auto",
      ...TEMPLATE_LANGUAGE_KEYS,
      "home:templates.layout.target_first",
      "home:templates.layout.source_first",
      "home:templates.layout.target_only",
      "home:templates.format.auto",
      "home:templates.format.lrc",
      "home:templates.format.srt",
      "home:templates.format.vtt",
      "home:templates.format.ass",
      "home:templates.kind.files",
      "home:templates.kind.directories",
      "home:templates.kind.both",
      "home:templates.name_layout.target_first",
      "home:templates.name_layout.source_first",
      "home:templates.name_layout.target_only",
      ...TEMPLATE_SEPARATOR_KEYS,
    ],
  },
  {
    // Searching and showing the help topics.
    selector: "src/pages/Help/index.tsx#item.titleKey",
    keys: HELP_TOPIC_TITLE_KEYS,
  },
  {
    selector: "src/pages/Help/index.tsx#topic.titleKey",
    keys: HELP_TOPIC_TITLE_KEYS,
  },
  {
    selector: "src/pages/Help/index.tsx#key",
    keys: HELP_TOPIC_BODY_KEYS,
  },
  {
    selector: "src/pages/Help/index.tsx#topics[id].intro!",
    keys: ["help:sections.cannot_open.intro", "help:sections.download_failed.intro"],
  },
];
