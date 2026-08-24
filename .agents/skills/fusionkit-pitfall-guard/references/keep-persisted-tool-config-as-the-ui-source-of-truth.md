# FK-PIT-0102: Keep persisted tool config as the UI source of truth

## Area

Frontend state / Zustand persistence / tool configuration

## Triggers

config resets after restart, persisted preferences, hydration, page-local `useState`,
legacy `localStorage` keys, mount effect, double source of truth

## Symptoms

- A persisted Zustand Store contains the user's last configuration, but the tool
  renders defaults after an application restart.
- A page initializes local state from removed legacy keys and then writes those
  defaults into the new persisted Store from an effect.
- Some fields survive restart while adjacent controls reset because `partialize`
  omitted part of the visible configuration.

## Root cause

Reusable configuration is owned by more than one state layer. Hydration succeeds,
but page-local initializers or synchronization effects treat their default values as
authoritative and overwrite the hydrated Store. Separately, a Store can appear
persisted while its whitelist covers only some of the controls shown in the panel.

## Do

- Make one sanitized persisted Store the direct source of truth for every reusable
  control on the tool page.
- Persist a complete, explicit preference whitelist and version it when the shape
  changes.
- Keep file/directory capabilities, task queues, results, errors, request IDs, and
  other runtime state outside that whitelist and reset them during merge.
- Migrate legacy keys before Store hydration, then stop reading or writing those keys
  from the page component.
- Test a real storage envelope across module reload and assert both restored
  preferences and discarded runtime/private fields.

## Avoid

- Do not mirror persisted preferences into page-local `useState` plus a write-back
  effect.
- Do not assume `persist(...)` means every visible configuration field is included in
  `partialize`.
- Do not persist raw file objects, capability tokens, task content, selected paths,
  plans, or errors merely to preserve nearby preferences.
- Do not keep writing migrated legacy keys for compatibility after the new Store owns
  the configuration.

## Validation

- Reload the Store module with a populated localStorage envelope and verify all
  visible preferences hydrate exactly.
- Verify dirty envelopes cannot restore task queues, selected paths, plans, errors,
  file content, or capability tokens.
- Search the page for direct access to superseded legacy keys.
- Run the affected Store tests, `tsc --noEmit`, and the root Vite build.

## Related files

- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `src/store/tools/subtitle/useSubtitleTranslatorConfigStore.ts`
- `src/store/tools/subtitle/useLocalSubtitleTranscriberStore.ts`
- `src/store/tools/subtitle/useSubtitleConverterStore.ts`
- `src/store/tools/rename/useNameTranslatorStore.ts`
