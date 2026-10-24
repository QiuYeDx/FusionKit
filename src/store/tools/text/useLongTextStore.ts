import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { z } from 'zod';
import {
  importDefaultsSchema,
  languageSchema,
  longTextRequestSchemas,
  type ImportDefaults,
  type LanguageTag,
  type LongTextRequest,
} from '@/long-text/contract';
import { isLanguageTag } from '@/long-text/languages';

export const LONG_TEXT_STORAGE_KEY = 'fusionkit-long-text';
export const LONG_TEXT_STORE_VERSION = 1;
/** Documents whose last page is remembered; the least recently visited one is forgotten first. */
export const REMEMBERED_PAGES = 50;

/**
 * What a new document starts with. `targetLanguage: null` follows the interface language and
 * `style: null` lets the importer suggest one from the content.
 */
export type LongTextDefaults = Omit<ImportDefaults, 'targetLanguage'> & { targetLanguage: LanguageTag | null };
export type ExportMode = LongTextRequest<'export'>['mode'];

export interface LongTextPreferences {
  activeDocumentId: string | null;
  defaults: LongTextDefaults;
  view: { targetOnly: boolean };
  /** Follow the run's progress in the reader. */
  follow: boolean;
  exportMode: ExportMode;
  /** Last page per document id, least recently visited first. */
  pageByDocument: Record<string, number>;
}

export interface LongTextStoreState extends LongTextPreferences {
  setActiveDocument: (documentId: string | null) => void;
  setDefaults: (patch: Partial<LongTextDefaults>) => void;
  setView: (patch: Partial<LongTextPreferences['view']>) => void;
  setFollow: (follow: boolean) => void;
  setExportMode: (mode: ExportMode) => void;
  rememberPage: (documentId: string, page: number) => void;
  forgetDocument: (documentId: string) => void;
}

export const DEFAULT_LONG_TEXT_PREFERENCES: LongTextPreferences = {
  activeDocumentId: null,
  defaults: {
    targetLanguage: null, style: null, instructions: '', profileId: null,
    pace: 2, batchSourceTokens: 1500, maxOutputTokens: null, knowledgeCollectionIds: [],
  },
  view: { targetOnly: false },
  follow: true,
  exportMode: 'target',
  pageByDocument: {},
};

const documentIdSchema = longTextRequestSchemas.read.shape.documentId;
const pageSchema = longTextRequestSchemas.readPage.shape.page;
const exportModeSchema = longTextRequestSchemas.export.shape.mode;
const defaultsShape = importDefaultsSchema.shape;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function read<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** Each invalid field keeps its `fallback` value. */
function readDefaults(value: unknown, fallback: LongTextDefaults): LongTextDefaults {
  const saved = isRecord(value) ? value : {};
  return {
    targetLanguage: read(languageSchema.nullable(), saved.targetLanguage, fallback.targetLanguage),
    style: read(defaultsShape.style, saved.style, fallback.style),
    instructions: read(defaultsShape.instructions, saved.instructions, fallback.instructions),
    profileId: read(defaultsShape.profileId, saved.profileId, fallback.profileId),
    pace: read(defaultsShape.pace, saved.pace, fallback.pace),
    batchSourceTokens: read(defaultsShape.batchSourceTokens, saved.batchSourceTokens, fallback.batchSourceTokens),
    maxOutputTokens: read(defaultsShape.maxOutputTokens, saved.maxOutputTokens, fallback.maxOutputTokens),
    knowledgeCollectionIds: [...new Set(read(defaultsShape.knowledgeCollectionIds, saved.knowledgeCollectionIds, fallback.knowledgeCollectionIds))],
  };
}

function readPages(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value).flatMap(([documentId, page]) => {
    const parsed = pageSchema.safeParse(page);
    return parsed.success && documentIdSchema.safeParse(documentId).success ? [[documentId, parsed.data] as const] : [];
  });
  return Object.fromEntries(entries.slice(-REMEMBERED_PAGES));
}

/** The persisted preferences of any stored value; invalid fields fall back to their defaults. */
export function sanitizeLongTextState(value: unknown): LongTextPreferences {
  const saved = isRecord(value) ? value : {};
  const fallback = DEFAULT_LONG_TEXT_PREFERENCES;
  const view = isRecord(saved.view) ? saved.view : {};
  return {
    activeDocumentId: read(documentIdSchema.nullable(), saved.activeDocumentId, fallback.activeDocumentId),
    defaults: readDefaults(saved.defaults, fallback.defaults),
    view: { targetOnly: typeof view.targetOnly === 'boolean' ? view.targetOnly : fallback.view.targetOnly },
    follow: typeof saved.follow === 'boolean' ? saved.follow : fallback.follow,
    exportMode: read(exportModeSchema, saved.exportMode, fallback.exportMode),
    pageByDocument: readPages(saved.pageByDocument),
  };
}

/** Moves the document to the most recently visited end and forgets the oldest beyond the limit. */
function visit(pages: Record<string, number>, documentId: string, page: number): Record<string, number> {
  const entries = Object.entries(pages).filter(([id]) => id !== documentId);
  entries.push([documentId, page]);
  return Object.fromEntries(entries.slice(-REMEMBERED_PAGES));
}

/**
 * Import defaults for new documents: the last used target language, otherwise the interface
 * language's (zh, the only interface language that is not a tag itself, means Simplified Chinese).
 * The main process replaces a target equal to the detected source language.
 */
export function toImportDefaults(defaults: LongTextDefaults, interfaceLanguage: string): ImportDefaults {
  const targetLanguage = defaults.targetLanguage ?? (isLanguageTag(interfaceLanguage) ? interfaceLanguage : 'zh-Hans');
  return { ...defaults, targetLanguage };
}

/**
 * Page preferences of the long text translator. Documents and their settings belong to the main
 * process and API keys to the model profiles; this store keeps only the defaults for new documents
 * and where the user left off.
 */
export const useLongTextStore = create<LongTextStoreState>()(persist(
  set => ({
    ...DEFAULT_LONG_TEXT_PREFERENCES,
    setActiveDocument: documentId => set(state => {
      if (documentId === null) return { activeDocumentId: null };
      if (!documentIdSchema.safeParse(documentId).success) return state;
      const page = state.pageByDocument[documentId];
      return { activeDocumentId: documentId, ...(page === undefined ? {} : { pageByDocument: visit(state.pageByDocument, documentId, page) }) };
    }),
    setDefaults: patch => set(state => ({ defaults: readDefaults({ ...state.defaults, ...patch }, state.defaults) })),
    setView: patch => set(state => ({ view: { targetOnly: patch.targetOnly ?? state.view.targetOnly } })),
    setFollow: follow => set({ follow }),
    setExportMode: exportMode => set({ exportMode }),
    rememberPage: (documentId, page) => set(state => {
      if (!documentIdSchema.safeParse(documentId).success || !pageSchema.safeParse(page).success) return state;
      const ids = Object.keys(state.pageByDocument);
      if (ids[ids.length - 1] === documentId && state.pageByDocument[documentId] === page) return state;
      return { pageByDocument: visit(state.pageByDocument, documentId, page) };
    }),
    forgetDocument: documentId => set(state => ({
      activeDocumentId: state.activeDocumentId === documentId ? null : state.activeDocumentId,
      pageByDocument: Object.fromEntries(Object.entries(state.pageByDocument).filter(([id]) => id !== documentId)),
    })),
  }),
  {
    name: LONG_TEXT_STORAGE_KEY,
    version: LONG_TEXT_STORE_VERSION,
    storage: createJSONStorage(() => localStorage),
    partialize: state => sanitizeLongTextState(state),
    migrate: persisted => sanitizeLongTextState(persisted),
    merge: (persisted, current) => ({ ...current, ...sanitizeLongTextState(persisted) }),
  },
));
