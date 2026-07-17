# Local Subtitle PRE Development Baseline

> Status: PRE-001 through PRE-004 completed on 2026-07-17. PRE-004 macOS arm64
> passed Metal/CPU backend, bounded-window raw transcript validity, performance,
> cancellation, reuse and packaged-like evidence. Whole-file inference remains
> prohibited because its historical raw results contained decoder loops.
> Developer ID and Gatekeeper are deferred to QA-004 and are not a PRE-004 gate.

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
| `metrics-contract.json` | Product-oriented runtime, resource, cancellation, raw transcript validity and SRT/LRC parse-back measurements. |
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

PRE-001 through PRE-004 are complete. PRE-005 continues with bundled FFmpeg,
sidecar staging and license evidence, followed by PRE-006 production technology
freeze. Developer ID, notarization and Gatekeeper accepted are future QA-004
public-distribution evidence, not a PRE-004 gate.

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

## PRE-004 macOS arm64 Metal/CPU runner

The macOS candidate is built from the exact `whisper.cpp v1.9.1` commit
`f049fff95a089aa9969deb009cdd4892b3e74916`, not from an unversioned extracted
source directory. The build is thin arm64, static, non-native-tuned, and embeds
the Metal library. Its staged `whisper-server` keeps the executable bit, has
only system framework or `/usr/lib` dependencies, and shares one artifact for
Metal and explicit `--no-gpu` CPU fallback. No macOS x64 artifact is staged.

The final strategy normalizes media once to 16 kHz mono PCM16 and uses 30-second
independent decoder windows with 5-second overlap, owned-core merge, a raw
transcript quality gate and bounded shorter-window retries. Both backends
returned all three current real samples with one model load and one server PID.
Metal RTF was 0.0698–0.0821 with about 1.87 GB peak RSS; CPU RTF was
0.1954–0.2811 with about 2.03 GB peak RSS. All language checks, raw validity and
SRT/standard-LRC parse-back checks passed. Cancellation settled as `aborted` in
2 ms on Metal and 6 ms on CPU; the next-task policy remains to restart the
server after any cancelled inference.

Metal is accepted only when bounded native diagnostics contain both Metal
initialization and a device observation with no failure marker. A successful
health endpoint is not sufficient. CPU is selected explicitly through
`--no-gpu`; an automatic fallback must be resolved and shown before batch
commit, while an explicit Metal request must fail as `backend_unverified`
instead of silently using CPU. On this Apple M5 sample, CPU was about
1.81–2.26× slower than Metal, which becomes the initial performance-warning
range rather than a universal hardware promise.

Historical whole-file `verbose_json` already contained the failure. Metal repeated one sentence
for 347 consecutive segments from 405.52 seconds to the end of the long
Japanese sample; Metal/CPU Chinese runs repeated for 77/43 segments, and the
CPU long-sample result extended about 27.89 seconds past the media. Disabling
token timestamps or flash attention and increasing max length did not fix it.
Beam search reduced the loop but introduced a different opening hallucination.
Independent greedy windows for the affected Chinese and Japanese intervals
recovered the actual changing speech, isolating the failure to decoder state in
one whole-file request. Output deduplication cannot recover the missing speech,
so whole-file inference is prohibited.

Silero VAD removes short hallucinations from silent windows. In v1.9.1 the VAD
segment timestamps are mapped back to the original media timeline, but token/
word timestamps remain on the silence-compressed timeline. VAD requests
therefore force `token_timestamps=false` and consume mapped segment time only;
the merge layer also rejects word time outside its parent segment. The final
Metal/CPU matrix had zero invalid raw timeline segments and at most two
consecutive equal cues. The long Japanese sample's silent `600–630 s` window
was empty, subsequent speech resumed near 638.70 s and the media tail remained
recognized through 738.84 s.

The packaged-like runner passes containment, arm64-only, executable-bit,
dependency and ad-hoc integrity checks. Gatekeeper rejected it because this
machine has no Developer ID identity. That records a currently unadopted
public no-warning distribution capability; it does not block PRE-004. A real
Developer ID/notarized artifact is checked only if that distribution mode is
adopted in QA-004.

The sanitized committed result is `pre004-macos-arm64-results.json`. The exact
source clone, build tree, staged binary, model, native results and generated
subtitles remain under ignored local storage. The bounded-window Metal/CPU rerun
passed raw transcript validity and structural parse-back together, completing
PRE-004.
