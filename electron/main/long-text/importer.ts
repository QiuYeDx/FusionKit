import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  IMPORT_SKIP_REASONS, LONG_TEXT_LIMITS,
  type Counts, type DocumentSummary, type ImportDefaults, type ImportResult, type ImportSkipReason, type LanguageTag,
  type LongTextFormat, type LongTextSettings, type SupportedEncoding, type TxtSplit,
} from '../../../src/long-text/contract';
import * as inline from '../../../src/long-text/inline';
import { emptyUsage } from '../../../src/long-text/journal';
import { defaultTarget, DETECTION_CHARS, detectSourceLanguage } from '../../../src/long-text/languages';
import { cutUtf16, type DocumentManifest } from '../../../src/long-text/model';
import { displaySource, SegmentationError, segmentDocument, type SegmentedDocument } from '../../../src/long-text/segments';
import { knowledgeSelectionSchema, type KnowledgeSelection } from '../../../src/translation-knowledge/execution-contract';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import { decodeBytes, detectEncoding, detectLineEnding } from './encoding';
import { effectiveLanguages, LongTextOperationError, manifestSummary, type LongTextRepository } from './repository';

/**
 * The import pipeline (design §2 F2–F3, §6.2–6.5): checks a file before reading it, reads it once,
 * finds duplicates, detects the encoding, segments and paginates, composes the settings of the new
 * document from the import defaults, and hands everything to the repository, which stages and renames
 * the folder. `resegment` re-decodes or re-segments an existing document the same way.
 */

export interface ImporterOptions {
  repository: LongTextRepository;
  /** The listed documents: their number bounds imports, and their file sources are checked for duplicates. */
  documents: () => readonly DocumentSummary[];
  /** The translation materials library; when it cannot be read, new documents start without materials. */
  readKnowledge: () => Promise<LibrarySnapshot> | LibrarySnapshot;
  /** Called after each document is written, before the next file is read, so the list never misses one. */
  onCreated?: (summary: DocumentSummary) => void;
  now?: () => number;
}

/** What `resegment` needs of a document: its manifest and S. A `LoadedDocument` fits. */
export interface ResegmentSource {
  readonly manifest: Readonly<DocumentManifest>;
  readonly source: string;
}

const FORMATS: ReadonlyMap<string, LongTextFormat> = new Map([['.txt', 'txt'], ['.md', 'markdown'], ['.markdown', 'markdown']]);
/** Extensions the native picker offers, without the dot; the same files readSourceFile accepts. */
export const IMPORT_EXTENSIONS: readonly string[] = [...FORMATS.keys()].map(extension => extension.slice(1));
const SUBTITLE_EXTENSIONS: ReadonlySet<string> = new Set(['.srt', '.ass', '.ssa', '.vtt', '.lrc', '.sbv', '.sub']);
const SKIP_REASONS: ReadonlySet<string> = new Set(IMPORT_SKIP_REASONS);
const PASTE_NAME_CHARS = 30;
const TOKEN = /<\/?[xm]\d+\/?>/g;
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

type Library = Pick<LibrarySnapshot, 'data'>;
type ReadLibrary = () => Promise<Library | null>;
interface SourceFile { path: string; format: LongTextFormat; bytes: Uint8Array; mtimeMs: number; sha256: string }
interface Imported { id: string; path: string; sha256: string }
interface Draft {
  name: string;
  format: LongTextFormat;
  S: string;
  source: DocumentManifest['source'];
  encoding: { name: SupportedEncoding; confidence: 'high' | 'low' } | null;
  original: Uint8Array | null;
}

export class LongTextImporter {
  private readonly now: () => number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ImporterOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Imports each file as a document, in order. A file that cannot become a document is skipped with its
   * reason; one already listed (same path, same sha256) is reported as a duplicate. A storage failure
   * stops the import and rejects; documents written before it were already passed to `onCreated`.
   */
  importFiles(paths: readonly string[], defaults: ImportDefaults): Promise<ImportResult> {
    return this.serial(async () => {
      const result: ImportResult = { documents: [], duplicates: [], skipped: [] };
      const imported: Imported[] = [];
      const library = this.libraryReader();
      for (const file of paths) {
        const name = path.basename(file);
        try {
          const read = await readSourceFile(file);
          const duplicate = await this.findDuplicate(read, imported);
          if (duplicate) {
            result.duplicates.push({ name, documentId: duplicate });
            continue;
          }
          this.ensureRoom(imported);
          const detection = detectEncoding(read.bytes);
          if ('error' in detection) throw new LongTextOperationError('binary_file');
          const manifest = await this.create({
            name, format: read.format, S: decodeBytes(read.bytes, detection.encoding),
            source: { kind: 'file', path: read.path, size: read.bytes.length, mtimeMs: read.mtimeMs, sha256: read.sha256 },
            encoding: { name: detection.encoding, confidence: detection.confidence },
            original: read.bytes,
          }, defaults, library);
          imported.push({ id: manifest.id, path: read.path, sha256: read.sha256 });
          result.documents.push(manifestSummary(manifest));
        } catch (error) {
          const reason = skipReason(error);
          if (!reason) throw error;
          result.skipped.push({ name, reason });
        }
      }
      return result;
    });
  }

  /**
   * Imports pasted text as a document. The page sends the name it shows for a blank field; without one the
   * first non-blank line (cut to 30 characters) names the document. Rejects with `limit_exceeded`,
   * `empty_document` or `too_many_segments`.
   */
  importText(name: string | undefined, text: string, format: LongTextFormat, defaults: ImportDefaults): Promise<DocumentSummary> {
    return this.serial(async () => {
      this.ensureRoom([]);
      const manifest = await this.create({
        name: name?.trim() || firstLine(text), format, S: text, source: { kind: 'paste' }, encoding: null, original: null,
      }, defaults, this.libraryReader());
      return manifestSummary(manifest);
    });
  }

  /**
   * Re-decodes the imported bytes as `encoding` and/or segments S again with `txtSplit` (TXT only), then
   * replaces the document's segmentation. Translations, runs and the sample are discarded; settings,
   * ledger, exports and `original.bin` stay. A changed encoding counts as confirmed. When the detected
   * source language changes, a target equal to it is moved away and materials of the old direction are
   * dropped. The caller checks that no run is active and that translations may be
   * discarded, and closes the loaded document first: its pending writes would otherwise land on the new
   * folder. Resolves with the manifest written.
   */
  async resegment(document: ResegmentSource, change: { encoding?: SupportedEncoding; txtSplit?: TxtSplit }): Promise<DocumentManifest> {
    const previous = document.manifest;
    let S = document.source;
    let encoding = previous.encoding && { ...previous.encoding };
    if (change.encoding) {
      if (!encoding) throw new LongTextOperationError('invalid_request');
      const original = await this.options.repository.withDocument(previous.id, files => files.readOriginal());
      if (!original) throw new LongTextOperationError('source_missing');
      S = decodeBytes(original, change.encoding);
      encoding = { ...encoding, name: change.encoding, confirmed: true };
    }
    const txtSplit = previous.format === 'txt' ? change.txtSplit ?? previous.structure?.txtSplit ?? 'auto' : undefined;
    const segmented = await segment(previous.format, S, txtSplit);
    const detected = { sourceLanguage: detectSourceLanguage(languageSamples(S, segmented, previous.format)), style: segmented.detectedStyle };
    const settings = resegmentedSettings(previous.settings, detected);
    const lineEnding = detectLineEnding(S);
    const stats = statsOf(S, segmented);
    const manifest: DocumentManifest = {
      ...structuredClone(previous),
      revision: previous.revision + 1, updatedAt: this.now(),
      encoding: encoding && { ...encoding, lineEnding }, lineEnding,
      structure: segmented.structure, detected, stats, settings,
      counts: pendingCounts(stats.translatable), usage: emptyUsage(), fullRunStarted: false, sample: null, runs: [],
    };
    await this.options.repository.replaceDocument(previous.id, { manifest, source: S, records: segmented.records, pages: segmented.pages, refs: segmented.refs });
    return manifest;
  }

  /** Imports run one after another, so the document limit and duplicate checks see every earlier import. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async create(draft: Draft, defaults: ImportDefaults, library: ReadLibrary): Promise<DocumentManifest> {
    const { S, format } = draft;
    const segmented = await segment(format, S, format === 'txt' ? 'auto' : undefined);
    const source = detectSourceLanguage(languageSamples(S, segmented, format));
    const target = defaultTarget(defaults.targetLanguage, source);
    const knowledge = defaults.knowledgeCollectionIds.length
      ? selectKnowledge(await library(), defaults.knowledgeCollectionIds, { source, target })
      : null;
    const settings: LongTextSettings = {
      sourceLanguage: 'auto', targetLanguage: target, style: defaults.style ?? segmented.detectedStyle,
      instructions: defaults.instructions, knowledge, profileId: defaults.profileId, pace: defaults.pace,
      batchSourceTokens: defaults.batchSourceTokens, maxOutputTokens: defaults.maxOutputTokens,
    };
    const at = this.now();
    const lineEnding = detectLineEnding(S);
    const stats = statsOf(S, segmented);
    const manifest: DocumentManifest = {
      schemaVersion: 1, id: randomUUID(), revision: 0, createdAt: at, updatedAt: at,
      name: cutUtf16(draft.name, LONG_TEXT_LIMITS.nameChars), format, source: draft.source,
      encoding: draft.encoding && { ...draft.encoding, confirmed: draft.encoding.confidence === 'high', lineEnding },
      lineEnding, structure: segmented.structure,
      detected: { sourceLanguage: source, style: segmented.detectedStyle },
      stats, settings, counts: pendingCounts(stats.translatable), usage: emptyUsage(),
      fullRunStarted: false, sample: null, runs: [], exportFolder: null, exports: [],
    };
    await this.options.repository.createDocument({
      manifest, source: S, original: draft.original, records: segmented.records, pages: segmented.pages, refs: segmented.refs,
    });
    this.options.onCreated?.(manifestSummary(manifest));
    return manifest;
  }

  private ensureRoom(imported: readonly Imported[]): void {
    const ids = new Set(this.options.documents().map(summary => summary.id));
    for (const entry of imported) ids.add(entry.id);
    if (ids.size >= LONG_TEXT_LIMITS.documents) throw new LongTextOperationError('limit_exceeded');
  }

  /** A document imported from the same path with the same content, in this import or listed before it. */
  private async findDuplicate(file: SourceFile, imported: readonly Imported[]): Promise<string | null> {
    const key = pathKey(file.path);
    const earlier = imported.find(entry => entry.sha256 === file.sha256 && pathKey(entry.path) === key);
    if (earlier) return earlier.id;
    for (const summary of this.options.documents()) {
      if (summary.unavailable || summary.source.kind !== 'file') continue;
      if (pathKey(path.join(summary.source.directory, summary.source.fileName)) !== key) continue;
      const read = await this.options.repository.withDocument(summary.id, files => files.readManifest()).catch(() => null);
      if (read && 'manifest' in read && read.manifest.source.kind === 'file' && read.manifest.source.sha256 === file.sha256) return summary.id;
    }
    return null;
  }

  /** A reader that reads the library once, on first use, and yields null when it cannot be read. */
  private libraryReader(): ReadLibrary {
    let pending: Promise<Library | null> | null = null;
    return () => (pending ??= Promise.resolve()
      .then(() => this.options.readKnowledge())
      .catch(error => {
        console.warn('[long-text] Could not read the translation materials; importing without them', error);
        return null;
      }));
  }
}

/**
 * Checks the path before any read: extension, then `lstat` (a regular file, not a link, within the size
 * limit). The file is then read through a handle that must still be that file.
 */
async function readSourceFile(file: string): Promise<SourceFile> {
  const extension = path.extname(file).toLowerCase();
  if (SUBTITLE_EXTENSIONS.has(extension)) throw new LongTextOperationError('subtitle_file');
  const format = FORMATS.get(extension);
  if (!format) throw new LongTextOperationError('unsupported_format');
  const resolved = path.resolve(file);
  let stat: Stats;
  try {
    stat = await lstat(resolved);
  } catch (error) {
    throw new LongTextOperationError('file_unreadable', { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new LongTextOperationError('file_unreadable');
  if (stat.size > LONG_TEXT_LIMITS.fileBytes) throw new LongTextOperationError('file_too_large');
  const bytes = await readBounded(resolved, stat);
  return { path: resolved, format, bytes, mtimeMs: stat.mtimeMs, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Reads the file `expected` describes, rejecting one that was swapped, grew while read, or passed the size limit. */
async function readBounded(file: string, expected: Stats): Promise<Uint8Array> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    throw new LongTextOperationError('file_unreadable', { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (stat.ino !== expected.ino || stat.dev !== expected.dev || !stat.isFile()) throw new LongTextOperationError('file_unreadable');
    // One byte more than the file should hold tells a growing file apart.
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, LONG_TEXT_LIMITS.fileBytes) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length === buffer.length) throw new LongTextOperationError(length > LONG_TEXT_LIMITS.fileBytes ? 'file_too_large' : 'file_unreadable');
    return buffer.subarray(0, length);
  } catch (error) {
    throw error instanceof LongTextOperationError ? error : new LongTextOperationError('file_unreadable', { cause: error });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Segments S; a document without a single translatable segment is `empty_document`. */
async function segment(format: LongTextFormat, S: string, txtSplit: TxtSplit | undefined): Promise<SegmentedDocument> {
  let segmented: SegmentedDocument;
  try {
    segmented = await segmentDocument(format, S, { txtSplit, inline });
  } catch (error) {
    if (error instanceof SegmentationError && error.code === 'too_many_segments') throw new LongTextOperationError('too_many_segments');
    throw error;
  }
  if (!segmented.records.some(record => record.t)) throw new LongTextOperationError('empty_document');
  return segmented;
}

/**
 * The text of the first translatable segments, about 20,000 characters, with inline marks removed: URLs,
 * code and markup would otherwise pass Latin letters off as the language of the document.
 */
function languageSamples(S: string, segmented: SegmentedDocument, format: LongTextFormat): string[] {
  const refs = new Set(segmented.refs);
  const samples: string[] = [];
  let length = 0;
  for (const record of segmented.records) {
    if (!record.t) continue;
    const text = inline.project(displaySource(S, record), record.k, format, { refs }).text.replace(TOKEN, ' ');
    samples.push(text);
    length += text.length;
    if (length >= DETECTION_CHARS) break;
  }
  return samples;
}

/**
 * Settings after a resegmentation found `detected`: a target equal to the effective source moves away
 * (`defaultTarget`), and materials chosen for another direction are dropped, as an import would.
 */
function resegmentedSettings(previous: LongTextSettings, detected: DocumentManifest['detected']): LongTextSettings {
  const settings = structuredClone(previous);
  const { source } = effectiveLanguages({ settings, detected });
  settings.targetLanguage = defaultTarget(settings.targetLanguage, source);
  const pair = settings.knowledge?.languagePair;
  if (pair && (pair.source !== source || pair.target !== settings.targetLanguage)) settings.knowledge = null;
  return settings;
}

/** The listed collections that exist, are not archived and translate in the document's direction; null when none does. */
function selectKnowledge(library: Library | null, ids: readonly string[], pair: { source: LanguageTag; target: LanguageTag }): KnowledgeSelection | null {
  if (!library) return null;
  const usable = new Set(library.data.collections
    .filter(collection => !collection.archived && collection.languagePair.source === pair.source && collection.languagePair.target === pair.target)
    .map(collection => collection.id));
  const collectionIds = [...new Set(ids)].filter(id => usable.has(id));
  if (!collectionIds.length) return null;
  const parsed = knowledgeSelectionSchema.safeParse({ version: 2, languagePair: { ...pair }, collectionIds, disabledEntryIds: [] });
  return parsed.success ? parsed.data : null;
}

function statsOf(S: string, segmented: SegmentedDocument): DocumentManifest['stats'] {
  let translatable = 0;
  let sourceTokens = 0;
  for (const record of segmented.records) {
    if (!record.t) continue;
    translatable++;
    sourceTokens += record.n;
  }
  return { characters: S.length, segments: segmented.records.length, translatable, pages: segmented.pages.length, sourceTokens };
}

function pendingCounts(translatable: number): Counts {
  return { translatable, done: 0, pending: translatable, failed: 0, attention: 0, edited: 0, locked: 0 };
}

function skipReason(error: unknown): ImportSkipReason | null {
  return error instanceof LongTextOperationError && SKIP_REASONS.has(error.code) ? (error.code as ImportSkipReason) : null;
}

function pathKey(file: string): string {
  const resolved = path.resolve(file);
  return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
}

function firstLine(text: string): string {
  const line = /^.*\S.*$/m.exec(text)?.[0] ?? '';
  return cutUtf16(line.trim(), PASTE_NAME_CHARS).trimEnd();
}
