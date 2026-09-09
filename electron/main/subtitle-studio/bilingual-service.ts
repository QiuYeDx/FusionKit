import { randomUUID } from 'node:crypto';
import { StudioError } from '../../../src/subtitle-studio/domain';
import type { BilingualOptions } from '../../../src/subtitle-studio/bilingual-contract';
import { applyBilingual, previewBilingual } from '../../../src/subtitle-studio/bilingual';
import type { DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';
import { DocumentRepository } from './document-repository';
import { sourceDigest } from './translation-planner';

function assertUninterpreted(snapshot: DocumentSnapshot) {
  if (snapshot.tasks.length || snapshot.document.translationTracks.length || snapshot.document.bilingualImport) throw new StudioError('revision_conflict');
}

export class BilingualService {
  constructor(private repository: DocumentRepository) {}

  async preview(documentId: string, revision: number, options: BilingualOptions, offset: number, guard: () => void = () => {}, reviewOnly = false) {
    const snapshot = await this.repository.readSnapshot(documentId);
    guard();
    if (snapshot.document.revision !== revision) throw new StudioError('revision_conflict');
    assertUninterpreted(snapshot);
    return previewBilingual(snapshot.document, options, offset, reviewOnly);
  }

  async apply(documentId: string, revision: number, options: BilingualOptions, guard: () => void = () => {}) {
    const snapshot = await this.repository.transact(documentId, revision, value => {
      assertUninterpreted(value);
      value.document = applyBilingual(value.document, options, randomUUID, sourceDigest);
    }, guard);
    return snapshot.document;
  }

  async removeTrack(documentId: string, revision: number, trackId: string, guard: () => void = () => {}) {
    const snapshot = await this.repository.transact(documentId, revision, value => {
      if (!value.document.translationTracks.some(track => track.id === trackId)) throw new StudioError('invalid_input');
      // Running translations commit against the document revision, including changes to other tracks.
      if (value.tasks.some(task => task.status === 'queued' || task.status === 'running')) throw new StudioError('revision_conflict');
      const tasks = value.tasks.filter(task => task.trackId === trackId);
      if (tasks.some(task => !['completed', 'failed', 'cancelled'].includes(task.status))) throw new StudioError('revision_conflict');
      value.document.translationTracks = value.document.translationTracks.filter(track => track.id !== trackId);
      value.tasks = value.tasks.filter(task => task.trackId !== trackId);
    }, guard);
    return snapshot.document;
  }
}
