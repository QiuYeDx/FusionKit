import { z } from 'zod';
import { ENTITY_ARRAYS, entrySchema, subjectSchema, collectionSchema, sourceSchema, styleSchema, recipeSchema, preferenceTemplateSchema } from '../../../src/translation-knowledge/schemas';
import type { EntityGroup, KnowledgeEntity } from '../../../src/translation-knowledge/ipc-contract';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const entity = z.union([entrySchema, subjectSchema, collectionSchema, sourceSchema, styleSchema, recipeSchema, preferenceTemplateSchema]);
export const referenceSchema = z.strictObject({ group: z.enum(ENTITY_ARRAYS), id: z.uuid(), digest });
export const changeSetSchema = z.strictObject({
  id: z.uuid(), generation: integer,
  changes: z.array(z.strictObject({ group: z.enum(ENTITY_ARRAYS), id: z.uuid(), before: entity.optional(), afterDigest: digest, afterRevision: integer.positive(), afterApprovalDigest: digest.optional(), inboundAfter: z.array(referenceSchema) })),
});
export type ImportChangeSet = z.infer<typeof changeSetSchema>;
export const maintenanceReceiptSchema = z.strictObject({ id: z.uuid(), action: z.enum(['archive', 'restore', 'undo_import', 'purge']), generation: integer, changed: integer, cleanupPending: z.boolean() });
export const maintenanceCommitSchema = z.strictObject({ ownerDigest: digest, requestDigest: digest, receipt: maintenanceReceiptSchema });
export type StoredMaintenanceCommit = z.infer<typeof maintenanceCommitSchema>;
export const historyFileSchema = z.strictObject({ name: z.string().regex(/^(?:generation-\d+-[a-f0-9-]{36}|\.pending-(?:purge-)?[a-f0-9-]{36})\.json$/), digest });
export type HistoryFile = z.infer<typeof historyFileSchema>;
export const purgeJournalSchema = z.strictObject({ format: z.literal(1), id: z.uuid(), generation: integer, target: z.strictObject({ name: z.string().regex(/^generation-\d+-[a-f0-9-]{36}\.json$/), digest }), files: z.array(historyFileSchema) });

export function catalog(data: { [key in EntityGroup]: KnowledgeEntity[] }): Map<string, { group: EntityGroup; record: KnowledgeEntity }> {
  return new Map(ENTITY_ARRAYS.flatMap(group => data[group].map(record => [record.id, { group, record }] as const)));
}

/** All portable relationships, including optional historical parents, matter to maintenance. */
export function references(group: EntityGroup, record: KnowledgeEntity): string[] {
  if (group === 'collections') return (record as z.infer<typeof collectionSchema>).aboutSubjectIds;
  if (group === 'entries') {
    const entry = record as z.infer<typeof entrySchema>;
    return [entry.collectionId, ...entry.aboutSubjectIds, ...entry.scope.requiredSubjects.map(item => item.subjectId), ...entry.evidence.map(item => item.sourceId), ...entry.derivedFrom.flatMap(item => [item.entryId, item.evidenceSourceId])];
  }
  if (group === 'styles') return (record as z.infer<typeof styleSchema>).ruleEntryIds;
  if (group === 'recipes') {
    const recipe = record as z.infer<typeof recipeSchema>;
    return [...recipe.readCollectionIds, ...recipe.subjectSuggestions.map(item => item.subjectId), ...(recipe.baseStyleId ? [recipe.baseStyleId] : []), ...recipe.modifierStyleIds, ...(recipe.suggestedDestinationCollectionId ? [recipe.suggestedDestinationCollectionId] : [])];
  }
  return [];
}
