import { describe, expect, it } from 'vitest';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import { compileKnowledge, resolveEnvironment, selectBatchKnowledge } from '../../src/translation-knowledge/execution';
import type { KnowledgeSelection } from '../../src/translation-knowledge/execution-contract';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import { buildFrozenKnowledgeSnapshot, captureKnowledgeSelectionData, validateFrozenKnowledgeSnapshot } from '../../src/translation-knowledge/snapshot-contract';
import { knowledgeFixture } from './fixtures';

const library = (): LibrarySnapshot => ({ generation: 3, data: knowledgeFixture() });
const [game, common] = knowledgeFixture().collections;
const cueId = '70000000-0000-4000-8000-000000000001';
const cues = [{ id: cueId, text: 'Reach the checkpoint before the boss.', sourceLanguage: 'en' }];
const selection = (patch: Partial<KnowledgeSelection> = {}): KnowledgeSelection => ({ version: 2, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [game.id], disabledEntryIds: [], ...patch });
function freeze(snapshot = library(), input = selection()) {
  const environment = resolveEnvironment(snapshot, input, cues);
  return buildFrozenKnowledgeSnapshot(snapshot, input, { batch: compileKnowledge(selectBatchKnowledge(environment, [cueId])) });
}

describe('frozen execution knowledge', () => {
  it('captures the selected collections with every entry, including disabled ones, and nothing else', () => {
    const snapshot = library();
    const data = captureKnowledgeSelectionData(snapshot, selection());
    expect(data.collections).toEqual([game]);
    expect(data.entries).toEqual(snapshot.data.entries.filter(entry => entry.collectionId === game.id));
    expect(data.entries.some(entry => !entry.enabled)).toBe(true);
    expect(data.presets).toEqual([]);
    expect(data.extensions).toBeUndefined();
  });

  it('keeps entries excluded from another collection so the record can explain them', () => {
    const snapshot = library();
    const excluded = snapshot.data.entries.find(entry => entry.collectionId === common.id)!;
    const data = captureKnowledgeSelectionData(snapshot, selection({ disabledEntryIds: [excluded.id] }));
    expect(data.collections.map(item => item.id)).toEqual([game.id, common.id]);
    expect(data.entries).toContainEqual(excluded);
    expect(data.entries.filter(entry => entry.collectionId === common.id)).toEqual([excluded]);
  });

  it('builds a self-contained, stable and isolated snapshot', () => {
    const snapshot = library();
    const frozen = freeze(snapshot);
    expect(frozen).toMatchObject({ version: 2, generation: 3, selection: selection() });
    expect(freeze(library()).digest).toBe(frozen.digest);
    const before = structuredClone(frozen);
    snapshot.data.entries[0].enabled = false;
    snapshot.data.collections[0].name = 'Renamed';
    expect(frozen).toEqual(before);
    expect(validateFrozenKnowledgeSnapshot(structuredClone(frozen))).toEqual(frozen);
  });

  it('normalizes absent optional choices before hashing', () => {
    const explicit = freeze(library(), { ...selection(), instructions: undefined });
    expect(explicit.digest).toBe(freeze().digest);
    expect('instructions' in explicit.selection).toBe(false);
  });

  it('rejects tampering, foreign content and older snapshot versions', () => {
    const frozen = freeze();
    const reject = (mutate: (value: any) => void) => {
      const copy = structuredClone(frozen) as any;
      mutate(copy);
      copy.digest = sha256Canonical((({ digest: _digest, ...base }) => base)(copy));
      expect(() => validateFrozenKnowledgeSnapshot(copy)).toThrow();
    };
    expect(() => validateFrozenKnowledgeSnapshot({ ...frozen, digest: '0'.repeat(64) })).toThrow();
    reject(value => { value.version = 1; });
    reject(value => { value.approvals = {}; });
    reject(value => { value.data.entries.push({ ...value.data.entries[0], id: '50000000-0000-4000-8000-0000000002ff', collectionId: common.id }); });
    reject(value => { value.data.entries = value.data.entries.filter((entry: { id: string }) => entry.id !== value.batches.batch.items[0].entryId); });
    reject(value => { value.batches.batch.items[0].payload.target = 'changed'; });
    reject(value => { value.batches.batch.items[0].required = !value.batches.batch.items[0].required; });
    reject(value => { const item = value.data.entries.find((entry: { id: string }) => entry.id === value.batches.batch.items[0].entryId); item.enabled = false; });
    reject(value => { value.selection.disabledEntryIds = [value.batches.batch.items[0].entryId]; });
    reject(value => { value.batches = {}; });
  });
});
