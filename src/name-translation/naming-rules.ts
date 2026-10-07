import {
  NAME_TRANSLATION_LIMITS,
  type NameEntryKind,
  type NameIssueCode,
  type NameLanguage,
} from "./contract";

/**
 * Pure naming rules shared by the renderer (live feedback) and the main
 * process (authoritative validation). Keep this module free of Node and DOM
 * APIs so both sides apply exactly the same rules.
 */

/** Legacy preset names, still accepted from HomeAgent tool calls. */
export type NameFormat = "translated" | "translated_original" | "original_translated";

export const NAME_FORMATS: readonly NameFormat[] = [
  "translated",
  "translated_original",
  "original_translated",
];

export const TRANSLATED_TOKEN = "{translated}";
export const ORIGINAL_TOKEN = "{original}";
export const DEFAULT_NAME_TEMPLATE = TRANSLATED_TOKEN;
export const MAX_NAME_TEMPLATE_CHARS = 120;

export type BilingualOrder = "translated_first" | "original_first";
export type BilingualStyle = "paren" | "bracket" | "dash" | "underscore" | "space";
export const BILINGUAL_STYLES: readonly BilingualStyle[] = ["paren", "bracket", "dash", "underscore", "space"];

const BILINGUAL_PATTERNS: Record<BilingualStyle, (first: string, second: string) => string> = {
  paren: (first, second) => `${first} (${second})`,
  bracket: (first, second) => `${first} [${second}]`,
  dash: (first, second) => `${first} - ${second}`,
  underscore: (first, second) => `${first}_${second}`,
  space: (first, second) => `${first} ${second}`,
};

export function bilingualTemplate(style: BilingualStyle, order: BilingualOrder): string {
  const [first, second] =
    order === "translated_first" ? [TRANSLATED_TOKEN, ORIGINAL_TOKEN] : [ORIGINAL_TOKEN, TRANSLATED_TOKEN];
  return BILINGUAL_PATTERNS[style](first, second);
}

export function legacyFormatTemplate(format: NameFormat): string {
  if (format === "translated_original") return bilingualTemplate("paren", "translated_first");
  if (format === "original_translated") return bilingualTemplate("paren", "original_first");
  return DEFAULT_NAME_TEMPLATE;
}

export type NameTemplateError = "missing_translated" | "illegal_chars" | "too_long";

/** A template must keep the translation and may only add filename-safe text. */
export function getTemplateError(template: string): NameTemplateError | null {
  if (!template.includes(TRANSLATED_TOKEN)) return "missing_translated";
  if (template.length > MAX_NAME_TEMPLATE_CHARS) return "too_long";
  const literal = template.split(TRANSLATED_TOKEN).join("").split(ORIGINAL_TOKEN).join("");
  if (ILLEGAL_CHARS.test(literal) || CONTROL_CHARS.test(literal)) return "illegal_chars";
  return null;
}

const ILLEGAL_CHARS = /[\\/:*?"<>|]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;
const SIMPLE_EXTENSION = /\.[A-Za-z0-9]{1,10}$/;
const COMPOUND_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"];
const CJK_TARGETS: ReadonlySet<NameLanguage> = new Set(["ZH", "ZH_HANT", "JA", "KO"]);

export interface NameParts {
  /** Part that is translated. Includes a leading dot for dot-files. */
  readonly stem: string;
  /** Extension including the dot, or "" for folders and extensionless files. */
  readonly extension: string;
}

export function splitName(name: string, kind: NameEntryKind): NameParts {
  if (kind === "directory") return { stem: name, extension: "" };
  const lower = name.toLowerCase();
  for (const compound of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(compound) && name.length > compound.length) {
      return {
        stem: name.slice(0, -compound.length),
        extension: name.slice(-compound.length),
      };
    }
  }
  const match = SIMPLE_EXTENSION.exec(name);
  // A leading-dot name such as ".env" has no extension: the whole name is the stem.
  if (!match || match.index === 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, match.index), extension: match[0] };
}

export function isCaseInsensitivePlatform(platform: string): boolean {
  return platform === "win32" || platform === "darwin";
}

/** Comparison key for "same name in one folder" on the given platform. */
export function nameKey(name: string, platform: string): string {
  const normalized = name.normalize("NFC");
  return isCaseInsensitivePlatform(platform) ? normalized.toLowerCase() : normalized;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Validates a single basename. Windows rules are enforced on every platform so
 * renamed entries stay portable.
 */
export function getNameIssue(name: string): NameIssueCode | null {
  if (!name || !name.trim() || name === "." || name === "..") return "empty_name";
  if (ILLEGAL_CHARS.test(name) || CONTROL_CHARS.test(name)) return "illegal_chars";
  if (/[. ]$/.test(name)) return "trailing_dot_space";
  const device = name.split(".")[0]?.trim() ?? "";
  if (RESERVED_NAMES.test(device)) return "reserved_name";
  if (
    name.length > NAME_TRANSLATION_LIMITS.maxNameChars ||
    utf8ByteLength(name) > NAME_TRANSLATION_LIMITS.maxNameBytes
  ) {
    return "too_long";
  }
  return null;
}

/** True when the stem contains letters that a model could translate. */
export function hasTranslatableText(stem: string): boolean {
  return /\p{L}/u.test(stem);
}

const CJK_REPLACEMENTS: Record<string, string> = {
  "\\": "＼",
  "/": "／",
  ":": "：",
  "*": "＊",
  "?": "？",
  '"': "＂",
  "<": "＜",
  ">": "＞",
  "|": "｜",
};

const LATIN_REPLACEMENTS: Record<string, string> = {
  "\\": "-",
  "/": "-",
  ":": " -",
  "*": "",
  "?": "",
  '"': "'",
  "<": "(",
  ">": ")",
  "|": "-",
};

/**
 * Cleans a model-produced stem so it becomes a usable filename part. Illegal
 * characters are mapped to natural equivalents for the target language instead
 * of being silently dropped.
 */
export function cleanTranslatedStem(stem: string, targetLang: NameLanguage): string {
  const replacements = CJK_TARGETS.has(targetLang) ? CJK_REPLACEMENTS : LATIN_REPLACEMENTS;
  return stem
    .replace(/\r?\n|\r|\t/g, " ")
    .replace(CONTROL_CHARS_GLOBAL, "")
    .replace(/[\\/:*?"<>|]/g, (char) => replacements[char] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .trim();
}

/**
 * Builds the proposed full name from the original name and a translated stem.
 * `{translated}` and `{original}` in the template are replaced by the stems;
 * the extension and a leading dot are always kept. When the translation equals
 * the original, the name stays unchanged instead of becoming "X (X)".
 */
export function composeName(params: {
  originalName: string;
  kind: NameEntryKind;
  translatedStem: string;
  template: string;
}): string {
  const { stem, extension } = splitName(params.originalName, params.kind);
  const leadingDot = stem.startsWith(".") && stem.length > 1;
  const originalStem = leadingDot ? stem.slice(1) : stem;
  let translated = params.translatedStem.trim();
  if (leadingDot) translated = translated.replace(/^\.+/, "");
  if (!translated || translated === originalStem) return params.originalName;

  const template = getTemplateError(params.template) ? DEFAULT_NAME_TEMPLATE : params.template;
  const combined = template
    .split(TRANSLATED_TOKEN)
    .map((part) => part.split(ORIGINAL_TOKEN).join(originalStem))
    .join(translated)
    .replace(/\s+/g, " ")
    .trim();
  return `${leadingDot ? "." : ""}${combined}${extension}`;
}

/** The stem that should be sent to the model (dot-files drop their leading dot). */
export function translatableStem(name: string, kind: NameEntryKind): string {
  const { stem } = splitName(name, kind);
  return stem.startsWith(".") && stem.length > 1 ? stem.slice(1) : stem;
}

/**
 * Appends " (2)", " (3)" ... before the extension until the name is not in
 * `taken`. `taken` holds name keys and is updated with the chosen name.
 */
export function numberName(
  name: string,
  kind: NameEntryKind,
  taken: Set<string>,
  platform: string,
): string {
  if (!taken.has(nameKey(name, platform))) {
    taken.add(nameKey(name, platform));
    return name;
  }
  const { stem, extension } = splitName(name, kind);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem} (${index})${extension}`;
    const key = nameKey(candidate, platform);
    if (!taken.has(key)) {
      taken.add(key);
      return candidate;
    }
  }
  return name;
}
