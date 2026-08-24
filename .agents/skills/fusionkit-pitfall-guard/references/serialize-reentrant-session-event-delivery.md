# FK-PIT-0050: Serialize reentrant session event delivery

## Area

Electron main-process session registries and shared revision event streams.

## Triggers

shared revision, task event, resource event, synchronous listener, reentrant
mutation, staged batch publication, owner release, out-of-order delivery

## Symptoms

- Listener A handles revision N and synchronously mutates the registry, causing
  revision N+1 to reach listener B before listener B receives revision N.
- A multi-entity publication delivers revision 1, a nested later revision, and
  then revision 2.
- Releasing an owner from one listener still delivers queued events to other
  listeners captured before the release.
- Authoritative state remains correct while renderer reconciliation repeatedly
  detects false revision gaps.

## Root cause

Calling listeners directly from each mutation makes delivery reentrant. A simple
draining guard is insufficient for a batch when only the first envelope has been
queued: nested mutations can append after revision 1 but before revision 2 is
added. Task and resource channels also cannot use independent queues when they
share one authoritative revision cursor.

## Do

- Maintain one FIFO delivery queue and one draining guard per owner session.
- Enqueue every envelope in a staged batch publication before starting the drain.
- Put task and resource envelopes in the same queue when they share a revision.
- During listener iteration, confirm that the session is still authoritative and
  that the listener remains subscribed.
- On owner release or shutdown, clear listeners and undelivered queue entries.
- Catch listener failures without rolling back authoritative state, and absorb
  rejected thenables when listener contracts are synchronous.
- Test cross-channel reentry, multi-envelope batches, unsubscribe, and owner
  release from inside a listener.

## Avoid

- Do not call task or resource listeners inline from each mutation independently.
- Do not add only a boolean reentry guard while enqueueing batch envelopes one at
  a time.
- Do not continue iterating a stale listener snapshot after the owner session was
  released.
- Do not give task and resource channels separate delivery ordering when their
  envelopes use one revision sequence.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/sessionRegistry.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Require every observer to see monotonically increasing revisions during a
listener-triggered nested mutation. For a two-task staged publication, revisions
1 and 2 must be delivered before the nested revision 3. Owner release during
revision 1 must prevent remaining listeners and queued envelopes from firing.

## Related files

- `electron/main/local-subtitle/session-registry.ts`
- `test/local-subtitle/sessionRegistry.test.ts`
- `src/services/local-subtitle/localSubtitleRuntimeService.ts`
