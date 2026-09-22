# FK-PIT-0170: Freeze batch cleanup confirmations before list refresh

## Area
Subtitle Studio / destructive batch UI / unavailable document recovery

## Triggers
Batch delete, clear selected, unavailable documents, partial failure, refreshed token, one confirmation.

## Symptoms
A refreshed list silently expands a confirmed deletion, one failed item blocks healthy siblings, or a failure marker disappears when its authorization token changes.

## Root cause
Live selection was confused with the frozen confirmation target; diagnostic identity was confused with authorization identity.

## Do
- Freeze the exact selected IDs and tokens when opening confirmation. Reuse main-process per-item checks; new or changed items require fresh authorization.
- Guard repeated clicks synchronously, report per-item progress, continue after individual failures, and retain unsuccessful rows.
- Keep selection/authorization keyed by ID+token but failure labels keyed by stable document ID.
- Put confirmation and aggregate results in a visible fixed footer. Focus cancel before deletion and a surviving action after completion.
- Test with real unavailable documents, one stale token, a newly discovered document and a healthy document; verify originals/exports remain untouched.

## Avoid
Do not rerun the batch over the latest full list after confirmation, drop all error feedback on refresh, or replace token validation with raw path deletion.

## Validation
`FUSIONKIT_STUDIO_E2E=1` with `test/subtitle-studio/recovery-batch-ui.test.ts`; repository and IPC regressions; TypeScript/i18n; wide light and narrow dark rendered review.

## Related files
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioRecovery.tsx`
- `electron/main/subtitle-studio/document-repository.ts`
- `test/subtitle-studio/recovery-batch-ui.test.ts`
