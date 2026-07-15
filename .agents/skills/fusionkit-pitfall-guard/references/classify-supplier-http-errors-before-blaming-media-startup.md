# FK-PIT-0015: Classify supplier HTTP errors before blaming media startup

## Area

Audio / Electron diagnostics

## Triggers

realtime captions,MiMo,HTTP 402,insufficient balance,SetApplicationIsDaemon,request rejected

## Symptoms

A macOS audio warning can coincide with a supplier rejection; probe the sanitized HTTP status and map actionable billing errors instead of reporting a generic request rejection.

## Root cause

Electron/Chromium may print a CoreAudio or macOS service warning while
`getUserMedia` initializes. A chunked caption session then sends its first
recorded WAV several seconds later, so an unrelated supplier HTTP failure can
appear immediately below that warning in the terminal. If the HTTP classifier
folds an actionable status such as 402 into a generic non-retryable error, the
UI reinforces the wrong diagnosis.

## Do

- Identify the resolved realtime mode before tracing the failure. MiMo captions
  use recorded WAV chunks and ASR HTTP requests, not native WebRTC.
- Establish the boundary where failure occurs: microphone acquisition,
  recording/encoding, IPC validation, or supplier HTTP response.
- For a real-provider probe, reuse the configured endpoint and request shape,
  but report only the status and sanitized provider error code/message. Never
  print the API key, audio bytes, Base64 data URI, or complete request body.
- Give stable semantics to actionable statuses such as HTTP 402 and map them to
  localized remediation text.
- Keep raw status and attempt metadata in sanitized error details for tests and
  diagnostics.

## Avoid

- Do not treat temporal adjacency in terminal output as proof of causality.
- Do not change microphone or WAV code when the first recorded chunk reached
  the supplier and received a structured HTTP response.
- Do not expose a supplier's raw error body directly in the primary UI.
- Do not retry payment or balance failures; the external account state must
  change first.

## Validation

```text
node_modules/.bin/vitest run test/audio/audioRuntimeClient.test.ts src/pages/Tools/Audio/shared/audioErrorMessage.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
git diff --check
```

For an authorized real-provider diagnosis, confirm that the probe output is
limited to HTTP status plus sanitized error metadata, and remove any temporary
audio file afterward.

## Related files

- `electron/main/audio/audio-http.ts`
- `electron/main/audio/adapters/mimo-chat-audio-adapter.ts`
- `src/pages/Tools/Audio/shared/audioErrorMessage.ts`
- `src/pages/Tools/Audio/RealtimeCaptions/index.tsx`
- `src/type/audioIpc.ts`
