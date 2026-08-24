# FK-PIT-0024: Keep Windows native preflight command resolution explicit

## Area

Windows native toolchain / PRE evidence / child-process environment.

## Triggers

pnpm missing, `nvidia-smi` failed, NVML unknown error, `spawnSync`,
`shell: false`, minimal environment, Windows x64 preflight.

## Symptoms

- PowerShell can run `pnpm --version`, but the Node preflight reports pnpm as
  missing.
- `nvidia-smi` works in the parent shell, but the sanitized probe returns
  `Failed to initialize NVML: Unknown Error`.
- A Windows target report contains false blockers even though the corresponding
  commands work outside the preflight.

## Root cause

Windows package-manager shims such as pnpm are commonly `.cmd` files. A Node
child process launched with `shell: false` can neither apply PowerShell command
resolution to the extensionless name nor execute the `.cmd` shim as a normal
binary. NVIDIA's Windows NVML initialization can
also depend on the non-secret `ProgramFiles` or `ProgramW6432` system location;
removing both from an otherwise minimal environment makes `nvidia-smi` fail.

## Do

- Invoke the fixed `pnpm.cmd --version` command through an explicit
  `cmd.exe /d /s /c` tool specification on Windows while keeping `pnpm` on
  POSIX; never interpolate user input into that command string.
- Keep the Node spawn itself at `shell: false`; do not enable a general-purpose
  shell option for all probes.
- Preserve only the non-secret Windows system-location variables required by
  the native probe, including `ProgramFiles` and `ProgramW6432`.
- Re-run the real Windows CPU and CUDA profiles after changing the probe, then
  distinguish remaining true toolchain blockers from prior false failures.
- Add deterministic tests for the platform-specific command and environment
  allowlist without recording actual local paths.

## Avoid

- Do not treat a PowerShell success as proof that a shell-free Node spawn will
  resolve the same command.
- Do not inherit the complete parent environment merely to make NVML work; it
  may contain API keys, proxy credentials or other secrets.
- Do not mark the Windows **source-build** toolchain ready while CMake or MSVC
  remains missing. An explicitly scoped official-prebuilt PRE-001 profile may
  still be runtime-ready; keep the two readiness results separate per
  `FK-PIT-0025`.

## Validation

```text
node --test scripts/local-subtitle/benchmark/preflight.test.mjs
node scripts/local-subtitle/benchmark/preflight.mjs --target windows-x64-cpu --output <report.json>
node scripts/local-subtitle/benchmark/preflight.mjs --target windows-x64-cuda --output <report.json>
node scripts/local-subtitle/benchmark/validate-manifests.mjs
git diff --check
```

Confirm that pnpm and `nvidia-smi` are available in the sanitized report when
they work on the host, secrets remain outside the child environment, and real
missing tools are still explicit blockers.

## Related files

- `scripts/local-subtitle/benchmark/preflight.mjs`
- `scripts/local-subtitle/benchmark/preflight.test.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/poc/reports/`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_implementation_records/2026-07-16_PRE-001_evidence-baseline.md`
