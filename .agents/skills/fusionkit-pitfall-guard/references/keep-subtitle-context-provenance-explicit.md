# FK-PIT-0107: Keep subtitle context provenance explicit

## Area

Subtitle translation / prompts / sequential and concurrent context.

## Triggers

Previous translated content, preceding source fragment, inconsistent names, glossary, translation harness, concurrent windows, semantic memory.

## Symptoms

The model is told it received an earlier translation, but the caller supplies the earlier source fragment. Sequential execution therefore does not provide previously adopted target-language terminology. Concurrent windows cannot depend on translations that have not committed.

## Root cause

A generic context string hides the distinction between source text, committed model translations and user-confirmed terminology. In the reviewed code both scheduling paths pass `fragments[index - 1]`, while both format prompts call it translated content.

## Do

- Trace prompt inputs from caller to renderer before trusting comments or labels.
- Model source context, committed translations, task memory and confirmed terminology as separate inputs.
- Label model translations as model output, not human confirmation.
- Advance sequential memory only after the corresponding translation commits.
- Freeze shared context for parallel windows and merge candidate updates in source order.
- Preserve context and prompt revisions in checkpoints.
- Treat this case as a diagnosed design gap until the implementation and request-level tests change.

## Avoid

- Do not call original subtitles previous translations.
- Do not invent prior translation context for concurrent requests.
- Do not let one model output become permanent confirmed knowledge merely through repetition.
- Do not mistake nonempty valid-looking SRT text for exact source-cue coverage.

## Validation

Capture two-window requests for sequential, parallel and resumed execution. Verify each context block against its actual source, confirm readonly cue IDs cannot appear in output, and check that failed windows do not advance memory. Existing base-translator tests do not prove semantic context quality.

## Related files

- `electron/main/translation/class/base-translator.ts`
- `electron/main/translation/class/srt-translator.ts`
- `electron/main/translation/class/lrc-translator.ts`
- `electron/main/translation/checkpoint.ts`
- `docs/v0.2.11/subtitle-quality-harness/finesub-review-and-proposal.md`
