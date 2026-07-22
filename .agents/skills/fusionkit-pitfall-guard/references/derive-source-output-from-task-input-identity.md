# FK-PIT-0055: Derive source output from task input identity

## Area

Electron source-output authorization, local subtitle batches, and filesystem identity.

## Triggers

source output, derive_source_output, parent directory, multi-parent, raw path,
symlink, junction, hard link, parent replacement, retry

## Symptoms

- Source output is modeled as one batch directory lease, so files from different
  parents write into the wrong directory or cannot share one batch.
- A renderer path, display label, or stale path captured at enqueue becomes write
  authority without proving that it still belongs to the authorized input.
- Replacing a parent directory preserves a hard-linked file identity but redirects
  subtitle writes into a different directory object.
- One unavailable source parent fences every sibling instead of failing one task.

## Root cause

The UI output mode was treated as a directory capability. In source mode there is
no user-selected batch directory: each task may have a different parent, and write
authority must be derived privately from that task's still-valid input capability.
File identity alone is insufficient because the same inode can appear under a
replacement parent through a hard link.

## Do

- Require both `transcribe` and `derive_source_output` on source input drafts before
  committing the batch, while keeping the resulting authority task-scoped.
- In main, resolve the committed task lease with exact owner, task, token, operation,
  and TTL checks. Derive the parent only from the canonical authorized file path.
- Pin the canonical parent relationship and directory object identity when the input
  is authorized for `derive_source_output`. Every later resolution must match that
  proof; lease renewal may change only expiry, never the authorized directory object.
- Keep filesystem structural proof separate from public label validation. A legal
  canonical parent basename that is unsafe as renderer text must not make a safe
  input file fail authorization or block transcribe/custom-output use.
- Validate in file -> parent -> file/parent order. Compare canonical containment and
  the directory object's `dev` / `ino` / `birthtimeMs`, including after realpath.
- Fail fast before media normalization so an invalid parent does not acquire a model
  pin. Discard the resolved raw path, retain only an opaque main-only parent identity,
  and resolve again against the pinned proof at every exporter write boundary.
- Keep parent failures task-scoped. A sibling in another parent and a later retry
  must perform their own resolution.
- Preserve stable error semantics: input identity changes remain
  `media_changed/preparing_media`; directory availability or identity failures are
  task-scoped `output_write_failed/exporting`; TTL failures remain
  `authorization_expired/preflight`.
- If an executor already returned one of those failures, a terminal capability
  renewal failure must not replace the more specific execution error.
- Return only existing main-private resolved-directory objects. Public snapshots,
  events, logs, and IPC results keep paths and capability tokens out.

## Avoid

- Do not accept a renderer-supplied source parent or derive one from `displayName`.
- Do not reuse an output-picker inspector for source parent proof when that inspector
  requires the directory basename to pass public `displayName` sanitization.
- Do not mint a fake global output token or batch lease for source mode.
- Do not cache a resolved raw path as write authority. Do retain the pinned parent
  object proof across preflight and export; accepting a fresh identity is a redirect.
- Do not treat exact file identity as proof that its current parent directory is the
  originally inspected directory object.
- Do not turn one `output_write_failed` source parent into a batch/session fence.
- Do not collapse `media_changed`, `output_write_failed`, and
  `authorization_expired` into whichever stage happened to call the resolver.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/authorizations.test.ts \
  test/local-subtitle/jobManager.test.ts \
  test/local-subtitle/jobManagerIpc.test.ts \
  test/local-subtitle/productionExecutor.test.ts \
  test/local-subtitle/subtitleExporter.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover different parents with the same source leaf, one failed parent with a healthy
sibling, missing operations, owner/task/token/TTL mismatch, canonical aliases,
symlink/junction and hard-link parent replacement before preflight and before export,
repair followed by retry, exact final file recheck, preserved `media_changed`, and
terminal renewal precedence, plus absence of raw paths in public state. On platforms
that allow it, also cover a safe file inside a structurally valid parent whose basename
is invalid as a public label; authorization and transcribe/custom output must remain
available without exposing that basename.

## Related files

- `electron/main/local-subtitle/authorizations.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `electron/main/local-subtitle/subtitle-exporter.ts`
- `electron/main/index.ts`
- `test/local-subtitle/authorizations.test.ts`
- `test/local-subtitle/jobManager.test.ts`
- `test/local-subtitle/jobManagerIpc.test.ts`
- `test/local-subtitle/productionExecutor.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
