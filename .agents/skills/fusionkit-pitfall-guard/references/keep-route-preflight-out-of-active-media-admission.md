# FK-PIT-0086: Keep route preflight out of active media admission

## Area

Electron / SPA lifecycle / local subtitle media admission

## Triggers

- A tool page runs `probeRuntime()` or `previewBackend()` in a mount effect.
- Committed transcription tasks continue after navigating away from the tool route.
- Runtime preflight and task normalization share a per-owner native media concurrency limit.
- Returning to the route makes queued or preparing tasks fail with `limit_exceeded`.

## Symptoms

- Tasks run normally while the detail page stays mounted.
- Navigating to another tool and returning triggers a fresh environment loading state.
- The new read-only probe or backend preview starts under the same owner as the task queue.
- A task entering media preparation during that window is rejected as a second owner operation,
  even though the application and renderer session never closed.

## Root cause

SPA route mount/unmount is a presentation lifecycle, not a renderer-session or task-authority
lifecycle. A mount-triggered preflight can still consume a main-process native admission ticket.
When committed jobs outlive the route, repeating that preflight makes visible navigation compete
with background execution. StrictMode single-flight only merges simultaneous identical probes; it
does not prevent a later route probe from colliding with real task media work.

## Do

- Start the shared task session observer at renderer-app initialization, outside route components.
- Run the automatic environment probe once per renderer session through an idempotent app-level
  service, then expose its cached snapshot with `useSyncExternalStore`.
- Cache successful backend previews by exact runtime generation, model, and device preference so a
  route remount reuses the prior result.
- While any committed task is active, do not issue a new backend preview or native runtime probe;
  a manual refresh may update session/resource metadata without entering native media admission.
- Keep manual rechecks fresh after tasks are idle, and invalidate preview cache after relevant
  resource changes.
- Test that route consumers do not invoke environment IPC directly and that repeated app-level
  initialization calls still execute only one automatic probe.

## Avoid

- Do not increase the native per-owner concurrency limit to accommodate page navigation.
- Do not cancel or release committed task authority from a route cleanup effect.
- Do not rely only on React generation guards; they prevent stale UI writes but cannot retract IPC
  work that already reached the main process.
- Do not permanently cache readiness without an explicit manual refresh and resource-change
  invalidation path.

## Validation

- Unit-test one-time environment initialization, explicit refresh, and backend-preview reuse.
- Source-test that the route no longer calls `probeRuntime`, `previewBackend`, or
  `listManagedResources` directly.
- Start a multi-file transcription, navigate away during media preparation, return, and confirm no
  task changes to `failed / limit_exceeded` because of navigation.
- Confirm manual refresh during an active task does not enter media runtime preflight.
- Run focused renderer/store/runtime tests, TypeScript, and the root three-part Vite build.

## Related files

- `src/main.tsx`
- `src/services/local-subtitle/localSubtitleEnvironmentService.ts`
- `src/services/local-subtitle/localSubtitleRuntimeService.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/index.tsx`
- `electron/main/local-subtitle/media-normalizer.ts`
