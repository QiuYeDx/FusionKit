# FK-PIT-0163: Bind translation plan authority to session claims and current draft identity

## Area

Subtitle Studio / translation session lifecycle

## Triggers

session owner,claim token,late check,unmount cancellation,document revision,stale plan,double start

## Symptoms

- Closing or invalidating an idle single-file panel cancels a batch or another panel's checked plan in the same renderer.
- Cleanup from an older mounted instance cancels a newer instance's plan of the same kind.
- A late check or a changed document, configuration or library can leave an apparently executable result behind.
- A document revision changes during a check, but source-specific roles and confirmations survive after the operation ends.
- Navigating away before admission acknowledgement hides already-created task IDs from the overview.

## Root cause

The main-process cancellation APIs are scoped to a renderer owner and plan kind, while multiple UI controllers can share that renderer. Component lifetime alone does not prove plan ownership. A checked result also belongs to a specific draft and document revision, not just to the mounted component. Advancing the remembered document identity before deferring a busy reset loses the reset permanently. Finally, an admitted task outlives its form, so the form's current identity cannot determine whether its acknowledgement is retained.

## Do

- Give each plan kind a unique session claim. Record that claim with the session epoch when a check completes, and accept submission only while the receipt still belongs to that session and kind.
- Cancel only claims still owned by the disposing or invalidating instance. Serialize cleanup across instances, check ownership again inside delayed cleanup, and join an in-flight plan before the final cancellation. An idle peer has nothing to cancel; an old peer must not revoke a new owner's claim.
- Build the current request identity from the document IDs/revisions, draft, resolved configuration/model credentials and active library generation. After each asynchronous check or library read, compare the epoch, claim and current identity before starting a request. Recheck plan expiry and library generation before admission.
- Claim the submission guard before the first await so two start clicks cannot pass while the same library refresh is pending.
- If a document changes during an operation, defer the draft reset without advancing the last processed document identity. Rerun it when pending becomes false. Source-revision changes and reuse on another document clear document topics, cue selections, per-cue roles, condition confirmations and per-entry exclusions while retaining reusable collection/configuration choices.
- Treat admitted task IDs as durable results: forward acknowledgements to the overview even when the form has unmounted or its source identity changed. Force disposal to cancel remaining batch admission and active trials, while preserving task IDs already accepted by main.
- Keep this renderer ownership layer separate from the main-process owner and frozen-plan validation. Both are required.

## Avoid

- Do not call every cancellation API unconditionally from each component cleanup.
- Do not trust a mounted Boolean or a plan ID alone as proof that a result still belongs to the current request.
- Do not advance a document identity ref immediately before returning because the form is busy.
- Do not discard accepted task IDs merely because the form is closed or a later document revision arrived.
- Do not carry source-specific authorizations through general draft reuse.

## Validation

Run the focused session/draft suite with the installed runtime, without invoking a package-manager install:

```bash
node node_modules/vitest/vitest.mjs run src/services/subtitle-studio/translation-session.test.ts
```

The 2026-09-18 focused suite passed all 12 tests. It covers late checks, idle peer cleanup, replacement by another instance of the same plan kind, changed library/expired plan rejection, duplicate submission during a delayed library read, accepted task acknowledgement after disposal, partial batches, and revision-bound draft reuse.

For UI changes, also exercise delayed real IPC in isolated Electron: revise a document during checking and verify its deferred reset runs after pending ends; change configuration after a preview and require a fresh plan; navigate away after the first batch admission and verify later admissions stop while accepted tasks remain in the overview. These UI scenarios supplement the focused service tests and must not be claimed from unit coverage alone. Stop only validation-owned services when finished.

## Related files

- `src/services/subtitle-studio/translation-session.ts`
- `src/services/subtitle-studio/translation-draft.ts`
- `src/services/subtitle-studio/translation-session.test.ts`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.tsx`
- `src/services/subtitle-studio/translation-overview-controller.ts`
- `test/translation-knowledge/batch-electron.test.ts`
- `test/translation-knowledge/consumer-ux-electron.test.ts`
- [FK-PIT-0161: explicit material selection](keep-translation-material-opt-in-visible-and-executable.md)
