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

  const extension =
    options.preserveExtension && target.kind === "file" ? target.extension : "";
  let newName = `${sanitizedStem}${extension}`;

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
    sanitizedStem = sanitizedStem.slice(0, maxStemLength).replace(/[. ]+$/g, "");
    newName = `${sanitizedStem}${extension}`;
    warnings.push("name_truncated");
  }

  return {
    translatedStem: sanitizedStem,
    newName,
    valid: true,
    warnings,
  };
}
