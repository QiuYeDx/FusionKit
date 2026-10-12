import { assertValidUnicode, canonicalize } from './canonicalize'
import { JsonInputError, parseStrictJson, pointer } from './json'
import { normalizeForMatching } from './matching'
import { ENTITY_ARRAYS, LIMITS, SCHEMA_VERSION, knowledgePackageSchema } from './schemas'
import type { KnowledgePackage, LanguagePair, TermEntry } from './schemas'

export interface Diagnostic { code: string; path: string; message: string }
export interface ValidationStats {
  bytes: number; entities: number; collections: number; entries: number; presets: number; errorCount: number; warningCount: number
}
export interface ValidationResult { valid: boolean; schemaVersion?: number; data?: KnowledgePackage; errors: Diagnostic[]; warnings: Diagnostic[]; stats: ValidationStats }
const encoder = new TextEncoder()
const emptyStats = (): ValidationStats => ({ bytes: 0, entities: 0, collections: 0, entries: 0, presets: 0, errorCount: 0, warningCount: 0 })
export const languagePairKey = (pair: LanguagePair) => `${pair.source}\0${pair.target}`

function validator(input: unknown, originalBytes?: number): ValidationResult {
  const result: ValidationResult = { valid: false, errors: [], warnings: [], stats: emptyStats() }
  if (originalBytes !== undefined) result.stats.bytes = originalBytes
  const diagnostic = (warning: boolean, code: string, path: string, message: string) => {
    const count = warning ? 'warningCount' : 'errorCount'
    result.stats[count]++
    const output = warning ? result.warnings : result.errors
    if (output.length < LIMITS.diagnostics) output.push({ code, path, message: message.length > 2048 ? `${message.slice(0, 2048)}… (diagnostic truncated)` : message })
  }
  const error = (code: string, path: string, message: string) => diagnostic(false, code, path, message)
  const warn = (code: string, path: string, message: string) => diagnostic(true, code, path, message)
  // Bound depth before handing data to Zod's recursive JSON schema or JCS.
  const ancestors = new Set<object>()
  const preflight = (value: unknown, parts: (string | number)[], depth: number): void => {
    const path = pointer(parts)
    if (depth > LIMITS.depth) { error('LIMIT_DEPTH', path, `Depth ${depth} exceeds ${LIMITS.depth}`); return }
    if (typeof value === 'string') {
      try { assertValidUnicode(value) } catch { error('INVALID_UNICODE', path, 'Lone Unicode surrogate is forbidden') }
      const bytes = encoder.encode(value).byteLength
      if (bytes > LIMITS.textBytes) error('LIMIT_TEXT_BYTES', path, `Text uses ${bytes} UTF-8 bytes; maximum is ${LIMITS.textBytes}`)
    } else if (typeof value === 'number' && !Number.isFinite(value)) error('NON_FINITE_NUMBER', path, 'JSON numbers must be finite')
    else if (value && typeof value === 'object') {
      if (ancestors.has(value)) { error('JSON_CYCLE', path, 'JSON cannot contain circular values'); return }
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) { error('JSON_VALUE', path, 'Expected a plain JSON object'); return }
      ancestors.add(value)
      for (const key of Object.keys(value)) {
        try { assertValidUnicode(key) } catch { error('INVALID_UNICODE', pointer([...parts, key]), 'Invalid Unicode object key') }
        if (encoder.encode(key).byteLength > LIMITS.textBytes) error('LIMIT_TEXT_BYTES', path, `Object key exceeds ${LIMITS.textBytes} UTF-8 bytes`)
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        if (!('value' in descriptor)) { error('JSON_VALUE', pointer([...parts, key]), 'Accessor properties are not JSON'); continue }
        preflight(descriptor.value, [...parts, key], depth + 1)
      }
      ancestors.delete(value)
    } else if (value !== null && typeof value !== 'boolean' && typeof value !== 'number') error('JSON_VALUE', path, 'Value is not JSON')
  }
  preflight(input, [], 0)
  if (result.stats.errorCount) return result
  try { result.stats.bytes = originalBytes ?? encoder.encode(canonicalize(input)).byteLength } catch (cause) { error('JSON_VALUE', '', String(cause)); return result }
  if (result.stats.bytes > LIMITS.fileBytes) { error('LIMIT_FILE_BYTES', '', `File uses ${result.stats.bytes} bytes; maximum is ${LIMITS.fileBytes}`); return result }
  const declared = input && typeof input === 'object' && 'schemaVersion' in input ? input.schemaVersion : undefined
  if (typeof declared === 'number') result.schemaVersion = declared
  if (declared !== undefined && declared !== SCHEMA_VERSION) { error('UNSUPPORTED_SCHEMA_VERSION', '/schemaVersion', `Unsupported schemaVersion ${String(declared)}; supported: ${SCHEMA_VERSION}`); return result }
  const parsed = knowledgePackageSchema.safeParse(input)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) error('SCHEMA_INVALID', pointer(issue.path.map(p => String(p))), issue.message)
    return result
  }
  const data = parsed.data
  for (const key of ENTITY_ARRAYS) result.stats[key] = data[key].length
  result.stats.entities = 1 + ENTITY_ARRAYS.reduce((total, key) => total + data[key].length, 0)
  if (result.stats.entities > LIMITS.entities) { error('LIMIT_ENTITIES', '', `Package has ${result.stats.entities} entities; maximum is ${LIMITS.entities}`); return result }

  const all = new Map<string, { type: string; path: string }>()
  const register = (id: string, type: string, path: string) => {
    const previous = all.get(id)
    if (previous) error('DUPLICATE_ID', `${path}/id`, `ID already occurs at ${previous.path}/id (${previous.type})`)
    else all.set(id, { type, path })
  }
  register(data.package.id, 'package', '/package')
  for (const key of ENTITY_ARRAYS) data[key].forEach((entity, i) => register(entity.id, key, `/${key}/${i}`))
  const collections = new Map(data.collections.map(item => [item.id, item]))
  const collection = (id: string, path: string) => {
    const entity = all.get(id)
    if (!entity) error('MISSING_REFERENCE', path, `Collection ${id} is absent from this package`)
    else if (entity.type !== 'collections') error('REFERENCE_TYPE', path, `Expected a collection, found ${entity.type} at ${entity.path}`)
    return collections.get(id)
  }
  const unique = (values: string[], path: string) => {
    const seen = new Map<string, number>()
    values.forEach((value, i) => { if (seen.has(value)) error('DUPLICATE_VALUE', `${path}/${i}`, `Duplicates index ${seen.get(value)}`); else seen.set(value, i) })
  }
  const languagePair = (pair: LanguagePair, path: string) => {
    for (const key of ['source', 'target'] as const) {
      const language = pair[key]
      try {
        const normalized = Intl.getCanonicalLocales(language)[0]
        const locale = new Intl.Locale(language)
        if (language !== normalized || ['auto', 'und', 'mul'].includes(language.split('-')[0]) || (locale.language === 'zh' && !['Hans', 'Hant'].includes(locale.script ?? ''))) error('LANGUAGE_TAG', `${path}/${key}`, `Use a canonical explicit BCP 47 tag (Chinese requires Hans/Hant); received ${language}`)
      } catch { error('LANGUAGE_TAG', `${path}/${key}`, `Invalid BCP 47 language tag ${language}`) }
    }
  }
  const checkExtensions = (value: unknown, parts: (string | number)[]) => {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'extensions')) return
    const bytes = encoder.encode(canonicalize((value as { extensions: unknown }).extensions)).byteLength
    if (bytes > LIMITS.extensionBytes) error('LIMIT_EXTENSION_BYTES', pointer([...parts, 'extensions']), `extensions uses ${bytes} bytes; maximum is ${LIMITS.extensionBytes}`)
  }
  checkExtensions(data, [])
  checkExtensions(data.package, ['package'])
  for (const key of ENTITY_ARRAYS) data[key].forEach((entity, i) => checkExtensions(entity, [key, i]))
  data.collections.forEach((item, i) => languagePair(item.languagePair, `/collections/${i}/languagePair`))
  data.entries.forEach((item, i) => {
    const path = `/entries/${i}`
    collection(item.collectionId, `${path}/collectionId`)
    if (item.origin?.url) {
      try { const url = new URL(item.origin.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid URL') } catch { error('ORIGIN_URL', `${path}/origin/url`, 'Use an absolute http/https URL without credentials') }
    }
    if (item.kind === 'term') {
      unique(item.payload.aliases, `${path}/payload/aliases`)
      item.payload.aliases.forEach((alias, j) => { if (alias === item.payload.source) error('ALIAS_IS_SOURCE', `${path}/payload/aliases/${j}`, 'An alias must differ from the source term') })
      if (item.payload.strength === 'keep_source' && item.payload.target !== item.payload.source) error('KEEP_SOURCE_TARGET', `${path}/payload/target`, 'keep_source requires target to exactly equal source')
    }
  })
  data.presets.forEach((item, i) => {
    const path = `/presets/${i}`
    languagePair(item.languagePair, `${path}/languagePair`)
    unique(item.collectionIds, `${path}/collectionIds`)
    item.collectionIds.forEach((id, j) => {
      const target = collection(id, `${path}/collectionIds/${j}`)
      if (target && languagePairKey(target.languagePair) !== languagePairKey(item.languagePair)) error('PRESET_LANGUAGE_MISMATCH', `${path}/collectionIds/${j}`, `Collection ${id} translates a different language pair`)
    })
  })
  // Offline hints only; whether two terms meet is decided when a task selects them.
  const terms = new Map<string, { entry: TermEntry; index: number }>()
  data.entries.forEach((entry, index) => {
    if (entry.kind !== 'term') return
    const pair = collections.get(entry.collectionId)?.languagePair
    if (!pair) return
    for (const source of new Set([entry.payload.source, ...entry.payload.aliases].map(value => normalizeForMatching(value).toLocaleLowerCase()))) {
      const key = `${languagePairKey(pair)}\0${source}`
      const previous = terms.get(key)
      if (!previous) { terms.set(key, { entry, index }); continue }
      if (previous.entry.collectionId === entry.collectionId) warn('DUPLICATE_TERM', `/entries/${index}/payload/source`, `The same source term also occurs at /entries/${previous.index}`)
      else if (previous.entry.payload.target !== entry.payload.target) warn('TERM_DISAGREEMENT', `/entries/${index}/payload/target`, `Collection ${previous.entry.collectionId} translates this term differently (/entries/${previous.index}); avoid selecting both`)
    }
  })
  result.valid = result.stats.errorCount === 0
  if (result.valid) result.data = data
  return result
}

export function validatePackage(input: unknown): ValidationResult { return validator(input) }

export function parseKnowledgePackage(text: string): ValidationResult {
  const bytes = encoder.encode(text).byteLength
  const failure = (code: string, path: string, message: string): ValidationResult => ({ valid: false, errors: [{ code, path, message }], warnings: [], stats: { ...emptyStats(), bytes, errorCount: 1 } })
  if (bytes > LIMITS.fileBytes) return failure('LIMIT_FILE_BYTES', '', `File uses ${bytes} bytes; maximum is ${LIMITS.fileBytes}`)
  try { return validator(parseStrictJson(text), bytes) } catch (cause) {
    if (cause instanceof JsonInputError) return failure(cause.code, cause.path, cause.message)
    return failure('JSON_SYNTAX', '', cause instanceof Error ? cause.message : String(cause))
  }
}
