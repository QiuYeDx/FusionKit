# FK-PIT-0077: Throttle streaming progress before Electron IPC

## Area

Electron / streaming progress

## Triggers

large download,progress event flood,cancel spinner,bytes keep increasing,IPC backlog

## Symptoms

Publishing every network chunk can queue thousands of stale progress events ahead of cancellation and make an already abortable transport look unstoppable.

## Root cause

Node response streams commonly expose small chunks. Publishing one revisioned
ResourceJob update and one Electron event per chunk turns a large model into
tens of thousands of IPC messages. The renderer can keep rendering already
queued progress after the user clicks cancel, while the cancel invocation
waits behind the same traffic. This makes UI bytes continue increasing even
when the download transport itself has an abort path.

## Do

- Coalesce progress before it enters SessionRegistry or Electron IPC.
- Publish the initial value, updates at a bounded time frequency, and the exact
  final value.
- Check cancellation again after an awaited write and before publishing
  progress.
- Keep cancellation and terminal state events unthrottled.

## Avoid

- Do not emit progress for every network, filesystem, or decoder chunk.
- Do not use renderer debouncing as the only protection; it leaves the main to
  serialize and enqueue every stale event.
- Do not infer a live download solely from old progress events still arriving
  after a cancel click.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/resourceDownload.test.ts test/local-subtitle/modelManager.test.ts test/local-subtitle/modelManagerIpc.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Feed hundreds of immediately available chunks and assert only the initial and
final progress callbacks are published inside one throttle interval. Also
retain the public IPC cancellation test and verify the job reaches
`cancelled`.

## Related files

- `electron/main/local-subtitle/resource-download.ts`
- `electron/main/local-subtitle/resource-job.ts`
- `electron/main/local-subtitle/session-registry.ts`
- `electron/main/local-subtitle/session-ipc.ts`
- `test/local-subtitle/resourceDownload.test.ts`
