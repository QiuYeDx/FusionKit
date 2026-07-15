# FK-PIT-0016: Keep finite provider options in shared route constraints

## Area

Audio route constraints / parameter errors

## Triggers

TTS,voice,MiMo,alloy,invalid parameter,provider 400,allowlist

## Symptoms

Finite provider options such as MiMo preset voices must live in the shared route contract and be enforced by renderer, main, and adapter with field-aware errors.

## Root cause

A text input plus suggestion buttons looks flexible, but it does not express
that some provider parameters are closed sets. A persisted value from another
provider can therefore survive a route switch and reach the supplier. If main
validates only whether the field exists, the supplier returns a generic 400
and the renderer cannot name the bad parameter.

## Do

- Put finite option sets on the route constraints that already define mode,
  formats, streaming, and field availability.
- Render a select/menu for a closed set and retain free text only for routes
  that explicitly allow arbitrary IDs.
- Treat an out-of-list persisted value as invalid and require the user to
  choose; do not silently overwrite a preference shared with another provider.
- Enforce the same allowlist in renderer preflight, Electron main validation,
  and adapter defense-in-depth.
- Preserve an allowlisted `field` on task errors and translate it to a
  user-facing parameter label.
- When a provider 400/422 includes `param` or `field`, map only known safe
  paths; never expose the whole response body.

## Avoid

- Do not model a closed provider option as a free text field with cosmetic
  shortcuts.
- Do not keep separate voice lists in the page, main process, and adapter.
- Do not silently coerce `alloy` to `mimo_default`; that hides a cross-provider
  persistence problem and can break the value again when switching back.
- Do not infer arbitrary provider fields from free-form error text.

## Validation

```text
node_modules/.bin/vitest run src/lib/audio-provider-registry.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts test/audio/audioIpcService.test.ts test/audio/audioRuntimeClient.test.ts test/audio/audioErrors.test.ts src/pages/Tools/Audio/shared/audioErrorMessage.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

In Electron, seed an invalid persisted voice, confirm the field-level error and
disabled submit state, then select a supported voice and verify the exact
provider request.

## Related files

- `src/lib/audio-provider-registry.ts`
- `src/store/tools/audio/speechSynthesizerConfig.ts`
- `src/pages/Tools/Audio/SpeechSynthesizer/index.tsx`
- `electron/main/audio/ipc.ts`
- `electron/main/audio/adapters/mimo-chat-audio-adapter.ts`
- `electron/main/audio/audio-http.ts`
- `src/pages/Tools/Audio/shared/audioErrorMessage.ts`
