# FK-PIT-0191: Build the test bundle before Electron UI tests

## Area

Electron UI tests, test build, pnpm scripts.

## Triggers

- `pnpm test` after a renderer, CSS or component change.
- A UI refactor (for example a shadcn/ui style migration) leaves every Electron screenshot and geometry
  assertion unchanged.
- `dist/` or `dist-electron/` timestamps are older than the change being tested.

## Symptoms

- Electron UI tests pass and their screenshots in `test-results/` look exactly like before a visible change.
- Unit tests that import `src/` reflect the change while Electron tests do not.

## Root cause

`package.json` declares `pretest: vite build --mode=test && node scripts/check-preload-bundle.mjs`, but the
repository uses pnpm 8, where `enable-pre-post-scripts` is off by default. `pnpm test` therefore runs only
`vitest run`, and every `*.electron.test.ts` launches whatever is already in `dist/` and `dist-electron/`.

## Do

- Build explicitly before Electron UI tests: `pnpm run pretest`, then `pnpm exec vitest run ...`
  (or `pnpm test ...`). The build waits for Electron UI tests running in the same checkout; see FK-PIT-0197.
- When comparing screenshots before and after a change, build both sides, and check
  `ls -la dist` timestamps against the change.

## Avoid

- Do not treat green Electron UI tests or unchanged screenshots as proof that a renderer change is safe
  unless the test bundle was rebuilt after the change.

## Validation

```text
pnpm run pretest
pnpm exec vitest run test/dialog-motion.electron.test.ts
```

## Related files

- `package.json` (`pretest`, `test`)
- `vitest.config.ts`
- `dist/`, `dist-electron/`
