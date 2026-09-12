import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StudioError, type MediaSubtitleDocument } from '../../../../src/subtitle-studio/domain';
import { DocumentRepository, type DocumentCreationReceipt } from '../document-repository';
import { transcriptToDocument } from './document-adapter';
import type { LocalSubtitleOwnerKey } from './native/authorizations';
import { sourceLocationCaptureSchema, type SourceLocationCapture } from '../source-location-service';

export interface TranscriptionDocumentSinkOptions {
  readonly repository: DocumentRepository;
  readonly owner: LocalSubtitleOwnerKey;
  readonly taskId: string;
  readonly generation: number;
  readonly assertActive: () => void;
  readonly sourceLocation?: SourceLocationCapture;
  readonly resolveSourceLocation?: () => Promise<SourceLocationCapture>;
}

const identityString = z.string().min(1).max(128).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const optionsSchema = z.object({
  repository: z.instanceof(DocumentRepository),
  owner: z.object({ webContentsId: z.number().int().positive().safe(), ownerSessionId: identityString }).strict(),
  taskId: identityString,
  generation: z.number().int().positive().safe(),
  assertActive: z.custom<() => void>(value => typeof value === 'function'),
  sourceLocation: sourceLocationCaptureSchema.optional(),
  resolveSourceLocation: z.custom<() => Promise<SourceLocationCapture>>(value => typeof value === 'function').optional(),
}).strict().refine(value => !value.sourceLocation || !value.resolveSourceLocation);

/** Main-process authority for one final transcript. No owner credentials enter the document. */
export function createTranscriptionDocumentSink(options: TranscriptionDocumentSinkOptions) {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) throw new StudioError('invalid_input');
  const { repository, assertActive, resolveSourceLocation } = parsed.data;
  let sourceLocation = parsed.data.sourceLocation;
  const identity = Object.freeze({ owner: Object.freeze(parsed.data.owner), taskId: parsed.data.taskId, generation: parsed.data.generation });
  const documentId = randomUUID();
  const cueIds: string[] = [];
  let document: MediaSubtitleDocument | undefined;
  let operation: Promise<DocumentCreationReceipt> | undefined;
  let committed = false;

  function publish(transcript: unknown, request: { signal?: AbortSignal } = {}): Promise<DocumentCreationReceipt> {
    try {
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => key !== 'signal')
        || (request.signal !== undefined && !(request.signal instanceof AbortSignal))) throw new StudioError('invalid_input');
      assertActive();
      if (!committed && request.signal?.aborted) throw new StudioError('interrupted');
      let index = 0;
      const candidate = transcriptToDocument(transcript, { documentId, newId: () => cueIds[index++] ?? (cueIds[index - 1] = randomUUID()) });
      if (document && document.origin.transcriptDigest !== candidate.origin.transcriptDigest) throw new StudioError('revision_conflict');
      document ??= candidate;
      if (operation) return operation;
      const guard = () => {
        assertActive();
        if (!committed && request.signal?.aborted) throw new StudioError('interrupted');
      };
      // Replays visit the repository again: a cached success cannot resurrect a deleted document.
      const pending = Promise.resolve().then(async () => {
        sourceLocation ??= await resolveSourceLocation?.();
        guard();
        return repository.createConfirmed(document!, guard, sourceLocation);
      }).then(receipt => {
        committed = true;
        // Publication wins over a cancellation or owner release arriving after the final guard.
        return receipt;
      });
      operation = pending;
      void pending.then(() => { if (operation === pending) operation = undefined; }, () => { if (operation === pending) operation = undefined; });
      return pending;
    } catch (error) { return Promise.reject(error); }
  }
  return Object.freeze({ identity, documentId, publish });
}

export type TranscriptionDocumentSink = ReturnType<typeof createTranscriptionDocumentSink>;
