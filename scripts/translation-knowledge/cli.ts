import { open } from 'node:fs/promises'
import { parseKnowledgePackage } from '../../src/translation-knowledge/validation'
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize'
import { ENTITY_ARRAYS, LIMITS } from '../../src/translation-knowledge/schemas'
import type { KnowledgePackage } from '../../src/translation-knowledge/schemas'

const args = process.argv.slice(2)
const json = args.includes('--json')
const digestIndex = args.indexOf('--digest')
const entityId = digestIndex >= 0 ? args[digestIndex + 1] : undefined
const positional = args.filter((arg, index) => arg !== '--json' && arg !== '--digest' && (digestIndex < 0 || index !== digestIndex + 1))
const fail = (message: string) => {
  if (json) console.log(JSON.stringify({ valid: false, errors: [{ code: 'TOOL_ERROR', path: '', message }], warnings: [], stats: null }))
  else console.error(message)
  process.exitCode = 2
}

async function main() {
  // Only this CLI knows about the filesystem; the bundled protocol is pure and never fetches URLs.
  if (positional.length !== 1 || args.includes('--help') || (digestIndex >= 0 && !entityId) || positional[0].startsWith('--')) {
    fail('Usage: node validate.mjs <file.fktk.json> [--json] [--digest <entity-uuid>] (Node.js >=18)')
    return
  }
  const handle = await open(positional[0], 'r')
  let buffer: Buffer
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Input must be a regular file')
    if (info.size > LIMITS.fileBytes) {
      const output = { valid: false, errors: [{ code: 'LIMIT_FILE_BYTES', path: '', message: `File uses ${info.size} bytes; maximum is ${LIMITS.fileBytes}` }], warnings: [], stats: { bytes: info.size, errorCount: 1, warningCount: 0 } }
      console.log(json ? JSON.stringify(output) : output.errors[0].message)
      process.exitCode = 1
      return
    }
    // Read at most limit+1, including if a file grows after stat.
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, end: LIMITS.fileBytes })) {
      chunks.push(chunk as Buffer); total += (chunk as Buffer).length
    }
    buffer = Buffer.concat(chunks, total)
  } finally { await handle.close() }
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer) } catch {
    const output = { valid: false, errors: [{ code: 'INVALID_UTF8', path: '', message: 'Input is not valid UTF-8' }], warnings: [], stats: { bytes: buffer.length, errorCount: 1, warningCount: 0 } }
    console.log(json ? JSON.stringify(output) : output.errors[0].message)
    process.exitCode = 1
    return
  }
  const { data, ...report } = parseKnowledgePackage(content)
  if (entityId && data) {
    const records: (KnowledgePackage['package'] | KnowledgePackage[typeof ENTITY_ARRAYS[number]][number])[] = [data.package]
    for (const key of ENTITY_ARRAYS) records.push(...data[key])
    const entity = records.find(record => record.id === entityId)
    if (!entity) { fail(`Entity ${entityId} does not exist in this package`); return }
    console.log(JSON.stringify({ id: entity.id, revision: entity.revision, digest: sha256Canonical(entity) }, null, json ? undefined : 2))
  } else if (json) console.log(JSON.stringify(report))
  else {
    console.log(report.valid ? `FK-TK/1 valid: ${report.stats.entities} entities, ${report.stats.warningCount} warnings. Protocol validity does not verify sources or confer local acceptance.` : `Invalid: ${report.stats.errorCount} errors, ${report.stats.warningCount} warnings.`)
    for (const item of [...report.errors, ...report.warnings]) console.log(`${item.code} ${item.path || '/'}: ${item.message}`)
  }
  process.exitCode = report.valid ? 0 : 1
}

main().catch(cause => fail(cause instanceof Error ? cause.message : String(cause)))
