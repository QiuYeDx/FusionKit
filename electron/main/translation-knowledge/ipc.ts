import { z } from 'zod';
import path from 'node:path';
import { DELETE_BATCH_LIMIT, KNOWLEDGE_CHANNELS, SAVE_BATCH_LIMIT } from '../../../src/translation-knowledge/ipc-contract';

const generation = z.number().int().nonnegative().safe();
const id = z.string().uuid();
const empty = z.object({}).strict();
const ids = z.array(id).max(20000).refine(values => new Set(values).size === values.length);
const group = z.enum(['collections', 'entries', 'presets']);
const records = z.array(z.record(z.string(), z.unknown())).max(20000);
/** Shape checks only; the service validates each record against the protocol. */
export const knowledgeRequestSchemas = {
  read: empty,
  saveRecords: z.object({ generation, items: z.array(z.object({ group, record: z.record(z.string(), z.unknown()) }).strict()).min(1).max(SAVE_BATCH_LIMIT) }).strict(),
  deleteRecords: z.object({ generation, items: z.array(z.object({ group, id }).strict()).min(1).max(DELETE_BATCH_LIMIT) }).strict(),
  restoreRecords: z.object({ generation, records: z.object({ collections: records, entries: records, presets: records }).strict() }).strict(),
  selectImport: empty,
  importDroppedFile: z.object({ path: z.string().min(1).max(32768).refine(value => path.isAbsolute(value)) }).strict(),
  commitImport: z.object({ planId: id, collections: z.array(z.object({ id, action: z.enum(['add', 'merge', 'copy', 'skip']) }).strict()).max(20000), conflict: z.enum(['keep_local', 'use_incoming']), presets: z.enum(['add', 'skip']) }).strict(),
  planExport: z.object({ generation, collectionIds: ids, includeDisabled: z.boolean(), includePresets: z.boolean() }).strict(),
  exportFile: z.object({ planId: id }).strict(),
  exportSkill: empty,
};
export const knowledgeEnvelopeSchema = z.object({ capability: id, payload: z.unknown() }).strict();
export const publicKnowledgeChannels = Object.keys(knowledgeRequestSchemas).map(key => KNOWLEDGE_CHANNELS[key as keyof typeof knowledgeRequestSchemas]);
export function trustedKnowledgeUrl(actual: string, expected: string): boolean {
  try { const a = new URL(actual); const b = new URL(expected); a.hash = ''; b.hash = ''; return a.href === b.href; }
  catch { return false; }
}
