# FK-PIT-0036: Keep Windows native smoke cwd short and stdio explicit

## Area

Windows native runtime / Node process smoke

## Triggers

`ENOENT` only on a long or non-ASCII media path, `read ENOTCONN`, Node 24,
repeated FFmpeg/ffprobe probes, `execFile({ timeout })` never settles, a killed
PowerShell probe leaves model loading stuck, the executable and input both exist.

## Symptoms

- FFprobe handles the long absolute media path from a normal working directory, but
  `CreateProcess` reports `ENOENT` when the same long directory is also used as `cwd`.
- Repeated asynchronous `execFile`/`spawn` probes can emit an unhandled Windows Socket
  `read ENOTCONN` even though the native program launches normally in isolation.
- `execFile({ timeout: 5000 })` kills the direct probe, but the awaiting caller remains
  stuck because a descendant still owns an inherited stdout/stderr pipe.

## Root cause

Windows process creation validates `cwd` separately from command arguments. A media tool
may be long-path-aware while `CreateProcess` still rejects an overlong working directory.
Node's asynchronous child stdio uses Windows pipe-backed Socket objects; restricted or
headless runners can expose pipe disconnects that do not indicate a media-runtime failure.
Node's native child timeout is primarily a process-termination aid. Its callback can still
wait for inherited handles to close, so it is not by itself a caller deadline.

## Do

- Keep `cwd` at a short, controlled runtime or output directory and pass the source media
  as an absolute argument.
- For a strictly serial bounded smoke matrix, use `spawnSync` with stdin ignored and
  stdout/stderr redirected to short-lived bounded files, then read and delete them.
- Diagnose executable resolution, process creation, child exit and media parsing as
  separate stages with stable error codes.
- Wrap asynchronous native probes in an app-owned timer that settles the caller immediately
  at the deadline. Kill the child as best-effort cleanup, ignore late callbacks, and settle
  aborts without waiting for child stdio teardown.
- Prove no-PATH behavior by enumerating the sanitized `PATH`/`PATHEXT` directly instead
  of spawning `where.exe` or a shell shim.

## Avoid

- Do not set `cwd = path.dirname(inputPath)` when input paths are intentionally long.
- Do not treat `ENOENT` as proof that the executable is missing until `cwd` is checked.
- Do not retry an unhandled `ENOTCONN` and call the resulting pass stable evidence.
- Do not assume `execFile`'s `timeout` guarantees that its Promise wrapper will settle.
- Do not restore the full system PATH merely to make a diagnostic shim resolve.

## Validation

- Probe and normalize a 225-character relative non-ASCII media path from a short cwd.
- Run mp3/wav/flac/aac/m4a/mp4/mkv/mov/webm sequentially with bounded stdio.
- Confirm the sanitized PATH cannot resolve FFmpeg without starting another process.
- Inject a fake child whose callback never fires; prove the caller resolves at its own
  deadline, kills once, ignores a late callback, and cancels with no live timer.
- Confirm no command capture files remain after both success and failure.

## Related files

- `scripts/local-subtitle/runtime/run-pre005-smoke.mjs`
- `scripts/local-subtitle/runtime/run-pre005-smoke.test.mjs`
- `electron/main/local-subtitle/backend-attestor.ts`
- `test/local-subtitle/backendAttestor.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/poc/pre005-windows-x64-results.json`
