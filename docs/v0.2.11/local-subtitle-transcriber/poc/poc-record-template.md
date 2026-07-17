# Local Subtitle PoC Record

## Identity

- Evidence ID:
- Work package:
- Date:
- Target profile:
- Runner/engine commit:
- Runner build hash:
- Model ID:
- Benchmark manifest ID:

## Sanitized environment

- Platform/architecture:
- CPU/GPU summary:
- Driver/toolchain versions:
- Packaged-like or development run:

Do not include usernames, hostnames, absolute paths, complete command lines or
environment dumps.

## Results

| Sample ID | Outcome | Detected language | RTF | Raw validity | Longest repeat (cue/ms) | Invalid timeline segments | Window coverage | SRT/LRC parse-back | Manual note |
| --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | --- |
|  |  |  |  |  |  |  |  |  |  |

Raw validity is evaluated before cue shaping or formatting. Record raw segment
count and normalized unique-text count in the local run detail. A parse-back
pass cannot override a raw validity failure.

For VAD runs, also record that `token_timestamps=false`, the mapped segment
timeline policy and `wordTimelineFallbackCount`. Any non-zero fallback requires
inspection even when the final segment timeline remains valid.

## Lifecycle evidence

- First model load:
- Reused-model task:
- Cancel request to target terminal latency:
- Runner shutdown and child-process cleanup:
- Temporary file cleanup:

## Packaging evidence

- Runner/dependency bytes:
- FFmpeg bytes and build record:
- Optional accelerator bytes:

## Decision

- Go / No-Go / More implementation required:
- Failed product checks:
- Open questions for later PRE work:
