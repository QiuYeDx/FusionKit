# FK-PIT-0197: Do not rebuild the test bundle under running Electron UI tests

## Area

Electron UI tests, test build, parallel agents or sessions in one checkout.

## Triggers

- Two agents, sessions or terminals work in the same checkout, and one runs `pnpm run pretest`,
  `vite build` or `pnpm run build` while another runs `*.electron.test.ts` / `*-ui.test.ts` or a QA script.
- A workflow runs two UI tasks at the same time.

## Symptoms

- One "Error launching app" box per launch on the developer's screen: "Unable to find Electron app at
  ...\FusionKit. Cannot find module ...\dist-electron\main\index.js". Quiet window mode does not hide it.
- Electron UI tests time out on launch, fail to copy `dist/` into a fixture app, or open a blank window, then
  pass when rerun alone.

## Root cause

`vite build` empties `dist-electron/` (vite.config.ts) and `dist/` before writing them again. A test that
launches Electron in that gap finds no main entry. Electron's default app reports a failed app load, and
every uncaught main-process error, with `dialog.showErrorBox`: a modal on the real screen that steals focus.
On 2026-10-28 two workflow agents (one rebuilding, one running the media converter UI tests) produced a
flood of these boxes while the developer was gaming.

## Do

- Any `vite build` (pretest, `pnpm run build`, a direct `vite build --mode=test`) takes the build lock in
  `test-results/.ui-test-locks/build.json` first (vite.config.ts → `scripts/ui-test-lock.mjs`) and waits
  until no test file or QA script holds a `runs/<pid>-<id>.json` marker. It logs what it waits for.
- `test/support/vitest.setup.ts` registers every test file that loads Playwright before its hooks run (it
  waits for a build in progress), and guards Playwright's shared `_electron.launch`
  (`scripts/guard-electron-launch.mjs`): a launch refuses to start when `dist-electron/main/index.js` is
  missing, and loads `scripts/electron-launch-guard.cjs` with `-r`, which sends `dialog.showErrorBox` to
  stderr and to a per-launch report file, and exits when the entry is missing. A reported box still fails the
  test (it used to block the app): the test, or the file's afterAll, during which the report is collected; with
  an app shared across tests, a late main-process error can surface in the next test.
- QA scripts that launch the app call `guardElectronLaunch(electron)` first (readme-screenshots, home-agent-qa).
- Run UI tasks one at a time when several agents share a checkout; give each its own worktree if they must
  run in parallel.

## Avoid

- Do not start `electron.exe` or `npx electron .` by hand, and do not call `_electron.launch` from a new
  script without `guardElectronLaunch`; those launches are not guarded.
- Do not delete `test-results/.ui-test-locks/` while a build or UI test is running. A lock file left by a
  killed process is stale once its process is gone; with a reused pid, once another process has watched it go
  five minutes without a heartbeat (plus two heartbeats of its own, so a machine waking from sleep keeps its
  owners). The wait messages name the file to delete if that ever blocks.
- The lock covers the `vite build` process only. `pnpm run build` packages `dist/` with electron-builder after
  vite exits, and `pnpm dev` (serve) empties `dist-electron/` without the lock: do not run either while another
  session runs UI tests or `pnpm run pretest`. A production build also leaves a non-test bundle behind; run
  `pnpm run pretest` again before UI tests.

## Validation

```text
npx vitest run test/electron-launch-guard.test.ts
pnpm run pretest
npx vitest run --maxWorkers=1 --minWorkers=1 test/electron-launch-guard.electron.test.ts
```

The Electron test checks inside the real app that the guard is in `process.argv`, that
`dialog.showErrorBox.name` is `reportErrorBoxToStderr`, and that the test file was registered.

## Related files

- `vite.config.ts`, `scripts/ui-test-lock.mjs`
- `scripts/guard-electron-launch.mjs`, `scripts/electron-launch-guard.cjs`, `test/support/vitest.setup.ts`, `vitest.config.ts`
- `scripts/readme-screenshots/capture.mjs`, `scripts/home-agent-qa.mjs`
- Related: FK-PIT-0188 (quiet windows), FK-PIT-0191 (build before UI tests)
