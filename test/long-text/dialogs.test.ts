import { describe, expect, it, vi } from 'vitest';
import type { DocumentDetail, LedgerEntry } from '../../src/long-text/contract';
import { knowledgeSelectionSchema, type KnowledgeSelection } from '../../src/translation-knowledge/execution-contract';

vi.hoisted(() => {
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
});

// The helpers under test never render; Radix primitives stay out of the node environment.
vi.mock('radix-ui', () => ({}));
vi.mock('@radix-ui/react-dialog', () => ({}));

const { compactCount, costRangeText, tokenRange } = await import('../../src/pages/Tools/Text/LongTextTranslator/dialogs/estimate-text');
const { clearedCount } = await import('../../src/pages/Tools/Text/LongTextTranslator/dialogs/ConfirmDialog');
const { defaultDestination, exportFileName } = await import('../../src/pages/Tools/Text/LongTextTranslator/dialogs/ExportDialog');
const { ledgerUpsert, visibleEntries } = await import('../../src/pages/Tools/Text/LongTextTranslator/dialogs/LedgerDialog');
const {
  changeLanguages, changeMaterials, defaultsFromSettings, draftFromDetail, effectiveSource, parseTokens, settingsFromDraft,
} = await import('../../src/pages/Tools/Text/LongTextTranslator/dialogs/SettingsDialog');
const { settingsSchema } = await import('../../src/long-text/contract');

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, failedRequests: 0, unknownRequests: 0 };

function detail(patch: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    id: uuid(1), revision: 3, name: 'novel.txt', format: 'txt', createdAt: 1, updatedAt: 2,
    source: { kind: 'file', fileName: 'novel.txt', directory: 'D:\\Books' },
    encoding: { name: 'gb18030', confidence: 'high', confirmed: true },
    languages: { source: 'ja', target: 'zh-Hans', sourceIsAuto: true }, style: 'literary',
    stats: { characters: 100, translatable: 10, pages: 1 },
    counts: { translatable: 10, done: 4, pending: 5, failed: 1, attention: 1, edited: 0, locked: 2 },
    usage, fullRunStarted: true, run: null, lastExport: null, journalIssues: 0,
    settings: {
      sourceLanguage: 'auto', targetLanguage: 'zh-Hans', style: 'literary', instructions: '', knowledge: null,
      profileId: null, pace: 2, batchSourceTokens: 1500, maxOutputTokens: null,
    },
    detected: { sourceLanguage: 'ja', style: 'literary' }, structure: { txtSplit: 'auto', resolved: 'line' },
    pages: [], ledger: { total: 0, confirmed: 0 }, sample: null, exportFolder: null,
    ...patch,
  };
}

const selection = (patch: Partial<KnowledgeSelection> = {}): KnowledgeSelection => ({
  version: 2, languagePair: { source: 'ja', target: 'zh-Hans' }, collectionIds: [uuid(7)], disabledEntryIds: [], ...patch,
});

function entry(n: number, patch: Partial<LedgerEntry> = {}): LedgerEntry {
  return { id: uuid(n), source: `term ${n}`, target: `译名 ${n}`, origin: 'model', confirmed: false, firstSeen: n, updatedAt: n, ...patch };
}

describe('estimate text', () => {
  it('adds input and output tokens per bound and collapses equal bounds', () => {
    expect(tokenRange({ inputTokens: [40_000, 60_000], outputTokens: [12_100, 24_600] })).toBe('52.1K–84.6K');
    expect(tokenRange({ inputTokens: [600, 600], outputTokens: [0, 0] })).toBe('600');
  });

  it('writes one currency sign for a cost range', () => {
    expect(costRangeText([0.031, 0.05])).toBe('$0.031–0.050');
    expect(costRangeText([1.2, 1.95])).toBe('$1.20–1.95');
    expect(costRangeText([2, 2])).toBe('$2.00');
    expect(costRangeText([0.00076, 0.0024])).toBe('<$0.001–0.0024');
    expect(costRangeText([0.00004, 0.0001])).toBe('<$0.001');
  });

  it('writes long counts compactly for the interface language', () => {
    expect(String(compactCount(382_123, 'zh'))).toBe('38.2万');
    expect(String(compactCount(382_123, 'en'))).toBe('382.1K');
    expect(String(compactCount(950, 'ja'))).toBe('950');
  });
});

describe('confirmations', () => {
  it('counts what clearing removes: done and failed segments, locked ones only when not kept', () => {
    const counts = { done: 4, failed: 1, locked: 2 };
    expect(clearedCount(counts, false)).toBe(5);
    expect(clearedCount(counts, true)).toBe(3);
  });
});

describe('export dialog', () => {
  it('previews the name the exporter writes first', () => {
    expect(exportFileName(detail(), 'target')).toBe('novel.zh-Hans.txt');
    expect(exportFileName(detail({ format: 'markdown', source: { kind: 'file', fileName: 'guide.markdown', directory: '/docs' } }), 'bilingual'))
      .toBe('guide.zh-Hans.bilingual.markdown');
    expect(exportFileName(detail({ name: '粘贴的文本 10-22 14:05', source: { kind: 'paste' }, format: 'markdown' }), 'target'))
      .toBe('粘贴的文本 10-22 14-05.zh-Hans.md');
  });

  it('exports beside the file until a folder is chosen; pasted text only has the folder', () => {
    expect(defaultDestination(detail())).toBe('source');
    expect(defaultDestination(detail({ exportFolder: 'E:\\Exports' }))).toBe('folder');
    expect(defaultDestination(detail({ source: { kind: 'paste' } }))).toBe('folder');
  });
});

describe('glossary dialog', () => {
  it('lists the newest entries first and filters by source or translation, ignoring case and width', () => {
    const entries = [entry(1, { source: 'Alice', target: '爱丽丝' }), entry(2, { source: 'ＢＯＢ', target: '鲍勃' }), entry(3, { source: 'Carol', target: '卡罗尔' })];
    expect(visibleEntries(entries, '').map(item => item.source)).toEqual(['Carol', 'ＢＯＢ', 'Alice']);
    expect(visibleEntries(entries, ' bob ').map(item => item.target)).toEqual(['鲍勃']);
    expect(visibleEntries(entries, '丽').map(item => item.source)).toEqual(['Alice']);
  });

  it('saves a row only with both sides filled in, trimmed and within 80 characters', () => {
    expect(ledgerUpsert({ source: ' アリス ', target: '爱丽丝 ', confirmed: true }, uuid(4)))
      .toEqual({ id: uuid(4), source: 'アリス', target: '爱丽丝', confirmed: true });
    expect(ledgerUpsert({ source: 'アリス', target: '爱丽丝', confirmed: false })).toEqual({ source: 'アリス', target: '爱丽丝', confirmed: false });
    expect(ledgerUpsert({ source: 'アリス', target: '  ', confirmed: true })).toBeNull();
    expect(ledgerUpsert({ source: 'x'.repeat(81), target: 'y', confirmed: true })).toBeNull();
  });
});

describe('settings dialog', () => {
  it('starts from the document settings, with the materials on the effective languages', () => {
    const draft = draftFromDetail(detail());
    expect(draft).toMatchObject({ sourceLanguage: 'auto', targetLanguage: 'zh-Hans', batchSourceTokens: '1500', maxOutputTokens: '', txtSplit: 'auto' });
    expect(draft.materials).toEqual({ version: 2, languagePair: { source: 'ja', target: 'zh-Hans' }, collectionIds: [], disabledEntryIds: [] });
    const markdown = draftFromDetail(detail({ structure: null, settings: { ...detail().settings, knowledge: selection({ languagePair: { source: 'en', target: 'zh-Hans' } }) } }));
    expect(markdown.txtSplit).toBeNull();
    expect(markdown.materials.languagePair).toEqual({ source: 'ja', target: 'zh-Hans' });
  });

  it('moves the materials with the page languages and keeps their collections', () => {
    const draft = draftFromDetail(detail({ settings: { ...detail().settings, knowledge: selection() } }));
    const english = changeLanguages(draft, { sourceLanguage: 'en' }, 'ja');
    expect(english.materials).toMatchObject({ languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [uuid(7)] });
    const back = changeLanguages(english, { sourceLanguage: 'auto', targetLanguage: 'en' }, 'ja');
    expect(back.materials.languagePair).toEqual({ source: 'ja', target: 'en' });
    expect(effectiveSource('auto', 'ko')).toBe('ko');
    expect(effectiveSource('fr', 'ko')).toBe('fr');
  });

  it('takes a source language the picker brings, unless a run locks the languages', () => {
    const draft = draftFromDetail(detail());
    const preset = selection({ languagePair: { source: 'en', target: 'zh-Hans' } });
    const adopted = changeMaterials(draft, preset, 'ja', false);
    expect(adopted.sourceLanguage).toBe('en');
    expect(adopted.materials.languagePair).toEqual({ source: 'en', target: 'zh-Hans' });
    const locked = changeMaterials(draft, preset, 'ja', true);
    expect(locked.sourceLanguage).toBe('auto');
    expect(locked.materials).toMatchObject({ languagePair: { source: 'ja', target: 'zh-Hans' }, collectionIds: [uuid(7)] });
    // The picker's unset source and the detected language itself leave "auto" alone.
    expect(changeMaterials(draft, selection({ languagePair: { source: '', target: 'zh-Hans' } }), 'ja', false).sourceLanguage).toBe('auto');
    expect(changeMaterials(draft, selection(), 'ja', false).sourceLanguage).toBe('auto');
  });

  it('reads typed token counts within the schema bounds', () => {
    const batch = settingsSchema.shape.batchSourceTokens;
    const output = settingsSchema.shape.maxOutputTokens.unwrap();
    expect(parseTokens(' 2000 ', batch)).toBe(2000);
    expect(parseTokens('499', batch)).toBeNull();
    expect(parseTokens('4001', batch)).toBeNull();
    expect(parseTokens('1500.5', batch)).toBeNull();
    expect(parseTokens('', batch)).toBeNull();
    expect(parseTokens('32768', output)).toBe(32768);
    expect(parseTokens('1000', output)).toBeNull();
  });

  it('saves materials only with collections, on the page languages and valid for knowledgeSelectionSchema', () => {
    const draft = draftFromDetail(detail());
    expect(settingsFromDraft(draft, 'ja')).toMatchObject({ knowledge: null, batchSourceTokens: 1500, maxOutputTokens: null });
    const chosen = changeLanguages({ ...draft, materials: selection({ languagePair: { source: '', target: 'zh-Hans' } }) }, {}, 'ja');
    const settings = settingsFromDraft(chosen, 'ja');
    expect(settings?.knowledge?.languagePair).toEqual({ source: 'ja', target: 'zh-Hans' });
    expect(knowledgeSelectionSchema.safeParse(settings?.knowledge).success).toBe(true);
    expect(settingsSchema.safeParse(settings).success).toBe(true);
    expect(settingsFromDraft({ ...draft, maxOutputTokens: '16384' }, 'ja')?.maxOutputTokens).toBe(16384);
    expect(settingsFromDraft({ ...draft, batchSourceTokens: '50' }, 'ja')).toBeNull();
    expect(settingsFromDraft({ ...draft, maxOutputTokens: 'auto' }, 'ja')).toBeNull();
  });

  it('hands new documents the saved settings, letting the style follow the content when it matches the suggestion', () => {
    const settings = { ...detail().settings, targetLanguage: 'en' as const, knowledge: selection(), profileId: 'profile-1' };
    expect(defaultsFromSettings(settings, 'literary')).toEqual({
      targetLanguage: 'en', style: null, instructions: '', profileId: 'profile-1', pace: 2,
      batchSourceTokens: 1500, maxOutputTokens: null, knowledgeCollectionIds: [uuid(7)],
    });
    expect(defaultsFromSettings({ ...settings, style: 'technical' }, 'literary').style).toBe('technical');
  });
});
