# FK-PIT-0129: Give combined row states one visual surface

## Area
Frontend / selectable lists / interactive state composition

## Triggers
Nested hover and selection highlights, preview-current button inside multiselect row, checkbox excluded from hover background.

## Symptoms
The checkbox and text belong to a large selected surface, while a smaller preview button adds another background for hover or current state. Their different edges and rounded corners create a visibly nested highlight.

## Root cause
Preview interaction originally owned the button background. Adding an outer multiselect state left both surfaces active, including older CSS rules with matching or greater specificity.

## Do
Let the common row wrapper own hover/current/selection backgrounds. Keep its inner controls transparent, including legacy hover and current selectors. Retain independent interaction semantics: checkbox changes selection, name button changes preview, and a small current indicator distinguishes the preview. Put keyboard focus on the same row boundary using focus-visible, and keep spacing between adjacent highlighted rows.

## Avoid
Do not layer two accent backgrounds, remove hover feedback, or shrink the interactive text area to disguise the mismatch. Check the final cascade rather than relying on a new transparent declaration that an older selector overrides.

## Validation
In isolated Electron, show adjacent current+selected, selected-only, and hovered rows. Inspect actual screenshots in light and dark themes and assert inner button background is transparent, only the wrapper paints the state, and row gaps remain. Verify checkbox and preview still perform distinct actions.

## Related files
- src/pages/Tools/Subtitle/SubtitleStudio/StudioLibrary.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/studio.css
- test/subtitle-studio/library-ui.test.ts
