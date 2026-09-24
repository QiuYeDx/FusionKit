# FK-PIT-0180: Name the record being removed, not its parent file

- Area: Subtitle Studio / destructive confirmation / record identity
- Triggers: clear translation shows filename, translation selector label, multiple tracks, oversized confirmation text

## Symptoms

The clear-translation confirmation repeats the document filename, even though the action removes one selected translation record. A generic filename component inherits a large body font and gives the wrong object visual emphasis.

## Root cause

The confirmation reused the document displayName instead of the active translation identity. The selector constructed its language-and-ordinal label independently, making inconsistent naming easy.

## Do

- Share one record-name formatter between the translation selector, per-document selectors and the removal confirmation, including the localized unknown-language fallback.
- Show a compact label/value row with explicit typography. Keep filenames for operations that actually target a file or document.
- Preserve the existing document revision and track ID checks, identity-change dismissal and default Cancel focus.
- Verify with two tracks on one document: cancel keeps both; confirm for record 2 removes only its ID and tasks while preserving record 1, source cues and the source file.

## Avoid

- Using a parent filename as the sole identity of a nested record action.
- Recreating the selector label with a different ordering, ordinal or fallback.
- Adding destructive actions or weakening stale-revision checks during visual cleanup.

## Validation

FUSIONKIT_STUDIO_E2E=1 node node_modules/vitest/vitest.mjs run test/subtitle-studio/remove-translation-ui.test.ts

Inspect wide/light and narrow/dark screenshots under test-results/studio-remove-translation. The fixture generates both tracks through native IPC against a local synthetic server.

## Related files

- src/pages/Tools/Subtitle/SubtitleStudio/StudioBilingual.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioBilingual.css
- src/pages/Tools/Subtitle/SubtitleStudio/StudioControls.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/index.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioPlanDocuments.tsx
- test/subtitle-studio/remove-translation-ui.test.ts
