import { z } from 'zod';
import type { ModelErrorCategory } from '../lib/model-error-category';
import { knowledgeSelectionSchema, type KnowledgeSelection } from '../translation-knowledge/execution-contract';
import type { LongTextChangeEvent } from './channels';

/**
 * Shared protocol between the long text translator page and the main-process `long-text` module.
 * The renderer reaches it only through `window.longText`; the preload imports this file as types.
 */

export const LONG_TEXT_LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt'] as const;
export type LanguageTag = (typeof LONG_TEXT_LANGUAGES)[number];
export type SourceLanguage = 'auto' | LanguageTag;
export const LONG_TEXT_FORMATS = ['txt', 'markdown'] as const;
export type LongTextFormat = (typeof LONG_TEXT_FORMATS)[number];
export const STYLES = ['general', 'literary', 'technical'] as const;
export type Style = (typeof STYLES)[number];
export type Pace = 1 | 2 | 4;
export const LONG_TEXT_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'big5', 'shift_jis', 'euc-jp', 'euc-kr', 'windows-1252'] as const;
export type SupportedEncoding = (typeof LONG_TEXT_ENCODINGS)[number];
export const TXT_SPLITS = ['auto', 'line', 'unwrap'] as const;
export type TxtSplit = (typeof TXT_SPLITS)[number];

export const SEGMENT_KINDS = ['paragraph', 'heading', 'list_item', 'quote', 'table_row', 'footnote', 'line', 'verbatim'] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];
export const VERBATIM_KINDS = ['code', 'frontmatter', 'html', 'math', 'rule', 'other'] as const;
export type VerbatimKind = (typeof VERBATIM_KINDS)[number];

export const FLAG_CODES = ['length_short', 'length_long', 'untranslated', 'term_missing', 'placeholder_repaired', 'markup_missing'] as const;
export type FlagCode = (typeof FLAG_CODES)[number];
export const REPAIR_KINDS = ['code', 'url', 'html', 'math', 'format', 'link', 'table', 'other'] as const;
export type RepairKind = (typeof REPAIR_KINDS)[number];
export type FlagDetail =
  | { ratio: number }                                   // length_*
  | { source: string; target: string; more: number }   // term_missing
  | { kinds: RepairKind[] }                             // placeholder_repaired
  | { items: string[] }                                 // markup_missing: at most 3 items of at most 60 characters
  | Record<string, never>;                              // untranslated
export const SEGMENT_FAILURE_CODES = ['protocol_invalid', 'too_long', 'content_filtered', 'transport', 'budget_required', 'empty_output'] as const;
export type SegmentFailureCode = (typeof SEGMENT_FAILURE_CODES)[number];

export interface LongTextSettings {
  sourceLanguage: SourceLanguage; targetLanguage: LanguageTag; style: Style;
  instructions: string;                     // ≤ 4000
  knowledge: KnowledgeSelection | null;     // null = no materials; the main process overrides languagePair with the document languages
  profileId: string | null;                 // null = follow the task model
  pace: Pace;
  batchSourceTokens: number;                // 500..4000, default 1500
  maxOutputTokens: number | null;           // null = automatic; otherwise 1024..32768
}
export interface Counts { translatable: number; done: number; pending: number; failed: number; attention: number; edited: number; locked: number }
export interface Usage { inputTokens: number; outputTokens: number; cachedInputTokens: number; requests: number; failedRequests: number; unknownRequests: number }
export const RUN_KINDS = ['full', 'sample', 'from'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const RUN_STATUSES = ['running', 'pausing', 'paused', 'completed', 'failed', 'interrupted'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export interface RunView {
  id: string; kind: RunKind; status: RunStatus;
  total: number; done: number; failed: number; deferred: number; inFlight: number;
  frontier: number | null; frontierPage: number | null;
  pace: Pace; effectiveLanes: number; etaSeconds: number | null;
  startedAt: number; endedAt: number | null;
  model: { profileId: string; modelKey: string; label: string };
  error?: LongTextError;
  usage: Usage;
}
export interface DocumentSummary {
  id: string; revision: number; name: string; format: LongTextFormat; createdAt: number; updatedAt: number;
  source: { kind: 'file'; fileName: string; directory: string } | { kind: 'paste' };
  encoding: { name: SupportedEncoding; confidence: 'high' | 'low'; confirmed: boolean } | null;   // null for pasted text
  languages: { source: LanguageTag; target: LanguageTag; sourceIsAuto: boolean };
  style: Style;
  stats: { characters: number; translatable: number; pages: number };
  counts: Counts; usage: Usage;
  fullRunStarted: boolean;
  run: RunView | null;                       // the active run, or the latest one
  lastExport: { name: string; at: number } | null;
  journalIssues: number;
  unavailable?: 'newer_version' | 'damaged';
}
export interface PageInfo { index: number; start: number; end: number; title: string | null; translatable: number; done: number; attention: number; inFlight: boolean }
export interface DocumentDetail extends DocumentSummary {
  settings: LongTextSettings;
  detected: { sourceLanguage: LanguageTag; style: Style };
  structure: { txtSplit: TxtSplit; resolved: 'line' | 'unwrap' } | null;   // null for Markdown
  pages: PageInfo[];
  ledger: { total: number; confirmed: number };
  sample: { indices: number[]; stale: boolean } | null;
  exportFolder: string | null;
}
export interface SegmentRow {
  index: number; ordinal: number; page: number; rev: number;
  kind: SegmentKind;
  level: number; marker: string; verbatimKind?: VerbatimKind;
  translatable: boolean;
  source: string;                            // display source; verbatim blocks are cut to 2,000 characters
  target: string | null;                     // display target: raw Markdown inline text, hard breaks as \n
  status: 'pending' | 'translating' | 'done' | 'failed';
  origin: 'model' | 'user' | null; locked: boolean;
  flags: Array<{ code: FlagCode; detail?: FlagDetail }>;   // only the ones not dismissed
  failure: { code: SegmentFailureCode; category?: ModelErrorCategory } | null;
  canUndo: boolean;
}
export interface LedgerEntry { id: string; source: string; target: string; origin: 'model' | 'user'; confirmed: boolean; firstSeen: number | null; updatedAt: number }
export interface Estimate { segments: number; sourceTokens: number; requests: number; inputTokens: [number, number]; outputTokens: [number, number]; basis: 'model' | 'observed' }
export const IMPORT_SKIP_REASONS = ['unsupported_format', 'subtitle_file', 'file_too_large', 'empty_document', 'binary_file', 'file_unreadable', 'too_many_segments', 'limit_exceeded'] as const;
export type ImportSkipReason = (typeof IMPORT_SKIP_REASONS)[number];
export interface ImportSkip { name: string; reason: ImportSkipReason }
export interface ImportResult { documents: DocumentSummary[]; duplicates: Array<{ name: string; documentId: string }>; skipped: ImportSkip[] }
export interface PageResult { documentId: string; revision: number; page: PageInfo; rows: SegmentRow[] }
export interface QueryResult { total: number; offset: number; rows: SegmentRow[]; truncated: boolean }

export const LONG_TEXT_LIMITS = Object.freeze({
  fileBytes: 10 * 1024 * 1024, largeFileBytes: 5 * 1024 * 1024, pasteChars: 2_000_000,
  documents: 200, importPaths: 50, segments: 200_000,
  splitTokens: 1_200, chunkTokens: 900, hardCutChars: 3_000, inlineMarks: 200,
  pageSegments: 60, pageTokens: 8_000, chapterMinSegments: 8,
  batchSegments: 40, batchSegmentsWithKnowledge: 20, sampleTokens: 800, sampleSegments: 12,
  priorPairs: 3, priorTokens: 600, followingSource: 2, followingTokens: 300, sectionTokens: 120, contextChars: 400,
  ledgerEntries: 2_000, ledgerPerBatch: 60, termsPerResponse: 10, termChars: 80,
  editChars: 20_000, instructionChars: 500, settingsInstructionChars: 4_000, nameChars: 120,
  queryLimit: 100, searchResults: 5_000, searchChars: 200,
  globalRequests: 6, interactiveRequests: 2, transportRetries: 3, maxRetryWaitMs: 60_000,
  consecutiveTransportFailures: 4, soloAttempts: 3, unstableMinFailed: 20, unstableRatio: 0.3,
  requestTimeoutMs: 180_000, minContextWindow: 8_192, defaultContextCap: 131_072,
  runConfirmTokens: 500_000, copyChars: 20_000_000, runsKept: 20, exportsKept: 10, loadedDocuments: 3,
});

const id = z.string().uuid();
export const indexSchema = z.number().int().min(0).max(LONG_TEXT_LIMITS.segments - 1);
const rev = z.number().int().min(0);
const absolutePath = z.string().min(1).max(32_768).refine(p => !p.includes('\0') && /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p));
/** Model endpoints: http(s) only, without credentials, query string or fragment. */
export const endpointSchema = z.string().url().max(2000).refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
export const languageSchema = z.enum(LONG_TEXT_LANGUAGES);
const styleSchema = z.enum(STYLES);
const paceSchema = z.union([z.literal(1), z.literal(2), z.literal(4)]);
const batchSourceTokensSchema = z.number().int().min(500).max(4000);
const maxOutputTokensSchema = z.number().int().min(1024).max(32768);
const profileIdSchema = z.string().min(1).max(200);
const encodingSchema = z.enum(LONG_TEXT_ENCODINGS);
/** No cross-field refinement: the renderer only sends a selection with collections, and the main
 * process overrides `knowledge.languagePair` with the document languages. */
export const settingsSchema = z.strictObject({
  sourceLanguage: z.union([z.literal('auto'), languageSchema]),
  targetLanguage: languageSchema,
  style: styleSchema,
  instructions: z.string().max(LONG_TEXT_LIMITS.settingsInstructionChars),
  knowledge: knowledgeSelectionSchema.nullable(),
  profileId: profileIdSchema.nullable(),
  pace: paceSchema,
  batchSourceTokens: batchSourceTokensSchema,
  maxOutputTokens: maxOutputTokensSchema.nullable(),
}) satisfies z.ZodType<LongTextSettings>;
export const importDefaultsSchema = z.strictObject({
  targetLanguage: languageSchema,
  style: styleSchema.nullable(),             // null = suggest from the content
  instructions: z.string().max(LONG_TEXT_LIMITS.settingsInstructionChars),
  profileId: profileIdSchema.nullable(),
  pace: paceSchema,
  batchSourceTokens: batchSourceTokensSchema,
  maxOutputTokens: maxOutputTokensSchema.nullable(),
  knowledgeCollectionIds: z.array(id).max(50),
});
export type ImportDefaults = z.infer<typeof importDefaultsSchema>;
export const modelSchema = z.strictObject({
  profileId: profileIdSchema, label: z.string().max(200),
  modelKey: z.string().trim().min(1).max(200), endpoint: endpointSchema,
  apiFormat: z.enum(['chat_completions', 'responses']),
  outputTokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  thinkingEnabled: z.boolean().optional(),
  contextWindow: z.number().int().min(LONG_TEXT_LIMITS.minContextWindow).max(2_000_000),
  maxOutputTokens: maxOutputTokensSchema,
}).refine(m => m.maxOutputTokens * 2 <= m.contextWindow);
export type LongTextModel = z.infer<typeof modelSchema>;
const credentials = { model: modelSchema, apiKey: z.string().min(1).max(4096) };
export const queryFilterSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['attention', 'untranslated', 'edited']) }),
  z.strictObject({ kind: z.literal('search'), text: z.string().trim().min(1).max(LONG_TEXT_LIMITS.searchChars) }),
]);
export type QueryFilter = z.infer<typeof queryFilterSchema>;

export const longTextRequestSchemas = {
  list: z.strictObject({}),
  pickFiles: z.strictObject({ filterName: z.string().min(1).max(60), defaults: importDefaultsSchema }),
  importFiles: z.strictObject({ paths: z.array(absolutePath).min(1).max(LONG_TEXT_LIMITS.importPaths), source: z.enum(['picker', 'drop']), defaults: importDefaultsSchema }),
  importText: z.strictObject({ name: z.string().trim().max(LONG_TEXT_LIMITS.nameChars).optional(), text: z.string().min(1).max(LONG_TEXT_LIMITS.pasteChars), format: z.enum(LONG_TEXT_FORMATS), defaults: importDefaultsSchema }),
  read: z.strictObject({ documentId: id }),
  readPage: z.strictObject({ documentId: id, page: z.number().int().min(0).max(LONG_TEXT_LIMITS.segments) }),
  query: z.strictObject({ documentId: id, filter: queryFilterSchema, offset: z.number().int().min(0).max(LONG_TEXT_LIMITS.segments), limit: z.number().int().min(1).max(LONG_TEXT_LIMITS.queryLimit) }),
  locate: z.strictObject({ documentId: id, from: indexSchema, direction: z.enum(['next', 'previous']) }),
  estimate: z.strictObject({ documentId: id, scope: z.enum(['full', 'sample']), contextWindow: z.number().int().min(LONG_TEXT_LIMITS.minContextWindow).max(2_000_000), maxOutputTokens: maxOutputTokensSchema }),
  updateSettings: z.strictObject({ documentId: id, expectedRevision: rev, settings: settingsSchema, clearTranslations: z.boolean() }),
  confirmEncoding: z.strictObject({ documentId: id }),
  previewEncoding: z.strictObject({ documentId: id, encoding: encodingSchema }),
  resegment: z.strictObject({ documentId: id, encoding: encodingSchema.optional(), txtSplit: z.enum(TXT_SPLITS).optional(), discardTranslations: z.boolean() }),
  start: z.strictObject({ documentId: id, kind: z.enum(RUN_KINDS), fromIndex: indexSchema.optional(), resample: z.boolean().optional(), ...credentials })
    .refine(r => (r.kind === 'from') === (r.fromIndex !== undefined) && (r.resample === undefined || r.kind === 'sample')),
  retranslate: z.strictObject({ documentId: id, index: indexSchema, rev, instruction: z.string().trim().max(LONG_TEXT_LIMITS.instructionChars).optional(), ...credentials }),
  pause: z.strictObject({ documentId: id, immediate: z.boolean() }),
  edit: z.strictObject({ documentId: id, index: indexSchema, rev, text: z.string().max(LONG_TEXT_LIMITS.editChars) }),
  setLocked: z.strictObject({ documentId: id, index: indexSchema, rev, locked: z.boolean() }),
  undo: z.strictObject({ documentId: id, index: indexSchema, rev }),
  dismissFlag: z.strictObject({ documentId: id, index: indexSchema, rev, code: z.enum(FLAG_CODES) }),
  clear: z.strictObject({ documentId: id, keepLocked: z.boolean() }),
  readLedger: z.strictObject({ documentId: id }),
  updateLedger: z.strictObject({
    documentId: id,
    upserts: z.array(z.strictObject({
      id: id.optional(),
      source: z.string().trim().min(1).max(LONG_TEXT_LIMITS.termChars),
      target: z.string().trim().min(1).max(LONG_TEXT_LIMITS.termChars),
      confirmed: z.boolean(),
    })).max(500),
    deletes: z.array(id).max(LONG_TEXT_LIMITS.ledgerEntries),
  }),
  chooseExportFolder: z.strictObject({ documentId: id }),
  export: z.strictObject({ documentId: id, mode: z.enum(['target', 'bilingual']), destination: z.enum(['source', 'folder']) }),
  copy: z.strictObject({ documentId: id, mode: z.enum(['target', 'bilingual']) }),
  reveal: z.strictObject({ documentId: id, target: z.enum(['source', 'export']) }),
  rename: z.strictObject({ documentId: id, name: z.string().trim().min(1).max(LONG_TEXT_LIMITS.nameChars) }),
  remove: z.strictObject({ documentId: id }),
} as const;
export type LongTextMethod = keyof typeof longTextRequestSchemas;
export type LongTextRequest<K extends LongTextMethod> = z.infer<(typeof longTextRequestSchemas)[K]>;

export const LONG_TEXT_ERROR_CODES = ['invalid_request', 'unavailable', 'not_found', 'busy', 'conflict', 'revision_conflict',
  'file_unreadable', 'file_too_large', 'unsupported_format', 'subtitle_file', 'empty_document', 'binary_file', 'too_many_segments',
  'encoding_unconfirmed', 'source_missing', 'source_changed', 'translations_exist', 'same_language', 'nothing_to_do',
  'model_invalid', 'model_context_too_small', 'model_failed', 'unstable_output',
  'knowledge_unavailable', 'knowledge_invalid', 'storage_failed',
  'destination_unavailable', 'export_failed', 'name_exhausted', 'limit_exceeded', 'internal'] as const;
export type LongTextErrorCode = (typeof LONG_TEXT_ERROR_CODES)[number];
/** `model_failed` always carries `category`; `message` is only the provider's redacted words, ≤ 300 characters. */
export type LongTextError = { code: LongTextErrorCode; category?: ModelErrorCategory; message?: string };
export type LongTextResult<T> = { ok: true; value: T } | { ok: false; error: LongTextError };

/** The `value` of a successful response, per method. */
export interface LongTextValues {
  list: { documents: DocumentSummary[]; storageBytes: number };
  pickFiles: ImportResult;                   // a cancelled picker returns three empty arrays
  importFiles: ImportResult;
  importText: DocumentSummary;
  read: DocumentDetail;
  readPage: PageResult;                      // every row of the page, verbatim blocks included
  query: QueryResult;                        // sorted by index
  locate: { index: number; page: number; wrapped: boolean } | null;
  estimate: Estimate;
  updateSettings: DocumentDetail;
  confirmEncoding: DocumentDetail;
  previewEncoding: { lines: string[]; replacementChars: number };   // ≤ 8 lines of ≤ 200 characters
  resegment: DocumentDetail;
  start: { runId: string };
  retranslate: SegmentRow;
  pause: { status: 'pausing' | 'paused' };
  edit: SegmentRow;
  setLocked: SegmentRow;
  undo: SegmentRow;
  dismissFlag: SegmentRow;
  clear: { changed: number };
  readLedger: { entries: LedgerEntry[] };
  updateLedger: { entries: LedgerEntry[] };
  chooseExportFolder: { path: string } | null;
  export: { path: string; name: string; translated: number; untranslated: number };
  copy: { characters: number };
  reveal: Record<string, never>;
  rename: DocumentSummary;
  remove: Record<string, never>;
}

type LongTextInvokers = {
  [K in Exclude<LongTextMethod, 'list'>]: (request: LongTextRequest<K>) => Promise<LongTextResult<LongTextValues[K]>>;
};
/** `window.longText`: one method per request schema, plus the change event subscription. */
export interface LongTextApi extends LongTextInvokers {
  list(): Promise<LongTextResult<LongTextValues['list']>>;
  /** Invalid events are dropped. Returns the unsubscribe function. */
  onChanged(listener: (event: LongTextChangeEvent) => void): () => void;
}

