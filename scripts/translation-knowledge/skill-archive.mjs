import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

export const skillDirectory = '.agents/skills/fusionkit-translation-knowledge'
export const skillFiles = [
  'SKILL.md', 'agents/openai.yaml', 'scripts/validate.mjs',
  'references/knowledge-v1.schema.json', 'references/protocol-v1.md',
  'references/research-and-evidence.md', 'references/organization-and-matching.md',
  'references/application-usage.md', 'examples/ja-starter.fktk.json',
  'examples/minimal.fktk.json', 'examples/multi-subject.fktk.json', 'examples/update.fktk.json',
]

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Deterministic ZIP: explicit distributable files only, UTF-8 names, deflate,
 * fixed 1980 timestamp. Never includes a user's library or local task data. */
export async function buildSkillArchive(root, overrides = new Map()) {
  const local = [], central = []
  let offset = 0
  for (const file of skillFiles) {
    const relative = `${skillDirectory}/${file}`
    // Canonicalize UTF-8 text so Windows autocrlf and Linux checkouts ship alike.
    const text = overrides.has(relative) ? overrides.get(relative).toString() : await readFile(path.join(root, relative), 'utf8')
    const bytes = Buffer.from(text.replace(/\r\n/g, '\n'))
    const packed = deflateRawSync(bytes), name = Buffer.from(`fusionkit-translation-knowledge/${file}`), crc = crc32(bytes)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12)
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26)
    local.push(header, name, packed)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14)
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(bytes.length, 24)
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42)
    central.push(record, name); offset += header.length + name.length + packed.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(skillFiles.length, 8); end.writeUInt16LE(skillFiles.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
