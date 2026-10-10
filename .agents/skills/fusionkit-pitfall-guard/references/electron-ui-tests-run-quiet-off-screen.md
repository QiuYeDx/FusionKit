# FK-PIT-0188: Electron UI tests run quiet and off-screen by default

## Area

Electron UI tests, Playwright Electron, developer experience.

## Triggers

- A UI test needs real OS focus, an on-screen window, real full screen or `maximize()`.
- Someone wants to watch a test run, or a new test "pops up" windows again.
- A measurement or screenshot differs slightly between runs right after a view change.

## Symptoms

- The developer's foreground app (often a game) loses focus every time a test launches FusionKit.
- `window.show()` / `window.focus()` in a test no longer brings the window forward (by design).
- `document.documentElement.requestFullscreen()` rejects inside tests.

## Root cause

`vitest.config.ts` defaults `FUSIONKIT_TEST_WINDOW=quiet`; every launch inherits it through `...process.env`.
`electron/main/test-window-mode.ts` then renders windows off-screen, keeps them out of the taskbar,
turns `show()` into `showInactive()`, makes `focus()`/`moveTop()`/`maximize()` no-ops, silences system
notifications and denies the HTML full-screen permission. Chromium occlusion is disabled so pages keep
painting, running animation frames and timers. Playwright's focus emulation keeps `document.hasFocus()` true.

## Do

- Run as usual (`pnpm test`, `pnpm exec vitest run ...`): quiet is the default.
- To watch: `pnpm test:inactive <files>` (on-screen, never takes focus) or `pnpm test:visible <files>`
  (exactly like the real app), or set `FUSIONKIT_TEST_WINDOW` yourself.
- Stub `document.fullscreenElement` / `requestFullscreen` / `exitFullscreen` in the page when a test covers
  full-screen behavior; never let a test cover the developer's screen.
- Wait for entrance animations (`element.getAnimations()` finished) before measuring boxes.

## Avoid

- Do not launch Electron with an env that drops `process.env` (the mode would be lost).
- Do not add `win.focus()`-dependent assertions (`isFocused()`), real full screen or maximize to tests.

## Validation

- `FUSIONKIT_DIALOG_MOTION_E2E=1 pnpm exec vitest run test/dialog-motion.electron.test.ts` passes quiet (animation timing).
- During a run, the window is at an x beyond every display and never in the taskbar.

## Related files

- `electron/main/test-window-mode.ts`
- `vitest.config.ts`
- `scripts/test-window.mjs`
