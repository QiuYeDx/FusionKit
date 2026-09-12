# FK-PIT-0132: Verify fork isolation with real branded capabilities

## Area

Subtitle Studio / transcription inheritance / capability isolation.

## Triggers

Mechanical copy, paired replay, WeakMap, WeakSet, branded PCM, validateWindowBrand, fake harness.

## Symptoms

Two copies produce identical transcripts, but the test does not prove that one copy rejects the other's backend, runtime or PCM capabilities.

## Root cause

An algorithm harness can deliberately disable some brand checks to inject synthetic inference windows. The inherited executor helper does this for window validation. Reusing that helper alone for an isolation claim bypasses the property being tested. Identical type names and Symbol descriptions also do not establish whether registries are shared.

## Do

- Bundle frozen Git sources and actual new sources into separate application module trees. Permit shared dependency packages, but check every application input stays in its own tree.
- Use the same deterministic inputs and compare full transcripts, requests, windows, retries and cleanup. Add explicit expected-path assertions so two copies taking the same wrong path cannot pass.
- Separately issue real backend, accelerator, batch and PCM/window proofs on both sides. Verify each proof works on its own side, then pass it to the other side's real consumer and assert rejection before work begins.
- For PCM tests, use the real normalizer with an injected process runner writing synthetic WAV data. Keep its actual brand checks enabled and supply the complete expected task/generation/window binding to consumers.
- Run all fixture cleanup actions even if one fails, and surface cleanup failure in the test evidence.

## Avoid

- Do not treat copy hashes, TypeScript assignability, or a predicate stub returning true as proof of runtime isolation.
- Do not normalize whole transcript strings or drop word/timing evidence just to make replay equality pass.
- Do not claim native ASR, GPU or real-audio equivalence from synthetic replay.

## Validation

Run `test/subtitle-studio-provenance/replay.test.ts`. Require the replay scenarios and all four bidirectional real-consumer capability tests to pass; confirm generated evidence reports complete cleanup. Ordinary tests under `test/subtitle-studio/transcription/` must remain independent of migration helpers and the legacy worktree.

## Related files

- `test/subtitle-studio-provenance/replay-harness.mjs`
- `test/subtitle-studio-provenance/replay.test.ts`
- `electron/main/subtitle-studio/transcription/native/media-normalizer.ts`
- `docs/features/subtitle-studio/records/2026-09-11-transcription-copy-replay.md`
