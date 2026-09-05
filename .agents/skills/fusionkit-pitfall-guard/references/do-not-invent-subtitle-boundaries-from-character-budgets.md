# FK-PIT-0116: Do not invent subtitle boundaries from character budgets

## Area

Local subtitles / sentence segmentation / timing evidence.

## Triggers

Japanese word cut in half, unpunctuated phrases, seven-second cue limit, character-proportional timestamps, grapheme-safe output, readable subtitle acceptance.

## Symptoms

The original ASR returns an unpunctuated long segment. A formatter enforces display duration by dividing its text into near-equal character groups, producing word fragments with plausible but invented internal timestamps. All Unicode, duration, text-conservation and parse-back tests pass.

## Root cause

Display budgets were treated as permission to introduce semantic and acoustic boundaries. Grapheme segmentation only preserves Unicode clusters. A tiny punctuation bonus in a length-balancing score does not prioritize sentence boundaries. Missing punctuation may already exist in raw ASR; CJK concatenation in a later merger is a separate cause and must not be blamed without evidence.

## Do

- Compare raw native response, owned-window projection, canonical cues and final SRT/LRC before selecting a fix. Record whether splitting, short-cue merging and boundary trimming actually ran.
- Separate textual break eligibility, acoustic time evidence, cue planning and same-cue visual wrapping. Do not let line length create new timestamps.
- Treat duration/character preferences as soft when no supported internal cut exists, while retaining actual format/resource hard limits. Preserve the raw segment and report the limitation.
- Require provenance for new timestamps. Native word or token fields also need original-time mapping and text-position validation; Japanese token units need language boundary protection.
- Keep source positions and original punctuation unchanged during layout. Use explicit continuation/separate-sentence/unknown join decisions, not CJK script detection as semantic proof.
- Add human-readable language fixtures and real final-output checks. Clearly distinguish stopping formatter damage from resolving raw ASR sentence/timing errors.

## Avoid

- Do not use character-proportional timing or enlarge the duration limit and call the whole issue fixed.
- Do not treat VAD boundaries, missing punctuation, word probabilities or successful forced alignment alone as proof of sentence boundaries or spoken content.
- Do not enable compressed VAD token timelines to address punctuation.
- Do not compare bilingual reference row counts to monolingual cue counts as an accuracy metric, or reuse another tool's LRC starts as exact acoustic truth.

## Validation

On 2026-09-05, two local full large-v3/CUDA/VAD requests over a 55-second opening reproduced all six user-reported LRC lines exactly. The first raw segment was 28 characters over 14.09 seconds; the default 7000 ms limit forced 9/10/9 characters and generated 7029/12061 ms boundaries. A second 38-character, 8.37-second segment produced a 20775 ms boundary. There were two split raw segments, five estimated cues and zero short-cue merges. Raising only the limit to 15000 ms removed the word cuts but retained unreadable unpunctuated blocks. All three NAS file hashes were unchanged, four exported subtitles parsed back, and the native process exited. This is diagnosis evidence; the replacement planner was not implemented in that turn.

## Related files

- `electron/main/local-subtitle/subtitle-post-processor.ts`
- `electron/main/local-subtitle/server-contract.ts`
- `electron/main/local-subtitle/subtitle-formats.ts`
- `test/local-subtitle/subtitlePostProcessor.test.ts`
- `docs/v0.2.11/subtitle-quality-harness/phase12-sentence-boundaries/requirements.md`
- `docs/v0.2.11/subtitle-quality-harness/phase12-sentence-boundaries/design.md`
