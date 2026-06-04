import type {
  NameTranslationModelInputItem,
  NameTranslationOptions,
} from "./nameTypes";

const LANGUAGE_LABELS: Record<string, string> = {
  auto: "auto-detected source language",
  ZH: "Chinese",
  JA: "Japanese",
  EN: "English",
  KO: "Korean",
  FR: "French",
  DE: "German",
  ES: "Spanish",
  RU: "Russian",
  PT: "Portuguese",
};

export function buildNameTranslationSystemPrompt(
  options: NameTranslationOptions
): string {
  return [
    "You translate file and folder basename stems for a batch rename preview.",
    'Return exactly one JSON object with this shape: {"items":[{"id":"...","translatedStem":"..."}]}.',
    "Do not wrap the JSON in markdown. Do not include explanations outside the schema.",
    "Translate only natural-language parts of each stem.",
    "Filenames may contain Japanese, emojis, #, brackets, underscores, and repeated punctuation; treat these as normal input, not as parsing errors.",
    "Always return one item for every input id, even when parts of the name should stay unchanged.",
    "Keep season/episode numbers, years, resolutions, codecs, release tags, bracketed group tags, and technical tokens unchanged unless they are natural language.",
    "Never output a file extension. The application appends the original extension.",
    'Do not output path separators or illegal filename characters: / \\ : * ? " < > |.',
    `Source language: ${LANGUAGE_LABELS[options.sourceLang] ?? options.sourceLang}.`,
    `Target language: ${LANGUAGE_LABELS[options.targetLang] ?? options.targetLang}.`,
    `Naming style: ${options.namingStyle}.`,
  ].join("\n");
}

export function buildNameTranslationUserPrompt(
  items: NameTranslationModelInputItem[]
): string {
  return JSON.stringify(
    {
      instructions: [
        "Return a single JSON object only.",
        "For every input item, return exactly one item with the same id and translatedStem.",
        "translatedStem must not include the extension.",
        "Special symbols and brackets are normal filename characters; keep or translate them according to the naming rules.",
      ],
      items,
    },
    null,
    2
  );
}
