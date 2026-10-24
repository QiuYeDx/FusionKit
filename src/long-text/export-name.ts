import type { LanguageTag, LongTextFormat } from './contract';
import { cutUtf16 } from './model';
import type { ExportMode } from './rebuild';

/**
 * Export file names (design §6.12 “写出”), shared by the exporter and the export dialog's preview so
 * both always show the same name.
 */

const BASE_CHARS = 120;
const UNSAFE_CHARS = /[<>:"/\\|?*\p{Cc}]/gu;
const EDGES = /^[\s.]+|[\s.]+$/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Windows treats a reserved device name as reserved before any extension: `CON.txt` is `CON`. */
const isReserved = (base: string) => RESERVED_NAMES.test(base.split('.')[0].trimEnd());

/**
 * A base file name that is valid everywhere: `<>:"/\|?*` and control characters become `-`, dots and
 * spaces at either end are dropped, at most 120 characters, a reserved Windows device name gets a
 * leading `_`, and an empty result is `untitled`.
 */
export function sanitizeFileName(name: string): string {
  let base = name.replace(UNSAFE_CHARS, '-').replace(EDGES, '');
  if (isReserved(base)) base = `_${base}`;
  if (base.length > BASE_CHARS) base = cutUtf16(base, BASE_CHARS).replace(EDGES, '');
  if (isReserved(base)) base = `_${base}`;
  return base || 'untitled';
}

export interface ExportNameSource {
  /** The source file's name for imported files, null for pasted text. */
  fileName: string | null;
  /** The document name, used for pasted text. */
  name: string;
  format: LongTextFormat;
}
/** An export file name split where a number goes: `${stem}${ext}`, then `${stem} (2)${ext}` …. */
export interface ExportName { stem: string; ext: string }

/**
 * `${base}.${target}[.bilingual]${ext}`: `base` is the source file name without its extension, or the
 * name of pasted text; `ext` is `.txt` for TXT and, for Markdown, `.markdown` when the source used it,
 * else `.md`.
 */
export function exportName(source: ExportNameSource, target: LanguageTag, mode: ExportMode): ExportName {
  const { fileName } = source;
  const dot = fileName ? fileName.lastIndexOf('.') : -1;
  const base = fileName === null ? source.name : dot > 0 ? fileName.slice(0, dot) : fileName;
  const sourceExt = fileName && dot > 0 ? fileName.slice(dot).toLowerCase() : '';
  const ext = source.format === 'txt' ? '.txt' : sourceExt === '.markdown' ? '.markdown' : '.md';
  return { stem: `${sanitizeFileName(base)}.${target}${mode === 'bilingual' ? '.bilingual' : ''}`, ext };
}

/** Candidate `number` (1 … 99) of an export name: the name itself, then `name (2).ext` …. */
export function numberedName({ stem, ext }: ExportName, number: number): string {
  return number === 1 ? `${stem}${ext}` : `${stem} (${number})${ext}`;
}
