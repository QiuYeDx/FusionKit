# FK-PIT-0107: Keep subtitle context provenance explicit

## Area

Subtitle translation / prompts / sequential and concurrent context.

## Triggers

Previous translated content, preceding source fragment, inconsistent names, glossary, translation harness, concurrent windows, semantic memory.

## Symptoms

The model is told it received an earlier translation, but the caller supplies the earlier source fragment. Sequential execution therefore does not provide previously adopted target-language terminology. Concurrent windows cannot depend on translations that have not committed.

## Root cause

A generic context string hides the distinction between source text, committed model translations and user-confirmed terminology. In the original reviewed code both scheduling paths passed `fragments[index - 1]`, while both format prompts called it translated content.

## Do

- Trace prompt inputs from caller to renderer before trusting comments or labels.
- Model source context, committed translations, task memory and confirmed terminology as separate inputs.
- Label model translations as model output, not human confirmation.
- Advance sequential memory only after the corresponding translation commits.
- Freeze shared context for parallel windows and merge candidate updates in source order.
- Preserve context and prompt revisions in checkpoints.
- Bound source and translation references separately, retaining complete subtitle units.
- Share runtime prompt construction with token estimation; reserve unknown translated context honestly rather than counting only the previous source.

## Avoid

- Do not call original subtitles previous translations.
- Do not invent prior translation context for concurrent requests.
- Do not let one model output become permanent confirmed knowledge merely through repetition.
- Do not mistake nonempty valid-looking SRT text for exact source-cue coverage.

## Validation

Capture two-window requests for sequential, parallel and resumed execution. Verify each context block against its actual source, confirm readonly cue IDs cannot appear in output, and check that failed windows do not advance memory. Request-level tests prove context provenance and scheduling, not translation accuracy or source-cue coverage.

## Related files

- `electron/main/translation/class/base-translator.ts`
- `electron/main/translation/class/srt-translator.ts`
- `electron/main/translation/class/lrc-translator.ts`
- `electron/main/translation/checkpoint.ts`
- `docs/v0.2.11/subtitle-quality-harness/finesub-review-and-proposal.md`

## Implementation status (2026-09-05)

Phase 1 now uses typed, separately labelled source and committed model-translation contexts, each bounded to 500 local-tokenizer tokens. Sequential and resumed requests use only the immediate resolved predecessor; concurrent requests are source-only regardless of completion order. The prompt builder is shared with preflight estimation. `test/translation/subtitle-context.test.ts` covers both formats, retry and recovery. Checkpoint v2 remains compatible: completed fragments are retained and only new requests receive the new prompt. Exact historical prompt snapshots and persistent terminology memory remain future work. Strict cue structure is implemented in the phase-2 follow-up below. See `docs/v0.2.11/subtitle-quality-harness/phase1-design-and-execution.md`.

## Phase-2 follow-up (2026-09-05)

Models now return fragment-scoped cue IDs and target-language lines only; the program rebuilds timestamps, metadata and bilingual source text. Structural errors use the existing bounded retry owner. Before resume, validate committed subtitle structure against source: requeue invalid entries while retaining their old translation field until a replacement commits, and never expose pending old translations as context. Keep parsing and splitting consistent for Windows SRT CRLF and preserve blank LRC lines without creating empty checkpoint fragments. Request tests cover these paths; valid IDs/line counts still cannot prove semantic accuracy.
