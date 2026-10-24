import type { FlagCode, FlagDetail, LanguageTag, LedgerEntry, LongTextFormat, RepairKind } from './contract';
import { markupRaws } from './inline';
import { LANGUAGE_INFO, type LanguageInfo } from './languages';
import type { InlineMark } from './model';
import type { TermPair } from './protocol';
import { countScripts, type Script, type ScriptCounts } from './text-stats';

/**
 * Quality hints (design §7), computed once when a translation is committed or edited and stored with
 * it. Lengths and scripts are counted on the text without its markup (code, URLs, HTML, math, link
 * destinations: `markupRaws`) and without the glossary and material terms that matched.
 */

export interface QualityFlag { code: FlagCode; detail?: FlagDetail }
type Family = LanguageInfo['family'];

/** Characters the source needs before lengths are compared, by the source language family. */
const LENGTH_MIN_CHARS: Readonly<Record<Family, number>> = { cjk: 16, ko: 16, alpha: 40 };
const SHORT_RATIO = 0.5;
const LONG_RATIO = 2;
/** Below this share of the reference, with a long enough source, an item is rejected rather than flagged. */
const OMISSION_RATIO = 0.15;
const OMISSION_MIN_CHARS = 40;
const COPY_MIN_LETTERS = 12;
const LEFTOVER_SHARE = 0.15;
const LEFTOVER_MIN_LETTERS = 5;
const OWN_SCRIPT_MIN_LETTERS = 20;
const MARKUP_ITEMS = 3;
const MARKUP_ITEM_CHARS = 60;
const RATIO_WINDOW = 200;
const RATIO_MIN_SAMPLES = 30;

/** `chars(target) / chars(source)` expected before a document has its own reference. */
const COLD_START: Readonly<Record<Family, Readonly<Record<Family, number>>>> = {
  cjk: { cjk: 1, ko: 1.4, alpha: 3 },
  ko: { cjk: 0.7, ko: 1, alpha: 2 },
  alpha: { cjk: 0.33, ko: 0.5, alpha: 1 },
};
const SCRIPTS: Readonly<Record<LanguageInfo['script'], readonly Script[]>> = {
  han: ['han'], 'han+kana': ['han', 'kana'], hangul: ['hangul'], latin: ['latin'], cyrillic: ['cyrillic'],
};

// ---------------------------------------------------------------------------------------------
// Terms

/** How terms and copies are compared: NFKC and lower case. */
const fold = (text: string) => text.normalize('NFKC').toLowerCase();
/** Characters of alphabetic scripts and digits, where a term must start and end on a word boundary. */
const WORD_CHAR = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]/u;

/** First occurrence of a folded term in a folded text at or after `from`, or −1. */
function indexOfTerm(text: string, term: string, from = 0): number {
  const startsWord = WORD_CHAR.test(term[0]);
  const endsWord = WORD_CHAR.test(term[term.length - 1]);
  for (let at = text.indexOf(term, from); at >= 0; at = text.indexOf(term, at + 1)) {
    if (startsWord && WORD_CHAR.test(text[at - 1] ?? '')) continue;
    if (endsWord && WORD_CHAR.test(text[at + term.length] ?? '')) continue;
    return at;
  }
  return -1;
}

/**
 * Whether a glossary term occurs in a text (design §6.9.4): NFKC and case-insensitive, on word
 * boundaries where the term starts or ends with a letter of an alphabetic script or a digit, and as a
 * plain substring otherwise (CJK).
 */
export function termOccurs(text: string, term: string): boolean {
  const needle = fold(term).trim();
  return needle !== '' && indexOfTerm(fold(text), needle) >= 0;
}

/**
 * Words a translation keeps from the source as they are and that read as names, acronyms or
 * identifiers (a capital or a digit: VS, Code, GitHub, Python, iPhone, useEffect, S3), found
 * case-sensitively on word boundaries in the source. Counted like a matched term.
 */
function keptNames(source: string, target: string): TermPair[] {
  const text = source.normalize('NFKC');
  const names = new Set<string>();
  for (const [word] of target.normalize('NFKC').matchAll(/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]+/gu)) {
    if (/[\p{Lu}\p{N}]/u.test(word) && /\p{L}/u.test(word) && indexOfTerm(text, word) >= 0) names.add(word);
  }
  return [...names].map(name => ({ source: name, target: name }));
}

/** The confirmed glossary entries whose source occurs in a segment's source: what `term_missing` checks. */
export function ledgerHits(entries: ReadonlyArray<Pick<LedgerEntry, 'source' | 'target' | 'confirmed'>>, source: string): TermPair[] {
  const text = fold(source);
  const hits: TermPair[] = [];
  for (const { source: term, target, confirmed } of entries) {
    const needle = fold(term).trim();
    if (confirmed && needle && indexOfTerm(text, needle) >= 0) hits.push({ source: term, target });
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Counting

/** The folded text with every markup raw and every occurrence of the terms blanked out. */
function countingText(text: string, raws: readonly string[], terms: readonly string[]): string {
  let result = text;
  for (const raw of raws) result = result.split(raw).join(' ');
  result = fold(result);
  for (const term of terms) {
    if (!term) continue;
    let blanked = '';
    let last = 0;
    for (let at = indexOfTerm(result, term); at >= 0; at = indexOfTerm(result, term, last)) {
      blanked += `${result.slice(last, at)} `;
      last = at + term.length;
    }
    result = blanked + result.slice(last);
  }
  return result;
}

interface Counted { text: string; chars: number; scripts: ScriptCounts }

function counted(text: string): Counted {
  let chars = 0;
  for (const char of text) if (!/\s/u.test(char)) chars++;
  return { text, chars, scripts: countScripts(text) };
}

/**
 * Both sides as counted. Each matched term is blanked out in either form on both sides, so a term the
 * model left untranslated counts the same as one it translated.
 */
function countSides(source: string, target: string, marks: readonly InlineMark[], terms: readonly TermPair[]): { source: Counted; target: Counted } {
  const raws = markupRaws(marks).sort((a, b) => b.length - a.length);
  const folded = [...new Set(terms.flatMap(term => [fold(term.source).trim(), fold(term.target).trim()]))].sort((a, b) => b.length - a.length);
  return { source: counted(countingText(source, raws, folded)), target: counted(countingText(target, raws, folded)) };
}

export interface LengthMeasure {
  /** `chars(target) / chars(source)`; 0 when nothing of the source is counted. */
  ratio: number;
  sourceChars: number;
  /** The source is long enough for the length hints and for the document's reference: 16 characters for CJK and Korean, 40 for alphabetic languages. */
  eligible: boolean;
}

function lengthOf(source: Counted, target: Counted, srcLang: LanguageTag): LengthMeasure {
  return {
    ratio: source.chars ? target.chars / source.chars : 0,
    sourceChars: source.chars,
    eligible: source.chars >= LENGTH_MIN_CHARS[LANGUAGE_INFO[srcLang].family],
  };
}

/**
 * The length ratio of one model translation. The runner rejects the item when `isOmission`, and
 * otherwise pushes an eligible ratio to the document's `RatioReference` when it commits the item.
 * `terms` are every matched glossary and material term, as given to `checkModelOutput`; names the
 * translation kept from the source (`keptNames`) are left out like them.
 */
export function measureLength(input: {
  source: string; target: string; srcLang: LanguageTag; marks: readonly InlineMark[]; terms?: readonly TermPair[];
}): LengthMeasure {
  const sides = countSides(input.source, input.target, input.marks, [...(input.terms ?? []), ...keptNames(input.source, input.target)]);
  return lengthOf(sides.source, sides.target, input.srcLang);
}

/** Whether a translation is so much shorter than the reference that the item fails (design §6.7.2). */
export function isOmission(measure: LengthMeasure, ratioRef: number): boolean {
  return measure.sourceChars >= OMISSION_MIN_CHARS && measure.ratio < OMISSION_RATIO * ratioRef;
}

export function coldStartRatio(source: LanguageTag, target: LanguageTag): number {
  return COLD_START[LANGUAGE_INFO[source].family][LANGUAGE_INFO[target].family];
}

/**
 * `R_ref`: the median of the latest 200 eligible length ratios of a document's model translations;
 * the cold-start value of the language pair until 30 have been pushed. Create a new one when the
 * document's languages change.
 */
export class RatioReference {
  private readonly coldStart: number;
  private readonly samples = new Float64Array(RATIO_WINDOW);
  private size = 0;
  private next = 0;
  private median: number | null = null;

  constructor(languages: { source: LanguageTag; target: LanguageTag }, samples: Iterable<number> = []) {
    this.coldStart = coldStartRatio(languages.source, languages.target);
    for (const ratio of samples) this.push(ratio);
  }

  push(ratio: number): void {
    if (!Number.isFinite(ratio) || ratio < 0) return;
    this.samples[this.next] = ratio;
    this.next = (this.next + 1) % RATIO_WINDOW;
    this.size = Math.min(this.size + 1, RATIO_WINDOW);
    this.median = null;
  }

  get value(): number {
    if (this.size < RATIO_MIN_SAMPLES) return this.coldStart;
    if (this.median === null) {
      const sorted = this.samples.slice(0, this.size).sort();
      const middle = this.size >> 1;
      this.median = this.size % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return this.median;
  }
}

// ---------------------------------------------------------------------------------------------
// Checks

const collapse = (text: string) => text.replace(/\s+/gu, ' ').trim();
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Whether the translation still reads as the source language: ① a copy of the source with at least
 * 12 letters, compared on `copy` (kept names not left out, so a copied title-case heading counts);
 * ② letters of a script only the source language uses, names kept from the source left out and
 * weighted by the cold-start ratio of the pair (Latin letters against Han characters count 0.33),
 * make up more than 15% of the translation (at least 12 of them when weighted, else 5); ③ a Japanese
 * or Korean translation of 20 letters without kana or Hangul. Two languages of the same script are
 * only checked for ①.
 */
function isUntranslated(copy: { source: Counted; target: Counted }, source: Counted, target: Counted, srcLang: LanguageTag, tgtLang: LanguageTag): boolean {
  if (copy.source.scripts.letters >= COPY_MIN_LETTERS && collapse(copy.source.text) === collapse(copy.target.text)) return true;
  const own = SCRIPTS[LANGUAGE_INFO[tgtLang].script];
  const leftover = SCRIPTS[LANGUAGE_INFO[srcLang].script]
    .filter(script => !own.includes(script))
    .reduce((sum, script) => sum + target.scripts[script], 0);
  // 0.33 alphabetic → CJK, 0.5 alphabetic → Korean, else 1.
  const weight = Math.min(1, coldStartRatio(srcLang, tgtLang));
  const weighted = leftover * weight;
  const min = weight < 1 ? COPY_MIN_LETTERS : LEFTOVER_MIN_LETTERS;
  if (leftover >= min && weighted > LEFTOVER_SHARE * (target.scripts.letters - leftover + weighted)) return true;
  if (target.scripts.letters < OWN_SCRIPT_MIN_LETTERS) return false;
  if (tgtLang === 'ja') return target.scripts.kana === 0;
  if (tgtLang === 'ko') return target.scripts.hangul === 0;
  return false;
}

/** Confirmed glossary hits whose translation is missing, then the material terms `checkRequiredTerms` reported, without repeats. */
function missingTerms(target: string, ledger: readonly TermPair[], required: readonly TermPair[]): TermPair[] {
  const translation = fold(target);
  const missing: TermPair[] = [];
  const seen = new Set<string>();
  const add = (term: TermPair) => {
    const key = `${fold(term.source).trim()}\u0000${fold(term.target).trim()}`;
    if (seen.has(key)) return;
    seen.add(key);
    missing.push(term);
  };
  for (const hit of ledger) {
    const expected = fold(hit.target).trim();
    if (expected && !translation.includes(expected)) add(hit);
  }
  required.forEach(add);
  return missing;
}

export interface ModelOutputCheck {
  /** Display source and the decoded translation, both raw Markdown inline text. */
  source: string;
  target: string;
  /** Effective languages. */
  srcLang: LanguageTag;
  tgtLang: LanguageTag;
  marks: readonly InlineMark[];
  /** `decode`'s repairs. */
  repaired: readonly RepairKind[];
  /** `RatioReference.value` of the document. */
  ratioRef: number;
  /** `ledgerHits` of the segment's source. */
  confirmedLedgerHits: readonly TermPair[];
  /** The terms of `checkRequiredTerms`' `required_term_suspect` issues for this segment. */
  requiredTermIssues: readonly TermPair[];
  /** Material terms that apply to the segment; only left out of the counts. */
  materialHits?: readonly TermPair[];
}

/**
 * Hints for a committed model translation, in display order: placeholder_repaired, term_missing,
 * untranslated, then length_short or length_long, so at most four.
 */
export function checkModelOutput(input: ModelOutputCheck): QualityFlag[] {
  const flags: QualityFlag[] = [];
  if (input.repaired.length) flags.push({ code: 'placeholder_repaired', detail: { kinds: [...input.repaired] } });
  const missing = missingTerms(input.target, input.confirmedLedgerHits, input.requiredTermIssues);
  if (missing.length) flags.push({ code: 'term_missing', detail: { source: missing[0].source, target: missing[0].target, more: missing.length - 1 } });
  const terms = [...input.confirmedLedgerHits, ...(input.materialHits ?? [])];
  const copy = countSides(input.source, input.target, input.marks, terms);
  const kept = keptNames(input.source, input.target);
  const { source, target } = kept.length ? countSides(input.source, input.target, input.marks, [...terms, ...kept]) : copy;
  if (isUntranslated(copy, source, target, input.srcLang, input.tgtLang)) flags.push({ code: 'untranslated' });
  const length = lengthOf(source, target, input.srcLang);
  if (length.eligible && input.ratioRef > 0) {
    const ratio = length.ratio / input.ratioRef;
    if (ratio < SHORT_RATIO) flags.push({ code: 'length_short', detail: { ratio: round2(ratio) } });
    else if (ratio > LONG_RATIO) flags.push({ code: 'length_long', detail: { ratio: round2(ratio) } });
  }
  return flags;
}

/**
 * The only hint of a user's edit: markup of the source (atoms, link and image destinations) that the
 * edited Markdown text no longer contains. Plain-text segments get none.
 */
export function checkUserEdit(input: { target: string; marks: readonly InlineMark[]; format: LongTextFormat }): Array<{ code: 'markup_missing'; detail: { items: string[] } }> {
  if (input.format !== 'markdown') return [];
  const missing = markupRaws(input.marks).filter(raw => !input.target.includes(raw));
  if (!missing.length) return [];
  const items = missing.slice(0, MARKUP_ITEMS).map(item => Array.from(item).slice(0, MARKUP_ITEM_CHARS).join(''));
  return [{ code: 'markup_missing', detail: { items } }];
}
