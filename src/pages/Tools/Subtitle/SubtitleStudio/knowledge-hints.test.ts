import { describe, expect, it } from 'vitest';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import type { TranslationDraft } from '@/services/subtitle-studio/translation-draft';
import { appliedHints, captureLanguagePair, hintsToOffer, materialNames, mergeHints, preferredCollection } from './knowledge-hints';

const SOURCE = 'テイムフィールド家のお嬢様';
const JA_ZH = { source: 'ja', target: 'zh-Hans' };
const hint = (source: string, target: string, cueIds: string[]) => ({ source, target, cueIds });
const library = (entries: { source: string; target: string; enabled?: boolean; aliases?: string[]; collectionId?: string }[]) => ({
  generation: 1,
  data: {
    collections: [{ id: 'c1', name: '绝区零 · 人物', languagePair: JA_ZH, archived: false }, { id: 'c2', name: '旧资料', languagePair: JA_ZH, archived: true },
      { id: 'c3', name: '繁体资料', languagePair: { source: 'ja', target: 'zh-Hant' }, archived: false }],
    entries: entries.map((entry, index) => ({ id: `e${index}`, kind: 'term', enabled: entry.enabled ?? true, collectionId: entry.collectionId ?? 'c1',
      payload: { source: entry.source, target: entry.target, aliases: entry.aliases ?? [] } })),
    presets: [],
  },
}) as unknown as LibrarySnapshot;
const draft = (selection: Partial<TranslationDraft['selection']>) => ({ selection: { version: 2, languagePair: { source: '', target: 'zh-Hans' }, collectionIds: [], disabledEntryIds: [], ...selection } }) as TranslationDraft;

describe('wordings an applied revision offers', () => {
  it('merges wordings of several calls and keeps those the user applied', () => {
    const merged = mergeHints([hint(SOURCE, '泰姆菲尔德家的大小姐', ['a'])], [hint(` ${SOURCE}`, '泰姆菲尔德家的大小姐', ['b']), hint('ホロウ', '空洞', ['c'])]);
    expect(merged).toEqual([hint(SOURCE, '泰姆菲尔德家的大小姐', ['a', 'b']), hint('ホロウ', '空洞', ['c'])]);
    expect(appliedHints(merged, new Set(['b']))).toEqual([merged[0]]);
    expect(appliedHints(undefined, new Set(['a']))).toEqual([]);
    expect(mergeHints([], Array.from({ length: 12 }, (_, index) => hint(`語${index}`, `词${index}`, [`${index}`])))).toHaveLength(10);
  });

  it('offers only wordings the library does not already hold with the same translation', () => {
    const hints = [hint(SOURCE, '泰姆菲尔德家的大小姐', ['a']), hint('ホロウ', '空洞', ['b']), hint('エーテル', '以太', ['c'])];
    const held = library([{ source: SOURCE, target: '泰姆菲尔德家的大小姐' }, { source: 'ホロウ', target: '虚空' }, { source: 'エーテル', target: '以太', enabled: false }]);
    expect(hintsToOffer(hints, held, JA_ZH).map(item => item.source)).toEqual(['ホロウ', 'エーテル']);
    // An alias counts, and an unknown source language still compares the target language.
    expect(hintsToOffer([hint('ホロウ（空洞）', '空洞', ['x'])], library([{ source: 'ホロウ', target: '空洞', aliases: ['ホロウ（空洞）'] }]), { target: 'zh-Hans' })).toEqual([]);
    // The direction comes from the collection the entry belongs to.
    expect(hintsToOffer(hints, library([{ source: SOURCE, target: '泰姆菲尔德家的大小姐', collectionId: 'c3' }]), { target: 'zh-Hans' })).toHaveLength(3);
    expect(hintsToOffer(hints, null, {})).toHaveLength(3);
  });

  it('chooses the language pair and the collection kept wordings go to', () => {
    expect(captureLanguagePair(draft({ languagePair: JA_ZH }), undefined, 'zh')).toEqual(JA_ZH);
    expect(captureLanguagePair(undefined, draft({ languagePair: { source: 'en', target: 'zh-Hans' } }), 'zh-TW')).toEqual({ source: 'en', target: 'zh-Hant' });
    expect(captureLanguagePair(undefined, undefined, undefined)).toEqual({});
    const snapshot = library([]);
    expect(preferredCollection(draft({ collectionIds: ['c2', 'c1'] }).selection, snapshot)).toBe('c1');
    expect(preferredCollection(draft({ collectionIds: ['c2'] }).selection, snapshot)).toBeUndefined();
    expect(preferredCollection(undefined, snapshot)).toBeUndefined();
    expect(materialNames(draft({ collectionIds: ['c1', 'c3', 'gone'] }).selection, snapshot)).toEqual(['绝区零 · 人物', '繁体资料']);
  });
});
