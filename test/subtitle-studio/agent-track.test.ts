import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDocument } from '../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { requestSchemas } from '../../src/subtitle-studio/ipc-contract';
import { CueEditService } from '../../electron/main/subtitle-studio/cue-edit-service';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { TranslationTrackService } from '../../electron/main/subtitle-studio/translation-track-service';
import { hasExecutionRecordEntry } from '../../src/pages/Tools/Subtitle/SubtitleStudio/StudioExecutionRecord';

const plain = (text: string) => ({ plain: text, spans: [{ text, marks: [] as ('b' | 'i' | 'u')[] }] });
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-agent-track-'));
  roots.push(root);
  const doc = importSubtitleText('1\n00:00:01,000 --> 00:00:02,000\nおはよう\n\n2\n00:00:03,000 --> 00:00:04,000\nいい天気だね\n', { format: 'srt', displayName: 'agent.srt', encoding: 'utf-8', digest: 'a'.repeat(64) }, randomUUID);
  const repository = new DocumentRepository(path.join(root, 'documents'));
  await repository.create(doc);
  const tracks = new TranslationTrackService(repository);
  const edits = new CueEditService(repository);
  const read = () => repository.readSnapshot(doc.id);
  return { doc, repository, tracks, edits, read };
}

describe('tracks made by external agents', () => {
  it('creates an empty AI track owned by the agent and takes unreviewed AI translations, undoable in one step', async () => {
    const { doc, tracks, edits, read } = await fixture();
    const created = await tracks.createAgentTrack(doc.id, 1, { language: 'zh', agent: { name: 'claude-code' } });
    const track = created.document.translationTracks.at(-1)!;
    expect(track).toMatchObject({ id: created.trackId, language: 'zh', name: 'claude-code', origin: 'ai', agent: { name: 'claude-code' }, entries: {} });
    expect(() => validateDocument(created.document)).not.toThrow();
    const [first, second] = created.document.cues;
    const result = await edits.apply(doc.id, created.document.revision, { kind: 'agent', trackId: track.id, targets: { [first.id]: plain('早上好'), [second.id]: plain('天气真好') } });
    expect(result.changed).toBe(2);
    const written = (await read()).document.translationTracks.at(-1)!;
    expect(written.entries[first.id]).toMatchObject({ text: plain('早上好'), origin: 'ai', reviewStatus: 'unreviewed', sourceRevision: first.sourceRevision });
    expect(written.revision).toBe(2);
    expect(result.undo).toEqual({ kind: 'entries', trackId: track.id, entries: { [first.id]: null, [second.id]: null } });
    await edits.apply(doc.id, (await read()).document.revision, result.undo);
    expect((await read()).document.translationTracks.at(-1)!.entries).toEqual({});
  });

  it('keeps a given name, refuses tracks FusionKit made and stale revisions, and caps the track count', async () => {
    const { doc, tracks, edits, read, repository } = await fixture();
    const named = await tracks.createAgentTrack(doc.id, 1, { language: 'en', name: 'English (Codex)', agent: { name: 'codex' } });
    expect(named.document.translationTracks.at(-1)!.name).toBe('English (Codex)');
    await expect(tracks.createAgentTrack(doc.id, 1, { language: 'zh', agent: { name: 'codex' } })).rejects.toMatchObject({ code: 'revision_conflict' });

    // A track that FusionKit's own translation made has no agent owner.
    await repository.transact(doc.id, named.document.revision, value => {
      value.document.translationTracks.push({ id: randomUUID(), language: 'zh', revision: 1, origin: 'ai', entries: {} });
    });
    const snapshot = await read();
    const own = snapshot.document.translationTracks.at(-1)!;
    await expect(edits.apply(doc.id, snapshot.document.revision, { kind: 'agent', trackId: own.id, targets: { [snapshot.document.cues[0].id]: plain('x') } }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(edits.apply(doc.id, snapshot.document.revision, { kind: 'agent', trackId: named.trackId, targets: { [randomUUID()]: plain('x') } }))
      .rejects.toMatchObject({ code: 'invalid_input' });

    await repository.transact(doc.id, snapshot.document.revision, value => {
      while (value.document.translationTracks.length < 100) value.document.translationTracks.push({ id: randomUUID(), language: 'zh', revision: 1, entries: {} });
    });
    await expect(tracks.createAgentTrack(doc.id, (await read()).document.revision, { language: 'zh', agent: { name: 'codex' } })).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('validates the request and hides the execution record entry for agent tracks', () => {
    const base = { documentId: randomUUID(), revision: 1, language: 'zh', agent: { name: 'claude-code' } };
    expect(requestSchemas.createAgentTranslationTrack.safeParse(base).success).toBe(true);
    expect(requestSchemas.createAgentTranslationTrack.safeParse({ ...base, agent: { name: '' } }).success).toBe(false);
    expect(requestSchemas.createAgentTranslationTrack.safeParse({ ...base, language: '' }).success).toBe(false);
    const track = { id: randomUUID(), language: 'zh', revision: 1, origin: 'ai' as const, entries: {} };
    expect(hasExecutionRecordEntry(track)).toBe(true);
    expect(hasExecutionRecordEntry({ ...track, agent: { name: 'claude-code' } })).toBe(false);
  });
});
