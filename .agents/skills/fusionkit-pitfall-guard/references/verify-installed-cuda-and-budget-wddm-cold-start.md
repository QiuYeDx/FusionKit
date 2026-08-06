# FK-PIT-0081: Verify installed CUDA and budget WDDM cold start

## Area

Local subtitle / Windows CUDA runtime status and execution attestation.

## Triggers

CUDA accelerator installed, backend card stays unverified, `backend_unverified`,
`Get-Counter`, WDDM, `nvidia-smi` reports `N/A`, CUDA server logs show GPU use.

## Symptoms

- The environment card always reports CUDA as `unverified/backend_unverified`
  even after the managed accelerator pack is installed and valid.
- An explicit CUDA task starts the verified server, loads the model onto CUDA,
  then fails quickly with `backend_unverified`.
- Sanitized server diagnostics show `use gpu = 1` and a positive CUDA model size,
  while the external exact-PID memory probe still returns no evidence.

## Root cause

The runtime summary treated platform support as the entire CUDA status and
hard-coded every supported Windows CUDA backend to `unverified`; it never asked
the managed accelerator manager for its verified pack proof. Separately, the
execution attestor allowed only 1.5 seconds for a PowerShell `Get-Counter`
process. A cold WDDM performance-counter query takes several seconds on a valid
Windows host, so it was killed before producing the exact-PID dedicated-memory
sample. The `nvidia-smi` fallback cannot replace that proof on WDDM systems
where per-process memory is reported as `N/A`.

## Do

- Resolve the managed CUDA accelerator during the runtime IPC probe and report
  `available` only for its branded, target-matching verification proof.
- Use the same accelerator resolver for card status, backend admission and
  execution-time revalidation.
- Give a cold WDDM `Get-Counter` process a bounded multi-second timeout inside a
  larger bounded evidence grace period.
- Preserve the minimal `ProgramFiles` and `ProgramW6432` system-location
  variables required by NVIDIA probes, as documented by FK-PIT-0024.
- Run the opt-in real Windows CUDA contract with the pinned archive and model;
  require the exact server PID to own positive GPU memory.

## Avoid

- Do not hard-code `unverified` merely because CUDA support exists on the host.
- Do not treat successful pack installation as execution-time GPU evidence;
  keep the exact child-PID attestation gate.
- Do not use `nvidia-smi used_gpu_memory` as the only Windows proof because WDDM
  commonly returns `N/A` for every process.
- Do not shrink native-process timeouts based only on warm local timings.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/backendAttestor.test.ts test/local-subtitle/runtimeIpc.test.ts test/local-subtitle/backendResolver.test.ts test/local-subtitle/productionExecutor.test.ts
FUSIONKIT_MODEL002_REAL_MODEL=<absolute-model> FUSIONKIT_MODEL002_REAL_CUDA_ARCHIVE=<absolute-zip> node_modules/.bin/vitest run test/local-subtitle/acceleratorManager.real.test.ts
node_modules/.bin/tsc --noEmit
```

On a real Windows WDDM host, confirm the environment card reports CUDA as
available, the real contract reaches a ready CUDA supervisor, and no test
server remains running afterward.

## Related files

- `electron/main/index.ts`
- `electron/main/local-subtitle/runtime-ipc.ts`
- `electron/main/local-subtitle/backend-attestor.ts`
- `test/local-subtitle/runtimeIpc.test.ts`
- `test/local-subtitle/backendAttestor.test.ts`
- `test/local-subtitle/acceleratorManager.real.test.ts`
