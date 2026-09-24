import { StudioError, translationTrackNameSchema } from '../../../src/subtitle-studio/domain';
import type { DocumentRepository } from './document-repository';

/** Names are local metadata. Keep content revisions and execution checkpoints intact. */
export class TranslationTrackService {
  constructor(private repository: DocumentRepository) {}

  async rename(documentId: string, revision: number, trackId: string, input: string, guard: () => void = () => {}) {
    const parsed = translationTrackNameSchema.safeParse(input);
    if (!parsed.success) throw new StudioError('invalid_input');
    const snapshot = await this.repository.transact(documentId, revision, value => {
      const track = value.document.translationTracks.find(item => item.id === trackId);
      if (!track) throw new StudioError('invalid_input');
      if (value.tasks.some(task => task.status === 'queued' || task.status === 'running')) throw new StudioError('resource_busy');
      if (parsed.data) track.name = parsed.data;
      else delete track.name;
    }, guard);
    return snapshot.document;
  }
}
