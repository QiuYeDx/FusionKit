import { randomUUID } from 'node:crypto';
import { StudioError, translationTrackNameSchema } from '../../../src/subtitle-studio/domain';
import type { DocumentRepository } from './document-repository';

/** The document schema's limit on translation tracks. */
const MAX_TRACKS = 100;

/** Names are local metadata. Keep content revisions and execution checkpoints intact. */
export class TranslationTrackService {
  constructor(private repository: DocumentRepository) {}

  /** An empty AI track an external agent fills itself; it never carries an execution record. */
  async createAgentTrack(documentId: string, revision: number, input: { language: string; name?: string; agent: { name: string } }, guard: () => void = () => {}) {
    const trackId = randomUUID();
    const snapshot = await this.repository.transact(documentId, revision, value => {
      if (value.document.translationTracks.length >= MAX_TRACKS) throw new StudioError('limit_exceeded');
      const name = input.name?.trim() || input.agent.name;
      value.document.translationTracks.push({ id: trackId, language: input.language.trim(), name, revision: 1, origin: 'ai', agent: { name: input.agent.name }, entries: {} });
    }, guard);
    return { document: snapshot.document, trackId };
  }

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
