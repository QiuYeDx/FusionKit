# FK-PIT-0146: Compare native default save paths with platform path semantics

## Area

Windows / export publication

## Triggers

SaveDialog, drive-letter case, defaultFilePath, indexed output, replacement race

## Symptoms

Studio's native dialog was given C:\...\sample (1).lrc but returned the same default with c:\.... Strict string comparison classified it as an explicit alternate path and selected the replacement publisher. If another export created that default while the dialog was open, the competing file could be overwritten.

## Root cause

path.resolve normalizes syntax, not Windows path case. String inequality is not proof the user chose a different file. This is especially significant when equality chooses indexed no-clobber publication and inequality grants explicit replace behavior.

## Do

- Compare resolved default and selected paths using Windows case-insensitive spelling on win32; retain strict comparison on other platforms.
- Preserve indexed publication from the original unindexed leaf when accepting the default, so a newly occupied suggestion advances to sample (2).lrc without nested suffixes.
- Cover ordinary and original-byte export with real filesystem tests: dialog returns drive-letter case variation after a competing file is created; assert both source and competitor remain unchanged and the next indexed output contains the requested content.
- Keep source-directory output on no-clobber publication independently of SaveDialog.

## Avoid

- Do not assume path.resolve or native dialog output has canonical drive-letter case.
- Do not weaken file identity checks, use renderer-supplied paths, or revise frozen source baselines for this current-composition fix.

## Validation

The two new cases in test/subtitle-studio/ipc.test.ts failed before the fix and passed afterward with all 23 IPC cases. This is an integration-layer correction; update the current integration audit's exact currentBlobOid and concrete reason after source freeze, then rerun the affected provenance guards. Final evidence is indexed in docs/features/subtitle-studio/records/2026-09-12-acceptance-closeout.md.

## Related files

- electron/main/subtitle-studio/index.ts
- test/subtitle-studio/ipc.test.ts
- resources/speech-resources/provenance/current-integration-audits.v1.json
