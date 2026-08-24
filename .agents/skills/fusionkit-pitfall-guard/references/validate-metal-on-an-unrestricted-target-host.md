# FK-PIT-0067: Validate Metal on an unrestricted target host

## Area

macOS native GPU validation / local inference / automation sandbox.

## Triggers

Metal, `MTLCreateSystemDefaultDevice`, sandbox, buffer allocation, SIGSEGV,
backend probe, target smoke, false negative

## Symptoms

- A Metal-capable Apple Silicon host reports a small buffer allocation failure
  or exits before health while the same CPU path succeeds.
- A minimal Metal device probe returns no device only inside the automation
  sandbox.
- Historical target-host evidence and the current restricted run disagree for
  the same runtime and model.

## Root cause

Some automation sandboxes do not expose the host GPU device to child
processes. Native code can then fail during Metal initialization or allocation,
including by signal, even when host memory is sufficient. That run proves only
that the restricted environment cannot exercise Metal; it is not target-host
evidence that the artifact or product backend is broken.

## Do

- Preserve the restricted result as an environment-specific negative signal.
- Re-run the exact content-addressed runtime and pinned production model on an
  unrestricted native target host.
- Require bounded diagnostics with positive Metal initialization and device
  markers, no failure marker, a healthy private endpoint, and confirmed child
  cleanup.
- Use an independent backend probe to record model-load time, peak RSS, and the
  same positive backend evidence.
- Compare artifact, runtime generation, model hash, arguments, and no-PATH
  environment before attributing different outcomes to sandbox access.

## Avoid

- Do not classify a Metal allocation failure as host RAM or product OOM from
  free-memory heuristics alone.
- Do not accept health success without positive Metal initialization and device
  evidence; that can hide CPU fallback.
- Do not weaken the model, build flags, explicit-Metal semantics, or runtime
  hashes merely to make a restricted sandbox pass.
- Do not publish raw diagnostics, private routes, model paths, or temporary
  paths in evidence reports.

## Validation

Run the canonical Metal target smoke and backend probe outside the restricted
sandbox, then run the CPU target smoke as a regression. Confirm all spawned
`whisper-server`, `ffmpeg`, and `ffprobe` processes are closed afterward. The
report must contain only bounded boolean backend evidence and path-free
identities.

## Related files

- `scripts/local-subtitle/runtime/run-native002-macos-smoke.mjs`
- `scripts/local-subtitle/whisper-server/process-metrics.mjs`
- `scripts/local-subtitle/whisper-server/run-backend-probe.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
