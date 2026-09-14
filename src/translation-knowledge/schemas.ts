import { z } from 'zod'

/** FK-TK/1 resource limits. Byte limits are additionally enforced by validation.ts. */
export const LIMITS = Object.freeze({ fileBytes: 32 * 1024 * 1024, entities: 20_000, textBytes: 32 * 1024, depth: 32, extensionBytes: 64 * 1024, diagnostics: 100 })
export const ENTITY_ARRAYS = ['subjects', 'collections', 'sources', 'entries', 'styles', 'recipes', 'preferenceTemplates'] as const
const text = z.string().max(LIMITS.textBytes)
const nonblank = text.regex(/\S/u, 'Must contain non-whitespace text')
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const utc = z.iso.datetime({ offset: false })
const language = nonblank
const extensions = z.record(z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/), z.json())
const record = { id: uuid, revision, extensions: extensions.optional() }
const catalog = { ...record, archived: z.boolean() }
const ids = z.array(uuid).max(LIMITS.entities)
export const languagePairSchema = z.strictObject({ source: language, target: language })
export const subjectSchema = z.strictObject({ ...catalog, kind: z.enum(['person', 'work', 'domain', 'other']), name: nonblank, aliases: z.array(nonblank), tags: z.array(nonblank), description: text })
export const collectionSchema = z.strictObject({ ...catalog, name: nonblank, description: text, aboutSubjectIds: ids, defaultLanguagePair: languagePairSchema.optional() })
export const sourceSchema = z.strictObject({ ...record, kind: z.enum(['user_note', 'web', 'document', 'reviewed_subtitle', 'ai_proposal']), title: nonblank, excerpt: nonblank, url: nonblank.optional(), accessedAt: utc.optional(), attribution: nonblank.optional(), contentDigest: digest.optional(), digestDescription: nonblank.optional() })
const subjectRole = z.enum(['present', 'topic', 'speaker', 'mentioned'])
const condition = z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('none') }), z.strictObject({ mode: z.literal('advisory'), text: nonblank }), z.strictObject({ mode: z.literal('requires_confirmation'), text: nonblank })])
export const scopeSchema = z.strictObject({ languagePair: languagePairSchema, requiredSubjects: z.array(z.strictObject({ subjectId: uuid, role: subjectRole })), condition })
const entryBase = { ...record, title: nonblank, collectionId: uuid, aboutSubjectIds: ids, scope: scopeSchema, state: z.enum(['candidate', 'ready', 'needs_review', 'rejected', 'archived']), evidence: z.array(z.strictObject({ sourceId: uuid, support: z.enum(['direct', 'inferred']), note: text.optional() })).min(1), derivedFrom: z.array(z.strictObject({ entryId: uuid, revision, digest, evidenceSourceId: uuid })) }
export const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...entryBase, kind: z.literal('context'), payload: z.strictObject({ text: nonblank, assertion: z.enum(['fact', 'reported', 'uncertain']), core: z.boolean() }) }),
  z.strictObject({ ...entryBase, kind: z.literal('term'), payload: z.strictObject({ source: nonblank, target: nonblank, aliases: z.array(nonblank), sense: text, match: z.strictObject({ mode: z.enum(['whole_term', 'literal_phrase']), caseSensitive: z.boolean() }), strength: z.enum(['required', 'preferred', 'keep_source']) }) }),
  z.strictObject({ ...entryBase, kind: z.literal('expression'), payload: z.strictObject({ sourcePhrase: nonblank, interpretation: nonblank, targetExamples: z.array(nonblank), mustNotInventOccurrences: z.literal(true) }) }),
  z.strictObject({ ...entryBase, kind: z.literal('memory'), payload: z.strictObject({ source: nonblank, target: nonblank, beforeSource: text.optional(), afterSource: text.optional(), alignment: z.enum(['one_to_one', 'reviewed_segment']), directReuseAllowed: z.literal(false) }) }),
  z.strictObject({ ...entryBase, kind: z.literal('rule'), payload: z.strictObject({ dimension: z.enum(['register', 'honorifics', 'person_reference', 'fidelity', 'other']), text: nonblank, strength: z.enum(['required', 'preferred']) }) }),
])
export const styleSchema = z.strictObject({ ...catalog, name: nonblank, description: text, languagePair: languagePairSchema, ruleEntryIds: ids.min(1) })
export const recipeSchema = z.strictObject({ ...catalog, name: nonblank, description: text, languagePair: languagePairSchema, readCollectionIds: ids, subjectSuggestions: z.array(z.strictObject({ subjectId: uuid, role: z.enum(['topic', 'speaker', 'mentioned']) })), baseStyleId: uuid.optional(), modifierStyleIds: ids, instructions: text, context: text, inheritGlobalPreferences: z.boolean(), learningSuggestion: z.enum(['off', 'save_reviewed']), suggestedDestinationCollectionId: uuid.optional() })
export const preferenceTemplateSchema = z.strictObject({ ...catalog, name: nonblank, instructions: nonblank })
export const knowledgePackageSchema = z.strictObject({
  format: z.literal('fusionkit.translation-knowledge'), schemaVersion: z.literal(1),
  package: z.strictObject({ ...record, name: nonblank, description: text, purpose: z.enum(['share', 'backup']), createdAt: utc, generator: z.strictObject({ name: nonblank, version: nonblank.optional() }), author: nonblank.optional(), sharingNote: text.optional() }),
  subjects: z.array(subjectSchema).max(LIMITS.entities), collections: z.array(collectionSchema).max(LIMITS.entities), sources: z.array(sourceSchema).max(LIMITS.entities), entries: z.array(entrySchema).max(LIMITS.entities), styles: z.array(styleSchema).max(LIMITS.entities), recipes: z.array(recipeSchema).max(LIMITS.entities), preferenceTemplates: z.array(preferenceTemplateSchema).max(LIMITS.entities), extensions: extensions.optional(),
})

export type KnowledgePackage = z.infer<typeof knowledgePackageSchema>
export type Subject = z.infer<typeof subjectSchema>
export type Collection = z.infer<typeof collectionSchema>
export type Source = z.infer<typeof sourceSchema>
export type Entry = z.infer<typeof entrySchema>
export type Style = z.infer<typeof styleSchema>
export type Recipe = z.infer<typeof recipeSchema>
export type PreferenceTemplate = z.infer<typeof preferenceTemplateSchema>
export type LanguagePair = z.infer<typeof languagePairSchema>
export type Scope = z.infer<typeof scopeSchema>

/** Generated artifacts consume this exact schema; semantics remain in validatePackage. */
export function knowledgePackageJsonSchema() {
  return { ...z.toJSONSchema(knowledgePackageSchema, { target: 'draft-2020-12' }), title: 'FusionKit Translation Knowledge v1', 'x-fktk-limits': LIMITS }
}
