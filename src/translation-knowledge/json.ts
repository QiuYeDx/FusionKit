import { assertValidUnicode } from './canonicalize'
import { LIMITS } from './schemas'

export const pointer = (parts: readonly (string | number)[]) => parts.length ? `/${parts.map(p => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}` : ''
export class JsonInputError extends Error {
  constructor(public code: string, public path: string, message: string) { super(message) }
}

/** Parse before JSON.parse could erase duplicate keys, including escaped equivalent keys. */
export function parseStrictJson(text: string): unknown {
  let offset = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const fail = (code: string, path: (string | number)[], message: string): never => { throw new JsonInputError(code, pointer(path), `${message} (offset ${offset})`) }
  const whitespace = () => { while (/^[\x20\t\r\n]$/.test(text[offset] ?? '')) offset++ }
  const string = (path: (string | number)[]) => {
    const start = offset++
    while (offset < text.length) {
      const char = text[offset++]
      if (char === '\\') { offset++; continue }
      if (char === '"') {
        let result: string
        try { result = JSON.parse(text.slice(start, offset)) as string } catch { return fail('JSON_SYNTAX', path, 'Invalid JSON string') }
        try { assertValidUnicode(result) } catch { return fail('INVALID_UNICODE', path, 'Lone Unicode surrogate is forbidden') }
        return result
      }
    }
    return fail('JSON_SYNTAX', path, 'Unterminated JSON string')
  }
  const value = (path: (string | number)[], depth: number): unknown => {
    if (depth > LIMITS.depth) fail('LIMIT_DEPTH', path, `Depth ${depth} exceeds ${LIMITS.depth}`)
    whitespace()
    const char = text[offset]
    if (char === '"') return string(path)
    if (char === '{') {
      offset++; whitespace()
      const result: Record<string, unknown> = Object.create(null)
      if (text[offset] === '}') { offset++; return result }
      while (true) {
        whitespace()
        if (text[offset] !== '"') fail('JSON_SYNTAX', path, 'Expected an object key')
        const key = string(path)
        if (Object.hasOwn(result, key)) fail('JSON_DUPLICATE_KEY', [...path, key], `Duplicate object key ${JSON.stringify(key)}`)
        whitespace()
        if (text[offset++] !== ':') fail('JSON_SYNTAX', path, 'Expected a colon')
        result[key] = value([...path, key], depth + 1)
        whitespace()
        const delimiter = text[offset++]
        if (delimiter === '}') return result
        if (delimiter !== ',') fail('JSON_SYNTAX', path, 'Expected a comma or closing brace')
      }
    }
    if (char === '[') {
      offset++; whitespace()
      const result: unknown[] = []
      if (text[offset] === ']') { offset++; return result }
      while (true) {
        result.push(value([...path, result.length], depth + 1)); whitespace()
        const delimiter = text[offset++]
        if (delimiter === ']') return result
        if (delimiter !== ',') fail('JSON_SYNTAX', path, 'Expected a comma or closing bracket')
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(offset))
    if (number) {
      offset += number[0].length
      const result = Number(number[0])
      if (!Number.isFinite(result)) fail('NON_FINITE_NUMBER', path, 'JSON numbers must be finite')
      return result
    }
    return fail('JSON_SYNTAX', path, 'Expected a JSON value')
  }
  const result = value([], 0)
  whitespace()
  if (offset !== text.length) fail('JSON_SYNTAX', [], 'Unexpected data after the JSON value')
  return result
}
