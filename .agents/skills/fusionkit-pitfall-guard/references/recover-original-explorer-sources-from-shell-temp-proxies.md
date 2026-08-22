# FK-PIT-0099: Recover original Explorer sources from Shell temp proxies

## Area

Electron / Windows Explorer drag / local subtitle source authority.

## Triggers

`DataTransfer.files`, `webUtils.getPathForFile`, Electron 41, Windows Explorer,
long path, `%TEMP%`, numbered input name, subtitle written to Temp, handoff failure.

## Symptoms

- A real Explorer drag is accepted, but the task name unexpectedly gains `(1)` or
  another numeric suffix that is absent from the source file.
- Source-mode subtitle export reports success while no subtitle appears beside the
  original media; the artifact instead exists under `%TEMP%`.
- Preview works because the committed temporary artifact is readable, but a later
  translation handoff can fail against the wrong directory authority.
- File-picker input works because it exposes the original path, while the same
  long-path media behaves differently when dragged.

## Root cause

On Electron 41 / Chromium 140, Windows Shell can materialize a long-path Explorer
drag as a copied backing file under `%TEMP%`. `webUtils.getPathForFile()` truthfully
returns the backing file path, but that path is not the user's source identity. If
main authorizes it directly, Chromium's collision suffix becomes the public task
name and source-output authority is derived from the temporary parent directory.

## Do

- Mark native captures as picker or drop inside the fixed preload bridge and bump
  the bridge version when that request shape changes.
- For a Windows drop whose backing path is inside the canonical temp directory,
  query the still-selected Explorer Shell items in main and require one unique
  mapping by batch cardinality, original/numbered leaf rule, extension, and size.
- Authorize only the recovered original paths. Let the normal input capability
  inspection pin file and parent-directory identity before enqueue and export.
- Fail closed with a drop-specific authorization error when the Explorer selection
  cannot be uniquely proven; never silently publish source-mode output to Temp.
- Keep visible-queue duplicate detection keyed by canonical source identity.
  Treat output `index` / `overwrite` policy separately and apply it only when the
  final subtitle leaf already exists in the authorized output directory.
- Preserve concrete handoff failures such as `artifact_changed`,
  `output_write_failed`, and `invalid_ipc_request` instead of collapsing them into
  `invalid_content`.

## Avoid

- Do not treat a non-empty `getPathForFile()` result as proof that it is the
  original Explorer source.
- Do not strip `(1)` heuristically from every input filename; it may be part of the
  real source name and does not recover source-directory authority.
- Do not use task-list membership or output conflict policy to rename input tasks.
- Do not accept a renderer-provided raw path or expose the recovered path back to
  renderer state.
- Do not validate this case only with synthetic CDP drag events or short paths.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/windowsExplorerDropResolver.test.ts \
  test/local-subtitle/preloadApi.test.ts \
  test/local-subtitle/ipc.test.ts \
  test/local-subtitle/jobManager.test.ts \
  test/local-subtitle/subtitleExporter.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

Also perform one real Explorer drag of media whose source path is long enough to
produce a `%TEMP%` proxy. Verify that the draft/task name is the original leaf, the
subtitle is written beside the original media, and translation handoff uses that
artifact. Re-adding the same visible source must be rejected; removing it must make
the source admissible again.

## Related files

- `src/pages/Tools/_shared/ui/ToolFileDropZone.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/index.tsx`
- `electron/preload/local-subtitle-api.ts`
- `electron/main/local-subtitle/windows-explorer-drop-resolver.ts`
- `electron/main/local-subtitle/ipc.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/translation/ipc.ts`
- `test/local-subtitle/windowsExplorerDropResolver.test.ts`
