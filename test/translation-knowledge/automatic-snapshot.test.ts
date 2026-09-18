import { describe, expect, it } from 'vitest';
import { knowledgeFixture } from './fixtures';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import { AUTOMATIC_KNOWLEDGE_MAX_BYTES, AUTOMATIC_KNOWLEDGE_POLICY, LEGACY_AUTOMATIC_KNOWLEDGE_POLICY, automaticKnowledgeExecutionPolicy, automaticKnowledgeResourceReferences, buildFrozenAutomaticKnowledge, validateFrozenAutomaticKnowledge, type AutomaticKnowledgeRequest, type FrozenAutomaticKnowledge } from '../../src/translation-knowledge/automatic-snapshot-contract';
import { KNOWLEDGE_EXECUTION_POLICY, LEGACY_KNOWLEDGE_EXECUTION_POLICY } from '../../src/translation-knowledge/execution';
import { automaticTranslationRequestSchema, automaticTranslationIntentSchema } from '../../src/subtitle-studio/automatic-translation-contract';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';

function fixture() {
  const data = knowledgeFixture();
  for (const entry of data.entries) entry.state = 'ready';
  const library: LibrarySnapshot = { generation: 7, data, imports: [], approvals: Object.fromEntries(data.entries.map(entry => [entry.id,
    { revision: entry.revision, digest: sha256Canonical(entry), method: 'human' as const, approvedAt: '2026-09-15T00:00:00Z' }])) };
  const request: AutomaticKnowledgeRequest = { knowledgeGeneration: 7, selection: { version: 1, recipeId: data.recipes[0].id,
    languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [], disabledEntryIds: [] }, documentTopicIds: data.subjects.slice(0, 2).map(subject => subject.id) };
  return { library, request };
}
function rehash(snapshot: FrozenAutomaticKnowledge) { const { digest: _digest, ...base } = snapshot; snapshot.digest = sha256Canonical(base); return snapshot; }

describe('pre-transcription frozen knowledge', () => {
  it('binds new preparations to v2 while dispatching historical preparations to the retained v1 compiler', () => {
    const { library, request } = fixture(), current = buildFrozenAutomaticKnowledge(library, request);
    expect(current.policyVersion).toBe(AUTOMATIC_KNOWLEDGE_POLICY);
    expect(automaticKnowledgeExecutionPolicy(current.policyVersion)).toBe(KNOWLEDGE_EXECUTION_POLICY);
    const legacy = rehash({ ...structuredClone(current), policyVersion: LEGACY_AUTOMATIC_KNOWLEDGE_POLICY });
    expect(validateFrozenAutomaticKnowledge(legacy)).toEqual(legacy);
    expect(automaticKnowledgeExecutionPolicy(legacy.policyVersion)).toBe(LEGACY_KNOWLEDGE_EXECUTION_POLICY);
    expect(() => automaticKnowledgeExecutionPolicy('automatic-knowledge-preparation/99')).toThrow();
  });

  it('captures every candidate and recipe dependency without cues, batches, or live-library coupling', () => {
    const { library, request } = fixture();
    const snapshot = buildFrozenAutomaticKnowledge(library, request);
    expect(snapshot.data.entries).toEqual(library.data.entries);
    expect(snapshot.data.recipes).toEqual(library.data.recipes);
    expect(snapshot.data.styles).toEqual(library.data.styles);
    expect(snapshot.approvals).toEqual(library.approvals);
    expect(snapshot).not.toHaveProperty('batches'); expect(snapshot.selection).not.toHaveProperty('bindings');
    expect(validateFrozenAutomaticKnowledge(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(automaticKnowledgeResourceReferences(snapshot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'entries', id: library.data.entries[0].id }),
      expect.objectContaining({ group: 'styles', id: library.data.styles[0].id }),
    ]));
    library.generation++; library.data.entries[0].title = 'Changed'; library.approvals = {};
    expect(validateFrozenAutomaticKnowledge(snapshot)).toEqual(snapshot);
    expect(snapshot.data.entries[0].title).not.toBe('Changed');
  });

  it('normalizes absent optional inputs but preserves explicit empty defaults', () => {
    const { library, request } = fixture();
    const absent = buildFrozenAutomaticKnowledge(library, request);
    request.selection.instructions = undefined; request.selection.context = undefined;
    expect(buildFrozenAutomaticKnowledge(library, request)).toEqual(absent);
    request.selection.instructions = ''; request.selection.context = '';
    const cleared = buildFrozenAutomaticKnowledge(library, request);
    expect(cleared.selection).toMatchObject({ instructions: '', context: '' }); expect(cleared.digest).not.toBe(absent.digest);
  });

  it.each(['generation', 'maintenance'] as const)('refuses %s changing before capture', field => {
    const { library, request } = fixture();
    if (field === 'generation') library.generation++;
    else library.maintenance = { cleanupPending: true, undoableImportIds: [], undoneImportIds: [] };
    expect(() => buildFrozenAutomaticKnowledge(library, request)).toThrowError(expect.objectContaining({ code: 'revision_conflict' }));
  });

  it.each(['recipe', 'collection', 'topic', 'style', 'rule_approval', 'language'] as const)('rejects unavailable %s selection before transcription', field => {
    const { library, request } = fixture();
    if (field === 'recipe') library.data.recipes[0].archived = true;
    if (field === 'collection') library.data.collections[0].archived = true;
    if (field === 'topic') library.data.subjects[0].archived = true;
    if (field === 'style') library.data.styles[0].archived = true;
    if (field === 'rule_approval') delete library.approvals[library.data.styles[0].ruleEntryIds[0]];
    if (field === 'language') request.selection.languagePair.target = 'zh-Hant';
    expect(() => buildFrozenAutomaticKnowledge(library, request)).toThrowError(expect.objectContaining({ code: 'knowledge_check_failed' }));
  });

  it.each(['digest', 'policy', 'source_dependency', 'style_dependency', 'extra_resource', 'extra_approval', 'cue_binding'] as const)('rejects %s damage even when the container digest is recomputed', field => {
    const { library, request } = fixture(), snapshot = buildFrozenAutomaticKnowledge(library, request);
    if (field === 'digest') snapshot.digest = '0'.repeat(64);
    if (field === 'policy') snapshot.policyVersion = 'automatic-knowledge-preparation/99';
    if (field === 'source_dependency') snapshot.data.sources = [];
    if (field === 'style_dependency') snapshot.data.styles = [];
    if (field === 'extra_resource') snapshot.data.subjects.push({ ...snapshot.data.subjects[0], id: '90000000-0000-4000-8000-000000000099' });
    if (field === 'extra_approval') snapshot.approvals['90000000-0000-4000-8000-000000000099'] = Object.values(snapshot.approvals)[0];
    if (field === 'cue_binding') Object.assign(snapshot.selection, { bindings: [] });
    expect(() => validateFrozenAutomaticKnowledge(field === 'digest' ? snapshot : rehash(snapshot))).toThrow();
  });

  it('enforces the complete 4 MiB UTF-8 envelope cap', () => {
    const { library, request } = fixture();
    // Each value is individually legal; the selected candidate set exceeds the
    // automatic snapshot bound while remaining under FK-TK/1's 32 MiB limit.
    const base = library.data.entries[0];
    library.data.entries.push(...Array.from({ length: 180 }, (_, index) => ({ ...structuredClone(base),
      id: `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: 'x'.repeat(30000) })));
    expect(JSON.stringify(library.data).length).toBeGreaterThan(AUTOMATIC_KNOWLEDGE_MAX_BYTES);
    expect(() => buildFrozenAutomaticKnowledge(library, request)).toThrowError(expect.objectContaining({ code: 'limit_exceeded' }));
  });

  it('preserves the old ordinary intent and rejects credentials or prepared material in shared choices', () => {
    const { library, request } = fixture(), snapshot = buildFrozenAutomaticKnowledge(library, request);
    const config = { model: { profileId: 'p', modelKey: 'm', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' },
      language: 'zh-Hans', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 20 };
    const intent = { intentId: '90000000-0000-4000-8000-000000000097', sourceTaskId: '90000000-0000-4000-8000-000000000098', generation: 1, state: 'pending', config };
    expect(automaticTranslationIntentSchema.safeParse(intent).success).toBe(true);
    expect(automaticTranslationIntentSchema.safeParse({ ...intent, knowledge: snapshot }).success).toBe(true);
    expect(automaticTranslationIntentSchema.safeParse({ ...intent, apiKey: 'forbidden' }).success).toBe(false);
    expect(automaticTranslationRequestSchema.safeParse({ config, apiKey: 'key', knowledge: request }).success).toBe(true);
    expect(automaticTranslationRequestSchema.safeParse({ config: { ...config, language: 'zh' }, apiKey: 'key', knowledge: request }).success).toBe(true);
    expect(automaticTranslationRequestSchema.safeParse({ config: { ...config, language: 'ja' }, apiKey: 'key', knowledge: request }).success).toBe(false);
    expect(automaticTranslationRequestSchema.safeParse({ config: { ...config, language: 'zh-Hant' }, apiKey: 'key', knowledge: request }).success).toBe(false);
    expect(automaticTranslationRequestSchema.safeParse({ config, apiKey: 'key', knowledge: snapshot }).success).toBe(false);
  });
});
