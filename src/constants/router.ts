export const LOCAL_SUBTITLE_TRANSCRIBER_ROUTE =
  "/tools/subtitle/local-transcriber" as const;

export const ToolNameMap: { [key: string]: string } = {
  "/tools/subtitle/translator": "menu.subtitle.translator",
  "/tools/subtitle/converter": "menu.subtitle.converter",
  "/tools/subtitle/extractor": "menu.subtitle.extractor",
  [LOCAL_SUBTITLE_TRANSCRIBER_ROUTE]: "menu.subtitle.local_transcriber",
  "/tools/rename/name-translator": "menu.rename.name_translator",
  "/tools/text/translator": "menu.text.translator",
  "/tools/audio/transcriber": "menu.audio.transcriber",
  "/tools/audio/speech-synthesis": "menu.audio.speech_synthesis",
  "/tools/audio/realtime-captions": "menu.audio.realtime_captions",
  "/tools/audio/realtime-voice": "menu.audio.realtime_voice",
};
