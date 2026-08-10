# FK-PIT-0084: Remove the header divider from collapsed ToolPanels

## Area

Frontend / collapsible ToolPanel surfaces.

## Triggers

ToolPanel, collapsed, header-only, border-b, thick bottom border, extra line,
HiDPI screenshot.

## Symptoms

A collapsed panel looks as if its bottom border is two pixels thick or has an
extra horizontal line. The expanded panel looks normal, and changing the outer
panel border alone either does not fix the issue or removes the card outline.

## Root cause

`ToolPanel` owns an outer border and its header owns a bottom divider. When the
collapsible body is unmounted, the zero-height body leaves the header divider
directly adjacent to the panel's bottom border. Antialiasing and high-DPI
scaling make the two neighboring lines look like one heavy edge.

## Do

- Keep the panel's outer border as the collapsed card outline.
- Set the header divider to `border-b-0` while the body is collapsed.
- Restore the header divider when the body is expanded.
- Scope the override to the collapsible consumer unless every ToolPanel follows
  the same body lifecycle.

## Avoid

- Do not remove the panel's outer border or hide the artifact with a negative
  margin.
- Do not add empty padding or a minimum-height body between the two borders.
- Do not change the shared ToolPanel default for unrelated panels that always
  render content.

## Validation

- In collapsed state, confirm the header computed `border-bottom-width` is
  `0px` while the panel keeps its outer border.
- In expanded state, confirm the header divider returns and separates the body.
- Capture the collapsed state in Electron at the target display scale and check
  that only one bottom edge is visible.
- Run the local subtitle page wiring test and TypeScript validation.

## Related files

- `src/pages/Tools/_shared/ui/ToolPanel.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleEnvironmentManager.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberPage.test.ts`
