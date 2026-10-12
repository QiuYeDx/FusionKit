import { z } from 'zod'

/** FK-TK/2 resource limits. Byte limits are additionally enforced by validation.ts. */
export const LIMITS = Object.freeze({ fileBytes: 32 * 1024 * 1024, entities: 20_000, textBytes: 32 * 1024, depth: 32, extensionBytes: 64 * 1024, diagnostics: 100 })
export const SCHEMA_VERSION = 2
export const ENTITY_ARRAYS = ['collections', 'entries', 'presets'] as const
const text = z.string().max(LIMITS.textBytes)
const nonblank = text.regex(/\S/u, 'Must contain non-whitespace text')
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const utc = z.iso.datetime({ offset: false })
const language = nonblank
const extensions = z.record(z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/), z.json())
const record = { id: uuid, revision, extensions: extensions.optional() }
const ids = z.array(uuid).max(LIMITS.entities)
export const languagePairSchema = z.strictObject({ source: language, target: language })
export const collectionSchema = z.strictObject({ ...record, name: nonblank, description: text, languagePair: languagePairSchema, archived: z.boolean() })
/** Where an entry came from. Informational only; it never changes whether the entry applies. */
export const originSchema = z.strictObject({
  kind: z.enum(['manual', 'revision', 'agent', 'web', 'import']),
  note: text.optional(), url: nonblank.optional(), title: nonblank.optional(), at: utc.optional(),
})
const entryBase = { ...record, collectionId: uuid, enabled: z.boolean(), origin: originSchema.optional() }
export const termPayloadSchema = z.strictObject({
  source: nonblank, target: nonblank, aliases: z.array(nonblank), note: text,
  strength: z.enum(['required', 'preferred', 'keep_source']),
  match: z.strictObject({ mode: z.enum(['whole_term', 'literal_phrase']), caseSensitive: z.boolean() }),
})
export const notePayloadSchema = z.strictObject({ text: nonblank, required: z.boolean() })
export const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...entryBase, kind: z.literal('term'), payload: termPayloadSchema }),
  /** Background the model should know. */
  z.strictObject({ ...entryBase, kind: z.literal('context'), payload: notePayloadSchema }),
  /** A requirement the translation should follow. */
  z.strictObject({ ...entryBase, kind: z.literal('rule'), payload: notePayloadSchema }),
])
export const presetSchema = z.strictObject({ ...record, name: nonblank, languagePair: languagePairSchema, collectionIds: ids, instructions: text, context: text })
export const knowledgePackageSchema = z.strictObject({
  format: z.literal('fusionkit.translation-knowledge'), schemaVersion: z.literal(SCHEMA_VERSION),
  package: z.strictObject({ ...record, name: nonblank, description: text, createdAt: utc, generator: z.strictObject({ name: nonblank, version: nonblank.optional() }), author: nonblank.optional(), sharingNote: text.optional() }),
  collections: z.array(collectionSchema).max(LIMITS.entities), entries: z.array(entrySchema).max(LIMITS.entities), presets: z.array(presetSchema).max(LIMITS.entities), extensions: extensions.optional(),
})

export type KnowledgePackage = z.infer<typeof knowledgePackageSchema>
export type Collection = z.infer<typeof collectionSchema>
export type Entry = z.infer<typeof entrySchema>
export type EntryKind = Entry['kind']
export type TermEntry = Extract<Entry, { kind: 'term' }>
export type NoteEntry = Extract<Entry, { kind: 'context' | 'rule' }>
export type Preset = z.infer<typeof presetSchema>
export type Origin = z.infer<typeof originSchema>
export type LanguagePair = z.infer<typeof languagePairSchema>

/** Generated artifacts consume this exact schema; semantics remain in validatePackage. */
export function knowledgePackageJsonSchema() {
  return { ...z.toJSONSchema(knowledgePackageSchema, { target: 'draft-2020-12' }), title: 'FusionKit Translation Knowledge v2', 'x-fktk-limits': LIMITS }
}
