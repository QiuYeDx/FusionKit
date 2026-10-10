import { describe, expect, it } from 'vitest';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import type { TranslationDraft } from '@/services/subtitle-studio/translation-draft';
import { appliedHints, captureLanguagePair, hintsToOffer, materialNames, mergeHints, preferredCollection } from './knowledge-hints';

const SOURCE = 'テイムフィールド家のお嬢様';
const hint = (source: string, target: string, cueIds: string[]) => ({ source, target, cueIds });
const library = (entries: { source: string; target: string; state?: string; aliases?: string[]; pair?: { source: string; target: string } }[]) => ({
  generation: 1, approvals: {}, imports: [],
  data: {
    collections: [{ id: 'c1', name: '绝区零 · 人物', archived: false }, { id: 'c2', name: '旧资料', archived: true }, { id: 'c3', name: '方案资料', archived: false }],
    recipes: [{ id: 'r1', name: '绝区零方案', readCollectionIds: ['c2', 'c3'] }],
    entries: entries.map((entry, index) => ({ id: `e${index}`, kind: 'term', state: entry.state ?? 'ready', collectionId: 'c1',
      scope: { languagePair: entry.pair ?? { source: 'ja', target: 'zh-Hans' } }, payload: { source: entry.source, target: entry.target, aliases: entry.aliases ?? [] } })),
  },
}) as unknown as LibrarySnapshot;
const draft = (selection: Partial<TranslationDraft['selection']>) => ({ selection: { version: 1, languagePair: { source: '', target: 'zh-Hans' }, collectionIds: [], bindings: [], confirmations: [], disabledEntryIds: [], ...selection } }) as TranslationDraft;

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
    const held = library([{ source: SOURCE, target: '泰姆菲尔德家的大小姐' }, { source: 'ホロウ', target: '虚空' }, { source: 'エーテル', target: '以太', state: 'archived' }]);
    expect(hintsToOffer(hints, held, { source: 'ja', target: 'zh-Hans' }).map(item => item.source)).toEqual(['ホロウ', 'エーテル']);
    // An alias counts, and an unknown source language still compares the target language.
    expect(hintsToOffer([hint('ホロウ（空洞）', '空洞', ['x'])], library([{ source: 'ホロウ', target: '空洞', aliases: ['ホロウ（空洞）'] }]), { target: 'zh-Hans' })).toEqual([]);
    expect(hintsToOffer(hints, library([{ source: SOURCE, target: '泰姆菲尔德家的大小姐', pair: { source: 'ja', target: 'zh-Hant' } }]), { target: 'zh-Hans' })).toHaveLength(3);
    expect(hintsToOffer(hints, null, {})).toHaveLength(3);
  });

  it('chooses the language pair and the collection kept wordings go to', () => {
    expect(captureLanguagePair(draft({ languagePair: { source: 'ja', target: 'zh-Hans' } }), undefined, 'zh')).toEqual({ source: 'ja', target: 'zh-Hans' });
    expect(captureLanguagePair(undefined, draft({ languagePair: { source: 'en', target: 'zh-Hans' } }), 'zh-TW')).toEqual({ source: 'en', target: 'zh-Hant' });
    expect(captureLanguagePair(undefined, undefined, undefined)).toEqual({});
    const snapshot = library([]);
    expect(preferredCollection(draft({ collectionIds: ['c2', 'c1'] }).selection, snapshot)).toBe('c1');
    expect(preferredCollection(draft({ recipeId: 'r1' }).selection, snapshot)).toBe('c3');
    expect(preferredCollection(undefined, snapshot)).toBeUndefined();
    expect(materialNames(draft({ recipeId: 'r1', collectionIds: ['c1'] }).selection, snapshot)).toEqual(['绝区零方案', '绝区零 · 人物']);
  });
});
