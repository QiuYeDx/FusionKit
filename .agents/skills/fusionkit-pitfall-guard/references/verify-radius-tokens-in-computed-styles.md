# FK-PIT-0118: Verify radius tokens in computed styles

## Area
Frontend / Tailwind / visual QA.

## Triggers
rounded-2xl, square dialog corners, custom radius tokens.

## Symptoms
A dialog with `rounded-2xl` renders with square corners despite a valid generated utility.

## Root cause
`src/index.css` includes `--radius-2xl: var(--radius-2xl)`. This self-reference does not supply a usable value; the expected utility name is not proof that a resolved radius exists.

## Do
Inspect computed border radius and the underlying token. For a scoped redesign, use an explicit radius such as `rounded-[20px]` when there is no valid shared token. Wait for dialog opening transitions to settle before capturing screenshots.
Also verify the computed radius of native disclosure controls and their keyboard focus surface. In the selected-document preview, a summary with `border-radius: inherit` resolved to 0px while its details parent resolved to 10px. Referencing the valid project token explicitly, with the inset border accounted for, restored the intended contour. Do not assume DOM-parent radius inheritance has produced the expected rendered value, or remove focus feedback to hide the defect.

## Avoid
Do not infer correct styling from class names alone or change all global tokens for a local modal task.

## Validation
Inspect the actual Electron dialog at desktop and narrow widths after loading and entrance animation complete; verify computed radius and visually check the corners.

## Related files
- `src/index.css`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleArtifactPreviewDialog.tsx`
