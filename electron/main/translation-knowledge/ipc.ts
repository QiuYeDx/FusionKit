import { z } from 'zod';
import path from 'node:path';
import { KNOWLEDGE_CHANNELS } from '../../../src/translation-knowledge/ipc-contract';

const generation = z.number().int().nonnegative().safe();
const id = z.string().uuid();
const empty = z.object({}).strict();
const ids = z.array(id).max(20000).refine(values => new Set(values).size === values.length);
const group = z.enum(['subjects', 'collections', 'sources', 'entries', 'styles', 'recipes', 'preferenceTemplates']);
const maintenanceTargets = z.array(z.object({ group, id }).strict()).min(1).max(20000).refine(values => new Set(values.map(value => value.id)).size === values.length);
export const knowledgeRequestSchemas = {
  read: empty,
  selectImport: empty,
  importDroppedFile: z.object({ path: z.string().min(1).max(32768).refine(value => path.isAbsolute(value)) }).strict(),
  commitImport: z.object({ planId: id, decisions: z.array(z.object({ id, action: z.enum(['keep', 'replace', 'copy', 'skip']) }).strict()).max(20000), adoptReady: z.boolean() }).strict(),
  saveRecord: z.object({ generation, group: z.enum(['subjects', 'collections', 'sources', 'entries', 'styles', 'recipes', 'preferenceTemplates']), record: z.record(z.string(), z.unknown()), source: z.record(z.string(), z.unknown()).optional(), adopt: z.boolean().optional() }).strict(),
  reviewEntries: z.object({ generation, ids: z.array(id).min(1).max(20000).refine(ids => new Set(ids).size === ids.length), action: z.enum(['adopt', 'reject', 'archive']) }).strict(),
  planMaintenance: z.discriminatedUnion('action', [
    z.object({ generation, action: z.literal('archive'), targets: maintenanceTargets }).strict(),
    z.object({ generation, action: z.literal('restore'), targets: maintenanceTargets }).strict(),
    z.object({ generation, action: z.literal('purge'), targets: maintenanceTargets }).strict(),
    z.object({ generation, action: z.literal('undo_import'), importId: id }).strict(),
  ]),
  commitMaintenance: z.object({ planId: id, confirmHistoryRemoval: z.boolean().optional() }).strict(),
  planExport: z.object({ generation, purpose: z.enum(['backup', 'share']), collectionIds: ids, recipeIds: ids, includeMemories: z.boolean(), includeUnreviewed: z.boolean(), includeInactive: z.boolean(), excludedSourceIds: ids }).strict(),
  exportFile: z.object({ planId: id }).strict(),
};
export const knowledgeEnvelopeSchema = z.object({ capability: id, payload: z.unknown() }).strict();
export const publicKnowledgeChannels = Object.keys(knowledgeRequestSchemas).map(key => KNOWLEDGE_CHANNELS[key as keyof typeof knowledgeRequestSchemas]);
export function trustedKnowledgeUrl(actual: string, expected: string): boolean {
  try { const a = new URL(actual); const b = new URL(expected); a.hash = ''; b.hash = ''; return a.href === b.href; }
  catch { return false; }
}
