# FK-PIT-0105: Serialize auxiliary recovery artifact publication

## Area

Subtitle translation / Windows and SMB atomic file publication

## Triggers

`fusionkit.remaining`, `fusionkit.completed`, concurrent slices, `rename`,
`EPERM`, `EBUSY`, `EACCES`, network drive, manual retry succeeds

## Symptoms

- A subtitle translation fragment succeeds, but the task immediately fails while
  renaming a `*.fusionkit.remaining.*.tmp` file.
- The same task continues normally after a manual retry.
- The manifest writer is serialized, yet concurrent workers still publish
  `completed`, `remaining`, or `error.log` files at the same time.
- A human-facing recovery artifact failure overturns otherwise valid model work.

## Root cause

Serializing only the checkpoint manifest does not serialize the complete
recovery publication. Concurrent workers can finish close together, mutate the
shared manifest, and independently run atomic replacements against the same
auxiliary destination. Windows and SMB briefly lock the destination during
those competing renames and can return `EPERM`, `EBUSY`, or `EACCES`.

The auxiliary `completed`, `remaining`, and `error.log` files are conveniences
for inspection or manual recovery; the checkpoint manifest is the machine
recovery authority. Propagating an auxiliary publication error through the
fragment success path therefore turns a recoverable internal filesystem event
into an incorrect terminal task failure.

## Do

- Snapshot recovery content when publication is enqueued so later worker
  mutations cannot change an older queued write.
- Serialize all auxiliary artifact flushes by stable task/checkpoint identity,
  not only the manifest JSON writer.
- Retry only transient file-lock errors (`EPERM`, `EBUSY`, `EACCES`) with a
  bounded exponential delay.
- If a remote rename reports an ambiguous error, accept success only when the
  temporary source disappeared and an exact destination read-back proves the
  intended content committed.
- Keep checkpoint persistence critical, but convert exhausted auxiliary
  artifact writes into warnings so successful translation work can continue.
- Clean each owned temporary file independently without masking the primary
  publication outcome.

## Avoid

- Do not assume a serialized manifest writer also protects sibling recovery
  files.
- Do not let multiple workers call `Promise.all` flushes against the same
  artifact paths without a task-scoped queue.
- Do not retry semantic errors, delete an unknown destination to force a retry,
  or treat destination existence alone as proof that an ambiguous rename won.
- Do not classify a `remaining` or `completed` convenience-file failure as a
  model translation failure.

## Validation

```text
node_modules/.bin/vitest run test/translation/recovery-artifacts.test.ts test/translation/base-translator.test.ts
node_modules/.bin/vitest run test/translation
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Inject transient rename failures and assert bounded retry, exact read-back after
an ambiguous commit, no overlapping rename to the same recovery target, final
latest-snapshot content, temporary-file cleanup, and successful final subtitle
output when only an auxiliary artifact is unavailable.

## Related files

- `electron/main/translation/atomic-file.ts`
- `electron/main/translation/checkpoint.ts`
- `electron/main/translation/recovery-artifacts.ts`
- `electron/main/translation/class/base-translator.ts`
- `test/translation/recovery-artifacts.test.ts`
- `test/translation/base-translator.test.ts`
