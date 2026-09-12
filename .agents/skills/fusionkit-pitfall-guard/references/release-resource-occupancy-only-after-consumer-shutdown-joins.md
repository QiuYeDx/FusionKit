# FK-PIT-0144: Release shared resource occupancy only after complete consumer shutdown joins

## Area

Application resource ownership / legacy and Studio consumer shutdown.

## Triggers

Shared model/VAD/CUDA resources, completed tasks become fenced, permanent resource_busy, Application runtime cleanup failed, quiesced, shutdown join.

## Symptoms

All four real T09 transcription chains reach completed, but application cleanup fails and shared-resource uninstall remains blocked. The shared manager still sees its legacy consumer as busy even though the task records represented completed work before shutdown.

## Root cause

The legacy JobManager's shutdown fences every non-removed task record, including terminal records. Its model, VAD and accelerator busy queries exclude only terminal and removed records. A completed record therefore becomes busy again when shutdown changes its internal state to fenced. That state prevents further task access; it is not a reliable indication that native work still owns resource files.

Resource occupancy and consumer lifecycle must be composed explicitly. Checking an empty UI queue, task completion, a shutdown-start flag or fenced records cannot prove that server processes, media operations, leases and failed cleanup have joined. Conversely, continuing to consult historical fenced records after a successful complete shutdown can hold a shared resource forever.

## Do

- Keep an application-level consumer quiesced flag false through the whole production runtime shutdown operation. Set it only after that operation resolves successfully, including task, server and media cleanup joins.
- Make the shared service's busy callback return false for a consumer only after this successful lifecycle join. Preserve the original task/native busy checks while the consumer is active or closing.
- On shutdown rejection or timeout, keep the consumer unquiesced and preserve resource ownership. Only a later successful retry can release it.
- For Studio, use the runtime's confirmed closed phase for the same guard. A terminal/fenced/closing flag is not equivalent to closed.
- Fence new admissions synchronously, join both business consumers, then join the dedicated resource smoke server, and only then close the shared resource service. Preserve primary and cleanup failures in the report.
- Keep the correction in application composition/adapters when legacy task code is a frozen source. Do not alter old task-state semantics to fit a new shared-resource owner.

## Avoid

- Do not globally exclude every fenced record from busy checks: a fenced task may still have native work or cleanup in flight.
- Do not clear busy, release consumer registrations or remove resource files in a finally block that also runs after failed shutdown.
- Do not equate completed transcription with successful application cleanup, durable document reopen or confirmed process exit.
- Do not recursively erase resource roots to make the cleanup result appear successful.

## Validation

Confirmed first failure: test-results/studio-t09/real-shared-Idlbo2/report.json (SHA-256 4513b27a67319a73a1c2de5cfaecc0f846901dfdc130e881bb5fb1081c8d02dc). The cpu-legacy-A, cpu-studio-A, cuda-legacy-A and cuda-studio-A chains all report completed. The overall report is failed with AggregateError / Application runtime cleanup failed. Cleanup joined, rootRemoved and serverDisposed are false; these incomplete cleanup fields must not be presented as successful exit evidence.

The correction uses electron/main/app-shutdown.ts#createResourceConsumerLifecycle in main and the real-comparison harness, with Studio's confirmed closed-phase guard. The focused test test/speech-resources/integration/consumer-shutdown.test.ts runs the actual legacy JobManager through enqueue, completed and shutdown/fenced states with a synthetic executor, then rejects later media cleanup. It confirms that raw busy stays true, shared shutdown remains blocked after failure, and only a successful complete consumer retry retires the wrapper's occupancy. This controlled regression starts no real inference server. Existing application shutdown ordering tests also hold pending consumer joins and retain shared resources when a consumer or smoke server fails.

Final post-fix real acceptance: test-results/studio-t09/real-shared-sMRxt5/report.json (SHA-256 3de15611a6684cc67d9fdb4a086da66f0efa14a3d04c45028bf2e3890d8407b7). All four CPU/CUDA legacy/Studio chains are completed. Its shutdownTargets explicitly mark legacy-consumer, studio-consumer, dedicated-smoke and shared-resources joined. Both Studio documents reopened after shutdown, and cleanup records joined, rootRemoved, serverDisposed and noObservedProcessAlive as true. This is separate real-run evidence, not an inference from UI or unit results.

The final bounded suite test-results/studio-t09/shared-regression-final.log reports 232 passed and 3 skipped, including the real-JobManager consumer-shutdown regression (log SHA-256 1bf3ec22e1a0150d7c662294c02bb76caa11cabb83cb3f245d91f99a6c2a426d).

The first report remains failed. Separate test-results/studio-t09/failed-run-cleanup.json records later explicit cleanup after all four observed PIDs exited and the identities of 24 installed files matched; only then was that exclusively owned failed-run resource root removed. Its SHA-256 is 64eb2d435a9100057e813ef34849ab4e2195e60543a1c1ffafd1d1c6064225a9. This recovery does not reclassify the original shutdown as successful.

## Related files

- electron/main/local-subtitle/job-manager.ts
- electron/main/index.ts
- electron/main/app-shutdown.ts
- electron/main/subtitle-studio/transcription/runtime.ts
- electron/main/speech-resources/service.ts
- test/speech-resources/integration/app-shutdown.test.ts
- test/speech-resources/integration/real-shared-comparison-harness.ts
- test-results/studio-t09/real-shared-Idlbo2/report.json
- [Keep cleanup single-flight after caller deadlines](keep-cleanup-single-flight-after-deadlines.md)
