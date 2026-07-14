# FK-PIT-0013: Resolve realtime execution mode from the complete route

## Area

Audio realtime routing

## Triggers

realtime captions,capability,WebRTC,chunked ASR,provider preset,transport,route model

## Symptoms

A generic realtime transcription capability cannot distinguish native WebRTC captions from chunked ASR; resolve the mode and fields from provider preset plus transport plus route model.

## Root cause

The task capability only says that realtime captions are available. It does not
say how they run. In FusionKit, an OpenAI `openai_realtime` route creates a
native WebRTC transcription session, while a MiMo `mimo_chat_audio` route
records short WAV chunks and sends them through ASR. Collapsing both routes to
`realtime_transcription` loses the transport, model contract, allowed
languages, and cleanup strategy.

## Do

- Resolve realtime constraints from `providerPreset + assignmentKey +
  transport + route.model`.
- Share the route definition between renderer field visibility and main IPC
  validation.
- For chunked captions, derive language choices from the same route-aware ASR
  definition used by main; MiMo currently accepts only `auto`, `zh`, and `en`.
- Include profile and route identity in the active session snapshot. Abort and
  release the old session when assignment, provider, transport, model, or
  enabled state changes.
- Test native WebRTC and chunked ASR under the same high-level capability so a
  capability-only regression is visible.

## Avoid

- Do not infer WebRTC from `realtime_transcription` or other generic
  capabilities.
- Do not feed legacy `audioDialect + capabilities` helpers from a standalone
  profile.
- Do not use provider-only realtime constraints when the same provider can
  expose multiple transports or models.
- Do not expose a broad language list for chunked ASR when main validates a
  narrower route-specific set.

## Validation

```text
node_modules/.bin/vitest run src/lib/audio-provider-registry.test.ts src/store/tools/audio/realtimeCaptionsConfig.test.ts test/audio/audioIpcService.test.ts
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'route-aware realtime captions' --reporter=dot
git diff --check
```

Confirm OpenAI renders native Realtime controls, MiMo renders a non-WebRTC
chunk notice with only `auto/zh/en`, mismatched or unknown built-in routes fail
closed, and renderer/main resolve the same mode and field contract.

## Related files

- `src/lib/audio-provider-registry.ts`
- `src/store/tools/audio/realtimeCaptionsConfig.ts`
- `src/pages/Tools/Audio/RealtimeCaptions/index.tsx`
- `electron/main/audio/realtime-ipc.ts`
- `test/audio/audioIpcService.test.ts`
- `test/e2e.spec.ts`
