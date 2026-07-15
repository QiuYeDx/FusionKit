# FK-PIT-0021: Keep local subtitle transcription separate from remote audio ASR

## Area

Subtitle tools / local inference / Electron native runtime architecture.

## Triggers

local Whisper, faster-whisper, whisper.cpp, local GPU, Metal, batch media transcription, SRT/LRC generation, 烤肉, 本地字幕转写

## Symptoms

- A local Whisper feature is added as another provider, mode, or route inside `/tools/audio/transcriber`.
- Local model paths, GPU settings, model downloads, FFmpeg, or native sidecar state enter the remote Audio API profile and IPC contracts.
- Subtitle-oriented batch jobs inherit remote API file limits, response-format constraints, or provider routing.
- Changes for local inference cause regressions in the existing OpenAI/MiMo audio transcription tool.

## Root cause

Both features can be described as “audio to text,” but their product and runtime contracts are different. The existing AudioTranscriber is a general remote API client resolved from provider routes. Local subtitle transcription owns native executables, device probing, multi-gigabyte models, long-running batch jobs, media normalization, canonical timelines, subtitle post-processing, and SRT/LRC artifacts. Treating a local engine as an audio provider couples unrelated configuration, lifecycle, validation, and packaging concerns.

## Do

- Add local subtitle transcription as a separate subtitle-category tool, route, Store, type family, preload bridge, IPC namespace, main runtime, queue, model manager, and exporter set.
- Keep the renderer task contract engine-neutral and local-runtime-specific; do not reuse Audio API profiles or assignments.
- Reuse only infrastructure without audio-provider semantics, such as shared tool layout components and the sender-bound capability pattern.
- Connect the tools through a narrow generated-subtitle artifact handoff contract, not shared mutable Stores.
- Keep generated artifact and output-directory references opaque through the subtitle translation runtime; resolve paths only in Electron main, adapting the legacy task shape there instead of exposing renderer paths.
- Let a subtitle-translator-owned import coordinator snapshot current translation settings and optionally start only the task IDs confirmed by the current import receipt.
- Add tests proving local-subtitle channels and payloads cannot enter `audio:*` runtime routes and vice versa.

## Avoid

- Do not add a `local`, `whisper_cpp`, or `faster_whisper` provider preset to the existing remote AudioTranscriber.
- Do not extend `AudioIpcService.transcribe()` with executable paths, model paths, GPU flags, or batch subtitle fields.
- Do not share persisted preferences or token registries when their TTL and lifecycle semantics differ.
- Do not exchange a one-time artifact or directory token for a renderer-visible path merely to populate legacy `originFileURL`/`targetFileURL` fields.
- Do not call `startAllTasks()` after an automatic handoff; it can start unrelated tasks that were already waiting in the subtitle translator queue.
- Do not describe remote API SRT output and local subtitle generation as interchangeable merely because both may produce text with timestamps.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle test/audio
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
git diff --check
```

Confirm that the local tool uses its own `/tools/subtitle/local-transcriber` route and `local-subtitle:*` channels, the existing `/tools/audio/transcriber` route remains provider/API-only, and the only cross-tool integration is a typed subtitle artifact handoff whose source/target references stay opaque outside Electron main. If automatic translation is enabled, verify that the translator-owned coordinator captures its own configuration and starts only task IDs returned by that handoff, never the pre-existing queue.

## Related files

- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `src/pages/Tools/Audio/AudioTranscriber/index.tsx`
- `src/services/audio/audioTranscriptionService.ts`
- `electron/main/audio/ipc.ts`
- Planned: `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/`
- Planned: `electron/main/local-subtitle/`
