export const LOCAL_SUBTITLE_TRANSCRIBER_ROUTE =
  "/tools/subtitle/local-transcriber" as const;

export const ToolNameMap: { [key: string]: string } = {
  "/tools/translation-knowledge": "knowledge:title",
  "/tools/subtitle/studio": "studio:title",
  "/tools/subtitle/translator": "menu.subtitle.translator",
  "/tools/subtitle/converter": "menu.subtitle.converter",
  "/tools/subtitle/extractor": "menu.subtitle.extractor",
  [LOCAL_SUBTITLE_TRANSCRIBER_ROUTE]: "menu.subtitle.local_transcriber",
  "/tools/rename/name-translator": "menu.rename.name_translator",
  "/tools/text/translator": "menu.text.translator",
  "/external-agent": "setting:external_agent.activity.title",
};
