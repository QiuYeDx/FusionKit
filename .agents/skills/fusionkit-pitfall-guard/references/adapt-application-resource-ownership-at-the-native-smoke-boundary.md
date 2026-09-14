# FK-PIT-0153: Adapt application resource ownership at the native smoke boundary

## Area

Shared speech resources / application ownership / dedicated native smoke supervisor.

## Triggers

Application owner `0`, `runtime_protocol_mismatch`, fresh model import, VAD install,
ready-resource migration, private smoke supervisor, no inference child spawned.

## Symptoms

- A clean profile verifies the packaged runtime successfully, then a fresh model
  import or VAD installation fails its native load check with
  `runtime_protocol_mismatch` before any whisper-server child is created.
- Transcription acceptance using copied or migrated ready resources can pass.
  Tests that replace the entire supervisor or stub the resource smoke callback
  also pass, despite the first-install path being broken.

## Root cause

`SpeechResourceService` uses the application-owned key
`{ webContentsId: 0, ownerSessionId: ... }` for shared resource jobs. It is not a
renderer inference owner. The dedicated resource smoke adapter passed that key
unchanged to `LocalSubtitleServerSupervisor`, whose real `validateOwner` rejects
non-positive `webContentsId` values before process creation.

The ownership domains are intentionally different. A valid runtime signature,
ready model metadata, or a working existing-resource transcription does not
exercise admission for a new installation. The earlier shared comparison harness
installed already-ready model/VAD records, so it did not reach this boundary.

## Do

- Allocate one private valid native owner when creating the dedicated smoke
  adapter. Use a positive numeric owner ID and a fresh random session ID; retain
  that owner for both model and VAD smoke loads within the same supervisor.
- Keep the shared application service's owner `0` and the original native owner
  validation unchanged. The private owner belongs only to the adapter's separate
  supervisor; it must not borrow a renderer's inference epoch or session ID.
- Fence smoke calls before runtime verification and again after its await, and
  retain the existing shutdown join for the native supervisor and startup cleanup.
- Run at least one regression through the actual supervisor `acquire` and owner
  validation. Low-level OS child, socket, HTTP and signature probes can be
  controlled, while real admission, runtime proof branding and private session
  filesystem checks still execute.
- Separately test direct native rejection of owner `0`, successful adaptation for
  model and VAD, distinct session IDs across adapter factories, confirmed child
  close, private session deletion, and rejection after shutdown.
- Include a clean-profile model import and VAD installation in real release
  acceptance; record them separately from reuse or migration of ready resources.

## Avoid

- Do not weaken the frozen native supervisor to accept owner `0`, or replace the
  shared application owner with a renderer ID globally.
- Do not pass a real window owner into a resource smoke process; resource jobs
  and their cleanup must survive independently of renderer navigation.
- Do not report an existing-ready-resource comparison or a fully mocked smoke
  test as evidence that first-time resource installation works.
- Do not infer an artifact/signing defect from a protocol error before checking
  whether the native process was ever spawned.

## Validation

The failing macOS I9 clean-profile run is preserved in
`test-results/studio-release-real/run-E6NCgr/result.json`. Its resource-readiness
poll failed after the valid runtime check; diagnosis found the owner rejection
before any native spawn. That failed result must not be relabeled as a pass.

The focused controlled regression starts no real inference server:

```bash
node node_modules/vitest/vitest.mjs run \
  test/speech-resources/integration/smoke-owner-admission.test.ts \
  test/speech-resources/integration/smoke-startup.test.ts \
  --maxWorkers=1 --minWorkers=1
```

Both files pass, four tests total. The broader shared integration suite passes
eight files and sixteen tests, including consumer shutdown, private sessions,
resource adapters and application shutdown ordering. TypeScript checking of the
adapter and new admission regression reports no diagnostics.

These controlled checks prove the ownership correction and lifecycle behavior;
the release real-workflow harness supplies separate fresh-install, actual native
load, transcription, document reopen, translation and export evidence.

## Related files

- `electron/main/speech-resources/service.ts`
- `electron/main/subtitle-studio/transcription/shared-resources.ts`
- `electron/main/subtitle-studio/transcription/native/server-supervisor.ts`
- `test/speech-resources/integration/smoke-owner-admission.test.ts`
- `test/speech-resources/integration/smoke-startup.test.ts`
- `test/speech-resources/integration/real-shared-comparison-harness.ts`
- `test/subtitle-studio-provenance/release-real-workflow.test.ts`
- [Release shared resource occupancy only after consumer shutdown joins](release-resource-occupancy-only-after-consumer-shutdown-joins.md)
