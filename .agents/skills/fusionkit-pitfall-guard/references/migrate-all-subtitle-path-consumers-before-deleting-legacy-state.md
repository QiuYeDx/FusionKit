# FK-PIT-0022: Migrate all subtitle path consumers before deleting legacy state

## Area

Subtitle translation state / Zustand persistence / Electron capability migration.

## Triggers

`outputURL`, `originFileURL`, `targetFileURL`, `checkpointPath`, task refs,
directory capability, Agent subtitle tools, recovery scanning, legacy adapter,
cross-key migration.

## Symptoms

- The SubtitleTranslator page works with a new directory capability, but Agent
  recovery scanning can no longer find its current output directory.
- A work package deletes persisted `outputURL` after the page cutover while
  `src/agent/tool-executor.ts`, RecoveryDialog, renderer events, or Electron
  translation recovery still read raw paths.
- Generated tasks are path-free, but a permissive legacy task branch lets the
  renderer recreate the same operation with raw `originFileURL` or
  `targetFileURL` fields.
- A migration writes the new Store successfully, deletes the old key, and then
  discovers that an already-hydrated or less-visible consumer was never moved.

## Root cause

A shared persisted path is treated as a page-owned field even though it is an
implicit cross-module API. In FusionKit, subtitle task creation, Agent tools,
recovery discovery, renderer event handlers, and Electron main translation
code all consume parts of the legacy path contract. Tying destructive cleanup
to the first visible page cutover creates a period where the repository is not
runnable and makes rollback incomplete.

## Do

- Inventory every producer and consumer before designing the cutover. Search
  renderer, Store, Agent, preload, Electron main, tests, and recovery schemas.
- Split the migration into completion-safe packages: introduce ref/capability
  types and a versioned legacy adapter; migrate ordinary and Agent new-task
  producers; migrate checkpoint/recovery consumers and events; only then
  remove the persisted path.
- Keep the source value until the target write, readback, both Store import
  orders, same-session live-state synchronization, and rollback tests pass.
- Give the legacy branch an explicit discriminant such as `legacy_path_v1`.
  Reject main-registered generated task IDs from that branch, and close it to
  all new-task producers before final cleanup.
- Keep historical v1 recovery path reads in a main-only compatibility reader;
  return opaque refs and redacted summaries to renderer and Agent consumers.
- Make each intermediate work package preserve existing manual, Agent, and
  recovery behavior. A later package is not an acceptable excuse for a broken
  intermediate repository state.

## Avoid

- Do not delete `outputURL` merely because the SubtitleTranslator page uses a
  new picker.
- Do not limit the consumer inventory to `src/pages` and the primary Zustand
  Store.
- Do not convert a legacy raw path into a new capability without a fresh,
  fixed user authorization flow.
- Do not let generated tasks fall back to legacy path fields to fit existing
  `SubtitleTranslatorTask` or checkpoint shapes.
- Do not mark the migration complete after persistent readback while a live,
  already-hydrated Store still exposes stale state.

## Validation

```text
rg -n 'outputURL|originFileURL|targetFileURL|checkpointPath' src electron test
node_modules/.bin/vitest run src/store/tools/subtitle src/services/subtitle src/agent test/translation
node_modules/.bin/tsc --noEmit
git diff --check
```

Test both Store import orders, target write/readback failure, same-session
retry, page and Agent task creation, RecoveryDialog and Agent recovery scans,
renderer progress/failure/resolved events, historical v1 recovery, generated
task rejection by the legacy branch, and rollback before removing the source
key.

## Related files

- `src/store/tools/subtitle/useSubtitleTranslatorStore.ts`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `src/pages/Tools/Subtitle/SubtitleTranslator/components/RecoveryDialog.tsx`
- `src/agent/tool-executor.ts`
- `src/agent/recovery-batch.ts`
- `src/renderer/subtitle.ts`
- `electron/main/translation/`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
