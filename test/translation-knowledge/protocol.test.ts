import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { canonicalize, sha256Canonical } from '../../src/translation-knowledge/canonicalize'
import { validatePackage, parseKnowledgePackage } from '../../src/translation-knowledge/validation'
import { knowledgePackageJsonSchema, LIMITS } from '../../src/translation-knowledge/schemas'
import { exampleDirectory, knowledgeFixture } from './fixtures'

const codes = (value: unknown) => validatePackage(value).errors.map(error => error.code)
describe('FK-TK/1', () => {
  it('accepts all five types and portable styles/recipes without granting trust', () => {
    const result = validatePackage(knowledgeFixture())
    expect(result.valid, JSON.stringify(result.errors)).toBe(true)
    expect(new Set(result.data!.entries.map(entry => entry.kind)).size).toBe(5)
    expect(result.warnings.some(warning => warning.code === 'STYLE_NOT_READY')).toBe(true)
    expect(JSON.stringify(result.data)).not.toContain('localAcceptance')
  })
  it('round-trips all valid examples and preserves opaque extensions', () => {
    for (const name of readdirSync(exampleDirectory).filter(name => name.endsWith('.json'))) {
      const text = readFileSync(path.join(exampleDirectory, name), 'utf8')
      const result = parseKnowledgePackage(text)
      expect(result.valid, `${name}: ${JSON.stringify(result.errors)}`).toBe(true)
      expect(parseKnowledgePackage(canonicalize(result.data)).data).toEqual(JSON.parse(text))
    }
  })
  it('rejects every distributed negative example', () => {
    for (const name of readdirSync(path.join(exampleDirectory, 'invalid'))) expect(parseKnowledgePackage(readFileSync(path.join(exampleDirectory, 'invalid', name), 'utf8')).valid, name).toBe(false)
  })
  it('uses the same generated Draft 2020-12 schema for application and skill', () => {
    const expected = knowledgePackageJsonSchema()
    for (const file of ['resources/translation-knowledge/knowledge-v1.schema.json', 'skills/fusionkit-translation-knowledge/references/knowledge-v1.schema.json']) expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(expected)
    expect(expected.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
  })
  it('rejects duplicate keys, syntax errors, lone surrogates, and overflowing numbers before schema validation', () => {
    expect(parseKnowledgePackage('{"a":1,"\\u0061":2}').errors[0]).toMatchObject({ code: 'JSON_DUPLICATE_KEY', path: '/a' })
    for (const text of ['{"a":1,}', '[1,]', '{/*no*/}', '```json\n{}\n```', '{} {}', '{"a":01}']) expect(parseKnowledgePackage(text).errors[0].code).toBe('JSON_SYNTAX')
    expect(parseKnowledgePackage('{"a":"\\ud800"}').errors[0].code).toBe('INVALID_UNICODE')
    expect(parseKnowledgePackage('{"a":1e400}').errors[0].code).toBe('NON_FINITE_NUMBER')
    expect(parseKnowledgePackage('\ufeff' + JSON.stringify(knowledgeFixture())).valid).toBe(true)
  })
  it('rejects unknown fields/types/versions, unsafe revisions and duplicate identities', () => {
    const fixture = knowledgeFixture()
    expect(codes({ ...fixture, apiKey: 'x' })).toContain('SCHEMA_INVALID')
    expect(codes({ ...fixture, schemaVersion: 2 })).toContain('UNSUPPORTED_SCHEMA_VERSION')
    fixture.entries[0].revision = Number.MAX_SAFE_INTEGER + 1
    expect(codes(fixture)).toContain('SCHEMA_INVALID')
    fixture.entries[0].revision = 1
    fixture.entries[0].id = fixture.subjects[0].id
    expect(codes(fixture)).toContain('DUPLICATE_ID')
  })
  it('enforces actual UTF-8 bytes, depth, extension size and diagnostic caps', () => {
    const fixture = knowledgeFixture()
    fixture.package.description = '中'.repeat(Math.floor(LIMITS.textBytes / 3) + 1)
    expect(codes(fixture)).toContain('LIMIT_TEXT_BYTES')
    fixture.package.description = ''
    fixture.extensions = { 'org.example': { a: 'a'.repeat(32_000), b: 'b'.repeat(32_000), c: 'c'.repeat(2_000) } }
    expect(codes(fixture)).toContain('LIMIT_EXTENSION_BYTES')
    expect(parseKnowledgePackage('['.repeat(34) + '0' + ']'.repeat(34)).errors[0].code).toBe('LIMIT_DEPTH')
    fixture.extensions = { 'org.example': Object.fromEntries(Array.from({ length: 120 }, (_, i) => [i, '中'.repeat(11_000)])) }
    const result = validatePackage(fixture)
    expect(result.errors).toHaveLength(100)
    expect(result.stats.errorCount).toBe(120)
  })
  it('checks type-specific references, duplicate sets, languages and person bindings', () => {
    const fixture = knowledgeFixture()
    fixture.entries[0].collectionId = fixture.subjects[0].id
    fixture.subjects[0].tags = ['a', 'a']
    fixture.entries[0].scope.languagePair.target = 'zh'
    fixture.entries[0].scope.requiredSubjects[0].role = 'speaker'
    const result = codes(fixture)
    for (const code of ['REFERENCE_TYPE', 'DUPLICATE_VALUE', 'LANGUAGE_TAG', 'SPEAKER_NOT_PERSON']) expect(result).toContain(code)
    for (const language of ['auto', 'und', 'mul', '*', 'zh-CN', 'ZH-hans', 'en_us']) {
      fixture.entries[0].scope.languagePair.target = language
      expect(codes(fixture), language).toContain('LANGUAGE_TAG')
    }
  })
  it('enforces source evidence, URL constraints and meaningful conditions', () => {
    const fixture = knowledgeFixture()
    fixture.sources[0].kind = 'web'
    fixture.sources[0].url = 'https://user:pass@example.test/'
    fixture.sources[0].contentDigest = 'a'.repeat(64)
    if (fixture.entries[0].kind === 'context') { fixture.entries[0].payload.assertion = 'uncertain'; fixture.entries[0].payload.core = true }
    if (fixture.entries[1].kind === 'term') { fixture.entries[1].payload.strength = 'keep_source' }
    const result = codes(fixture)
    for (const code of ['WEB_SOURCE_METADATA', 'SOURCE_URL', 'SOURCE_DIGEST_METADATA', 'CORE_UNCERTAIN', 'KEEP_SOURCE_TARGET']) expect(result).toContain(code)
    fixture.sources[0].url = 'file:///tmp/example.txt'
    expect(codes(fixture)).toContain('SOURCE_URL')
  })
  it('checks derivation digest and permits omitted historical parents with included evidence', () => {
    const fixture = knowledgeFixture()
    const parent = fixture.entries[0]
    fixture.entries[1].derivedFrom = [{ entryId: parent.id, revision: parent.revision, digest: sha256Canonical(parent), evidenceSourceId: fixture.sources[0].id }]
    expect(validatePackage(fixture).valid).toBe(true)
    parent.title += ' edited'
    expect(codes(fixture)).toContain('DERIVATION_DIGEST')
    parent.revision++
    expect(validatePackage(fixture).warnings.some(warning => warning.code === 'DERIVATION_REVISION_CHANGED')).toBe(true)
    fixture.entries.shift()
    expect(validatePackage(fixture).valid).toBe(true)
  })
  it('rejects visible derivation cycles even when they cite different revisions', () => {
    const fixture = knowledgeFixture()
    const [a, b] = fixture.entries
    a.derivedFrom = [{ entryId: b.id, revision: 2, digest: '0'.repeat(64), evidenceSourceId: fixture.sources[0].id }]
    b.derivedFrom = [{ entryId: a.id, revision: 2, digest: '0'.repeat(64), evidenceSourceId: fixture.sources[0].id }]
    expect(codes(fixture)).toContain('DERIVATION_CYCLE')
  })
  it('requires complete and exact-language style/recipe dependencies', () => {
    const fixture = knowledgeFixture()
    fixture.styles[0].ruleEntryIds = [fixture.entries[0].id]
    fixture.recipes[0].readCollectionIds = []
    fixture.recipes[0].languagePair.target = 'zh-Hant'
    fixture.recipes[0].learningSuggestion = 'save_reviewed'
    const result = codes(fixture)
    for (const code of ['STYLE_RULE_TYPE', 'RECIPE_STYLE_COLLECTION', 'RECIPE_STYLE_LANGUAGE', 'RECIPE_LEARNING_DESTINATION']) expect(result).toContain(code)
  })
  it('warns about competing translations without rejecting separate collections', () => {
    const fixture = knowledgeFixture()
    const term = structuredClone(fixture.entries[1])
    term.id = '50000000-0000-4000-8000-000000000099'
    const collection = structuredClone(fixture.collections[0])
    collection.id = '30000000-0000-4000-8000-000000000099'
    fixture.collections.push(collection)
    term.collectionId = collection.id
    if (term.kind === 'term') term.payload.target = '检查站'
    fixture.entries.push(term)
    const result = validatePackage(fixture)
    expect(result.valid).toBe(true)
    expect(result.warnings.some(warning => warning.code === 'TERM_TRANSLATION_CONFLICT')).toBe(true)
  })
})

describe('RFC 8785 canonicalization', () => {
  it('matches the RFC number/string vector and sorts keys by UTF-16 units', () => {
    const value = JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"€$\\u000f\\nA\'B\\\"\\\\\\\\\\\"/","literals":[null,true,false]}')
    expect(canonicalize(value)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\\"\\\\\\\\\\\"/"}')
    expect(canonicalize({ '\ufb33': 1, '😀': 2, '€': 3, '\r': 4 })).toBe('{"\\r":4,"€":3,"😀":2,"דּ":1}')
    expect(canonicalize(-0)).toBe('0')
  })
  it('does not normalize Unicode and rejects non-JSON/lone surrogate values', () => {
    expect(canonicalize('é')).not.toBe(canonicalize('e\u0301'))
    for (const value of [NaN, Infinity, '\ud800', { '\udc00': 1 }, undefined, new Date(), [, 1]]) expect(() => canonicalize(value)).toThrow()
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    expect(() => canonicalize(cycle)).toThrow()
  })
  it('matches Node SHA-256 for varied entity lengths and Unicode content', () => {
    for (const value of [null, '', 'abc', '𠮷'.repeat(100), knowledgeFixture(), ...Array.from({ length: 130 }, (_, i) => 'a'.repeat(i))]) expect(sha256Canonical(value)).toBe(createHash('sha256').update(canonicalize(value), 'utf8').digest('hex'))
  })
})

describe('portable CLI', () => {
  it('runs copied outside the repo without dependencies and has correct exit codes', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fktk-cli-'))
    try {
      const cli = path.join(directory, 'validate.mjs')
      cpSync('skills/fusionkit-translation-knowledge/scripts/validate.mjs', cli)
      const invoke = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8' })
      const good = invoke(path.join(exampleDirectory, 'multi-subject.fktk.json'), '--json')
      expect(good.status, good.stderr).toBe(0)
      expect(JSON.parse(good.stdout)).toEqual((({ data: _data, ...report }) => report)(parseKnowledgePackage(readFileSync(path.join(exampleDirectory, 'multi-subject.fktk.json'), 'utf8'))))
      expect(invoke(path.join(exampleDirectory, 'invalid/duplicate-key.fktk.json'), '--json').status).toBe(1)
      expect(invoke('missing.fktk.json', '--json').status).toBe(2)
      writeFileSync(path.join(directory, 'bad-utf8.fktk.json'), Buffer.from([0xff]))
      expect(JSON.parse(invoke('bad-utf8.fktk.json', '--json').stdout).errors[0].code).toBe('INVALID_UTF8')
      const fixture = knowledgeFixture()
      const digest = invoke(path.join(exampleDirectory, 'multi-subject.fktk.json'), '--digest', fixture.entries[0].id, '--json')
      expect(digest.status).toBe(0)
      expect(JSON.parse(digest.stdout).digest).toBe(sha256Canonical(fixture.entries[0]))
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
