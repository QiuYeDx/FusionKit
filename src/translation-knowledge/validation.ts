import { assertValidUnicode, canonicalize, sha256Canonical } from './canonicalize'
import { JsonInputError, parseStrictJson, pointer } from './json'
import { ENTITY_ARRAYS, LIMITS, knowledgePackageSchema } from './schemas'
import type { Entry, KnowledgePackage, LanguagePair } from './schemas'

export interface Diagnostic { code: string; path: string; message: string }
export interface ValidationStats {
  bytes: number; entities: number; subjects: number; collections: number; sources: number; entries: number; styles: number; recipes: number; preferenceTemplates: number; errorCount: number; warningCount: number
}
export interface ValidationResult { valid: boolean; schemaVersion?: number; data?: KnowledgePackage; errors: Diagnostic[]; warnings: Diagnostic[]; stats: ValidationStats }
const encoder = new TextEncoder()
const emptyStats = (): ValidationStats => ({ bytes: 0, entities: 0, subjects: 0, collections: 0, sources: 0, entries: 0, styles: 0, recipes: 0, preferenceTemplates: 0, errorCount: 0, warningCount: 0 })
const pairKey = (pair: LanguagePair) => `${pair.source}\0${pair.target}`

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
  if (input && typeof input === 'object' && 'schemaVersion' in input && typeof input.schemaVersion === 'number') result.schemaVersion = input.schemaVersion
  if (result.schemaVersion !== undefined && result.schemaVersion !== 1) { error('UNSUPPORTED_SCHEMA_VERSION', '/schemaVersion', `Unsupported schemaVersion ${result.schemaVersion}; supported: 1`); return result }
  const parsed = knowledgePackageSchema.safeParse(input)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) error('SCHEMA_INVALID', pointer(issue.path.map(p => String(p))), issue.message)
    return result
  }
  const data = parsed.data
  result.schemaVersion = 1
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
  const subjects = new Map(data.subjects.map(item => [item.id, item]))
  const collections = new Map(data.collections.map(item => [item.id, item]))
  const entries = new Map(data.entries.map(item => [item.id, item]))
  const styles = new Map(data.styles.map(item => [item.id, item]))
  const sources = new Map(data.sources.map(item => [item.id, item]))
  const digests = new Map<string, string>()
  const entryDigest = (entry: Entry) => {
    let digest = digests.get(entry.id)
    if (!digest) { digest = sha256Canonical(entry); digests.set(entry.id, digest) }
    return digest
  }
  const ref = (id: string, type: string, path: string): boolean => {
    const entity = all.get(id)
    if (!entity) error('REFERENCE_MISSING', path, `Referenced ${type} ID ${id} is absent from this package`)
    else if (entity.type !== type) error('REFERENCE_TYPE', path, `Expected ${type}, found ${entity.type} at ${entity.path}`)
    return entity?.type === type
  }
  const unique = (values: string[], path: string) => {
    const seen = new Map<string, number>()
    values.forEach((value, i) => { if (seen.has(value)) error('DUPLICATE_VALUE', `${path}/${i}`, `Duplicates index ${seen.get(value)}`); else seen.set(value, i) })
  }
  const refs = (values: string[], type: string, path: string) => { unique(values, path); values.forEach((id, i) => ref(id, type, `${path}/${i}`)) }
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
  const subjectBindings = (bindings: { subjectId: string; role: string }[], path: string) => {
    unique(bindings.map(item => `${item.subjectId}:${item.role}`), path)
    bindings.forEach((binding, i) => {
      ref(binding.subjectId, 'subjects', `${path}/${i}/subjectId`)
      if (binding.role === 'speaker' && subjects.has(binding.subjectId) && subjects.get(binding.subjectId)!.kind !== 'person') error('SPEAKER_NOT_PERSON', `${path}/${i}/subjectId`, 'speaker requires a person subject')
    })
  }
  const checkExtensions = (value: unknown, parts: (string | number)[]) => {
    if (!value || typeof value !== 'object') return
    if (Object.hasOwn(value, 'extensions')) {
      const extension = (value as { extensions: unknown }).extensions
      const bytes = encoder.encode(canonicalize(extension)).byteLength
      if (bytes > LIMITS.extensionBytes) error('LIMIT_EXTENSION_BYTES', pointer([...parts, 'extensions']), `extensions uses ${bytes} bytes; maximum is ${LIMITS.extensionBytes}`)
    }
  }
  checkExtensions(data, [])
  checkExtensions(data.package, ['package'])
  for (const key of ENTITY_ARRAYS) data[key].forEach((entity, i) => checkExtensions(entity, [key, i]))
  data.subjects.forEach((item, i) => { unique(item.aliases, `/subjects/${i}/aliases`); unique(item.tags, `/subjects/${i}/tags`) })
  data.collections.forEach((item, i) => { refs(item.aboutSubjectIds, 'subjects', `/collections/${i}/aboutSubjectIds`); if (item.defaultLanguagePair) languagePair(item.defaultLanguagePair, `/collections/${i}/defaultLanguagePair`) })
  data.sources.forEach((item, i) => {
    const path = `/sources/${i}`
    if (item.kind === 'web' && (!item.url || !item.accessedAt)) error('WEB_SOURCE_METADATA', path, 'web sources require url and accessedAt')
    if (Boolean(item.contentDigest) !== Boolean(item.digestDescription)) error('SOURCE_DIGEST_METADATA', path, 'contentDigest and digestDescription must occur together')
    if (item.url) {
      try { const url = new URL(item.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid URL') } catch { error('SOURCE_URL', `${path}/url`, 'Use an absolute http/https URL without credentials') }
    }
  })
  data.entries.forEach((item, i) => {
    const path = `/entries/${i}`
    ref(item.collectionId, 'collections', `${path}/collectionId`)
    refs(item.aboutSubjectIds, 'subjects', `${path}/aboutSubjectIds`)
    languagePair(item.scope.languagePair, `${path}/scope/languagePair`)
    subjectBindings(item.scope.requiredSubjects, `${path}/scope/requiredSubjects`)
    unique(item.evidence.map(e => e.sourceId), `${path}/evidence`)
    item.evidence.forEach((evidence, j) => ref(evidence.sourceId, 'sources', `${path}/evidence/${j}/sourceId`))
    unique(item.derivedFrom.map(parent => `${parent.entryId}:${parent.revision}`), `${path}/derivedFrom`)
    item.derivedFrom.forEach((parent, j) => {
      const parentPath = `${path}/derivedFrom/${j}`
      ref(parent.evidenceSourceId, 'sources', `${parentPath}/evidenceSourceId`)
      if (parent.entryId === item.id) error('DERIVATION_SELF', `${parentPath}/entryId`, 'A derived entry cannot cite itself')
      const visible = entries.get(parent.entryId)
      const anyParent = all.get(parent.entryId)
      if (anyParent && anyParent.type !== 'entries') error('REFERENCE_TYPE', `${parentPath}/entryId`, 'derivedFrom must refer to an entry or an omitted historical entry')
      if (visible) {
        if (parent.revision === visible.revision && parent.digest !== entryDigest(visible)) error('DERIVATION_DIGEST', `${parentPath}/digest`, 'Digest differs from the included parent at the declared revision')
        else if (parent.revision !== visible.revision) warn('DERIVATION_REVISION_CHANGED', parentPath, `Evidence cites revision ${parent.revision}; included parent is revision ${visible.revision}. Review the historical excerpt.`)
      }
    })
    if (item.kind === 'context' && item.payload.assertion === 'uncertain' && item.payload.core) error('CORE_UNCERTAIN', `${path}/payload/core`, 'Uncertain context cannot be core')
    if (item.kind === 'term') {
      unique(item.payload.aliases, `${path}/payload/aliases`)
      if (item.payload.strength === 'keep_source' && item.payload.target !== item.payload.source) error('KEEP_SOURCE_TARGET', `${path}/payload/target`, 'keep_source requires target to exactly equal source')
    }
    if ((item.kind === 'term' || item.kind === 'rule') && item.payload.strength === 'required' && item.scope.condition.mode === 'advisory') error('REQUIRED_ADVISORY', `${path}/scope/condition`, 'A required term/rule needs requires_confirmation for a scenario-specific condition')
    if (item.kind === 'expression') {
      unique(item.payload.targetExamples, `${path}/payload/targetExamples`)
      const people = item.aboutSubjectIds.filter(id => subjects.get(id)?.kind === 'person')
      for (const person of people) if (!item.scope.requiredSubjects.some(binding => binding.subjectId === person && binding.role === 'speaker')) error('EXPRESSION_SPEAKER_REQUIRED', `${path}/scope/requiredSubjects`, `Expression about person ${person} requires that person's speaker condition`)
    }
    if (item.kind === 'memory' && item.payload.alignment === 'reviewed_segment') warn('MEMORY_ALIGNMENT_REVIEW', `${path}/evidence`, 'Check that cited excerpts describe confirmation and segment alignment; validation cannot establish human review')
    if (item.state === 'ready' && item.evidence.some(e => sources.get(e.sourceId)?.kind === 'ai_proposal')) warn('AI_PROPOSAL_READY', `${path}/state`, 'AI-proposed evidence does not establish local acceptance; review this ready declaration')
  })
  // Iterative DFS prevents a long but shallow file from overflowing the call stack.
  const completed = new Set<string>()
  for (const item of data.entries) {
    if (completed.has(item.id)) continue
    const active = new Set<string>()
    const stack: { entry: Entry; next: number }[] = [{ entry: item, next: 0 }]
    active.add(item.id)
    while (stack.length) {
      const frame = stack[stack.length - 1]
      if (frame.next >= frame.entry.derivedFrom.length) { completed.add(frame.entry.id); active.delete(frame.entry.id); stack.pop(); continue }
      const parentId = frame.entry.derivedFrom[frame.next++].entryId
      const parent = entries.get(parentId)
      if (!parent || completed.has(parentId)) continue
      if (active.has(parentId)) { error('DERIVATION_CYCLE', `${all.get(frame.entry.id)?.path ?? ''}/derivedFrom`, `Visible derivation cycle reaches ${parentId}`); continue }
      active.add(parentId); stack.push({ entry: parent, next: 0 })
    }
  }
  data.styles.forEach((item, i) => {
    const path = `/styles/${i}`
    languagePair(item.languagePair, `${path}/languagePair`)
    refs(item.ruleEntryIds, 'entries', `${path}/ruleEntryIds`)
    item.ruleEntryIds.forEach((id, j) => {
      const rule = entries.get(id)
      if (!rule) return
      if (rule.kind !== 'rule') error('STYLE_RULE_TYPE', `${path}/ruleEntryIds/${j}`, 'Styles may reference rule entries only')
      if (pairKey(rule.scope.languagePair) !== pairKey(item.languagePair)) error('STYLE_LANGUAGE_MISMATCH', `${path}/ruleEntryIds/${j}`, 'Style and rule language pairs must exactly match')
      if (rule.state !== 'ready' || collections.get(rule.collectionId)?.archived || rule.aboutSubjectIds.some(subjectId => subjects.get(subjectId)?.archived) || rule.scope.requiredSubjects.some(binding => subjects.get(binding.subjectId)?.archived)) warn('STYLE_NOT_READY', `${path}/ruleEntryIds/${j}`, 'This rule or a related catalog is not usable; local acceptance is additionally required')
    })
  })
  data.recipes.forEach((item, i) => {
    const path = `/recipes/${i}`
    languagePair(item.languagePair, `${path}/languagePair`)
    refs(item.readCollectionIds, 'collections', `${path}/readCollectionIds`)
    subjectBindings(item.subjectSuggestions, `${path}/subjectSuggestions`)
    refs(item.modifierStyleIds, 'styles', `${path}/modifierStyleIds`)
    if (item.baseStyleId) { ref(item.baseStyleId, 'styles', `${path}/baseStyleId`); if (item.modifierStyleIds.includes(item.baseStyleId)) error('DUPLICATE_STYLE', `${path}/baseStyleId`, 'The base style must not also occur as a modifier') }
    if ((item.learningSuggestion === 'save_reviewed') !== Boolean(item.suggestedDestinationCollectionId)) error('RECIPE_LEARNING_DESTINATION', `${path}/learningSuggestion`, 'save_reviewed requires a destination; off forbids a destination')
    if (item.suggestedDestinationCollectionId) ref(item.suggestedDestinationCollectionId, 'collections', `${path}/suggestedDestinationCollectionId`)
    for (const id of [...(item.baseStyleId ? [item.baseStyleId] : []), ...item.modifierStyleIds]) {
      const style = styles.get(id)
      if (!style) continue
      if (pairKey(style.languagePair) !== pairKey(item.languagePair)) error('RECIPE_STYLE_LANGUAGE', path, `Style ${id} has a different language pair`)
      for (const ruleId of style.ruleEntryIds) {
        const rule = entries.get(ruleId)
        if (rule && !item.readCollectionIds.includes(rule.collectionId)) error('RECIPE_STYLE_COLLECTION', `${path}/readCollectionIds`, `Include collection ${rule.collectionId} required by style ${id}`)
      }
      if (style.archived) warn('RECIPE_STYLE_ARCHIVED', path, `Style ${id} is archived`)
    }
  })
  // Conservative offline warnings: actual simultaneous activation is decided by a task.
  const terms = new Map<string, { entry: Extract<Entry, { kind: 'term' }>; index: number }>()
  data.entries.forEach((entry, index) => {
    if (entry.kind !== 'term' || ['archived', 'rejected'].includes(entry.state)) return
    for (const source of [entry.payload.source, ...entry.payload.aliases]) {
      const key = `${pairKey(entry.scope.languagePair)}\0${source.normalize('NFC').toLowerCase()}`
      const previous = terms.get(key)
      if (previous && previous.entry.id !== entry.id && previous.entry.payload.target !== entry.payload.target) warn('TERM_TRANSLATION_CONFLICT', `/entries/${index}/payload/target`, `Potential translation conflict with /entries/${previous.index} (${previous.entry.collectionId}) and collection ${entry.collectionId}; review simultaneous selection, scope and matching before use`)
      else if (!previous) terms.set(key, { entry, index })
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
