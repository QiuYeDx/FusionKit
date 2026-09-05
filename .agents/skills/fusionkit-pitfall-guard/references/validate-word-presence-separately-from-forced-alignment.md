# FK-PIT-0112: Validate word presence separately from forced alignment

## Area

Local subtitles / fixed-text acoustic alignment.

## Triggers

Forced alignment, CTranslate2, DTW, word confidence, sparse speech, first word absorbs silence, wrong-text negative controls.

## Symptoms

A fixed-text aligner returns finite ordered timestamps for nonexistent text. A plausible text candidate has a long leading pause assigned to its first lexical token despite a relatively high mean conditional probability.

## Root cause

Forced alignment optimizes a path conditioned on supplied tokens; it is not independent confirmation that the tokens were spoken. Boundary/path constraints can absorb unused audio into a word or punctuation. A model score is not a calibrated statement about word presence or timing correctness.

## Do

- Preserve the exact supplied text, audio fingerprint, uncompressed time domain, model revision, and raw word/token evidence.
- Include nonverbal and deliberately unrelated-text controls before proposing automatic replacement.
- Review long lexical/punctuation spans and window-edge dependence separately from mean probability.
- Report model/compute type and encoding cache reuse when comparing runtime costs.
- Treat returned timestamps as candidates until text verification and acoustic onset evidence are adequate.

## Avoid

- Do not claim a correct alignment merely because all words received positive durations.
- Do not hide a long leading word by proportional or average-word-duration truncation and call it acoustic evidence.
- Do not transfer a small-model experiment's quality to full large-v3 or ship a threshold calibrated on one clip.

## Validation

Eight fixed-text CPU/int8 small-model experiments on 2026-09-05 preserved their input text. One B candidate assigned 23.56 seconds to its first word while mean lexical probability was about 0.718. Nonverbal and unrelated-text controls also returned timelines. No automatic replacement was accepted; the original ASR runtime remained unchanged.

Phase 7 added 22 encodings / 42 fixed-text audio-ablation scores on the same isolated small model. A nonverbal false-word control scored higher on real audio than equal-length silence (mean log contrast +1.4737); an unrelated sentence showed a first-token masking peak despite negative whole-text contrast. Audio dependence and local masking peaks are therefore review signals, not independent word verification or exact onset. Six Python tests cover masking invariants, score validation, budgets, origin mapping, non-acceptance and output protection. All three workspace WAV fingerprints were unchanged.

Phase 12 added full large-v3 free-decoding controls. A conditioned nonverbal input produced false words with positive, in-parent, text-covering word intervals: structural validity still did not establish speech presence. Other candidates returned zero-duration words and multi-second lexical spans. Six offline audit tests preserve the non-acceptance contract. The user's FP32-stored model and the official FP16-stored candidate had identical tensor names/shapes; the same user model at explicit FP16 and FP32 compute produced identical text and segment boundaries on all three fixed inputs. Record storage dtype, actual compute type, model configuration and runtime version separately; larger files alone do not establish greater model capacity or quality. This finding does not establish numerical weight equality or universal precision equivalence.

## Separate whisper.cpp DTW points from ordinary word edges

In phase12 T-SEG-03D/03E (2026-09-06), ordinary word edges drifted 540/600 ms across fixed shifted crops despite exact local text. The existing runtime's separately enabled DTW points were stable within 20/40 ms on two boundaries. Neither figure is a measured onset error. Native `t_dtw` is a token-interior point in 10 ms units, distinct from verbose_json `start/end`; preserve that semantic distinction in contracts and review pages.

At pinned commit f049fff95a089aa9969deb009cdd4892b3e74916, enabling flash attention disables DTW. The capability probe must use a fresh `--dtw large.v3 --no-flash-attn` process and inspect effective data; do not claim that setting token_timestamps alone enables DTW. Production load identity must include these context-level modes if adopted. See [pinned native initialization](https://github.com/ggml-org/whisper.cpp/blob/f049fff95a089aa9969deb009cdd4892b3e74916/src/whisper.cpp#L3404).

Keep every planned crop in the comparison, validate -1/uncomputed, units, original-media offsets, ordering and collapsed adjacent points, and require entire exact candidate groups rather than extracting matching substrings through wrong words. A nonverbal DTW control still produced repeated false words; stable alignment cannot authorize a replacement transcript. The offline audit's automaticAcceptance remains false. Sixteen ordinary/DTW audit tests and thirteen existing local-evidence tests passed; a two-cut listening proposal preserved the actual baseline SRT text and was not shipped as production timing.

## Related files

- `electron/main/local-subtitle/local-review.ts`
- `docs/v0.2.11/subtitle-quality-harness/phase6-forced-alignment.md`

- `scripts/local-subtitle/benchmark/acoustic-grounding.py`
- `docs/v0.2.11/subtitle-quality-harness/phase7-acoustic-grounding.md`
