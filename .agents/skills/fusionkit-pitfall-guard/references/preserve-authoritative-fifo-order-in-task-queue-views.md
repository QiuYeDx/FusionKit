# FK-PIT-0094: Preserve authoritative order within explicit task queue groups

## Area

Frontend / Electron FIFO task queues

## Triggers

task queue, FIFO, session snapshot, enqueue receipt, optimistic batch, status grouping, active first, completed last, createdAt, UUID, display order

## Symptoms

- Tasks execute in the expected FIFO order, but rows appear shuffled or newest-first.
- Files submitted in one batch share the same timestamp, so a secondary opaque task-ID sort produces a seemingly random order.
- A newly submitted optimistic batch jumps to the top and later moves again when the authoritative snapshot arrives.
- A product-required active-first view is implemented with a generic sort that silently scrambles FIFO order inside each status group.

## Root cause

The main-process session snapshot and queue-specific arrays already carry insertion/FIFO order. Re-sorting those arrays in the renderer by `createdAt` replaces that authority, while opaque UUIDs are identities rather than sequence numbers. A product may still require explicit status grouping, but the grouping priority and the within-group order are separate contracts.

## Do

- Preserve batch order and task order exactly as published by the main-process session.
- Append optimistic enqueue receipts in submission order.
- During reconciliation, keep authoritative live batches first, remove duplicates by stable batch ID, and append only not-yet-observed optimistic batches.
- Flatten batches without another task-level sort.
- When product UX explicitly requires status grouping, concatenate authoritative status queues in the declared priority instead of sorting individual tasks. Preserve each queue's existing order.
- For subtitle AI translation, use `Pending`, `Waiting`, `NotStarted`, `Failed`, `Resolved`: active work first, untouched tasks in the middle, failures above completed history, and completed tasks last.
- If the product needs a separate newest-first history view, model and label it independently from the execution queue.

## Avoid

- Do not infer queue position from UUID/task-ID lexical order.
- Do not use equal-resolution timestamps as a stable within-batch sequence.
- Do not prepend optimistic rows when execution admission is append/FIFO.
- Do not let renderer reconciliation redefine an order owned by the main process.
- Do not use an unstable or timestamp-based comparator to implement status grouping.

## Validation

- Use same-timestamp task fixtures whose IDs have the reverse lexical order from admission order.
- Assert that optimistic-to-live reconciliation neither duplicates nor moves batches.
- Assert that flattened renderer rows match the job manager's FIFO publication order.
- For an explicitly grouped view, assert both the group priority and reverse-lexical-ID fixtures that prove FIFO is preserved inside each group.
- Run:
  - `vitest run src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.test.ts`
  - `vitest run test/local-subtitle/jobManager.test.ts`
  - `vitest run src/pages/Tools/Subtitle/SubtitleTranslator/subtitleTranslatorTaskOrder.test.ts`

## Related files

- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/session-registry.ts`
- `src/services/local-subtitle/localSubtitleSessionReducer.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/index.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.ts`
- `src/pages/Tools/Subtitle/SubtitleTranslator/subtitleTranslatorTaskOrder.ts`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
