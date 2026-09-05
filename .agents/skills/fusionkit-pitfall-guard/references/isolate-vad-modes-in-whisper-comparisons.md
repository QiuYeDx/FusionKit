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


## Same-mode task order also needs validation

T-SEG-04A/04B on 2026-09-05 reproduced changed text and timestamps even with VAD enabled throughout: opening -> conditioned quiet control -> nonverbal control -> the same opening. A fresh process reproduced the first opening exactly. The real 216-second file also differed when run alone versus after unrelated tasks. This demonstrates process-reuse order dependence; it does not identify the precise native tensor/decoder state responsible.

The pinned upstream server copies default request parameters for each call, defaults no_context to true, and invokes VAD reset. Do not guess that an omitted padding field or prompt is leaking and change inference settings without evidence. Test the whole preceding sequence, not only isolated requests. In the verified Windows CUDA VAD production path, acquire a task lease with freshInferenceState: retire an already-used process while keeping resource pins, but reuse an unused loaded process. Reuse within one file remains allowed. Preserve strict cancellation/cleanup and active-lease fences, and measure the per-file reload overhead.

## Related files

- `electron/main/local-subtitle/server-supervisor.ts`
- `electron/main/local-subtitle/server-process-contract.ts`
- `scripts/local-subtitle/whisper-server/supervisor.mjs`
- `scripts/local-subtitle/benchmark/speech-coverage-diagnostics.mjs`
- `docs/v0.2.11/subtitle-quality-harness/phase2-design-and-execution.md`

## Independent no-VAD witnesses must not inherit decoder state

T-SEG-05A (2026-09-06) added a fixed 20–40 second seam witness. Running it before existing no-VAD DTW separator requests changed previously accepted text/times. Moving it after them preserved the baseline but changed the witness enough to fail its unchanged evidence gate. Do not fix this by accepting favorable output, loosening the matcher, or trying more crops. Preserve the original request sequence and acquire a fresh inference state for each independent witness, using the pinned separator load identity; unused epochs may still be reused. The existing resource-pin, busy-lease, cancellation and cleanup fences apply.

The final actual six-file batch preserved every prior cue except the explicitly evidenced duplicate observation, with the same 24960–31230 ms resolution in short and full inputs. Fifty-six supervisor tests and eighty-seven executor tests passed, including request order, shared budget and fresh-witness startup failure. This is validated isolation of a observed same-mode effect, not identification or repair of its upstream native cause. A qualifying seam now costs an extra model load; cap it and report that tradeoff. See phase12 T-SEG-05A overlap implementation record.
