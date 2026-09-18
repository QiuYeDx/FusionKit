import { describe, expect, it, vi } from 'vitest';
import type { SubtitleStudioApi } from '@/subtitle-studio/ipc-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { activeAutomaticMaterials, emptySelection, reusableTranslationDraft, TranslationDraftMemory, type TranslationDraft } from './translation-draft';
import { TranslationSession, partialCheck, readyCount, type TranslationSessionInput } from './translation-session';

const documentId = '10000000-0000-4000-8000-000000000001';
const selection = { ...emptySelection('zh'), languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: ['20000000-0000-4000-8000-000000000001'] };
const input: TranslationSessionInput = { documents: [{ documentId, revision: 1 }], batch: false, documentTopicIds: [], cueIds: [], generation: 4, knowledge: selection,
  config: { language: 'zh', instructions: '', contextWindow: 32768, maxOutputTokens: 4096, maxBatchCues: 32, model: { profileId: 'test', modelKey: 'test', endpoint: 'https://example.test', apiFormat: 'chat_completions' } } };
const library = () => Promise.resolve({ generation: 4 } as LibrarySnapshot);
const preview = { planId: 'plan', documentId, revision: 1, expiresAt: Date.now() + 60000, canRun: true, cueCount: 2, batchCount: 1, estimatedInputTokens: 10, outputTokenReserve: 10, knowledgeDigest: '', resourceCount: 1, includedEntryCount: 1, issues: [] };
function fixture() {
  const api = {
    cancelKnowledgeTrial: vi.fn(async () => ({ ok: true, value: null })),
    cancelKnowledgeTranslationPlan: vi.fn(async () => ({ ok: true, value: null })),
    cancelKnowledgeTranslationBatchPlan: vi.fn(async () => ({ ok: true, value: null })),
    planKnowledgeTranslation: vi.fn(async () => ({ ok: true, value: structuredClone(preview) })),
    planKnowledgeTrial: vi.fn(async () => ({ ok: true, value: { ...structuredClone(preview), sourceDigest: '', cues: [{ id: 'one', text: 'First' }], batches: [] } })),
    createKnowledgeTranslation: vi.fn(async () => ({ ok: true, value: { taskId: 'task' } })),
    planTranslation: vi.fn(async () => ({ ok: true, value: { ...preview, contextTokenReserve: 0 } })),
    createTranslation: vi.fn(async () => ({ ok: true, value: { taskId: 'plain-task' } })),
    planKnowledgeTranslationBatch: vi.fn(async () => ({ ok: true, value: { planId: 'batch', expiresAt: Date.now() + 60000, knowledgeGeneration: 4, readyCount: 1, items: [{ documentId, displayName: 'one', ok: true, plan: preview }, { documentId: 'two', displayName: 'two', ok: false, error: 'revision_conflict' }], totalEstimatedInputTokens: 10, totalOutputTokenReserve: 10 } })),
  };
  return { api, session: new TranslationSession(api as unknown as SubtitleStudioApi) };
}
describe('one-panel translation session', () => {
  it('checks locally without credentials and admits exactly the returned plan on an explicit action', async () => {
    const { api, session } = fixture();
    const checked = await session.check(input);
    expect(api.createKnowledgeTranslation).not.toHaveBeenCalled();
    expect(api.planKnowledgeTranslation.mock.calls[0]).not.toContain('secret');
    expect(await session.submit(checked!, input, 'secret', library, () => true)).toEqual({ kind: 'single', taskId: 'task' });
    expect(api.createKnowledgeTranslation).toHaveBeenCalledWith({ planId: 'plan', apiKey: 'secret' });
  });
  it('keeps no-materials execution on the ordinary API', async () => {
    const { api, session } = fixture();
    const plain = { ...input, knowledge: undefined, generation: undefined };
    const checked = await session.check(plain);
    expect(api.planKnowledgeTranslation).not.toHaveBeenCalled();
    expect(await session.submit(checked!, plain, 'secret', library, () => true)).toEqual({ kind: 'single', taskId: 'plain-task' });
  });
  it('rejects an edited draft, expired plan or changed library before sending', async () => {
    const { api, session } = fixture();
    const checked = await session.check(input);
    expect(await session.submit(checked!, input, 'secret', library, () => false)).toBeNull();
    await expect(session.submit(checked!, input, 'secret', async () => ({ generation: 5 } as LibrarySnapshot), () => true)).rejects.toMatchObject({ code: 'revision_conflict' });
    if (checked?.kind === 'knowledge') checked.value.expiresAt = 0;
    await expect(session.submit(checked!, input, 'secret', library, () => true)).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(api.createKnowledgeTranslation).not.toHaveBeenCalled();
  });
  it('discards a late check and waits for its cleanup before another plan', async () => {
    const { api, session } = fixture();
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    api.planKnowledgeTranslation.mockImplementationOnce(async () => { began(); await new Promise<void>(resolve => { release = resolve; }); return { ok: true, value: structuredClone(preview) }; });
    const pending = session.check(input); await started;
    session.invalidate(); release();
    expect(await pending).toBeNull();
    expect((await session.check(input))?.kind).toBe('knowledge');
  });
  it('does not let an idle mounted peer cancel the active session', async () => {
    const { api, session } = fixture();
    const peer = new TranslationSession(api as unknown as SubtitleStudioApi);
    const checked = await session.check(input);
    api.cancelKnowledgeTranslationPlan.mockClear();
    peer.invalidate(); peer.dispose();
    await Promise.resolve();
    expect(api.cancelKnowledgeTranslationPlan).not.toHaveBeenCalled();
    expect(await session.submit(checked!, input, 'secret', library, () => true)).toEqual({ kind: 'single', taskId: 'task' });
  });
  it('does not let an older peer cleanup cancel the new owner of the same plan kind', async () => {
    const { api, session } = fixture();
    const peer = new TranslationSession(api as unknown as SubtitleStudioApi);
    await session.check(input);
    const latest = await peer.check(input);
    api.cancelKnowledgeTranslationPlan.mockClear();
    session.dispose();
    await Promise.resolve();
    expect(api.cancelKnowledgeTranslationPlan).not.toHaveBeenCalled();
    expect(await peer.submit(latest!, input, 'secret', library, () => true)).toEqual({ kind: 'single', taskId: 'task' });
  });
  it('returns admitted task IDs even when its panel is disposed before acknowledgement', async () => {
    const { api, session } = fixture();
    const checked = await session.check(input);
    let release!: () => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    api.createKnowledgeTranslation.mockImplementationOnce(async () => { began(); await new Promise<void>(resolve => { release = resolve; }); return { ok: true, value: { taskId: 'durable' } }; });
    const pending = session.submit(checked!, input, 'secret', library, () => true); await started;
    session.dispose(); release();
    expect(await pending).toEqual({ kind: 'single', taskId: 'durable' });
  });
  it('joins the start guard before reading the library so a double click cannot admit twice', async () => {
    const { api, session } = fixture();
    const checked = await session.check(input);
    let release!: (library: LibrarySnapshot) => void;
    const waiting = new Promise<LibrarySnapshot>(resolve => { release = resolve; });
    const first = session.submit(checked!, input, 'secret', () => waiting, () => true);
    expect(await session.submit(checked!, input, 'secret', library, () => true)).toBeNull();
    release({ generation: 4 } as LibrarySnapshot);
    expect(await first).toEqual({ kind: 'single', taskId: 'task' });
    expect(api.createKnowledgeTranslation).toHaveBeenCalledTimes(1);
  });
  it('exposes a partial batch so admission needs a separate explicit choice', async () => {
    const { api, session } = fixture();
    const checked = await session.check({ ...input, batch: true, knowledge: { ...selection, bindings: [{ subjectId: 'person', role: 'speaker', cueIds: ['cue'] }], confirmations: [{ entryId: 'term', cueIds: ['cue'] }] } });
    expect(partialCheck(checked!)).toBe(true); expect(readyCount(checked!)).toBe(1);
    expect(api.createKnowledgeTranslation).not.toHaveBeenCalled();
    const sent = (api.planKnowledgeTranslationBatch.mock.calls as unknown[][])[0][0] as { knowledge: object };
    expect(sent.knowledge).not.toHaveProperty('bindings'); expect(sent.knowledge).not.toHaveProperty('confirmations');
  });
  it('projects document topics and explicit roles into the same trial sample without granting a speaker identity', async () => {
    const { api, session } = fixture();
    await session.check({ ...input, cueIds: ['one', 'two'], documentTopicIds: ['topic', 'topic'], knowledge: { ...selection,
      bindings: [{ subjectId: 'topic', role: 'topic', cueIds: ['one'] }, { subjectId: 'person', role: 'speaker', cueIds: ['one', 'outside'] }],
      confirmations: [{ entryId: 'term', cueIds: ['two', 'outside'] }] } }, true);
    const sent = (api.planKnowledgeTrial.mock.calls as unknown[][])[0][0] as { cueIds: string[]; knowledge: typeof selection };
    expect(sent.cueIds).toEqual(['one', 'two']);
    expect(sent.knowledge.bindings).toEqual([{ subjectId: 'person', role: 'speaker', cueIds: ['one'] }, { subjectId: 'topic', role: 'topic', cueIds: ['one', 'two'] }]);
    expect(sent.knowledge.confirmations).toEqual([{ entryId: 'term', cueIds: ['two'] }]);
  });
});

describe('translation draft reuse', () => {
  const draft: TranslationDraft = { profileId: 'profile', language: 'zh', instructions: '', contextWindow: '32768', maxOutputTokens: '4096', maxBatchCues: '32', documentTopicIds: ['topic'], cueIds: ['cue'],
    selection: { ...selection, instructions: '', context: '', disabledEntryIds: ['term'], bindings: [{ subjectId: 'person', role: 'speaker', cueIds: ['cue'] }], confirmations: [{ entryId: 'term', cueIds: ['cue'] }] } };
  it('retains a document draft but clears source-specific authority after a revision or explicit reuse', () => {
    const memory = new TranslationDraftMemory(); memory.remember(documentId, 1, draft);
    expect(memory.read(documentId, 1)).toEqual(draft);
    for (const copy of [memory.read(documentId, 2), memory.last(), reusableTranslationDraft(draft)]) {
      expect(copy?.selection.collectionIds).toEqual(selection.collectionIds);
      expect(copy?.selection.instructions).toBe(''); expect(copy?.selection.context).toBe('');
      expect(copy?.selection.bindings).toEqual([]); expect(copy?.selection.confirmations).toEqual([]);
      expect(copy?.selection.disabledEntryIds).toEqual([]);
      expect(copy?.documentTopicIds).toEqual([]); expect(copy?.cueIds).toEqual([]);
    }
    expect(memory.read('new-document', 1)).toBeUndefined();
  });
  it('does not activate old disabled automatic choices', () => {
    const saved = { enabled: false, sourceLanguage: 'en', collectionIds: selection.collectionIds, documentTopicIds: ['topic'], disabledEntryIds: [], instructions: 'old' };
    expect(activeAutomaticMaterials(saved, 'zh')).toEqual(emptySelection('zh'));
    expect(activeAutomaticMaterials({ ...saved, enabled: true }, 'zh').collectionIds).toEqual(selection.collectionIds);
  });
});
