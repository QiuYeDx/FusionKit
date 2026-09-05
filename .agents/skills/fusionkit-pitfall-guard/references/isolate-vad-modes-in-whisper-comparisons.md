# FK-PIT-0108: Isolate VAD modes in whisper comparisons

## Area

Local subtitle benchmarks / whisper-server state / fallback planning.

## Triggers

VAD on/off comparison, same clip different timestamps, server reuse, quiet speech rescue, stale mapping, large-v3.

## Symptoms

The same 30-second clip produces identical text/timestamp hashes in two fresh no-VAD processes, but differs when no-VAD follows VAD requests in one process. A benchmark may mistake this state effect for detector quality.

## Root cause

At pinned whisper.cpp commit `f049fff95a089aa9969deb009cdd4892b3e74916`, the server copies default request parameters each time. However, the native VAD mapping is cleared in the VAD path; the non-VAD branch does not clear it, and timestamp getters inspect the retained mapping state. This explains a route to timestamp contamination, not every observed textual difference.

Sources: [server request parameters](https://github.com/ggml-org/whisper.cpp/blob/f049fff95a089aa9969deb009cdd4892b3e74916/examples/server/server.cpp#L782), [native VAD branch](https://github.com/ggml-org/whisper.cpp/blob/f049fff95a089aa9969deb009cdd4892b3e74916/src/whisper.cpp#L7097), [timestamp mapping](https://github.com/ggml-org/whisper.cpp/blob/f049fff95a089aa9969deb009cdd4892b3e74916/src/whisper.cpp#L7288).

## Do

- Use fresh processes for baseline VAD-mode comparisons. Repeat a fixed-mode control before blaming nondeterminism or request defaults.
- Verify effective VAD usage in native diagnostics, not just the requested multipart flag.
- Keep future no-VAD rescue on a matching load identity and process epoch.
- Inspect production lifecycle guards before attributing a prototype-only reproduction to the application.
- Keep detector-candidate coverage separate from gap bridging: 100% candidate coverage can still include a long unsupported display interval.

## Avoid

- Do not infer missing speech, silence or improved accuracy solely from output length or candidate coverage.
- Do not fix this by proportionally moving subtitle text without acoustic alignment evidence.
- Do not weaken FusionKit's existing request/load VAD identity check to enable mixed-mode reuse.

## Validation

On 2026-09-05, isolated no-VAD A controls matched; a mixed-mode A run differed. B current/current and current/relaxed/current controls matched for current-mode responses. FusionKit production already rejects VAD mode mismatches and retires incompatible load identities; 51 serverSupervisor tests passed. No production cross-mode failure was established.

## Related files

- `electron/main/local-subtitle/server-supervisor.ts`
- `electron/main/local-subtitle/server-process-contract.ts`
- `scripts/local-subtitle/whisper-server/supervisor.mjs`
- `scripts/local-subtitle/benchmark/speech-coverage-diagnostics.mjs`
- `docs/v0.2.11/subtitle-quality-harness/phase2-design-and-execution.md`
