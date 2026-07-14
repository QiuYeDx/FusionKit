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

const AUDIO_TRANSCRIBER_SUBMIT_KEYS = [
  "audio:workspace.audio_api_not_configured.title",
  "audio:workspace.audio_route_not_configured.title",
  "audio:transcriber.errors.file_authorizing",
  "audio:transcriber.errors.no_file",
  "audio:transcriber.errors.file_path_unavailable",
  "audio:transcriber.errors.unsupported_file",
  "audio:transcriber.errors.unsupported_file_for_mimo",
  "audio:transcriber.errors.file_too_large",
  "audio:transcriber.errors.output_dir_required",
];

export const I18N_USAGE_MANIFEST = [
  {
    selector:
      "src/pages/Setting/components/AudioApiConfig.tsx#`setting:fields.audio.route.${routeTranslationKey(definition.key)}`",
    keys: [
      "setting:fields.audio.route.transcription",
      "setting:fields.audio.route.preset_voice",
      "setting:fields.audio.route.realtimeCaptions",
      "setting:fields.audio.route.realtimeVoice",
    ],
  },
  {
    selector: "src/pages/Setting/index.tsx#item.labelKey",
    keys: [
      "setting:nav.general.label",
      "setting:nav.proxy.label",
      "setting:nav.model.label",
      "setting:nav.audio.label",
    ],
  },
  {
    selector: "src/pages/Setting/index.tsx#item.hintKey",
    keys: [
      "setting:nav.general.hint",
      "setting:nav.proxy.hint",
      "setting:nav.model.hint",
      "setting:nav.audio.hint",
    ],
  },
  {
    selector: "src/pages/HomeAgent/index.tsx#opt.labelKey",
    keys: [
      "home:execution_mode_queue_only",
      "home:execution_mode_ask_before_execute",
      "home:execution_mode_auto_execute",
    ],
  },
  {
    selector: "src/pages/Tools/index.tsx#cat.titleKey",
    keys: [
      "tools:subtitle.subtitle_tools",
      "tools:subtitle.music_tools",
      "tools:subtitle.rename_tools",
      "tools:subtitle.text_tools",
      "tools:subtitle.audio_tools",
    ],
  },
  {
    selector: "src/pages/Tools/index.tsx#cat.hintKey",
    keys: [
      "tools:sub_desc.subtitle_tools",
      "tools:sub_desc.music_tools",
      "tools:sub_desc.rename_tools",
      "tools:sub_desc.text_tools",
      "tools:sub_desc.audio_tools",
    ],
  },
  {
    selector: "src/pages/Tools/index.tsx#item.titleKey",
    keys: [
      "tools:fields.subtitle_translator",
      "tools:fields.subtitle_formatter",
      "tools:fields.subtitle_language_extractor",
      "tools:coming_soon.title",
      "tools:fields.name_translator",
      "tools:fields.text_translator",
      "tools:fields.audio_transcriber",
      "tools:fields.speech_synthesizer",
      "tools:fields.realtime_captions",
      "tools:fields.realtime_voice",
    ],
  },
  {
    selector: "src/pages/Tools/index.tsx#item.descKey",
    keys: [
      "tools:field_desc.subtitle_translator",
      "tools:field_desc.subtitle_formatter",
      "tools:field_desc.subtitle_language_extractor",
      "tools:coming_soon.music_desc",
      "tools:field_desc.name_translator",
      "tools:field_desc.text_translator",
      "tools:field_desc.audio_transcriber",
      "tools:field_desc.speech_synthesizer",
      "tools:field_desc.realtime_captions",
      "tools:field_desc.realtime_voice",
    ],
  },
  {
    selector: "src/pages/Tools/index.tsx#c",
    keys: [
      "tools:chips.name_translator_files",
      "tools:chips.name_translator_safe",
      "tools:chips.text_translator_txt",
      "tools:chips.text_translator_markdown",
      "tools:chips.audio_file",
      "tools:chips.openai_mimo",
      "tools:chips.tts_stream",
      "tools:chips.mimo_voice",
      "tools:chips.microphone",
      "tools:chips.realtime",
      "tools:chips.webrtc",
      "tools:chips.duplex",
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
      "common:menu.audio.transcriber",
      "common:menu.audio.speech_synthesis",
      "common:menu.audio.realtime_captions",
      "common:menu.audio.realtime_voice",
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
    selector: "src/pages/Tools/Text/TextTranslator/index.tsx#language.labelKey",
    keys: SUBTITLE_LANGUAGE_KEYS,
  },
  {
    selector:
      "src/pages/Tools/Rename/NameTranslator/components/OptionsPanel.tsx#scope.labelKey",
    keys: [
      "rename:options.scope.self.label",
      "rename:options.scope.children.label",
      "rename:options.scope.descendants.label",
    ],
  },
  {
    selector:
      "src/pages/Tools/Rename/NameTranslator/components/OptionsPanel.tsx#scope.hintKey",
    keys: [
      "rename:options.scope.self.hint",
      "rename:options.scope.children.hint",
      "rename:options.scope.descendants.hint",
    ],
  },
  {
    selector:
      "src/pages/Tools/Rename/NameTranslator/components/RiskConfirmDialog.tsx#`risk_reasons.${reason}`",
    keys: [
      "rename:risk_reasons.directories",
      "rename:risk_reasons.descendants",
      "rename:risk_reasons.path_segments",
      "rename:risk_reasons.large_batch",
      "rename:risk_reasons.warnings",
    ],
  },
  {
    selector: "src/pages/Tools/Audio/shared/AudioToolShell.tsx#titleKey",
    keys: [
      "audio:pages.transcriber.title",
      "audio:pages.speech.title",
      "audio:pages.captions.title",
      "audio:pages.voice.title",
    ],
  },
  {
    selector: "src/pages/Tools/Audio/shared/AudioToolShell.tsx#descriptionKey",
    keys: [
      "audio:pages.transcriber.description",
      "audio:pages.speech.description",
      "audio:pages.captions.description",
      "audio:pages.voice.description",
    ],
  },
  {
    selector: "src/pages/Tools/Audio/shared/AudioToolShell.tsx#workspaceTitleKey",
    keys: [
      "audio:pages.transcriber.workspace",
      "audio:pages.speech.workspace",
      "audio:pages.captions.workspace",
      "audio:pages.voice.workspace",
    ],
  },
  {
    selector:
      "src/pages/Tools/Audio/AudioTranscriber/index.tsx#`audio:transcriber.languages.${language}`",
    keys: [
      "audio:transcriber.languages.auto",
      "audio:transcriber.languages.zh",
      "audio:transcriber.languages.en",
      "audio:transcriber.languages.ja",
      "audio:transcriber.languages.ko",
      "audio:transcriber.languages.fr",
      "audio:transcriber.languages.de",
      "audio:transcriber.languages.es",
    ],
  },
  {
    selector: "src/pages/Tools/Audio/AudioTranscriber/index.tsx#submitIssueKey",
    keys: AUDIO_TRANSCRIBER_SUBMIT_KEYS,
  },
  {
    selector: "src/pages/Tools/Audio/AudioTranscriber/index.tsx#issueKey",
    keys: AUDIO_TRANSCRIBER_SUBMIT_KEYS,
  },
  {
    selector: "src/pages/Tools/Audio/AudioTranscriber/index.tsx#finalIssueKey",
    keys: AUDIO_TRANSCRIBER_SUBMIT_KEYS,
  },
  {
    selector:
      "src/pages/Tools/Audio/AudioTranscriber/index.tsx#`audio:transcriber.status.${status}`",
    keys: [
      "audio:transcriber.status.idle",
      "audio:transcriber.status.running",
      "audio:transcriber.status.completed",
      "audio:transcriber.status.failed",
      "audio:transcriber.status.cancelled",
    ],
  },
  {
    selector:
      "src/pages/Tools/Audio/SpeechSynthesizer/index.tsx#`audio:speech.status.${status}`",
    keys: [
      "audio:speech.status.idle",
      "audio:speech.status.running",
      "audio:speech.status.streaming",
      "audio:speech.status.completed",
      "audio:speech.status.failed",
      "audio:speech.status.cancelled",
    ],
  },
];
