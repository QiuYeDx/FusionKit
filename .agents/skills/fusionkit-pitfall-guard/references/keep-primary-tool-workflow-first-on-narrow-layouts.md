# FK-PIT-0083: Keep the primary tool workflow first on narrow layouts

## Area

Frontend, responsive tool detail pages, Electron narrow-window validation.

## Triggers

- `ToolDetailLayout` switches from two columns to one column.
- A configuration aside appears before the workspace in DOM order.
- A narrow Electron window opens to a full screen of settings while the upload,
  editor, preview, or primary action remains below the fold.

## Symptoms

The desktop page looks balanced, but a narrow window makes the tool feel like a
settings page. Users cannot see the primary workflow without scrolling past a
long configuration panel, and controls sized for the fixed desktop aside leave
large empty areas when that aside becomes full width.

## Root cause

`ToolDetailLayout` renders the aside before the main element so the desktop grid
can place configuration on the left. CSS grid keeps that source order after it
collapses to one column unless the consumer explicitly changes the responsive
order. Fixed-width controls in the aside compound the problem.

## Do

- Set the main workflow to `order-1` and the aside to `order-2` below the desktop
  breakpoint, then restore `lg:order-2` for main and `lg:order-1` for aside.
- Make select triggers and other single-column form controls fill their field.
- Keep low-frequency configuration in disclosures so returning users can reach
  the main action quickly.
- Validate both the first narrow viewport and an expanded configuration state in
  Electron after the preload loading layer exits.

## Avoid

- Do not assume a responsive grid automatically chooses the right content order.
- Do not accept a narrow screenshot that only shows configuration when the page
  is primarily an upload, editing, or task workflow.
- Do not keep desktop `w-fit` control widths after the aside becomes full width.

## Validation

- Capture the first 786-pixel-wide Electron viewport and confirm the primary
  workflow appears before configuration.
- Expand the longest disclosure, then verify page and disclosure
  `scrollWidth <= clientWidth + 1`.
- Confirm single-column select triggers use the full field width and the desktop
  layout still places configuration on the left.

## Related files

- `src/pages/Tools/_shared/ui/ToolDetailLayout.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/index.tsx`
- `test/e2e.spec.ts`
