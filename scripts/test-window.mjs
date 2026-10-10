// Runs `pnpm test` (build + Vitest) with a chosen FUSIONKIT_TEST_WINDOW mode, e.g.
//   pnpm test:visible test/subtitle-studio/cue-editing-ui.test.ts
// Modes: quiet (default), inactive (on-screen, never takes focus), visible.
import { spawn } from 'node:child_process'

const [mode, ...args] = process.argv.slice(2)
if (!['quiet', 'inactive', 'visible'].includes(mode)) {
  console.error('Usage: node scripts/test-window.mjs <quiet|inactive|visible> [vitest args...]')
  process.exit(2)
}

const child = spawn('pnpm', ['test', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, FUSIONKIT_TEST_WINDOW: mode },
})
child.on('exit', code => process.exit(code ?? 1))
