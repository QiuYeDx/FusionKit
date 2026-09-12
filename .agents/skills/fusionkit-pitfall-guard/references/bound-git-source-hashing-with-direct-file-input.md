# FK-PIT-0133: Bound Git source hashing with direct file input

## Area

Provenance maintenance / Node child processes / macOS.

## Triggers

spawnSync, Git hash-object, stdin, worktree drift check, stalled validation.

## Symptoms

Source verification stops producing output while the same Git hash-object child remains active for minutes. This occurred in two independent Node checks; hashing the same 42 KiB file with a bounded Python subprocess finished in milliseconds.

## Root cause

The observed stall was in the synchronous Node/Git stdin path, not in hashing the source or finding a worktree difference. Retrying the whole unbounded check created a second stalled process. The lower-level host cause was not established.

## Do

- Inspect the specific parent and child processes before assuming a slow scan or source drift. Terminate only the task-owned stalled pair.
- For worktree hashing, pass the already checked regular source file to Git directly, retain its repository-relative path for attribute normalization, and set a bounded child timeout.
- Continue to reject symlinks and external clean filters before hashing. Git must retain responsibility for canonical CRLF and encoding behavior.
- Verify large input, CRLF normalization, source changes, and clean-filter rejection in an isolated repository.

## Avoid

- Do not equate a timeout with changed source, silently skip the file, or hash raw worktree bytes when the contract uses Git-normalized content.
- Do not keep launching duplicate unbounded checks or leave stalled validation children behind.

## Validation

Run `test/subtitle-studio-provenance/copy.test.ts` and `node scripts/subtitle-studio-provenance/copy.mjs --check`. The copy verifier reads all registered sources without stdin and times out each Git read after ten seconds. The T01 frozen generator remains unchanged.

## Related files

- `scripts/subtitle-studio-provenance/copy.mjs`
- `test/subtitle-studio-provenance/copy.test.ts`
- `docs/features/subtitle-studio/records/2026-09-11-transcription-copy-replay.md`
