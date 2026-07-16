# Local Subtitle PRE-001 Development Baseline

> Status: completed on 2026-07-16. The three current real samples and all three
> target-environment reports satisfy the deliberately small PRE-001 gate.

This directory records only the engineering facts needed to start the local
subtitle implementation. Media, subtitle text, models, native binaries,
machine paths and credentials stay outside Git; machine-local paths live only
in the ignored `sample-inventory.json.local` file.

## Completion decision

PRE-001 uses the three user-provided samples already available locally:

- one Japanese video with SRT;
- one Japanese WAV with LRC;
- one Chinese video with SRT.

Their media can be decoded, their size and SHA-256 values are stable, and the
subtitle timestamps are valid and remain within the media duration. This is a
development smoke corpus, not a research benchmark. English is not a separate
PRE-001 requirement, and there is no independent transcript, CER/WER,
FasterWhisperGUI snapshot/configuration, CTranslate2 model hash, sample-rights
audit or exact baseline-output matching gate.

The supplied SRT/LRC files are retained only as user-provided sample subtitle
artifacts for format/timeline smoke checks and later manual comparison. Their
text is not treated as ground truth.

## Files

| File | Purpose |
| --- | --- |
| `benchmark-manifest.json` | Three-sample ja/zh development scope, media integrity and subtitle timeline summaries. |
| `metrics-contract.json` | Product-oriented runtime, resource, cancellation and SRT/LRC parse-back measurements. |
| `third-party-candidates.json` | Candidate engine/model/media dependencies and later implementation/distribution decisions. |
| `sample-inventory.example.json` | Shape of the ignored machine-local media/subtitle path inventory. |
| `clean-room-protocol.md` | Minimal rule that FusionKit is implemented from its design and public upstream APIs, without copying third-party GUI code. |
| `poc-record-template.md` | Sanitized runtime PoC evidence template for later PRE work. |
| `reports/` | Sanitized target reports without hostname, username or absolute paths. |

The deterministic silence fixture is generated outside Git:

```text
node scripts/local-subtitle/benchmark/generate-synthetic-fixtures.mjs --output <local-directory>
```

## Validation

Committed contracts and target reports:

```text
node scripts/local-subtitle/benchmark/validate-manifests.mjs
```

Completed PRE-001 readiness, including physical files from the ignored local
inventory:

```text
node scripts/local-subtitle/benchmark/validate-manifests.mjs --strict --inventory docs/v0.2.11/local-subtitle-transcriber/poc/sample-inventory.json.local
```

Tests:

```text
node --test scripts/local-subtitle/benchmark/generate-synthetic-fixtures.test.mjs scripts/local-subtitle/benchmark/preflight.test.mjs scripts/local-subtitle/benchmark/validate-manifests.test.mjs
```

Validation errors use stable sample IDs and never print local paths.

## Target reports

The PRE-001 matrix is macOS arm64 Metal, Windows x64 CPU and Windows x64 CUDA.
macOS x64 is intentionally unsupported.

Windows PRE-001 uses the pinned official `whisper.cpp v1.9.1` release assets.
The CPU ZIP has a verified SHA-256 and successful `whisper-cli.exe --help`
launch. The CUDA asset is pinned from official release metadata; actual CUDA
inference belongs to PRE-003.

CMake, MSVC and `nvcc` describe a possible source-build environment. They are
not required to consume the official Windows prebuilt PoC assets and are not
PRE-001 or end-user prerequisites. PRE-002 will choose between installing a
local source toolchain and using a controlled build machine.

System FFmpeg/ffprobe are development probes only. The eventual product must
ship its selected binaries outside asar; redistribution, signing and notices
remain later release work and are not sample-corpus blockers.

PRE-001 is complete. The next work package is PRE-002, the minimal persistent
CPU runner and JSONL protocol PoC.
