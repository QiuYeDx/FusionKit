import { StudioError } from '../../../src/subtitle-studio/domain';
import type { AutomaticTranslationRequest } from '../../../src/subtitle-studio/automatic-translation-contract';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import { buildFrozenAutomaticKnowledge, type FrozenAutomaticKnowledge } from '../../../src/translation-knowledge/automatic-snapshot-contract';

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

/** Freezes materials before transcription and bounds what pending captures may hold in memory. */
export class AutomaticKnowledgeService implements AutomaticKnowledgeCapture {
  private held = new Set<{ bytes: number }>();
  private closed = false;
  constructor(private readLibrary: () => Promise<LibrarySnapshot>) {}
  async capture(request: NonNullable<AutomaticTranslationRequest['knowledge']>, guard: () => void = () => {}) {
    const alive = () => { if (this.closed) throw new StudioError('interrupted'); guard(); };
    alive();
    const library = await this.readLibrary(); alive();
    const snapshot = freezeMaterial(buildFrozenAutomaticKnowledge(library, request));
    const capture = { bytes: Buffer.byteLength(JSON.stringify(snapshot), 'utf8') };
    if (this.held.size >= AUTOMATIC_KNOWLEDGE_CAPTURE_LIMITS.captures
      || capture.bytes + [...this.held].reduce((sum, item) => sum + item.bytes, 0) > AUTOMATIC_KNOWLEDGE_CAPTURE_LIMITS.bytes) throw new StudioError('limit_exceeded');
    this.held.add(capture);
    return { snapshot, release: () => { this.held.delete(capture); } };
  }
  /** Existing captures remain until their task owners finish cleanup. */
  close(): void { this.closed = true; }
}
