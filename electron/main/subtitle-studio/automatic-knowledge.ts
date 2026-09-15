import { randomUUID } from 'node:crypto';
import { StudioError } from '../../../src/subtitle-studio/domain';
import type { AutomaticTranslationRequest } from '../../../src/subtitle-studio/automatic-translation-contract';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import { automaticKnowledgeResourceReferences, buildFrozenAutomaticKnowledge, type FrozenAutomaticKnowledge } from '../../../src/translation-knowledge/automatic-snapshot-contract';
import type { AutomaticKnowledgeReference, KnowledgeTaskGate } from '../../../src/translation-knowledge/task-reference-contract';

export interface AutomaticKnowledgeCapture {
  capture(request: NonNullable<AutomaticTranslationRequest['knowledge']>, guard?: () => void): Promise<{
    snapshot: FrozenAutomaticKnowledge; release(): void;
  }>;
}
export const AUTOMATIC_KNOWLEDGE_CAPTURE_LIMITS = { captures: 32, bytes: 32 * 1024 * 1024 } as const;
function freezeMaterial(snapshot: FrozenAutomaticKnowledge): FrozenAutomaticKnowledge {
  const pending: object[] = [snapshot];
  while (pending.length) {
    const value = pending.pop()!;
    for (const child of Object.values(value)) if (child && typeof child === 'object') pending.push(child);
    Object.freeze(value);
  }
  return snapshot;
}

/** Owns references from pre-transcription capture until publication or cancellation.
 * The shared gate serializes the live read + lease with final permanent clearing. */
export class AutomaticKnowledgeService implements AutomaticKnowledgeCapture {
  private leases = new Map<string, { bytes: number; reference: AutomaticKnowledgeReference }>();
  private closed = false;
  constructor(private readLibrary: () => Promise<LibrarySnapshot>, private gate: KnowledgeTaskGate) {}
  async capture(request: NonNullable<AutomaticTranslationRequest['knowledge']>, guard: () => void = () => {}) {
    const alive = () => { if (this.closed) throw new StudioError('interrupted'); guard(); };
    alive();
    return this.gate.run(async () => {
      alive();
      const library = await this.readLibrary(); alive();
      const snapshot = freezeMaterial(buildFrozenAutomaticKnowledge(library, request));
      const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
      if (this.leases.size >= AUTOMATIC_KNOWLEDGE_CAPTURE_LIMITS.captures
        || bytes + [...this.leases.values()].reduce((sum, lease) => sum + lease.bytes, 0) > AUTOMATIC_KNOWLEDGE_CAPTURE_LIMITS.bytes) throw new StudioError('limit_exceeded');
      const preparationId = randomUUID();
      this.leases.set(preparationId, { bytes, reference: { kind: 'automatic_preparation', preparationId,
        displayName: '', status: 'active', resources: automaticKnowledgeResourceReferences(snapshot) } });
      return { snapshot, release: () => { this.leases.delete(preparationId); } };
    });
  }
  activeKnowledgeReferences(): AutomaticKnowledgeReference[] { return [...this.leases.values()].map(lease => structuredClone(lease.reference)); }
  /** Existing leases remain until their task owners finish cleanup. */
  close(): void { this.closed = true; }
}
