# FK-PIT-0011: Resolve ASR constraints from the complete route

## Area

Audio ASR registry, renderer field visibility, Electron main validation, and adapters.

## Triggers

- transcription, Whisper, GPT transcribe, custom OpenAI-compatible
- provider preset, route model, response format, stream, timestamps
- renderer accepts a field that main rejects, or main accepts a field the adapter rejects

## Symptoms

- `whisper-1` cannot submit text, subtitle, verbose JSON, or timestamp options even though the
  adapter supports them.
- GPT transcription incorrectly exposes Whisper-only formats or timestamps.
- Main accepts streaming for Whisper, then the adapter rejects it later.
- A custom OpenAI-compatible model inherits built-in OpenAI assumptions instead of a portable
  minimum contract.

## Root cause

An audio API profile identifies the connection provider, but the enabled route identifies the
actual transport and model. OpenAI GPT transcription and Whisper share a provider and endpoint
family while having different response format, streaming, and timestamp contracts. Provider-only
constraint lookup therefore loses the information needed to validate the task.

## Do

- Resolve ASR constraints from `providerPreset + route.transport + route.model`.
- Use the same route-aware resolver in renderer normalization/visibility, main IPC validation,
  and adapter defense-in-depth checks.
- Keep explicit matrices for GPT transcription, Whisper, MiMo ASR, and unknown compatible models.
- Fail closed for an unknown model under the built-in OpenAI preset; use the documented portable
  minimum only for custom OpenAI-compatible profiles.
- Test two different models under the same provider preset so provider-only regressions are visible.

## Avoid

- Do not call a transcription constraint helper with only the provider preset.
- Do not infer Whisper behavior from the `openai_audio` transport alone.
- Do not keep separate renderer, main, and adapter model-family tables.
- Do not treat a configured route as usable until its transport/model combination resolves.

## Validation

```text
node_modules/.bin/vitest run src/lib/audio-provider-registry.test.ts src/store/tools/audio/audioTranscriberConfig.test.ts test/audio/audioIpcService.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

Confirm GPT transcription exposes JSON + stream without timestamps, Whisper exposes legacy
formats + timestamps without stream, MiMo exposes its constrained language/format set, custom
unknown models use the portable contract, and unknown built-in OpenAI models fail closed.

## Related files

- `src/lib/audio-provider-registry.ts`
- `src/store/tools/audio/audioTranscriberConfig.ts`
- `src/pages/Tools/Audio/AudioTranscriber/index.tsx`
- `electron/main/audio/ipc.ts`
- `electron/main/audio/adapters/openai-audio-adapter.ts`
