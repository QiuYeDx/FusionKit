import { describe, expect, it } from 'vitest';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import { AUTOMATIC_KNOWLEDGE_MAX_BYTES, AUTOMATIC_KNOWLEDGE_POLICY, buildFrozenAutomaticKnowledge, validateFrozenAutomaticKnowledge } from '../../src/translation-knowledge/automatic-snapshot-contract';
import type { KnowledgeSelection } from '../../src/translation-knowledge/execution-contract';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import { knowledgeFixture } from './fixtures';

const library = (): LibrarySnapshot => ({ generation: 4, data: knowledgeFixture() });
const [game, common, archived] = knowledgeFixture().collections;
const selection = (patch: Partial<KnowledgeSelection> = {}): KnowledgeSelection => ({ version: 2, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [game.id, common.id], disabledEntryIds: [], ...patch });
const request = (patch: Partial<KnowledgeSelection> = {}) => ({ knowledgeGeneration: 4, selection: selection(patch) });

describe('pre-transcription frozen knowledge', () => {
  it('captures the selected collections without cues, batches or live-library coupling', () => {
    const snapshot = library();
    const frozen = buildFrozenAutomaticKnowledge(snapshot, request({ instructions: 'Short lines.' }));
    expect(frozen).toMatchObject({ version: 2, policyVersion: AUTOMATIC_KNOWLEDGE_POLICY, generation: 4, selection: selection({ instructions: 'Short lines.' }) });
    expect(frozen.data.collections.map(item => item.id)).toEqual([game.id, common.id]);
    expect(frozen.data.entries).toEqual(snapshot.data.entries.filter(entry => [game.id, common.id].includes(entry.collectionId)));
    const before = structuredClone(frozen);
    snapshot.data.entries[0].enabled = false;
    expect(frozen).toEqual(before);
    expect(validateFrozenAutomaticKnowledge(structuredClone(frozen))).toEqual(frozen);
  });

  it('normalizes absent optional inputs but preserves explicit empty text', () => {
    const absent = buildFrozenAutomaticKnowledge(library(), request({ context: undefined }));
    expect('context' in absent.selection).toBe(false);
    expect(buildFrozenAutomaticKnowledge(library(), request({ context: '' })).selection.context).toBe('');
  });

  it('rejects stale generations, archived or wrong-direction collections and removed fields', () => {
    expect(() => buildFrozenAutomaticKnowledge(library(), { ...request(), knowledgeGeneration: 3 })).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
    expect(() => buildFrozenAutomaticKnowledge(library(), request({ collectionIds: [archived.id] }))).toThrow(expect.objectContaining({ code: 'knowledge_check_failed' }));
    expect(() => buildFrozenAutomaticKnowledge(library(), request({ languagePair: { source: 'ja', target: 'zh-Hans' } }))).toThrow(expect.objectContaining({ code: 'knowledge_check_failed' }));
    expect(() => buildFrozenAutomaticKnowledge(library(), { ...request(), documentTopicIds: [] } as never)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => buildFrozenAutomaticKnowledge(library(), { ...request(), selection: { ...selection(), recipeId: game.id } } as never)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it('rejects tampering, foreign content and older snapshot versions', () => {
    const frozen = buildFrozenAutomaticKnowledge(library(), request());
    const reject = (mutate: (value: any) => void) => {
      const copy = structuredClone(frozen) as any;
      mutate(copy);
      copy.digest = sha256Canonical((({ digest: _digest, ...base }) => base)(copy));
      expect(() => validateFrozenAutomaticKnowledge(copy)).toThrow();
    };
    expect(() => validateFrozenAutomaticKnowledge({ ...frozen, digest: '0'.repeat(64) })).toThrow();
    reject(value => { value.version = 1; });
    reject(value => { value.policyVersion = 'automatic-knowledge-preparation/1;fktk-execution/2'; });
    reject(value => { value.documentTopicIds = []; });
    reject(value => { value.data.entries.push({ ...value.data.entries[0], id: '50000000-0000-4000-8000-0000000002ff', collectionId: archived.id }); value.data.collections.push({ ...archived }); });
    reject(value => { value.data.collections.push({ ...archived }); });
  });

  it('enforces the complete 4 MiB UTF-8 envelope cap', () => {
    const snapshot = library();
    snapshot.data.entries = snapshot.data.entries.concat(Array.from({ length: 160 }, (_, index) => ({
      id: `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`, revision: 1, collectionId: game.id, enabled: true, kind: 'context' as const,
      payload: { text: '中'.repeat(10_000), required: false },
    })));
    expect(new TextEncoder().encode(JSON.stringify(snapshot.data)).byteLength).toBeGreaterThan(AUTOMATIC_KNOWLEDGE_MAX_BYTES);
    expect(() => buildFrozenAutomaticKnowledge(snapshot, request())).toThrow(expect.objectContaining({ code: 'limit_exceeded' }));
  });
});
