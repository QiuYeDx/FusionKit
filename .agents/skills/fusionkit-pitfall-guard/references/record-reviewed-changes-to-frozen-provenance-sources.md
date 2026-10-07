# Record reviewed changes to frozen provenance sources

- **ID:** FK-PIT-0186
- **Area:** Subtitle Studio provenance / maintenance
- **Triggers:** Worktree drift, Changed source, Changed audited composition source, Extraction source worktree changed, Destination content differs, provenance replay, local-subtitle fix, electron/main/index.ts, package.json, vite.config.ts

## Symptoms

`test/subtitle-studio-provenance/**` fails after an ordinary product change: replay suites fail to load with `Worktree drift`, shared-resource extraction reports `Extraction source worktree changed`, or the transcript-executor replay reports `Destination content differs`. The change itself is correct and unrelated tests pass.

## Root cause

Subtitle Studio's transcription copy and the shared speech-resource extraction are pinned to historical Git blobs. The checks also compare the current worktree so that any later edit to a frozen source (the classic local transcriber, its tests, application entry points, `package.json`, `vite.config.ts`) or to a reviewed copy is noticed and reviewed. Without a recorded review the suites stay red for every later commit and hide genuine regressions.

## Do

- Run `pnpm vitest run test/subtitle-studio-provenance` after touching classic local-subtitle sources, `test/local-subtitle/`, app entry points or build configuration.
- Review the change against the frozen copy: decide whether Studio needs an equivalent change (usually in its own executor, not the frozen native copy).
- Record the review for the exact current bytes:
  - frozen sources: `scripts/subtitle-studio-provenance/current-source-audits.json` (`sourcePath`, `frozenBlobOid`, `currentBlobOid` = `git hash-object --path=<p> -- <p>`, reason with commit);
  - application entry points: `current-composition-audits.json` and `resources/speech-resources/provenance/current-integration-audits.v1.json` (`currentBlobOid` plus an appended dated reason);
  - edited Studio copies: `current-copy-audits.json` (add the destination to `CURRENT_COPY_AUDIT_OWNERS` with its owning provenance record).
- Keep intended behaviour differences explicit in the replay fixtures (for example `derivedStatus`) and still compare every other observable.
- Put new shared test helpers outside frozen roots (for example `test/support/`); a new file under `test/local-subtitle/` is reported as an added selected source.

## Avoid

- Re-pinning a frozen baseline, extraction manifest or copy recipe to make the drift disappear.
- Feeding current worktree bytes into reconstruction or replay fixtures; use the frozen Git blobs.
- Recording an approval before reviewing the diff, or reusing one approval for later edits.

## Validation

```bash
pnpm vitest run test/subtitle-studio-provenance
```

## Related files

- `scripts/subtitle-studio-provenance/source-change-audits.mjs`
- `scripts/subtitle-studio-provenance/copy.mjs`
- `scripts/subtitle-studio-provenance/shared-resource-extraction.mjs`
- `scripts/subtitle-studio-provenance/current-copy-audits.mjs`
- `test/subtitle-studio-provenance/transcript-executor-replay.test.ts`
