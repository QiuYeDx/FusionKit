import path from 'node:path';
import type { OutputBaseName } from './types';

/**
 * Output names (module-encode design §6): the source name plus the task's suffix, cleaned for
 * Windows and cut to fit the folder. Numbering on a collision (`name (1).ext`) is the engine's.
 */

export const NAMING_POLICY = Object.freeze({
  /** The whole path, in UTF-16 units as Windows counts them; room is left below MAX_PATH for ` (n)`. */
  maxPathLength: 240,
  /** A name cut shorter than this to fit the folder is refused instead (`output_path_too_long`). */
  minTruncatedName: 16,
});

/** Characters Windows does not allow in a name, control characters included. */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
/** Bidirectional controls, which can make `exe.mp4` display as `mp4.exe`. */
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Device names Windows reserves whatever the extension. */
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
const TRAILING = /[. ]+$/;

/** A language code as it may appear in a file name. */
export const isNameLanguage = (language: string | null | undefined): language is string => !!language && /^[a-z]{2,3}$/.test(language);

const withoutUnsafe = (text: string) => text.replace(ILLEGAL, '').replace(BIDI, '');

/** Ends the base name: no trailing dots or spaces, never empty, never a reserved device name. */
function finish(base: string): string {
  const trimmed = base.replace(TRAILING, '') || '_';
  return RESERVED.test(trimmed.split('.')[0].replace(TRAILING, '')) ? `_${trimmed}` : trimmed;
}

/** Cleans a base name (without its extension) for Windows. */
export const sanitizeBaseName = (base: string) => finish(withoutUnsafe(base));

function sourceStem(sourceFileName: string): { stem: string; extension: string } {
  const name = path.basename(sourceFileName);
  const extension = path.extname(name);
  return { stem: name.slice(0, name.length - extension.length), extension: extension.slice(1).toLowerCase() };
}

/** The source stem and the suffix the rule adds; only the stem is ever shortened. */
function nameParts(sourceFileName: string, rule: OutputBaseName, extension: string, besideSource: boolean): { stem: string; suffix: string } {
  const source = sourceStem(sourceFileName);
  switch (rule.rule) {
    case 'compressed': return { stem: source.stem, suffix: '-compressed' };
    // Beside the source with its own extension, the plain name would be the source itself.
    case 'converted': case 'source': return { stem: source.stem, suffix: besideSource && source.extension === extension.toLowerCase() ? '-converted' : '' };
    case 'track': return { stem: source.stem, suffix: `.track${rule.number}${isNameLanguage(rule.language) ? `.${rule.language}` : ''}` };
  }
}

/** The cleaned base name before any shortening, e.g. for display. */
export function outputBaseName(sourceFileName: string, rule: OutputBaseName, extension: string, besideSource: boolean): string {
  const { stem, suffix } = nameParts(sourceFileName, rule, extension, besideSource);
  return finish(withoutUnsafe(stem) + suffix);
}

export type OutputFileName = { ok: true; fileName: string } | { ok: false; code: 'output_path_too_long' };

export interface OutputFileNameInput {
  directory: string;
  sourceFileName: string;
  baseName: OutputBaseName;
  /** Without the dot. */
  extension: string;
  /** The output goes in the source's own folder: a convert that keeps the extension adds `-converted`. */
  besideSource: boolean;
}

/**
 * The output file name in `directory`. When the full path would pass 240 UTF-16 units, the source
 * stem is cut at a code point boundary (the task suffix and extension stay); a name cut below 16
 * code points is refused with `output_path_too_long`.
 */
export function outputFileName(input: OutputFileNameInput): OutputFileName {
  const { stem, suffix } = nameParts(input.sourceFileName, input.baseName, input.extension, input.besideSource);
  const points = [...withoutUnsafe(stem)];
  const tail = `.${input.extension}`;
  const compose = (count: number) => `${finish(points.slice(0, count).join('') + suffix)}${tail}`;
  const fits = (name: string) => path.join(input.directory, name).length <= NAMING_POLICY.maxPathLength;
  let count = points.length;
  let fileName = compose(count);
  while (!fits(fileName) && count > 0) fileName = compose(--count);
  const base = fileName.slice(0, -tail.length);
  if (!fits(fileName) || (count < points.length && [...base].length < NAMING_POLICY.minTruncatedName)) return { ok: false, code: 'output_path_too_long' };
  return { ok: true, fileName };
}
