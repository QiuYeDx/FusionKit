# FK-PIT-0037: Preserve buffered entity observations during snapshot reconciliation

## Area

Frontend state / revision reconciliation

## Triggers

subscribe-before-snapshot, buffered event, authoritative snapshot, shared revision,
entity omitted from snapshot, task generation, tombstone, late event, resurrection

## Symptoms

- A listener observes a task or resource update while the initial snapshot is pending.
  The newer snapshot omits that entity, replay drops the covered event as stale, and a
  later event for the same task generation or resource id unexpectedly resurrects it.
- Treating every snapshot omission as deletion suppresses an entity whose first event
  occurred after the snapshot revision.
- Buffer compaction or overflow preserves the revision floor but loses the identity and
  generation needed to reject late events safely.
- Task and resource channels appear individually ordered but disagree because they use
  separate revision cursors for one authoritative session.

## Root cause

Subscribing before reading the snapshot closes the event-loss window but creates an
overlap window. A snapshot at revision R authoritatively covers events through R. When
an entity was observed at revision E <= R but is absent from that snapshot, the absence
means the entity was removed or superseded. After the snapshot is installed, replaying E
is correctly ignored as stale, so the buffered envelope may be the only remaining
evidence needed to establish its tombstone.

The opposite case is equally important: if E > R, the snapshot says nothing about that
entity and its absence must not create a tombstone. Payload buffering alone is
insufficient when events are deduplicated, covered by a snapshot, or discarded during
bounded overflow. Reconciliation therefore needs revision-scoped identity observations
that survive independently of the replay queue.

## Do

- Register every session event listener before requesting the initial snapshot.
- Use one revision cursor for all channels emitted by the same authoritative session.
- While synchronization is pending, retain both event payloads and compact observations:
  task identity includes `batchId`, `taskId`, generation and first/removal revision;
  resource identity includes `jobId` and first/removal revision.
- Before merging a snapshot, apply only observations whose first revision is less than
  or equal to the snapshot revision.
- For a covered task absent from the snapshot, retain its maximum observed generation
  and establish a generation-scoped tombstone. For a covered resource absence, establish
  the resource-id tombstone. A covered explicit removal has the same effect.
- Do not tombstone observations first seen after the snapshot; replay those events after
  the snapshot merge in revision order.
- Preserve observations across rejected/stale snapshot attempts and event-buffer
  overflow. Raise the minimum acceptable snapshot revision to cover discarded events.
- Clear observations only after an authoritative snapshot merge and buffered replay
  reach a consistent revision.
- Test task and resource identities separately, including covered omission, uncovered
  addition, snapshot-covered duplicate, higher task generation, overflow and
  cross-channel gaps.

## Avoid

- Do not infer reconciliation solely from entities already present in renderer state;
  bootstrap state may be empty when the only identity evidence is buffered.
- Do not interpret snapshot absence as deletion without proving the snapshot covers the
  entity observation.
- Do not discard identity metadata merely because the corresponding payload event is
  stale, deduplicated or removed from a bounded queue.
- Do not key task observations by `taskId` alone or omit generation.
- Do not let task and resource channels advance independent revision watermarks when
  main assigns one session-wide revision sequence.

## Validation

```text
node_modules/.bin/vitest run src/services/local-subtitle/localSubtitleRuntimeService.test.ts src/services/local-subtitle/localSubtitleSessionReducer.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

Confirm that a covered missing task/resource cannot be revived by a later event with the
same identity, an event newer than the snapshot remains replayable, a higher task
generation can supersede its generation tombstone, and overflow cannot lower the
required snapshot revision or erase covered identity evidence.

## Related files

- `src/services/local-subtitle/localSubtitleRuntimeService.ts`
- `src/services/local-subtitle/localSubtitleRuntimeService.test.ts`
- `src/services/local-subtitle/localSubtitleSessionReducer.ts`
- `src/services/local-subtitle/localSubtitleSessionReducer.test.ts`
- `src/type/localSubtitle.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
