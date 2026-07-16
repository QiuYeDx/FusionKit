# Local Subtitle PRE-001 Evidence Baseline

> Status: tooling and contracts are implemented and the macOS arm64 report is
> ready; real sample custody, baseline hashes and Windows evidence are pending.

This directory defines the repeatable evidence boundary for PRE-001. It does
not contain media, transcripts, models, native binaries or credentials.

## Files

| File | Purpose |
| --- | --- |
| `benchmark-manifest.json` | Required languages, acoustic cases, duration classes and path cases. Evidence fields remain pending until licensed local samples are selected. |
| `baseline-profile.json` | Fixed neutral `faster-whisper-GUI` comparison parameters. The local application and model hashes must be captured before a benchmark is valid. |
| `metrics-contract.json` | CER/WER, cue timing, RTF, memory, load/reuse, cancellation, package-size and parse-back definitions. |
| `third-party-candidates.json` | Candidate upstream versions, declared licenses, decision state and unresolved distribution questions. |
| `sample-inventory.example.json` | Shape of the machine-local path inventory. An actual inventory must end in `.local` so the repository ignore rule applies. |
| `clean-room-protocol.md` | Allowed observations and the no-copy/no-credential review gate. |
| `poc-record-template.md` | Sanitized per-target PoC evidence record. |
| `reports/` | Committed sanitized toolchain reports; reports never include hostname, username or absolute path. |

The deterministic silence sample is generated outside Git and has a committed
size/hash contract:

```text
node scripts/local-subtitle/benchmark/generate-synthetic-fixtures.mjs --output <local-directory>
```

## Validation levels

Structural validation checks that the committed contracts are internally
consistent and cover every required scenario. Pending evidence is reported as a
warning:

```text
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/generate-synthetic-fixtures.test.mjs scripts/local-subtitle/benchmark/preflight.test.mjs scripts/local-subtitle/benchmark/validate-manifests.test.mjs
```

Strict readiness additionally requires every sample to have real duration,
byte size, SHA-256, license evidence and reference-transcript hash, plus a
machine-local inventory whose files match those hashes:

```text
node scripts/local-subtitle/benchmark/validate-manifests.mjs --strict --inventory docs/v0.2.11/local-subtitle-transcriber/poc/sample-inventory.json.local
```

Strict readiness is expected to fail until the user-owned/licensed corpus is
selected. Errors only name stable sample IDs; they do not print local paths.

## Toolchain reports

Run the read-only preflight separately on every target profile:

```text
node scripts/local-subtitle/benchmark/preflight.mjs --target mac-arm64-metal --output docs/v0.2.11/local-subtitle-transcriber/poc/reports/YYYY-MM-DD_mac-arm64-metal.json
node scripts/local-subtitle/benchmark/preflight.mjs --target windows-x64-cpu --output docs/v0.2.11/local-subtitle-transcriber/poc/reports/YYYY-MM-DD_windows-x64-cpu.json
node scripts/local-subtitle/benchmark/preflight.mjs --target windows-x64-cuda --output docs/v0.2.11/local-subtitle-transcriber/poc/reports/YYYY-MM-DD_windows-x64-cuda.json
```

macOS x64 is intentionally outside the release matrix. Running the preflight
on that architecture fails with `unsupported_architecture`; there is no macOS
x64 CPU artifact or Rosetta fallback evidence requirement.

The script only executes version/probe commands. It does not install software,
download resources, run pnpm install or modify the lockfile. A missing required
tool, wrong platform/architecture, pnpm other than 8.7.0 or lockfile other than
v6 produces a non-zero exit after the report is written.

The `ffmpeg` and `ffprobe` PATH probes above are development/PRE evidence only.
They let a PoC workstation exercise media cases before packaged resources
exist. They are not end-user prerequisites and do not prove release readiness.
The production app must package audited platform binaries outside asar, resolve
them from a versioned manifest, and must never fall back to system PATH or a
user-selected executable.

`package.json` currently has no `packageManager` field. PRE-001 records that as
a warning; adding `pnpm@8.7.0` metadata should be handled as an explicit
repository-maintenance change rather than hidden inside native PoC work.

## Evidence completion gate

PRE-001 remains `进行中` until all of the following are true:

1. Every sample entry is `ready` and strict inventory/hash validation passes.
2. The reference application snapshot and CTranslate2 `large-v3` hashes are
   recorded without storing their paths.
3. Sanitized ready reports exist for macOS arm64, Windows x64 CPU and Windows
   x64 CUDA; unavailable target machines are not replaced by mocks.
4. Sample license/source evidence is reviewed and all media stays outside Git.
5. The structural checks, script tests and `git diff --check` pass.
