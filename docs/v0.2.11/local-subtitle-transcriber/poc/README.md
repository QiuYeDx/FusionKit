# Local Subtitle PRE Development Baseline

> Status: PRE-001 through PRE-006 are complete. macOS arm64 and Windows x64
> both passed bundled runtime staging, electron-builder positive/negative
> gates, and packaged no-PATH media/fault matrices. Windows uses the explicit
> `unsigned_personal_distribution` profile selected for personal/friend
> sharing; no certificate or trust-store change is required. The five-item
> production freeze is recorded in `pre006-production-decision.json`, and the
> next implementation packages are CORE-001 / CORE-002.

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
| `third-party-candidates.json` | Selected engine/model/media dependencies plus deferred release gates. |
| `pre006-production-decision.json` | Machine-checked five-part production freeze and go/no-go result. |
| `sample-inventory.example.json` | Shape of the ignored machine-local media/subtitle path inventory. |
| `clean-room-protocol.md` | Minimal rule that FusionKit is implemented from its design and public upstream APIs, without copying third-party GUI code. |
| `poc-record-template.md` | Sanitized runtime PoC evidence template for later PRE work. |
| `pre003-windows-x64-results.json` | Sanitized Windows CPU/CUDA functional and performance result. |
| `pre004-macos-arm64-results.json` | Sanitized macOS Metal/CPU bounded-window and packaged-like result. |
| `pre005-macos-arm64-results.json` | Sanitized macOS bundled media runtime, builder gate, signing and no-PATH result. |
| `pre005-windows-x64-results.json` | Sanitized Windows immutable FFmpeg audit, unsigned staging, builder gate and no-PATH result. |
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

System FFmpeg/ffprobe are development probes and fixture generators only.
PRE-006 selects the reproducible macOS arm64 FFmpeg 8.1.2 build outside asar:
LGPL-2.1-or-later, GPL/nonfree/version3/network/external libraries disabled,
macOS 11 deployment target, system-only dynamic dependencies and a stable
logical configure prefix. Windows x64 uses the immutable audited BtbN LGPLv3
build as the initial personal-distribution baseline with an explicit unsigned
integrity profile. It does not require a Windows source-build toolchain;
packaged mode never falls back to system PATH.

PRE-001 through PRE-006 are complete. The FFmpeg 8.1.2 detached signature was
verified on Windows against the pinned full fingerprint; Windows unsigned
staging, positive/negative builder gates, and packaged media/fault evidence are
recorded. Trusted Windows installer signing is optional QA-003 work only if
low-warning public distribution is requested later; Developer ID, notarization
and Gatekeeper acceptance remain QA-004 work. QA-005 still checks exact notices,
source offers and the NVIDIA redistributable file list before artifacts are
shared, without adding a Windows code-signing requirement.

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
- The Windows production decision is a small CPU runtime in the base install
  plus an official-release, size/SHA-verified optional CUDA accelerator pack.
  The CUDA Toolkit is not required; PRE-006 conservatively requires Windows
  NVIDIA driver 551.61 or newer, while the real target evidence used 610.62.
  The selected personal profile does not require Authenticode; QA-005 retains
  the exact NVIDIA redistributable/notice review.

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

## PRE-005 macOS bundled runtime and packaging

The macOS media candidate is built reproducibly from the pinned FFmpeg 8.1.2
source archive (`464beb5e...b524c`). The build recipe disables GPL, nonfree,
version3, network, autodetection and external libraries; enables only the
protocols, demuxers, decoders, filters and WAV output needed by the product;
targets thin arm64 with a macOS 11 minimum; and records a stable logical prefix
instead of embedding a developer output path. Both binaries contain only system
dynamic dependencies and pass private-path scans. The detached signature and
release key files match their pinned hashes. Windows `gpgv` verified the
detached signature against full fingerprint
`FCF986EA15E6E293A5644F10B4322F04D67658D8`.

The staging script signs `whisper-server`, `ffmpeg` and `ffprobe` before freezing
their byte sizes and SHA-256 values. It then creates a versioned manifest with
license/source references and verifies all artifacts from manifest-relative
paths under a sanitized environment. The signed hashes are:

- `whisper-server`: `159a1f8c79e27c741be6f4f7240b472663e7d45465ae24a49d86f7d87b7f6681`
- `ffmpeg`: `55f36865bfedfef597c1c6462ec92fcab1392bf418815e66b416195493bacc53`
- `ffprobe`: `8dfe0a7aba414a65a284eca637b04713c0ad0cabaf290f9b5f2679664fb60d09`
- runtime manifest: `fa82588f3e272db2031af3ed263ba5104596295260dbe0b30c529fef283e8320`

The ignored electron-builder spike places the runtime in
`Contents/Resources/local-subtitle` outside asar and uses architecture-bearing
artifact names. A valid `beforePack` run produced the arm64 app; after a copied
staging directory had `ffmpeg` removed, the same hook failed with
`media_runtime_missing` before creating any app. Outer ad-hoc signing passed
independent deep/strict verification and did not change any frozen runtime hash.
Developer ID and Gatekeeper acceptance are still QA-004 release evidence, not a
PRE-005 functional gate.

The packaged no-PATH smoke launched all three manifest artifacts and normalized
mp3, wav, flac, aac, m4a, mp4, mkv, mov and webm. The video fixtures contained
real video tracks; multi-audio selection, non-ASCII and 225-character paths,
corrupt input, zero-duration input and FFmpeg progress were covered. Missing
manifest/tool/license/source evidence maps to `media_runtime_missing`; changed
hash, wrong architecture or non-executable media tools map to
`media_runtime_invalid`; a statically valid wrong executable maps to
`media_runtime_launch_failed`; and a missing server remains `runtime_missing`.
Every fault was blocked before enqueue.

The sanitized macOS result is `pre005-macos-arm64-results.json`. The Windows
result is `pre005-windows-x64-results.json`: 15 unsigned x64 PE artifacts were
frozen by size/SHA/architecture, all three programs launched from manifest
paths, the x64 `dir` positive build succeeded, the missing-FFmpeg negative build
failed before leaving a runnable app, and the same 9-format/9-fault packaged
matrix passed. The outer `FusionKit.exe` is intentionally `NotSigned`; no
certificate or trust-store entry was created. Native sources, binaries,
packaged apps, generated media and machine paths remain under ignored local
storage. PRE-005 supplied the evidence consumed by the completed PRE-006 freeze.

## PRE-006 production freeze

The machine-readable decision record freezes five `go` decisions:

- `whisper.cpp v1.9.1 / f049fff`, Node-managed official server HTTP contract
  v1, phase-only progress, and no native bridge;
- Windows x64 CPU base + optional CUDA 12.4 pack, macOS arm64 Metal + explicit
  CPU fallback, and stable rejection of macOS x64;
- minimal pinned-source FFmpeg 8.1.2 on macOS and the immutable BtbN LGPLv3
  baseline on Windows, acquired and audited before offline builder staging;
- exact `large-v3-q5_0` and Silero v6.2.0 launch resources, with other
  large-v3/turbo variants deferred until they have equivalent evidence;
- the 30-second PCM window / 5-second overlap quality contract and observed
  package/model/accelerator footprint guards.

`validate-manifests.mjs` now loads this record and rejects drift in any selected
pin, platform/profile, model hash, media source, quality rule or third-party
candidate decision. PRE blockers are empty, so CORE-001 and CORE-002 are
unlocked.
