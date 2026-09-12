import { StudioError } from '../../../src/subtitle-studio/domain';
import type { DocumentRepository } from './document-repository';
import type { TranslationService } from './translation-service';

export function createAutomaticTranslationCoordinator(options: { repository: DocumentRepository; translation: TranslationService }) {
  let closed = false;
  let initialized: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  const admissions = new Map<string, Promise<{ taskId: string }>>();
  const assertOpen = () => { if (closed) throw new StudioError('interrupted'); };
  function initialize(): Promise<void> {
    try { assertOpen(); } catch (error) { return Promise.reject(error); }
    if (!initialized) {
      const operation = options.translation.initialize(); initialized = operation;
      void operation.catch(() => { if (initialized === operation) initialized = undefined; });
    }
    return initialized;
  }
  function handoff(documentId: string, intentId: string, apiKey: string): Promise<{ taskId: string }> {
    const identity = JSON.stringify([documentId, intentId]);
    const existing = admissions.get(identity); if (existing) return existing;
    const operation = Promise.resolve().then(async () => {
      assertOpen(); await initialize(); assertOpen();
      // Read through the repository on every replay: cached completion cannot revive deletion.
      const snapshot = await options.repository.readSnapshot(documentId); assertOpen();
      if (snapshot.automaticTranslation?.intentId !== intentId) throw new StudioError('access_denied');
      return options.translation.startAutomatic(documentId, intentId, apiKey, assertOpen);
    });
    admissions.set(identity, operation);
    const release = () => { if (admissions.get(identity) === operation) admissions.delete(identity); };
    void operation.then(release, release);
    return operation;
  }
  return Object.freeze({ initialize, handoff,
    shutdown(): Promise<void> {
      closed = true;
      return shutdown ??= Promise.allSettled([...admissions.values(), ...(initialized ? [initialized] : [])]).then(() => undefined);
    },
  });
}
export type AutomaticTranslationCoordinator = ReturnType<typeof createAutomaticTranslationCoordinator>;
