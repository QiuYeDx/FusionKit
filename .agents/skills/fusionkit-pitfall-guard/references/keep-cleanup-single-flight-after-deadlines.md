# FK-PIT-0142: Keep cleanup single-flight after caller deadlines

## Area

Real ASR acceptance / isolated resource managers and cleanup ownership.

## Triggers

`Promise.race`, cleanup deadline, timed-out uninstall, pending native work, retryable shutdown, observer teardown.

## Symptoms

A bounded cleanup call times out, clears its cached Promise, and permits a retry while the first deletion or shutdown still runs. Alternatively, replacing the race with an unconditional await silently removes the caller deadline. Both errors can hide an active inference process or allow two managers to mutate the same isolated root.

## Root cause

A caller's waiting budget and the lifetime of the underlying operation are different facts. Rejecting the caller does not cancel filesystem work or join native cleanup; removing the timeout does not make cleanup bounded.

## Do

- Retain the actual cleanup operation and its ownership lock until it truly settles. A caller deadline must not open a second cleanup attempt.
- Return an explicit bounded failure with `cleanupPending` / `joined` evidence. Allow an explicit retry only after the previous operation has actually settled.
- Stop subsequent inference scenarios when a previous chain has not joined. Do not uninstall resources while that chain may still use them.
- Bound observer teardown too, restore original methods in finally, and preserve the production error together with cleanup failures.
- Use production uninstall APIs first. Verify the entire owned tree contains only empty directories before removing those directories; never recursively erase leftovers to manufacture successful uninstall evidence.

## Avoid

- Do not clear a single-flight Promise merely because its timeout wrapper rejected.
- Do not replace a bounded wait with an unlimited await and keep claiming the same time budget.
- Do not equate an elapsed timer, rejected Promise, or missing UI task with a stopped native process.

## Validation

The T08 resource fixture unit test holds the actual cleanup Promise unresolved past its deadline: a repeated call must reuse the same result and must not start a second operation. After real settlement, an explicit retry is permitted. This controlled unit evidence does not claim a native process timeout occurred in the real matrix.

## Related files

- `test/subtitle-studio-provenance/real-default-resource-fixture.ts`
- `test/subtitle-studio-provenance/real-default-resource-fixture.test.ts`
- `test/subtitle-studio-provenance/real-default-comparison-harness.ts`
- `docs/features/subtitle-studio/modules/module-transcription/design.md`
