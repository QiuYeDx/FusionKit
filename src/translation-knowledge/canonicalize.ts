/** RFC 8785 JCS: ECMAScript number/string serialization, UTF-16 property ordering. */
export function assertValidUnicode(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Lone high surrogate is not valid Unicode')
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError('Lone low surrogate is not valid Unicode')
  }
}

export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>()
  const encode = (item: unknown): string => {
    if (item === null) return 'null'
    if (typeof item === 'string') { assertValidUnicode(item); return JSON.stringify(item) }
    if (typeof item === 'boolean') return item ? 'true' : 'false'
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('JCS forbids non-finite numbers')
      return JSON.stringify(item)
    }
    if (typeof item !== 'object') throw new TypeError('JCS accepts only JSON values')
    if (ancestors.has(item)) throw new TypeError('JCS forbids circular structures')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError('JCS accepts only plain JSON objects')
    ancestors.add(item)
    try {
      if (Array.isArray(item)) return `[${Array.from(item, encode).join(',')}]`
      return `{${Object.keys(item).sort().map(key => {
        assertValidUnicode(key)
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!
        if (!('value' in descriptor)) throw new TypeError('JCS forbids accessor properties')
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`
      }).join(',')}}`
    } finally { ancestors.delete(item) }
  }
  return encode(value)
}

// Portable synchronous SHA-256 keeps application and standalone validator behavior identical.
const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]
const rotate = (n: number, bits: number) => (n >>> bits) | (n << (32 - bits))
export function sha256Canonical(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalize(value))
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
  padded.set(bytes); padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000))
  view.setUint32(padded.length - 4, bytes.length * 8)
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const words = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15], b = words[i - 2]
      words[i] = words[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + words[i]) | 0
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    for (const [i, part] of [a, b, c, d, e, f, g, h].entries()) hash[i] = (hash[i] + part) | 0
  }
  return hash.map(n => (n >>> 0).toString(16).padStart(8, '0')).join('')
}
