import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { canonicalize, sha256Canonical } from '../../src/translation-knowledge/canonicalize'
import { validatePackage, parseKnowledgePackage } from '../../src/translation-knowledge/validation'
import { knowledgePackageJsonSchema, LIMITS } from '../../src/translation-knowledge/schemas'
import { entrySummary } from '../../src/translation-knowledge/summary'
import { exampleDirectory, knowledgeFixture } from './fixtures'

const codes = (value: unknown) => validatePackage(value).errors.map(error => error.code)
const warnings = (value: unknown) => validatePackage(value).warnings.map(warning => warning.code)
describe('FK-TK/2', () => {
  it('accepts all three entry kinds, disabled entries, origins and presets', () => {
    const result = validatePackage(knowledgeFixture())
    expect(result.valid, JSON.stringify(result.errors)).toBe(true)
    expect(new Set(result.data!.entries.map(entry => entry.kind))).toEqual(new Set(['term', 'context', 'rule']))
    expect(result.data!.entries.some(entry => !entry.enabled)).toBe(true)
    expect(result.data!.entries.some(entry => entry.origin?.kind === 'web')).toBe(true)
    expect(result.stats).toMatchObject({ collections: 3, entries: 7, presets: 1, errorCount: 0 })
  })
  it('round-trips all valid examples and preserves opaque extensions', () => {
    for (const name of readdirSync(exampleDirectory).filter(name => name.endsWith('.json'))) {
      const text = readFileSync(path.join(exampleDirectory, name), 'utf8')
      const result = parseKnowledgePackage(text)
      expect(result.valid, `${name}: ${JSON.stringify(result.errors)}`).toBe(true)
      expect(parseKnowledgePackage(canonicalize(result.data)).data).toEqual(JSON.parse(text))
    }
    const fixture = knowledgeFixture()
    fixture.extensions = { 'org.example.note': { kept: true } }
    expect(validatePackage(fixture).data!.extensions).toEqual({ 'org.example.note': { kept: true } })
  })
  it('rejects every distributed negative example', () => {
    for (const name of readdirSync(path.join(exampleDirectory, 'invalid'))) expect(parseKnowledgePackage(readFileSync(path.join(exampleDirectory, 'invalid', name), 'utf8')).valid, name).toBe(false)
  })
  it('uses the same generated Draft 2020-12 schema for application and skill', () => {
    const expected = knowledgePackageJsonSchema()
    for (const file of ['resources/translation-knowledge/knowledge-v2.schema.json', '.agents/skills/fusionkit-translation-knowledge/references/knowledge-v2.schema.json']) expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(expected)
    expect(expected.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(expected.title).toBe('FusionKit Translation Knowledge v2')
  })
  it('rejects duplicate keys, syntax errors, lone surrogates, and overflowing numbers before schema validation', () => {
    expect(parseKnowledgePackage('{"a":1,"\\u0061":2}').errors[0]).toMatchObject({ code: 'JSON_DUPLICATE_KEY', path: '/a' })
    for (const text of ['{"a":1,}', '[1,]', '{/*no*/}', '```json\n{}\n```', '{} {}', '{"a":01}']) expect(parseKnowledgePackage(text).errors[0].code).toBe('JSON_SYNTAX')
    expect(parseKnowledgePackage('{"a":"\\ud800"}').errors[0].code).toBe('INVALID_UNICODE')
    expect(parseKnowledgePackage('{"a":1e400}').errors[0].code).toBe('NON_FINITE_NUMBER')
    expect(parseKnowledgePackage('﻿' + JSON.stringify(knowledgeFixture())).valid).toBe(true)
  })
  it('rejects every other schema version without converting it', () => {
    for (const schemaVersion of [1, 3, 0]) {
      const result = validatePackage({ ...knowledgeFixture(), schemaVersion })
      expect(result.errors).toEqual([expect.objectContaining({ code: 'UNSUPPORTED_SCHEMA_VERSION', path: '/schemaVersion' })])
      expect(result.data).toBeUndefined()
    }
  })
  it('rejects unknown fields, removed concepts, unsafe revisions and duplicate identities', () => {
    const fixture = knowledgeFixture()
    expect(codes({ ...fixture, apiKey: 'x' })).toContain('SCHEMA_INVALID')
    expect(codes({ ...fixture, subjects: [] })).toContain('SCHEMA_INVALID')
    expect(codes({ ...fixture, entries: [{ ...fixture.entries[0], state: 'ready' }] })).toContain('SCHEMA_INVALID')
    expect(codes({ ...fixture, entries: [{ ...fixture.entries[0], kind: 'memory' }] })).toContain('SCHEMA_INVALID')
    fixture.entries[0].revision = Number.MAX_SAFE_INTEGER + 1
    expect(codes(fixture)).toContain('SCHEMA_INVALID')
    fixture.entries[0].revision = 1
    fixture.entries[0].id = fixture.collections[0].id
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
  it('checks collection references, duplicate sets and language tags', () => {
    const fixture = knowledgeFixture()
    fixture.entries[0].collectionId = '30000000-0000-4000-8000-0000000000ff'
    fixture.entries[1].collectionId = fixture.presets[0].id
    fixture.presets[0].collectionIds = [fixture.collections[0].id, fixture.collections[0].id]
    fixture.collections[2].languagePair.target = 'zh'
    const result = codes(fixture)
    for (const code of ['MISSING_REFERENCE', 'REFERENCE_TYPE', 'DUPLICATE_VALUE', 'LANGUAGE_TAG']) expect(result).toContain(code)
    for (const language of ['auto', 'und', 'mul', '*', 'zh-CN', 'ZH-hans', 'en_us']) {
      fixture.collections[2].languagePair.target = language
      expect(codes(fixture), language).toContain('LANGUAGE_TAG')
    }
  })
  it('requires preset collections to exist and translate the preset language pair', () => {
    const fixture = knowledgeFixture()
    fixture.collections[1].languagePair = { source: 'ja', target: 'zh-Hans' }
    expect(codes(fixture)).toContain('PRESET_LANGUAGE_MISMATCH')
    fixture.presets[0].collectionIds = ['30000000-0000-4000-8000-0000000000fe']
    expect(codes(fixture)).toContain('MISSING_REFERENCE')
  })
  it('checks term aliases, keep_source targets and origin URLs', () => {
    const fixture = knowledgeFixture()
    const term = fixture.entries[0]
    if (term.kind !== 'term') throw new Error('fixture')
    term.payload.aliases = ['checkpoint', 'save point', 'save point']
    term.payload.strength = 'keep_source'
    term.origin = { kind: 'web', url: 'https://user:pass@example.test/' }
    const result = codes(fixture)
    for (const code of ['ALIAS_IS_SOURCE', 'DUPLICATE_VALUE', 'KEEP_SOURCE_TARGET', 'ORIGIN_URL']) expect(result).toContain(code)
    term.origin = { kind: 'web', url: 'file:///tmp/example.txt' }
    expect(codes(fixture)).toContain('ORIGIN_URL')
  })
  it('warns about duplicate terms in one collection and disagreements across collections without rejecting', () => {
    const fixture = knowledgeFixture()
    const original = fixture.entries[0]
    if (original.kind !== 'term') throw new Error('fixture')
    const duplicate = structuredClone(original)
    duplicate.id = '50000000-0000-4000-8000-000000000298'
    duplicate.payload.source = 'CHECKPOINT'
    duplicate.payload.aliases = []
    const elsewhere = structuredClone(original)
    elsewhere.id = '50000000-0000-4000-8000-000000000299'
    elsewhere.collectionId = fixture.collections[1].id
    elsewhere.payload.target = '检查站'
    fixture.entries.push(duplicate, elsewhere)
    const result = validatePackage(fixture)
    expect(result.valid, JSON.stringify(result.errors)).toBe(true)
    expect(warnings(fixture)).toEqual(expect.arrayContaining(['DUPLICATE_TERM', 'TERM_DISAGREEMENT']))
    expect(warnings(knowledgeFixture())).toEqual([])
  })
})

describe('entry summaries', () => {
  it('formats terms and the first line of notes', () => {
    const [term, , context] = knowledgeFixture().entries
    expect(entrySummary(term)).toBe('checkpoint → 存档点')
    expect(entrySummary({ ...context, kind: 'rule', payload: { text: '第一行\n第二行', required: false } })).toBe('第一行')
    expect(entrySummary({ ...context, kind: 'context', payload: { text: '长'.repeat(130), required: false } })).toBe(`${'长'.repeat(120)}…`)
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
      cpSync('.agents/skills/fusionkit-translation-knowledge/scripts/validate.mjs', cli)
      const invoke = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8' })
      const good = invoke(path.join(exampleDirectory, 'multi-collection.fktk.json'), '--json')
      expect(good.status, good.stderr).toBe(0)
      expect(JSON.parse(good.stdout)).toEqual((({ data: _data, ...report }) => report)(parseKnowledgePackage(readFileSync(path.join(exampleDirectory, 'multi-collection.fktk.json'), 'utf8'))))
      expect(invoke(path.join(exampleDirectory, 'invalid/duplicate-key.fktk.json'), '--json').status).toBe(1)
      expect(JSON.parse(invoke(path.join(exampleDirectory, 'invalid/unsupported-version.fktk.json'), '--json').stdout).errors[0].code).toBe('UNSUPPORTED_SCHEMA_VERSION')
      expect(invoke('missing.fktk.json', '--json').status).toBe(2)
      writeFileSync(path.join(directory, 'bad-utf8.fktk.json'), Buffer.from([0xff]))
      expect(JSON.parse(invoke('bad-utf8.fktk.json', '--json').stdout).errors[0].code).toBe('INVALID_UTF8')
      const fixture = knowledgeFixture()
      const digest = invoke(path.join(exampleDirectory, 'multi-collection.fktk.json'), '--digest', fixture.entries[0].id, '--json')
      expect(digest.status).toBe(0)
      expect(JSON.parse(digest.stdout).digest).toBe(sha256Canonical(fixture.entries[0]))
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
