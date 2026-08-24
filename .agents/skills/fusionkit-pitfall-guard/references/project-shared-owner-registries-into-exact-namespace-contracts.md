# FK-PIT-0100: Project shared owner registries into exact namespace contracts

## Area

Electron preload/main IPC capability registration and cross-namespace handoff.

## Triggers

owner_released, sendSync, strict registration response, bridgeVersion, shared owner registry, sibling IPC namespace, generated subtitle handoff

## Symptoms

- A fixed preload API immediately returns `owner_released` without invoking its main-process handler.
- Another feature using the same underlying owner registry continues to work, making the session appear healthy.
- Main-process diagnostics at the intended operation never run.
- Unit tests pass because they mock the intended namespace response, while production returns an extra field from the shared registry.

## Root cause

A reusable owner registry can return a broader internal record than a namespace exposes. Passing that result through unchanged violates a strict preload contract; for example, `{ ownerSessionId, bridgeVersion }` is not the exact translation registration shape `{ ownerSessionId }`. The preload correctly fails closed, but the visible symptom is a misleading unavailable-owner result before any invoke occurs. A related mistake is ferrying a sibling namespace's owner session ID through renderer code instead of resolving it from the already-authenticated sender in main.

## Do

- Project shared registry results into the exact response type owned by each IPC namespace.
- Keep strict preload validation so unexpected fields still fail closed.
- Add a production-shaped main-adapter test in which the shared registry returns its broader record and assert that the namespace response contains only its declared fields.
- Resolve sibling owner identity in main from the authenticated `webContents`, frame, and process rather than accepting a renderer-carried sibling session ID.
- When a preload method reports a session error and main logs are silent, inspect the synchronous registration result before debugging the later handler.

## Avoid

- Do not return a shared helper's success payload wholesale across a narrower namespace boundary.
- Do not loosen an exact preload parser merely to accept accidental internal fields.
- Do not cache or expose one namespace's private owner session ID through another contextBridge API.
- Do not rely only on preload tests whose registration fixture was hand-written to the ideal shape.

## Validation

```text
node_modules/.bin/vitest run test/translation/subtitle-translation-preload.test.ts test/translation/subtitle-translation-ipc-service.test.ts test/translation/generated-import-candidate.test.ts src/services/subtitle/generatedSubtitleImportCoordinator.test.ts src/services/local-subtitle/localSubtitlePostActionService.test.ts
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
git diff --check
```

In the running Electron app, transcribe a short file with `加入并开始翻译`, confirm the local row reports `已加入翻译 · 翻译已开始`, then confirm the generated task exists and reaches a running or completed state on the subtitle translation page.

## Related files

- `electron/main/translation/ipc.ts`
- `electron/main/local-subtitle/ipc-security.ts`
- `electron/preload/subtitle-translation-api.ts`
- `electron/preload/index.ts`
- `src/type/subtitleTranslationIpc.ts`
- `test/translation/subtitle-translation-preload.test.ts`
- `test/translation/subtitle-translation-ipc-service.test.ts`
- `test/local-subtitle/ipcSecurity.test.ts`
