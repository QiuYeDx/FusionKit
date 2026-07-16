# FK-PIT-0025: Separate official prebuilt PoC readiness from source-build toolchains

## Area

Windows native runtime / PRE evidence / whisper.cpp

## Triggers

official prebuilt,whisper.cpp,CMake,MSVC,PRE-001,PRE-002,sourceBuild

## Symptoms

A PRE-001 runtime profile is falsely blocked by compilers that are only needed
if a later package actually chooses to build or patch a native artifact.

## Root cause

One `requiredTools` list was used for two different evidence questions. A
PRE-001 Windows PoC can execute a pinned official `whisper.cpp` release asset,
while a later source-build path may compile an upstream or FusionKit native
artifact. PRE-002 subsequently proved that the official prebuilt
`whisper-server` already supplies model residency, structured JSON and abort,
so CMake/MSVC are not required for the Windows CPU PoC at all. Treating them as
runtime requirements creates a false blocker and incorrectly suggests that end
users need a compiler toolchain.

## Do

- Give every target report an explicit readiness scope.
- For Windows PRE-001 official-prebuilt profiles, require media runtime probes
  and the applicable driver probe, while keeping CMake/MSVC/`nvcc` in a
  separate `sourceBuild` result.
- Pin the exact upstream release, asset filename, byte size, SHA-256 and URL;
  validate those facts in the report contract.
- Keep `sourceBuild.ready: false` visible when compilers are missing, but do
  not turn it into a PRE-001 blocker when `sourceBuild.requiredForPoc` is
  false.
- Before relying on a small prebuilt asset, verify its downloaded hash and at
  least perform a no-model launch smoke. Record larger untested assets as
  metadata-only evidence instead of claiming execution.
- Before requiring a source-build toolchain, inspect and exercise every relevant
  executable in the pinned official archive, especially a persistent server.
- Require a real source-build toolchain or controlled CI evidence only when a
  selected target artifact must actually be compiled or patched.

## Avoid

- Do not delete compiler probes merely to make a report green; preserve them
  under the correct readiness facet.
- Do not call a one-shot upstream CLI the production runtime. Also do not infer
  from that CLI limitation that the official server is insufficient without
  testing its model reuse, cancellation and structured response behavior.
- Do not claim CUDA inference, packaging or redistribution is verified from an
  asset name, driver probe or upstream digest alone.
- Do not turn CMake, MSVC, CUDA Toolkit or `nvcc` into end-user prerequisites.

## Validation

```text
node --test scripts/local-subtitle/benchmark/preflight.test.mjs scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node scripts/local-subtitle/benchmark/preflight.mjs --target windows-x64-cpu --output <report.json>
node scripts/local-subtitle/benchmark/preflight.mjs --target windows-x64-cuda --output <report.json>
node scripts/local-subtitle/benchmark/validate-manifests.mjs
```

Confirm that both Windows reports can be PRE-001 ready with missing CMake/MSVC,
that `sourceBuild.ready` remains false, that the official asset digests are
contract-checked, and that tampering with an asset digest fails validation.

## Related files

- `scripts/local-subtitle/benchmark/preflight.mjs`
- `scripts/local-subtitle/benchmark/preflight.test.mjs`
- `scripts/local-subtitle/benchmark/validate-manifests.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/poc/third-party-candidates.json`
- `docs/v0.2.11/local-subtitle-transcriber/poc/reports/`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
