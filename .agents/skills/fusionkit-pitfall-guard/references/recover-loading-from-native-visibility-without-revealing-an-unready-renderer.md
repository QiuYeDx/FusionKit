# FK-PIT-0154: Recover loading from native visibility without revealing an unready renderer

## Area

Electron / loading lifecycle

## Triggers

preload loading, 0 percent, hidden reload, native show, renderer ready, theme reload, language reload

## Symptoms

The renderer and its animation frames are active, but the global preload overlay remains at 0% after hiding, reloading and showing the native window. A nominal loading timeout does not remove it. A screenshot file named dark can also contain a light theme after a prior theme reload.

## Root cause

On macOS with Electron 41 and Playwright attached, a native window can be hidden while document.visibilityState remains visible. In the reproduced quick hide/reload/show sequence, BrowserWindow.isVisible() and isFocused() became true but the native show event was absent. A loader that only starts from the initial ready-to-show or a visible dom-ready can miss its start signal.

The old 4999ms fallback only requested completion. Completion still depended on the minimum progress animation having started, so it could wait forever. Conversely, unconditionally removing the overlay after a wall-clock timeout would reveal a renderer that had not sent its ready notification.

## Do

- Distinguish native window visibility, native event delivery, DOM visibility, renderer readiness and actual frame progress when diagnosing a stuck overlay.
- Preserve the initial show signal. For a hidden document at dom-ready, use only a short bounded native visibility check; clear it on successful start, main-frame navigation/reload and window destruction.
- Arm an independent cleanup deadline only after the real renderer-ready notification. Cleanup must not depend on the progress animation or on receiving the missing start signal.
- Make cleanup idempotent and fence late mount/animation callbacks. Remove timers, frame callbacks, listeners and both overlay/style nodes.
- Test missing and delayed start notifications, hidden reload, sequential theme/language reloads and a ready notification held beyond the old deadline.
- Record actual rendered theme in screenshot evidence and assert it agrees with the filename. Wait for both .app-loading-wrap and #app-loading-style to disappear before visual acceptance.

## Avoid

- Do not replace native visibility checks with document.visibilityState or assume every show call emits show.
- Do not extend test waits or mark the historical platform failure reproduced merely because a related lifecycle defect was found.
- Do not remove an overlay before renderer readiness to manufacture a green screenshot.
- Do not await an unbounded native event inside an inspector evaluation. Keep diagnostic actions synchronous and observe bounded state/event results from the test runner.

## Validation

On 2026-09-14, baseline run-65t2ki reproduced a ready renderer stuck at 0%. Diagnostic run-Utv7tC recorded native visible/focused=true, hide=1, show=0, focus=1, 228 renderer frames and zero start signals.

Final real Electron run-TxzOBj still recorded show=0 but received one start signal and passed the normal 2-second progress-start assertion. A missing notification recovered in about 5156ms; an 800ms delayed signal and four theme/language reloads passed. Holding renderer readiness for more than 5.2 seconds retained the 92% overlay, which exited only after readiness was released.

The full operation-result suite run-8GemQ8 passed after fixing its screenshot-theme assertions: 27 action records, 12 geometry records, 3 controlled HTTP requests and zero page errors. Owned Electron/services/profiles were cleaned. Windows and packaged-app acceptance remain separate.

## Related files

- electron/main/index.ts
- electron/preload/index.ts
- test/preload-loading-ui.test.ts
- test/subtitle-studio/result-feedback-ui.test.ts
- docs/features/subtitle-studio/records/2026-09-14-release-loading.md
- electron-visual-qa-wait-for-loading.md
