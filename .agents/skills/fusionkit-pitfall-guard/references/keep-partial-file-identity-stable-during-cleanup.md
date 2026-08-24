# FK-PIT-0045: Keep partial-file identity stable during cleanup

## Area

Node atomic artifact writes, cancellation, and owned-file cleanup.

## Triggers

partial write, cancellation, multi-chunk write, size, file identity, unlink
failure, `cancel_failed`

## Symptoms

- Cancelling a write after its first chunk leaves an owned `.partial` behind.
- Cleanup refuses to remove the file because its current size differs from the
  size captured immediately after creation.
- An unlink failure is swallowed and the operation incorrectly reports
  `cancelled` or activates a final artifact.

## Root cause

File size is mutable content metadata, not stable object identity. If `{ dev,
ino, size }` is captured when an exclusive partial is empty, any later write
makes the ownership comparison fail. Treating identity mismatch or unlink
failure as best-effort cleanup then hides the leak and can violate terminal
state or artifact activation contracts.

## Do

- Bind ownership to stable fields such as device, inode, and birth time.
- Validate expected size separately before parsing, hashing, or committing
  content.
- Treat missing paths as already cleaned, but surface identity mismatch and
  other unlink failures without deleting an unproven replacement.
- Let explicit `cancel_failed` take precedence over an aborted signal.
- If hard-link detach fails after no-clobber commit, synchronously roll back the
  new final link where its identity still matches, revoke the reservation, and
  only then clean the partial.

## Avoid

- Do not put mutable size, mtime, or ctime into an in-progress partial's stable
  ownership proof.
- Do not silently return on identity mismatch or non-`ENOENT` unlink errors.
- Do not activate a Registry ref after required partial cleanup failed.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/subtitleExporter.test.ts src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

Cover cancellation after at least one MiB has been written, pre-commit unlink
failure, post-hard-link detach failure, final-link rollback, and terminal/schema
handling of `cancel_failed`.

## Related files

- `electron/main/local-subtitle/subtitle-exporter.ts`
- `src/type/localSubtitle.ts`
- `src/type/localSubtitleIpc.ts`
- `test/local-subtitle/subtitleExporter.test.ts`
- `src/type/localSubtitle.test.ts`
- `src/type/localSubtitleIpc.test.ts`
