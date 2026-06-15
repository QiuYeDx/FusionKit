import type {
  NameTranslationOptions,
  NameTranslationTarget,
} from "./nameTypes";

const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_BASENAME_LENGTH = 255;

export interface SanitizedNameResult {
  translatedStem: string;
  newName: string;
  valid: boolean;
  reason?: string;
  warnings: string[];
}

function sanitizeSeparator(separator: string): string {
  return separator
    .replace(INVALID_FILENAME_CHARS, "")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ");
}

function composeBilingualStem(
  sanitizedTranslatedStem: string,
  originalStem: string,
  options: NameTranslationOptions
): string {
  const sep = sanitizeSeparator(options.bilingualSeparator || " - ") || " - ";

  if (options.outputMode === "bilingual_target_first") {
    return `${sanitizedTranslatedStem}${sep}${originalStem}`;
  }
  return `${originalStem}${sep}${sanitizedTranslatedStem}`;
}

export function sanitizeTranslatedName(
  target: NameTranslationTarget,
  translatedStem: string,
  options: NameTranslationOptions
): SanitizedNameResult {
  const warnings: string[] = [];
  const originalStem = translatedStem;
  let sanitizedStem = translatedStem
    .replace(CONTROL_CHARS, "")
    .replace(INVALID_FILENAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (sanitizedStem !== originalStem) {
    warnings.push("invalid_chars_sanitized");
  }

  if (options.preserveLeadingDot && target.originalName.startsWith(".")) {
    sanitizedStem = sanitizedStem.replace(/^\.+/, "");
    sanitizedStem = `.${sanitizedStem}`;
  }

  sanitizedStem = sanitizedStem.replace(/[. ]+$/g, "");
  if (!sanitizedStem || sanitizedStem === ".") {
    return {
      translatedStem: sanitizedStem,
      newName: "",
      valid: false,
      reason: "empty_name",
      warnings,
    };
  }

  if (WINDOWS_RESERVED_NAMES.test(sanitizedStem.replace(/^\.+/, ""))) {
    sanitizedStem = `${sanitizedStem}_name`;
    warnings.push("windows_reserved_name_adjusted");
  }

  let finalStem = sanitizedStem;
  if (options.outputMode && options.outputMode !== "target_only") {
    finalStem = composeBilingualStem(sanitizedStem, target.stem, options);
  }

  const extension =
    options.preserveExtension && target.kind === "file" ? target.extension : "";
  let newName = `${finalStem}${extension}`;

  if (newName.length > MAX_BASENAME_LENGTH) {
    const maxStemLength = MAX_BASENAME_LENGTH - extension.length;
    if (maxStemLength <= 0) {
      return {
        translatedStem: sanitizedStem,
        newName,
        valid: false,
        reason: "path_too_long",
        warnings,
      };
    }
    finalStem = finalStem.slice(0, maxStemLength).replace(/[. ]+$/g, "");
    newName = `${finalStem}${extension}`;
    warnings.push("name_truncated");
  }

  return {
    translatedStem: sanitizedStem,
    newName,
    valid: true,
    warnings,
  };
}
