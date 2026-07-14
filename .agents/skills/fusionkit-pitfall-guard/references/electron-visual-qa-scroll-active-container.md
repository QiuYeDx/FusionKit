# FK-PIT-0009: Scroll the target element in Electron visual QA

## Area

Electron visual QA, Playwright screenshots, internal scroll containers.

## Triggers

- A screenshot after `window.scrollTo()` repeats the previous viewport.
- The app shell scrolls an internal container instead of the document.
- Fixed top or bottom navigation covers a target brought only barely into view.

## Symptoms

- “Workspace” and “configuration” screenshots are identical even though the test asked to scroll.
- DOM assertions pass, but the screenshot still shows the previous section.
- `window.scrollY` changes little or not at all while the visible app content can still scroll.

## Root cause

FusionKit pages may be hosted inside an app-shell scroll container. Scrolling the document does
not necessarily move that container. Minimal `scrollIntoViewIfNeeded()` positioning can also leave
the target against a fixed navigation overlay.

## Do

- Scroll a concrete target with `element.scrollIntoView({ block: "center" })` for form controls.
- For final result/output proof, use a stable result element and `block: "start"` when space allows.
- Wait two animation frames after scrolling before measuring or taking the screenshot.
- Inspect the actual image and confirm the intended section differs from the previous capture.
- Measure horizontal overflow and verify fixed navigation does not cover the target controls.

## Avoid

- Do not assume `window.scrollTo()` controls the active FusionKit scroll host.
- Do not accept two differently named screenshots that contain the same viewport.
- Do not rely on DOM visibility alone as proof that a fixed overlay is not covering the target.

## Validation

```text
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t '<visual scenario>' --reporter=verbose
```

After the run, inspect each screenshot and confirm the requested target is visible, loading is gone,
and fixed navigation does not overlap the interaction being proven.

## Related files

- `test/e2e.spec.ts`
- `src/pages/Tools/_shared/ui/ToolDetailLayout.tsx`
