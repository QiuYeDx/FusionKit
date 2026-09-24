# FK-PIT-0182: Keep translation result names separate from execution identity

- Area: Subtitle Studio / translation metadata / naming
- Triggers: custom result name, rename track, frozen checkpoint, reuse settings, long selector label

## Symptoms

Adding editable result names can accidentally change a task checkpoint, leak local labels to model prompts, reuse a file-specific name on the next translation, or overflow a compact selector.

## Root cause

A result name is mutable presentation metadata. Track IDs, content revisions, task configuration and execution records have independent identity and integrity rules.

## Do

- Store an optional name on the track. Keep old documents valid and retain the language-and-ordinal fallback when absent.
- Accept an optional name for the next translation, but exclude it from reusable settings and model requests.
- Rename through a guarded repository transaction using the document revision and track ID. Reject active translation tasks and stale revisions.
- Change only track.name and the document revision; preserve track content revisions, cue entries, task configuration and execution records.
- Use one formatter in preview, batch export selection and clear confirmation. Clip compact triggers with ellipsis; allow full names to wrap in options and confirmations.
- Verify native create, cancel rename, save, restart persistence, clear-to-automatic, long names and removal of the correct track.

## Avoid

- Rewriting immutable execution records to reflect a current display name.
- Treating a result name as a filename, model instruction, or unique identifier.
- Reusing a custom name as a default for unrelated documents.

## Validation

- Unit: translation-service.test.ts, knowledge-translation.test.ts, knowledge-batch-translation.test.ts.
- Electron: FUSIONKIT_STUDIO_E2E=1 with test/subtitle-studio/remove-translation-ui.test.ts.
- Inspect light/dark screenshots under test-results/studio-remove-translation.

## Related files

- src/subtitle-studio/domain.ts
- electron/main/subtitle-studio/translation-track-service.ts
- src/services/subtitle-studio/translation-draft.ts
- src/pages/Tools/Subtitle/SubtitleStudio/StudioRenameTranslation.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioControls.tsx
