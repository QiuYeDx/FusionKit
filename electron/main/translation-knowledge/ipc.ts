import { z } from 'zod';
import { KNOWLEDGE_CHANNELS } from '../../../src/translation-knowledge/ipc-contract';

const generation = z.number().int().nonnegative().safe();
const id = z.string().uuid();
const empty = z.object({}).strict();
export const knowledgeRequestSchemas = {
  read: empty,
  selectImport: empty,
  commitImport: z.object({ planId: id, decisions: z.array(z.object({ id, action: z.enum(['keep', 'replace', 'copy', 'skip']) }).strict()).max(20000), adoptReady: z.boolean() }).strict(),
  saveRecord: z.object({ generation, group: z.enum(['subjects', 'collections', 'sources', 'entries', 'styles', 'recipes', 'preferenceTemplates']), record: z.record(z.string(), z.unknown()), source: z.record(z.string(), z.unknown()).optional(), adopt: z.boolean().optional() }).strict(),
  reviewEntries: z.object({ generation, ids: z.array(id).min(1).max(20000).refine(ids => new Set(ids).size === ids.length), action: z.enum(['adopt', 'reject', 'archive']) }).strict(),
  exportFile: z.object({ generation, purpose: z.enum(['backup', 'share']), collectionIds: z.array(id).max(20000).refine(ids => new Set(ids).size === ids.length), includeMemories: z.boolean() }).strict(),
};
export const knowledgeEnvelopeSchema = z.object({ capability: id, payload: z.unknown() }).strict();
export const publicKnowledgeChannels = Object.keys(knowledgeRequestSchemas).map(key => KNOWLEDGE_CHANNELS[key as keyof typeof knowledgeRequestSchemas]);
export function trustedKnowledgeUrl(actual: string, expected: string): boolean {
  try { const a = new URL(actual); const b = new URL(expected); a.hash = ''; b.hash = ''; return a.href === b.href; }
  catch { return false; }
}
