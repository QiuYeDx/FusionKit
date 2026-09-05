# FK-PIT-0115: Verify quiet input conditioning through native fallback and final output

## Area

Local subtitles / quiet audio.

## Triggers

Gain, VAD padding, soft limiter, long hallucination, fallback.

## Symptoms

Fixed gain plus more VAD context improves one whisper clip, but changes normal speech or creates a long spurious sentence in a neighboring clip. A peak-headroom-limited implementation can fail even when the original fixed-gain experiment succeeds.

## Root cause

VAD context and waveform amplitude jointly affect recognition. A few isolated transients can constrain whole-window gain. Display splitting can disguise a bad raw sentence as several acceptable short captions. Successful diagnostic output does not establish that the default executor forwards the same bytes and parameters.

## Do

- Bound gain, duration, RMS and limiting fraction; preserve sample positions, source identity and untouched normal-level PCM.
- Test the actual production waveform, speech and negative controls. Verify immutable window metadata and request snapshots carry conditional padding.
- Assess enhanced raw output before shaping. On risky long/repeated output, discard it and retry original audio once with ordinary padding; retain existing retry bounds.
- Exercise same-process native fallback as well as the default executor integration. Compare visible text/timing and quality decisions; keep probability differences as diagnostics.
- Serialize and parse final SRT/LRC. Report which samples improved, which are unchanged and which remain unresolved.

## Avoid

- Do not apply global gain from one favorable example or call empty output proof of silence.
- Do not silently substitute fixed-gain results for a different limiter implementation.
- Do not claim heldout accuracy when a discovered regression was used to tune the fallback, or when samples share a source and have no human transcript.
- Do not mistake a successful local build for an updated installed application.

## Validation

2026-09-05: production conditioning improved B from a 21-second wrong cue to one complete 2.86-second candidate and removed text from its annotated noise control. A/C remained unchanged. One added quiet window produced a roughly 12-second suspect cue; original-audio fallback restored its baseline text/timing in a live same-process test. Other added windows were not conditioned. 316 relevant tests passed, as did TypeScript, build and preload checks; 30 final SRT/LRC files were encoded and parsed. This is bounded regression evidence, not general word accuracy or frame accuracy.

## Related files

- electron/main/local-subtitle/quiet-audio.ts
- electron/main/local-subtitle/pcm-window.ts
- electron/main/local-subtitle/media-normalizer.ts
- electron/main/local-subtitle/production-executor.ts
- electron/main/local-subtitle/server-contract.ts
- electron/main/local-subtitle/server-supervisor.ts
- test/local-subtitle/productionExecutor.test.ts
- docs/v0.2.11/subtitle-quality-harness/phase10-quiet-audio-conditioning.md

## Human acceptance checkpoint

The next phase froze version 0.3.0-subtitle-preview.1 for user review. A different complete 176-second track produced 41 cues in each variant, with changes in text/timing and 5 original-audio fallbacks (7 requests versus 12). This established complete-track execution, not accuracy. Ship both comparison results, state the extra runtime cost, identify the executable version, and pause when the user requests a human acceptance checkpoint. Verify the packaged main matches the tested build; an isolated-profile startup check does not prove the user's existing models completed a desktop task.

Related acceptance record: docs/v0.2.11/subtitle-quality-harness/phase11-human-acceptance.md.
