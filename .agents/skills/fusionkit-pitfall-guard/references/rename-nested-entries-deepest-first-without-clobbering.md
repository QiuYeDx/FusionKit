# FK-PIT-0185: Rename nested entries deepest-first without clobbering

## Area

Node / batch filesystem rename (name translator, any batch rename).

## Triggers

rename folder and children, `fs.rename` overwrite, prefix rewrite, temp name residue, swap, case-only rename, rollback.

## Symptoms

- Renaming a folder and its children in one batch fails, or children are renamed at stale paths.
- After a failure, entries remain on disk as hidden `.something.tmp` names.
- An existing file silently disappears: `fs.rename` replaced it.

## Root cause

A parent rename changes every descendant path, so parent-first execution needs fragile prefix rewriting. `fs.rename` overwrites an existing file on both Windows and POSIX. Two-phase "everything through a temp name" without automatic reversal leaves temp names behind when a later step fails.

## Do

- Group renames by real parent directory and run groups in descending parent depth. Each step then uses an original path that is still valid; no prefix rewriting is needed.
- Within a group, use unique temporary names only when a target reuses a name currently held by a source in that group (chains, swaps, case-only changes on case-insensitive filesystems).
- `lstat` the target immediately before every rename and abort if it exists.
- Append each completed step to a journal (JSONL, O(n)); on failure, reverse completed steps in reverse order; record `undone` per step so undo/recovery can resume.
- Compute targets in the main process from source path + validated basename; resolve conflicts against a real `readdir` of the parent, iterating to a fixpoint because entries that drop out keep their names.

## Avoid

- Do not trust renderer-computed target paths.
- Do not let one invalid item block the whole batch; skip it explicitly.
- Do not place Electron drop fixtures in `%TEMP%`: drops from there are treated as Explorer proxies (FK-PIT-0099).

## Validation

```text
node_modules/.bin/vitest run test/name-translation
FUSIONKIT_NAME_TRANSLATOR_E2E=1 node_modules/.bin/vitest run test/name-translation/name-translator.electron.test.ts
```

## Related files

- `electron/main/name-translation/planner.ts`
- `electron/main/name-translation/executor.ts`
- `electron/main/name-translation/journal.ts`
- `test/name-translation/executor.test.ts`
