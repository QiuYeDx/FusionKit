// Keeps a build and the Electron UI tests in one checkout from overlapping.
// `vite build` (vite.config.ts) empties dist-electron/ and dist/ before writing them again. An Electron test
// that launches in that gap finds no main entry, and Electron's default app then opens an "Error launching
// app" box on the developer's screen for every launch. So a build waits until no Electron UI test is using
// the build output, and a test file waits for a running build before it uses it.
//
// In test-results/.ui-test-locks, build.json is held by the building process and runs/<pid>-<id>.json by
// each test file (or QA script) that uses Electron. Owners touch their files every HEARTBEAT_MS. A file is
// stale once its process is gone, or once another process has watched it stay untouched past STALE_MS
// (its pid may have been reused).
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export const UI_TEST_LOCK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-results/.ui-test-locks')
const HEARTBEAT_MS = 10 * 1000
const STALE_MS = 5 * 60 * 1000
// Vitest's fake timers replace globalThis.Date in test processes; file times need the real clock.
const wallClock = Date.now
// Waits are measured on the process's own clock, so a wall-clock step does not end them early.
const monotonic = () => performance.now()
// "Someone else has this name, or is deleting it": look again later.
const HELD_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY'])
// Volumes without hard links (FAT, some network shares) answer linkSync with one of these.
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR'])

const buildLock = dir => path.join(dir, 'build.json')
const runsDir = dir => path.join(dir, 'runs')

// On `process`, not in this module: Vitest evaluates this module again for every test file, and each worker
// thread has its own `process`. `files` maps each owned file to the token it was written with, if any.
const held = () => (process[Symbol.for('fusionkit.uiTestLocks')] ??= { files: new Map(), runs: new Map(), builds: new Map(), suspects: new Map() })

/** Keeps `file` fresh while this process lives, and removes it when the process exits (if it is still ours). */
function own(file, token) {
  const state = held()
  state.files.set(file, token)
  state.heartbeat ??= setInterval(() => {
    const seconds = wallClock() / 1000
    for (const owned of state.files.keys()) {
      try {
        utimesSync(owned, seconds, seconds)
      } catch {}
    }
  }, HEARTBEAT_MS).unref()
  if (state.exitHook) return
  state.exitHook = true
  process.once('exit', () => state.files.forEach((ownToken, owned) => (ownToken === undefined || ownerOf(readText(owned))?.token === ownToken) && remove(owned)))
}

function disown(file) {
  const state = held()
  state.files.delete(file)
  remove(file)
  if (state.files.size || !state.heartbeat) return
  clearInterval(state.heartbeat)
  state.heartbeat = undefined
}

const remove = file => {
  try {
    rmSync(file, { force: true })
    return true
  } catch {
    // Windows keeps a file that another process is deleting (delete pending) until it is closed.
    return false
  }
}

const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const readText = file => {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    // Missing: no owner. Anything else (a file briefly locked on Windows): held, look again later.
    return error.code === 'ENOENT' ? undefined : null
  }
}

const touchedAt = file => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

const ownerOf = text => {
  try {
    const owner = JSON.parse(text)
    return Number.isInteger(owner?.pid) ? owner : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether `owner`, read from `file`, is still there. A live pid whose file has not been touched for STALE_MS
 * is a reused pid, or an owner whose next heartbeat has not come yet because the machine just woke up or the
 * clock jumped. It counts as gone only after this process has watched it stay untouched for two heartbeats.
 */
function isLive(owner, file) {
  if (owner === undefined || !isAlive(owner.pid)) return false
  const { suspects } = held()
  const touched = touchedAt(file)
  if (wallClock() - touched < STALE_MS) {
    suspects.delete(file)
    return true
  }
  const now = monotonic()
  const seen = suspects.get(file)
  if (seen?.touched !== touched || now - seen.lastLook > HEARTBEAT_MS) {
    suspects.set(file, { touched, since: now, lastLook: now })
    return true
  }
  seen.lastLook = now
  return now - seen.since < 2 * HEARTBEAT_MS
}

/**
 * The live owner recorded in `file` (with `file` added), or undefined when there is none. `reap(file, text)`
 * may remove a stale file; when it returns false the file counts as held for now.
 */
function liveOwner(file, reap) {
  const text = readText(file)
  if (text === undefined) return undefined
  if (text === null) return { pid: undefined, file }
  const owner = ownerOf(text)
  if (isLive(owner, file)) return { ...owner, file }
  // Unreadable but just written: an exclusive create (see writeOwner) that is not filled in yet.
  if (owner === undefined && wallClock() - touchedAt(file) < HEARTBEAT_MS) return { pid: undefined, file }
  return reap && !reap(file, text) ? { pid: undefined, file } : undefined
}

/** Removes a stale file unless it was rewritten or came back to life meanwhile; true once it is gone. */
const reapUnchanged = (file, text) => {
  const current = readText(file)
  if (current === undefined) return true
  if (current !== text || isLive(ownerOf(current), file)) return false
  held().suspects.delete(file)
  return remove(file)
}

/**
 * Removes a stale build.json. Only one process at a time may do so: otherwise one could delete the fresh lock
 * another process created right after its own removal.
 */
function reapBuildLock(file, text) {
  const reaper = `${file}.reap`
  try {
    writeOwner(reaper, { pid: process.pid }, true)
  } catch (error) {
    if (!HELD_CODES.has(error.code)) throw error
    liveOwner(reaper, reapUnchanged)
    return false
  }
  try {
    return reapUnchanged(file, text)
  } finally {
    remove(reaper)
  }
}

/** Writes `owner` to `file` whole, so a reader never sees half a file. With `exclusive`, fails when `file` exists. */
function writeOwner(file, owner, exclusive) {
  const text = JSON.stringify(owner)
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, text)
  try {
    if (!exclusive) renameSync(temporary, file)
    else {
      try {
        linkSync(temporary, file)
      } catch (error) {
        if (!NO_HARD_LINKS.has(error.code)) throw error
        writeFileSync(file, text, { flag: 'wx' })
      }
    }
  } finally {
    remove(temporary)
  }
}

/** Live Electron test processes. */
export function liveUiTestRuns(dir = UI_TEST_LOCK_DIR) {
  let names = []
  try {
    names = readdirSync(runsDir(dir)).filter(name => name.endsWith('.json'))
  } catch {}
  return names.map(name => liveOwner(path.join(runsDir(dir), name), reapUnchanged)).filter(Boolean)
}

/** The live build holding the lock, if any. A stale lock is left for the next build to remove. */
export const liveTestBuild = (dir = UI_TEST_LOCK_DIR) => liveOwner(buildLock(dir))

/**
 * Takes the build lock, then waits until no Electron test process is running. Returns `release`.
 * Throws, holding nothing, when either wait passes `timeoutMs` or the lock is lost meanwhile.
 */
export async function acquireTestBuildLock({ dir = UI_TEST_LOCK_DIR, timeoutMs = 30 * 60 * 1000, pollMs = 1000, log = () => {} } = {}) {
  mkdirSync(runsDir(dir), { recursive: true })
  const lock = buildLock(dir)
  const token = randomUUID()
  const deadline = monotonic() + timeoutMs
  for (let reported = false, retries = 0; ; ) {
    try {
      writeOwner(lock, { pid: process.pid, token }, true)
      break
    } catch (error) {
      if (!HELD_CODES.has(error.code)) throw error
    }
    const other = liveOwner(lock, reapBuildLock)
    // Released or removed as stale: take it at once, but never spin.
    if (!other && retries++ < 3) continue
    if (monotonic() > deadline) throw new Error(`Another build (pid ${other?.pid ?? '?'}) still holds ${lock}. If no build is running, delete that file.`)
    if (!reported) log(`Waiting for another build (pid ${other?.pid ?? '?'}) to finish...`)
    reported = true
    await sleep(pollMs)
  }
  own(lock, token)
  const release = () => {
    if (liveTestBuild(dir)?.token === token) disown(lock)
    else held().files.delete(lock)
  }
  try {
    for (let reported = false; ; reported = true) {
      const runs = liveUiTestRuns(dir)
      if (!runs.length) {
        const holder = liveTestBuild(dir)
        if (!holder || (holder.pid !== undefined && holder.token !== token)) throw new Error(`${lock} was deleted or taken over while this build waited; not rebuilding. Run the build again.`)
        return release
      }
      const files = runs.map(run => run.file).join(', ')
      if (monotonic() > deadline) throw new Error(`Electron UI tests are still running; not rebuilding dist/ and dist-electron/ under them. If none is running, delete ${files}.`)
      if (!reported) log(`Waiting for running Electron UI tests to finish before rebuilding (${files})...`)
      await sleep(pollMs)
    }
  } catch (error) {
    release()
    throw error
  }
}

/** acquireTestBuildLock for a build process (vite.config.ts): held until the process exits; taken once per process. */
export async function holdTestBuildLock(options = {}) {
  const dir = options.dir ?? UI_TEST_LOCK_DIR
  const { builds } = held()
  if (!builds.has(dir)) builds.set(dir, acquireTestBuildLock(options).catch(error => (builds.delete(dir), Promise.reject(error))))
  await builds.get(dir)
}

/**
 * Registers this process as using the build output (Electron UI tests), first waiting for a build in
 * progress. Only the first call while registered waits. A registered process goes ahead even while a build
 * waits for the lock: that build waits for it to leave.
 */
export async function joinUiTestRun({ dir = UI_TEST_LOCK_DIR, timeoutMs = 15 * 60 * 1000, pollMs = 500, log = message => console.warn(message) } = {}) {
  const { runs } = held()
  if (runs.has(dir)) return
  mkdirSync(runsDir(dir), { recursive: true })
  const marker = path.join(runsDir(dir), `${process.pid}-${randomUUID()}.json`)
  const deadline = monotonic() + timeoutMs
  for (let reported = false; ; ) {
    for (let build = liveTestBuild(dir); build && !runs.has(dir); build = liveTestBuild(dir)) {
      if (monotonic() > deadline) {
        const others = liveUiTestRuns(dir).map(run => run.file)
        throw new Error(others.length
          ? `A build (pid ${build.pid ?? '?'}) is waiting for other Electron UI tests to finish (${others.join(', ')}) before rewriting dist/ and dist-electron/. Run this again once they are done.`
          : `A build (pid ${build.pid ?? '?'}) is still rewriting dist/ and dist-electron/. Run this again once it has finished.`)
      }
      if (!reported) log(`Waiting for a build (pid ${build.pid ?? '?'}) to finish before using dist/ and dist-electron/...`)
      reported = true
      await sleep(pollMs)
    }
    // Another call in this process may have registered while this one slept.
    if (runs.has(dir)) return
    writeOwner(marker, { pid: process.pid }, false)
    // A build that took the lock before this marker existed may not have seen it: let that build go first.
    if (!liveTestBuild(dir)) break
    remove(marker)
  }
  runs.set(dir, marker)
  own(marker)
}

/** Ends this process's registration once it no longer uses the build output; a waiting build may then start. */
export function leaveUiTestRun({ dir = UI_TEST_LOCK_DIR } = {}) {
  const { runs } = held()
  const marker = runs.get(dir)
  if (!marker) return
  runs.delete(dir)
  disown(marker)
}
