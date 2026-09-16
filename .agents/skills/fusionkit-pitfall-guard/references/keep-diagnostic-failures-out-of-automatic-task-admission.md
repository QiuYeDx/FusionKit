# FK-PIT-0160: Keep diagnostic failures out of automatic task admission

## Area

Subtitle automatic translation / diagnostics

## Triggers

preparation report, fallback, lone surrogate, JCS, pending intent, automatic initialization

## Symptoms

A failed report builder can fail again in an error-only retry; diagnostic failures must not prevent saving source subtitles and a failed automatic task.

## Root cause

An automatic plan can correctly reject damaged frozen knowledge while the outer durable intent remains readable. Its optional diagnostic builder hashes the same data with strict canonical JSON. A lone UTF-16 surrogate can pass a general string schema but fail canonicalization. Retrying the builder without issue details still hashes the invalid material/configuration and fails again, leaving the intent pending instead of publishing the visible failure.

## Do

- Publish the failed task and retain the source independently of diagnostic enrichment. Try a bounded generic report when detailed report generation fails; if that also fails, retain the task without a report and expose the explicit legacy/unavailable state.
- Keep report admission validation strict and historical report reads tolerant, following FK-PIT-0156. A nonfatal report fallback is not permission to write malformed reports.
- Validate reusable choices separately. Unreadable or noncanonical selections/configuration produce no seed; never silently repair them or fall back to ordinary translation.
- Route historical inspection before translation initialization, preserving owner authorization and post-read liveness checks.
- Bound issue excerpts and UTF-8 bytes before final hashing. Hash the retained report once, not once for every removed issue.

## Avoid

- Do not call the same failing report builder as an unguarded final fallback.
- Do not let a report error reject the entire transaction that publishes the source and failed task.
- Do not recompile current knowledge when displaying historical failure details, or label current source text as an old excerpt.

## Validation

Use isolated repositories with checksum-valid snapshots containing lone surrogates in frozen material and configuration. Initialization must save one failed task, preserve source/intent, return no reusable seed and make no provider request. Also cover unknown versions, damaged digests, immutable reports, original excerpts after source changes, task-row cleanup, strict new writes and bounded multibyte reports. Spy on initialization and live-library reads through the production IPC handler; repeated native reads must leave stored document bytes unchanged.

## Related files

- `electron/main/subtitle-studio/automatic-knowledge-report.ts`
- `electron/main/subtitle-studio/translation-service.ts`
- `electron/main/subtitle-studio/document-repository.ts`
- `electron/main/subtitle-studio/index.ts`
- `test/translation-knowledge/automatic-service.test.ts`
- `test/subtitle-studio/ipc.test.ts`
- `test/translation-knowledge/automatic-electron.test.ts`
