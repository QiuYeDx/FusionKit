# FK-PIT-0001: Wait for FusionKit loading to finish before visual QA

## Area

Electron visual QA, Playwright screenshots, UI regression validation.

## Triggers

- Screenshot shows only `100%`, a blank white/black screen, or the FusionKit loading wordmark.
- A visual matrix script opens and closes Electron windows quickly.
- A task uses screenshots as proof for UI layout, spacing, responsive behavior, or theme validation.
- Files involved include `electron/preload/index.ts`, visual QA scripts, or Electron window sizing code.

## Symptoms

- DOM selectors may already exist behind the global loading overlay, but the screenshot still captures `.app-loading-wrap`.
- Metrics may look plausible while the image is invalid for visual review.
- Dark/light screenshots can be wrong if `localStorage` is written after the app has already hydrated the theme store.

## Root cause

FusionKit injects a preload loading screen from `electron/preload/index.ts`. The renderer posts `removeLoading`, then the preload animation holds and reveals for additional time before removing `.app-loading-wrap` and `#app-loading-style`. Waiting only for `domcontentloaded`, route selectors, or target elements is not enough.

## Do

- Wait until both `.app-loading-wrap` and `#app-loading-style` are absent before taking screenshots.
- Wait for the target route, title text, and relevant target elements.
- After writing `fusionkit-theme` in `localStorage`, reload the page so `useThemeStore` rehydrates and applies the `dark` class.
- Add a short post-ready delay for route motion/theme transition when screenshots are used as visual evidence.
- For 786×540 single-column pages, capture both first-screen config state and a scrolled workspace state if upload/task areas are below the fold.

## Avoid

- Do not treat a screenshot of the 100% loading overlay as a valid UI screenshot.
- Do not rely only on `waitForSelector()` when a global overlay can still cover the app.
- Do not infer dark/light correctness from `localStorage` alone; verify the `html.dark` class or visual output.

## Validation

Useful Playwright checks:

```ts
await page.waitForFunction(() => {
  return !document.querySelector(".app-loading-wrap")
    && !document.querySelector("#app-loading-style");
});
```

Also record:

- viewport/window size;
- whether loading is present;
- page-level horizontal overflow;
- screenshots paths;
- route and theme.

## Related files

- `electron/preload/index.ts`
- `src/store/useThemeStore.ts`
- `src/utils/common.ts`
- `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_PRE-001_UI-001_UI-002_visual-matrix-closure.md`
