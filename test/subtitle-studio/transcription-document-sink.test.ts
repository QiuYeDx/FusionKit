import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentRepository, type CommitStage } from '../../electron/main/subtitle-studio/document-repository';
import { createTranscriptionDocumentSink } from '../../electron/main/subtitle-studio/transcription/document-sink';
import { StudioError } from '../../src/subtitle-studio/domain';
import type { LocalSubtitleTranscript } from '../../src/subtitle-studio/transcription/domain';
import { localSubtitleTranscriptSchema } from '../../src/subtitle-studio/transcription/ipc-contract';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const transcript = (): LocalSubtitleTranscript => ({
  schemaVersion: 1, source: { displayName: 'media.wav', durationMs: 4000 },
  model: { engine: 'whisper_cpp', modelId: 'ggml-base', modelHash: 'a'.repeat(64), backend: 'cpu' },
  detectedLanguage: 'en', languageProbability: 0.97,
  segments: [{ id: 'segment-1', startMs: 100, endMs: 1500, text: 'Hello world.', confidence: 0.9, speaker: 'speaker-1',
    words: [{ startMs: 100, endMs: 700, text: 'Hello', probability: 0.8 }, { startMs: 800, endMs: 1500, text: ' world.', probability: 0.99 }] }],
});
async function fixture(fault?: (stage: CommitStage) => void) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-document-sink-')); roots.push(root);
  const repository = new DocumentRepository(root, { fault });
  let active = true;
  const options = { repository, owner: { webContentsId: 3, ownerSessionId: 'private-owner-session' }, taskId: 'task-1', generation: 1,
    assertActive: () => { if (!active) throw new StudioError('access_denied'); } };
  const sink = createTranscriptionDocumentSink(options);
  return { root, repository, sink, options, revoke: () => { active = false; } };
}

describe('transcription document sink', () => {
  it('freezes a validated task identity and remains inert until publication', async () => {
    const { sink, root, options } = await fixture();
    options.owner.ownerSessionId = 'changed';
    expect(sink.identity.owner.ownerSessionId).toBe('private-owner-session');
    expect(Object.isFrozen(sink.identity)).toBe(true);
    expect(Object.isFrozen(sink.identity.owner)).toBe(true);
    expect(await readdir(root)).toEqual([]);
    for (const invalid of [{ generation: 0 }, { generation: Number.MAX_SAFE_INTEGER + 1 }, { taskId: '../bad\n' }, { extra: true }, { owner: { ...options.owner, path: '/secret' } }]) {
      expect(() => createTranscriptionDocumentSink({ ...options, ...invalid } as never)).toThrow('invalid_input');
    }
  });

  it('coalesces concurrent publication, preserves all final evidence, and replays without duplicating documents', async () => {
    const { sink, repository, root } = await fixture();
    const value = transcript();
    const first = sink.publish(value); const second = sink.publish(structuredClone(value));
    expect(second).toBe(first);
    const receipt = await first;
    expect(receipt).toMatchObject({ status: 'committed', documentId: sink.documentId, revision: 1, replayed: false });
    const document = await repository.read(sink.documentId);
    expect(document.preservation).toEqual({ schemaVersion: 1, kind: 'transcription', transcript: value });
    expect(await sink.publish(value)).toMatchObject({ documentId: sink.documentId, replayed: true });
    expect(await repository.list()).toHaveLength(1);
    for (const file of await readdir(path.join(root, sink.documentId))) {
      const text = await readFile(path.join(root, sink.documentId, file), 'utf8');
      expect(text).not.toContain('private-owner-session');
      expect(text).not.toContain('task-1');
    }
  });

  it('rejects transcript drift while a publication is pending and after it commits', async () => {
    const { sink, repository } = await fixture();
    const value = transcript();
    const first = sink.publish(value);
    const changed = { ...structuredClone(value), segments: [{ ...value.segments[0], text: 'Different' }] };
    await expect(sink.publish(changed)).rejects.toThrow('revision_conflict');
    await first;
    await expect(sink.publish(changed)).rejects.toThrow('revision_conflict');
    expect(await repository.list()).toHaveLength(1);
  });

  it('keeps the same document and cue identities across a failed publication retry', async () => {
    let fail = true;
    const { sink, repository } = await fixture(stage => { if (fail && stage === 'current-publish') throw new Error('disk full'); });
    await expect(sink.publish(transcript())).rejects.toThrow('disk full');
    expect(await repository.list()).toEqual([]);
    fail = false;
    expect(await sink.publish(transcript())).toMatchObject({ documentId: sink.documentId, status: 'committed' });
    const stored = await repository.read(sink.documentId);
    expect(await sink.publish(transcript())).toMatchObject({ documentId: sink.documentId, replayed: true });
    expect((await repository.read(sink.documentId)).cues).toEqual(stored.cues);
  });

  it('blocks cancellation and owner revocation before publication with no document', async () => {
    const controller = new AbortController();
    const early = await fixture(stage => { if (stage === 'current-publish') controller.abort(); });
    await expect(early.sink.publish(transcript(), { signal: controller.signal })).rejects.toThrow('interrupted');
    expect(await early.repository.list()).toEqual([]);
    let revoke = () => {};
    const owner = await fixture(stage => { if (stage === 'current-publish') revoke(); }); revoke = owner.revoke;
    await expect(owner.sink.publish(transcript())).rejects.toThrow('access_denied');
    expect(await owner.repository.list()).toEqual([]);
  });

  it('retains publication success for late cancellation and uncertain durability', async () => {
    const controller = new AbortController();
    let fail = true;
    const { sink, repository } = await fixture(stage => { if (stage === 'current-directory-sync' && fail) { controller.abort(); throw new Error('fsync'); } });
    expect(await sink.publish(transcript(), { signal: controller.signal })).toMatchObject({ status: 'committed', durability: 'uncertain' });
    expect(await repository.list()).toHaveLength(1);
    fail = false;
    expect(await sink.publish(transcript(), { signal: controller.signal })).toMatchObject({ status: 'committed', durability: 'confirmed', replayed: true });
  });

  it('does not turn a late owner release into a failed creation or authorize later calls', async () => {
    let revoke = () => {};
    const current = await fixture(stage => { if (stage === 'current-directory-sync') revoke(); }); revoke = current.revoke;
    expect(await current.sink.publish(transcript())).toMatchObject({ status: 'committed' });
    await expect(current.sink.publish(transcript())).rejects.toThrow('access_denied');
    expect(await current.repository.list()).toHaveLength(1);
  });

  it('never resurrects a deleted document from a cached successful publication', async () => {
    const { sink, repository } = await fixture();
    await sink.publish(transcript());
    await repository.delete(sink.documentId, 1);
    await expect(sink.publish(transcript())).rejects.toThrow('document_unavailable');
    expect(await repository.list()).toEqual([]);
  });

  it('serializes a replay behind an already queued deletion', async () => {
    const { sink, repository } = await fixture();
    await sink.publish(transcript());
    const deletion = repository.delete(sink.documentId, 1);
    const replay = sink.publish(transcript());
    await expect(replay).rejects.toThrow('document_unavailable');
    await deletion;
    expect(await repository.list()).toEqual([]);
  });

  it('rejects non-transcript authority and filesystem fields before persistence', async () => {
    const { sink, root } = await fixture();
    await expect(sink.publish({ ...transcript(), filePath: '/secret/source.wav' })).rejects.toThrow('invalid_input');
    await expect(sink.publish({ ...transcript(), source: { ...transcript().source, fileToken: 'private-file-token' } })).rejects.toThrow('invalid_input');
    await expect(sink.publish(transcript(), { signal: 'forged' } as never)).rejects.toThrow('invalid_input');
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects a valid 100001-segment transcript without publishing any document', async () => {
    const { sink, repository, root } = await fixture();
    const value: LocalSubtitleTranscript = {
      ...transcript(),
      source: { displayName: 'long-media.wav', durationMs: 100001 },
      segments: Array.from({ length: 100001 }, (_, index) => ({
        id: `segment-${index}`, startMs: index, endMs: index + 1, text: 'a',
      })),
    };
    expect(localSubtitleTranscriptSchema.safeParse(value).success).toBe(true);
    await expect(sink.publish(value)).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(await repository.listSnapshot()).toMatchObject({ documents: [], unavailableDocuments: 0, sequence: 0 });
    expect(await readdir(root)).toEqual([]);
  });

  it('verifies the preserved transcript digest on both repository write and reopen', async () => {
    const { sink, repository, root } = await fixture();
    await sink.publish(transcript());
    const document = await repository.read(sink.documentId);
    if (document.schemaVersion !== 2) throw new Error('Expected a media document');
    document.origin.transcriptDigest = '0'.repeat(64);
    await expect(repository.createConfirmed(document)).rejects.toThrow('invalid_input');
    const directory = path.join(root, sink.documentId);
    const pointerPath = path.join(directory, 'current.json');
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    const generationPath = path.join(directory, `${pointer.generation}.json`);
    const snapshot = JSON.parse(await readFile(generationPath, 'utf8'));
    snapshot.document.origin.transcriptDigest = '0'.repeat(64);
    const json = JSON.stringify(snapshot);
    await writeFile(generationPath, json);
    pointer.digest = createHash('sha256').update(json).digest('hex');
    await writeFile(pointerPath, JSON.stringify(pointer));
    await expect(new DocumentRepository(root).read(sink.documentId)).rejects.toThrow('document_unavailable');
  });
});
