import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const preloadPath = path.resolve(
  scriptDirectory,
  '../dist-electron/preload/index.mjs',
)
const preloadSource = await readFile(preloadPath, 'utf8')
const sandboxRequireAllowlist = new Set([
  'electron',
  'events',
  'timers',
  'url',
])
const requiredModules = [
  ...preloadSource.matchAll(/\brequire\((['"])([^'"]+)\1\)/gu),
].map((match) => match[2])
const unsupportedModules = [
  ...new Set(
    requiredModules.filter(
      (moduleName) => !sandboxRequireAllowlist.has(moduleName),
    ),
  ),
].sort()

if (unsupportedModules.length > 0) {
  throw new Error(
    `Sandboxed preload contains unsupported external modules: ${unsupportedModules.join(', ')}`,
  )
}

console.log(
  `Sandboxed preload external module check passed (${[...new Set(requiredModules)].join(', ') || 'none'}).`,
)
