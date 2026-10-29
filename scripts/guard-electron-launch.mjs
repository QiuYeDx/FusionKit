// Guards Playwright's `_electron.launch` (one shared object per process) for Electron UI tests and QA
// scripts. Each launch first registers the process with the build lock (scripts/ui-test-lock.mjs), waiting
// for a build in progress; refuses to start Electron when the app's main entry is missing; and loads
// electron-launch-guard.cjs ahead of the app, which keeps Electron's error boxes off the developer's screen.
// Their reports are echoed as they arrive and kept for takeErrorBoxReports().
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { joinUiTestRun } from './ui-test-lock.mjs'

export const LAUNCH_GUARD = fileURLToPath(new URL('./electron-launch-guard.cjs', import.meta.url))
export const { missingAppEntry, REPORT_LOG_ENV, REPORT_PREFIX } = createRequire(import.meta.url)(LAUNCH_GUARD)

const GUARDED = Symbol.for('fusionkit.electronLaunchGuard')
// One report file per guarded launch. The guard appends to it from Electron's first line of JavaScript, so it
// also holds reports from before launch() resolves, which never reach a stderr reader attached afterwards.
const reportLogs = () => (process[Symbol.for('fusionkit.electronErrorBoxLogs')] ??= [])

/** Error-box report lines from this process's guarded apps since the last call. */
export function takeErrorBoxReports() {
  const lines = []
  const logs = reportLogs()
  for (const log of [...logs]) {
    let text = ''
    try {
      text = readFileSync(log.file, 'utf8')
    } catch {}
    const end = text.lastIndexOf('\n') + 1
    if (end > log.read) lines.push(...text.slice(log.read, end).split('\n').filter(Boolean))
    log.read = Math.max(log.read, end)
    // Its app is gone and everything it reported has been read.
    if (!log.exited) continue
    logs.splice(logs.indexOf(log), 1)
    rmSync(log.file, { force: true })
  }
  return lines
}

export function guardElectronLaunch(electron, { join = joinUiTestRun } = {}) {
  if (electron[GUARDED]) return
  const launch = electron.launch.bind(electron)
  electron.launch = async (options = {}) => {
    // A packaged executable loads its own app.asar; only Electron's default app reads -r and dist-electron/.
    if (options.executablePath) return launch(options)
    await join()
    const args = options.args ?? []
    const missing = missingAppEntry(args, options.cwd ?? process.cwd())
    if (missing) throw new Error(`${missing} Build the test bundle first: pnpm run pretest`)
    const log = { file: path.join(tmpdir(), `fusionkit-error-boxes-${process.pid}-${randomUUID()}.log`), read: 0 }
    reportLogs().push(log)
    const app = await launch({ ...options, args: ['-r', LAUNCH_GUARD, ...args], env: { ...(options.env ?? process.env), [REPORT_LOG_ENV]: log.file } })
    const child = app.process?.()
    child?.once('exit', () => { log.exited = true })
    const stderr = child?.stderr
    if (stderr) {
      createInterface({ input: stderr }).on('line', line => {
        if (line.startsWith(REPORT_PREFIX)) console.error(line)
      })
    }
    return app
  }
  electron[GUARDED] = true
}
