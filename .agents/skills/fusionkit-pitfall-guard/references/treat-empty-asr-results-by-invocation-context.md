# FK-PIT-0018: Treat empty ASR results by invocation context

## Area

Audio realtime captions / Electron runtime adapters

## Triggers

MiMo, realtime captions, empty response, silence, recorded chunk, ASR

## Symptoms

Realtime captions stop with an empty-response error after the user stays silent for one chunk,
even though microphone capture and the provider request both succeeded.

## Root cause

File transcription and fixed-duration caption chunks shared the same adapter rule: an empty ASR
text result always became `empty_response`. That is correct for a user-requested file task, but a
five-second realtime chunk can legitimately contain no speech. Once converted to a generic error,
the renderer cannot distinguish silence from a malformed provider response.

## Do

- Carry a trusted main-only invocation option into the adapter for recorded caption chunks.
- Allow empty text only in that narrow path and return a normal result with `text: ""`.
- Let the renderer skip the empty line and keep the recorder and serial queue alive.
- Continue failing on authentication, payment, permission, rate limit, network, parameter, parse,
  and invalid-response errors.
- Keep ordinary file transcription strict so an empty result remains actionable there.

## Avoid

- Do not globally remove the adapter's empty-response check.
- Do not classify every `empty_response` from every audio task as silence.
- Do not retry a normal silent chunk as though it were a transient network failure.

## Validation

```text
node_modules/.bin/vitest run test/audio/audioRuntimeClient.test.ts test/audio/audioIpcService.test.ts
node_modules/.bin/vitest run test/e2e.spec.ts -t 'route-aware realtime captions' --reporter=dot
```

Confirm a silent chunk produces no subtitle and does not stop the session, a later voiced chunk is
still appended, and a provider 402 or authentication error still fails the session.

## Related files

- `electron/main/audio/audio-runtime-client.ts`
- `electron/main/audio/ipc.ts`
- `electron/main/audio/adapters/mimo-chat-audio-adapter.ts`
- `src/pages/Tools/Audio/RealtimeCaptions/index.tsx`
