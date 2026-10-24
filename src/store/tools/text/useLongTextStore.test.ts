import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importDefaultsSchema } from '@/long-text/contract';
import type { LongTextDefaults } from './useLongTextStore';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size; },
    },
  });
  return values;
});

const KEY = 'fusionkit-long-text';
const docId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const collectionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function loadStore() {
  vi.resetModules();
  return import('./useLongTextStore');
}

function persisted(): { version: number; state: Record<string, unknown> } {
  return JSON.parse(storage.get(KEY) ?? 'null');
}

beforeEach(() => {
  storage.clear();
});

describe('useLongTextStore', () => {
  it('starts from the defaults', async () => {
    const { useLongTextStore, DEFAULT_LONG_TEXT_PREFERENCES } = await loadStore();
    expect(useLongTextStore.getState()).toMatchObject(DEFAULT_LONG_TEXT_PREFERENCES);
    expect(DEFAULT_LONG_TEXT_PREFERENCES).toMatchObject({
      activeDocumentId: null, follow: true, exportMode: 'target', view: { targetOnly: false }, pageByDocument: {},
      defaults: { targetLanguage: null, style: null, instructions: '', profileId: null, pace: 2, batchSourceTokens: 1500, maxOutputTokens: null, knowledgeCollectionIds: [] },
    });
  });

  it('persists every preference under its key and restores it after a reload', async () => {
    const first = (await loadStore()).useLongTextStore;
    const defaults: LongTextDefaults = { targetLanguage: 'ja', style: 'literary', instructions: '人名用常见译名', profileId: 'profile-1', pace: 4, batchSourceTokens: 2500, maxOutputTokens: 4096, knowledgeCollectionIds: [collectionId] };
    first.getState().setDefaults(defaults);
    first.getState().setView({ targetOnly: true });
    first.getState().setFollow(false);
    first.getState().setExportMode('bilingual');
    first.getState().rememberPage(docId(1), 12);
    first.getState().setActiveDocument(docId(1));
    expect(persisted().version).toBe(1);

    const second = (await loadStore()).useLongTextStore.getState();
    expect(second).toMatchObject({
      activeDocumentId: docId(1), defaults, view: { targetOnly: true }, follow: false, exportMode: 'bilingual', pageByDocument: { [docId(1)]: 12 },
    });
  });

  it('replaces invalid stored values with the defaults before hydration', async () => {
    storage.set(KEY, JSON.stringify({
      version: 1,
      state: {
        activeDocumentId: 'not-a-uuid',
        defaults: { targetLanguage: 'it', style: 'poetic', instructions: 'x'.repeat(4001), profileId: '', pace: 3, batchSourceTokens: 100, maxOutputTokens: 512, knowledgeCollectionIds: ['nope'] },
        view: { targetOnly: 'yes' },
        follow: 1,
        exportMode: 'pdf',
        pageByDocument: { 'not-a-uuid': 1, [docId(1)]: -1, [docId(2)]: 2.5, [docId(3)]: 7 },
        documents: [{ name: 'novel.txt' }],
      },
    }));
    const { useLongTextStore, DEFAULT_LONG_TEXT_PREFERENCES } = await loadStore();
    const state = useLongTextStore.getState();
    expect(state).toMatchObject({ ...DEFAULT_LONG_TEXT_PREFERENCES, pageByDocument: { [docId(3)]: 7 } });
    expect(state.pageByDocument).toEqual({ [docId(3)]: 7 });
    expect(state).not.toHaveProperty('documents');
  });

  it('keeps the valid fields of a partly damaged value', async () => {
    const { sanitizeLongTextState } = await loadStore();
    const state = sanitizeLongTextState({
      defaults: { targetLanguage: 'ko', pace: 'fast', knowledgeCollectionIds: [collectionId, collectionId] },
      follow: false,
    });
    expect(state.defaults).toMatchObject({ targetLanguage: 'ko', pace: 2, knowledgeCollectionIds: [collectionId] });
    expect(state.follow).toBe(false);
    expect(sanitizeLongTextState(null)).toEqual(sanitizeLongTextState({}));
  });

  it('sanitizes a stored value of another version through migrate', async () => {
    storage.set(KEY, JSON.stringify({ version: 0, state: { follow: false, exportMode: 'zip', defaults: { targetLanguage: 'fr' } } }));
    const state = (await loadStore()).useLongTextStore.getState();
    expect(state).toMatchObject({ follow: false, exportMode: 'target', defaults: { targetLanguage: 'fr', pace: 2 } });
    expect(persisted().version).toBe(1);
  });

  it('keeps the current default when a patch is invalid', async () => {
    const { useLongTextStore } = await loadStore();
    useLongTextStore.getState().setDefaults({ pace: 4, batchSourceTokens: 3000 });
    useLongTextStore.getState().setDefaults({ pace: 3 as never, batchSourceTokens: 9000, instructions: '更口语' });
    expect(useLongTextStore.getState().defaults).toMatchObject({ pace: 4, batchSourceTokens: 3000, instructions: '更口语' });
  });

  it('remembers the last page of at most 50 documents, forgetting the least recently visited', async () => {
    const { useLongTextStore, REMEMBERED_PAGES } = await loadStore();
    const store = useLongTextStore.getState();
    for (let n = 0; n < REMEMBERED_PAGES; n++) store.rememberPage(docId(n), n);
    store.setActiveDocument(docId(0));          // visiting document 0 makes document 1 the oldest
    store.rememberPage(docId(2), 40);
    store.rememberPage(docId(REMEMBERED_PAGES), 1);

    const pages = useLongTextStore.getState().pageByDocument;
    expect(Object.keys(pages)).toHaveLength(REMEMBERED_PAGES);
    expect(pages).not.toHaveProperty(docId(1));
    expect(pages[docId(0)]).toBe(0);
    expect(pages[docId(2)]).toBe(40);
    expect(Object.keys(pages).slice(-3)).toEqual([docId(0), docId(2), docId(REMEMBERED_PAGES)]);
    expect(Object.keys(persisted().state.pageByDocument as object)).toEqual(Object.keys(pages));
  });

  it('keeps the 50 most recent pages of a longer stored list', async () => {
    const stored = Object.fromEntries(Array.from({ length: 60 }, (_, n) => [docId(n), n]));
    storage.set(KEY, JSON.stringify({ version: 1, state: { pageByDocument: stored } }));
    const pages = (await loadStore()).useLongTextStore.getState().pageByDocument;
    expect(Object.keys(pages)).toEqual(Array.from({ length: 50 }, (_, n) => docId(n + 10)));
  });

  it('ignores invalid documents and pages', async () => {
    const { useLongTextStore } = await loadStore();
    const before = useLongTextStore.getState();
    before.rememberPage('../../etc', 1);
    before.rememberPage(docId(1), -1);
    before.rememberPage(docId(1), 1.5);
    before.setActiveDocument('not-a-uuid');
    expect(useLongTextStore.getState()).toBe(before);
  });

  it('clears the active document and keeps the view when a patch leaves it out', async () => {
    const { useLongTextStore } = await loadStore();
    const store = useLongTextStore.getState();
    store.setActiveDocument(docId(1));
    store.setView({ targetOnly: true });
    store.setView({});
    store.setActiveDocument(null);
    expect(useLongTextStore.getState()).toMatchObject({ activeDocumentId: null, view: { targetOnly: true } });
  });

  it('forgets a deleted document', async () => {
    const { useLongTextStore } = await loadStore();
    const store = useLongTextStore.getState();
    store.rememberPage(docId(1), 3);
    store.rememberPage(docId(2), 4);
    store.setActiveDocument(docId(1));
    store.forgetDocument(docId(1));
    expect(useLongTextStore.getState()).toMatchObject({ activeDocumentId: null, pageByDocument: { [docId(2)]: 4 } });
    expect(useLongTextStore.getState().pageByDocument).not.toHaveProperty(docId(1));
  });

  it('never persists keys, document content or runtime state', async () => {
    const { useLongTextStore } = await loadStore();
    useLongTextStore.getState().setDefaults({ instructions: 'keep', apiKey: 'sk-secret-key' } as never);
    useLongTextStore.setState({ apiKey: 'sk-secret-key', documents: [{ source: 'private paragraph' }], defaults: { ...useLongTextStore.getState().defaults, apiKey: 'sk-secret-key' } } as never);
    const serialized = storage.get(KEY) ?? '';
    expect(serialized).toContain('keep');
    expect(serialized).not.toMatch(/apiKey|sk-secret-key|private paragraph|documents/u);
    expect(Object.keys(persisted().state).sort()).toEqual(['activeDocumentId', 'defaults', 'exportMode', 'follow', 'pageByDocument', 'view']);
  });
});

describe('toImportDefaults', () => {
  it('uses the last used target language', async () => {
    const { toImportDefaults, DEFAULT_LONG_TEXT_PREFERENCES } = await loadStore();
    const defaults = { ...DEFAULT_LONG_TEXT_PREFERENCES.defaults, targetLanguage: 'ko' as const, knowledgeCollectionIds: [collectionId] };
    const value = toImportDefaults(defaults, 'en');
    expect(value).toEqual({ ...defaults, targetLanguage: 'ko' });
    expect(importDefaultsSchema.safeParse(value).success).toBe(true);
  });

  it('derives the target from the interface language otherwise', async () => {
    const { toImportDefaults, DEFAULT_LONG_TEXT_PREFERENCES } = await loadStore();
    const target = (language: string) => toImportDefaults(DEFAULT_LONG_TEXT_PREFERENCES.defaults, language).targetLanguage;
    expect(target('zh')).toBe('zh-Hans');
    expect(target('zh-Hant')).toBe('zh-Hant');
    expect(target('en')).toBe('en');
    expect(target('ja')).toBe('ja');
    expect(target('xx')).toBe('zh-Hans');
    expect(importDefaultsSchema.safeParse(toImportDefaults(DEFAULT_LONG_TEXT_PREFERENCES.defaults, 'en')).success).toBe(true);
  });
});
