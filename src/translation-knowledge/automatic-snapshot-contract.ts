import { z } from 'zod';
import { StudioError } from '../subtitle-studio/domain';
import { sha256Canonical } from './canonicalize';
import { knowledgeSelectionSchema, normalizeKnowledgeSelection } from './execution-contract';
import { KNOWLEDGE_EXECUTION_POLICY } from './execution';
import { captureKnowledgeSelectionData } from './snapshot-contract';
import { knowledgePackageSchema } from './schemas';
import { validatePackage } from './validation';
import type { LibrarySnapshot } from './ipc-contract';

export const AUTOMATIC_KNOWLEDGE_POLICY = `automatic-knowledge-preparation/2;${KNOWLEDGE_EXECUTION_POLICY}` as const;
export const AUTOMATIC_KNOWLEDGE_MAX_BYTES = 4 * 1024 * 1024;
export const automaticKnowledgeRequestSchema = z.object({
  knowledgeGeneration: z.number().int().nonnegative().safe(), selection: knowledgeSelectionSchema,
}).strict();
export type AutomaticKnowledgeRequest = z.infer<typeof automaticKnowledgeRequestSchema>;
/** Durable materials captured before transcription, when no subtitle cues exist yet. */
export const frozenAutomaticKnowledgeSchema = z.object({
  version: z.literal(2), policyVersion: z.literal(AUTOMATIC_KNOWLEDGE_POLICY), generation: z.number().int().nonnegative().safe(),
  selection: knowledgeSelectionSchema, data: knowledgePackageSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type FrozenAutomaticKnowledge = z.infer<typeof frozenAutomaticKnowledgeSchema>;
const invalid = (): never => { throw new TypeError('Invalid frozen automatic knowledge'); };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Validate choices that do not depend on subtitle text; matching and conflicts
 * remain deferred until the actual transcript has been published. */
function assertSelection({ selection, data }: Pick<FrozenAutomaticKnowledge, 'selection' | 'data'>): void {
  for (const id of selection.collectionIds) {
    const collection = data.collections.find(item => item.id === id);
    if (!collection || collection.archived || collection.languagePair.source !== selection.languagePair.source || collection.languagePair.target !== selection.languagePair.target) invalid();
  }
}

export function buildFrozenAutomaticKnowledge(library: LibrarySnapshot, input: AutomaticKnowledgeRequest): FrozenAutomaticKnowledge {
  const parsed = automaticKnowledgeRequestSchema.safeParse(input);
  if (!parsed.success) throw new StudioError('invalid_input');
  if (library.generation !== parsed.data.knowledgeGeneration) throw new StudioError('revision_conflict');
  try {
    const selection = normalizeKnowledgeSelection(parsed.data.selection);
    const base = { version: 2 as const, policyVersion: AUTOMATIC_KNOWLEDGE_POLICY, generation: library.generation,
      selection, data: captureKnowledgeSelectionData(library, selection) };
    const snapshot = { ...base, digest: sha256Canonical(base) };
    if (bytes(snapshot) > AUTOMATIC_KNOWLEDGE_MAX_BYTES) throw new StudioError('limit_exceeded');
    return validateFrozenAutomaticKnowledge(snapshot);
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw new StudioError('knowledge_check_failed');
  }
}

/** Never consult the live library. */
export function validateFrozenAutomaticKnowledge(value: unknown): FrozenAutomaticKnowledge {
  if (bytes(value) > AUTOMATIC_KNOWLEDGE_MAX_BYTES) invalid();
  const parsed = frozenAutomaticKnowledgeSchema.safeParse(value);
  if (!parsed.success) invalid();
  const snapshot = parsed.data!, { digest, ...base } = snapshot;
  if (sha256Canonical(base) !== digest || !validatePackage(snapshot.data).valid) invalid();
  assertSelection(snapshot);
  if (sha256Canonical(captureKnowledgeSelectionData(snapshot, snapshot.selection)) !== sha256Canonical(snapshot.data)) invalid();
  return snapshot;
}
