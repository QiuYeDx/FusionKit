# Local Subtitle PRE-001–PRE-003 Development Baseline

> Status: PRE-001 through PRE-003 completed on 2026-07-17. The three current
> real samples now cover the Windows CPU/CUDA development gate as well as the
> original environment baseline.

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
launch. The CUDA asset is pinned from official release metadata and completed
real CUDA inference in PRE-003.

CMake, MSVC and `nvcc` describe a possible source-build environment. They are
not required to consume the official Windows prebuilt assets and are not
PRE-001, PRE-002 or end-user prerequisites. PRE-002 proved that Node can manage
the prebuilt `whisper-server.exe`; a source toolchain is required only if a
later target artifact truly must be compiled or patched.

System FFmpeg/ffprobe are development probes only. The eventual product must
ship its selected binaries outside asar; redistribution, signing and notices
remain later release work and are not sample-corpus blockers.

PRE-001 through PRE-003 are complete. The next target-specific work is PRE-004
on macOS arm64; the current Windows environment can continue with PRE-005
bundled FFmpeg, sidecar staging, signing and license evidence.

## PRE-003 Windows CPU/CUDA runner

`scripts/local-subtitle/whisper-server/run-poc.mjs` accepts an explicit
`--backend cpu|cuda`. CPU adds the official `--no-gpu` flag. CUDA omits that
flag but is considered verified only when the exact server PID has non-zero
dedicated GPU memory; an asset filename or successful `/health` response is not
backend evidence.

Windows WDDM commonly reports per-process memory as `N/A` through
`nvidia-smi --query-compute-apps`. The PoC therefore samples the Windows
`GPU Process Memory(pid_...)` performance counter first and keeps
`nvidia-smi` as a fallback. It also samples process working-set memory, records
model load time, language detection, RTF and cancellation, and writes local SRT
and standard LRC smoke artifacts that are independently parsed back.

Inference multipart uploads use a streaming `node:http` client with a separate
long-task timeout and bounded response. Global Node `fetch` is intentionally not
used here: the server sends response headers only after transcription, so a CPU
request longer than the default Undici header timeout can fail at roughly five
minutes while the native child is still healthy.

Example shape; all path arguments must point to ignored local files:

```text
node scripts/local-subtitle/whisper-server/run-poc.mjs \
  --server <official-whisper-server> \
  --model <verified-ggml-model> \
  --ffmpeg <development-only-ffmpeg> \
  --inventory <sample-inventory.json.local> \
  --output <ignored-output-directory> \
  --backend cuda \
  --cancel-sample ja-audio-drama-frequent-silence-medium
```

The cancellation probe runs after the complete sample set. PRE-003 found that
an immediate `/health` success after an aggressive CPU abort does not guarantee
the next inference request is reusable; the production policy is therefore to
restart the official server after a cancelled request before dispatching the
next task. Normal, non-cancelled tasks continue to reuse one model process.

## PRE-003 completion result

- Official `whisper.cpp v1.9.1` CPU and CUDA Windows x64 packages ran the
  public `large-v3-q5_0` GGML model without a local build toolchain.
- All three current Chinese/Japanese samples completed on both backends. CUDA
  RTF was 0.0509–0.0735 with about 2.12 GB peak exact-PID VRAM; CPU RTF was
  0.5063–0.592 with about 2.50 GB peak working set.
- Language detection matched every requested language, and every generated SRT
  and standard LRC artifact parsed back successfully.
- A final native-HTTP CUDA smoke completed at RTF 0.0488. A missing
  `cublas64_12.dll` startup stayed healthy but used zero VRAM, and the probe
  rejected it as `backend_unverified` instead of falsely reporting CUDA.
- The Windows distribution recommendation is a small CPU runtime in the base
  install plus a signed, hash-verified optional CUDA accelerator pack. PRE-005
  and PRE-006 retain the release-license, signing and update decisions.

The sanitized committed result is `pre003-windows-x64-results.json`. Media,
subtitle text, native archives, models, generated subtitles and machine paths
remain under ignored local storage.
