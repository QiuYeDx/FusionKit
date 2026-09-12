# FK-PIT-0145: Size nested readers against the remaining workspace height

## Area

Frontend / Electron layout

## Triggers

translation overview, nested grid, minmax, reader footer overlap, narrow window

## Symptoms

After adding the Studio translation summary, the outer preview panel still ended above navigation, but its nested cue reader extended behind the footer. Checking only the outer panel missed the defect. A later strict layout check also found that the title summary reduced the medium-window reader below the existing 300px contract.

## Root cause

The document workspace subtracted a fixed old header height. An inner grid additionally reserved minmax(120px,1fr) even when translation controls left less space. Shrinking title top padding without measuring the title bar would violate the existing alignment contract.

## Do

- Allocate auto header plus minmax(0,1fr) content from the actual viewport; keep every nested flex/grid boundary shrinkable.
- Measure reader, tabs, panel body, footer and navigation bounds, not just the outer card. Read computed grid tracks when scrollHeight differs from clientHeight.
- Use minmax(0,1fr) for the normal reader. If the user explicitly expands diagnostic messages, preserve the readable cue minimum and use the panel's existing outer scroll; verify that scrolling reaches complete cues.
- Reclaim unnecessary header margins while preserving the project title-bar gap. Check 1280x860, 1106x756 and 786x540 with both empty and active task summaries.

## Avoid

- Do not relax a geometry assertion to hide overflow.
- Do not claim a screenshot with an open modal proves its background reader is usable.
- Do not apply a fixed reader minimum to every state when several toolbars can occupy the same panel.

## Validation

Direct Node20 Vite test build, then FUSIONKIT_STUDIO_E2E=1 vertical-layout.test.ts and FUSIONKIT_STUDIO_I3_QUEUE_UI=1 acceptance-queue-overview-ui.test.ts with bounded workers. The former checks title gaps, reader minimums, expanded diagnostics and pagination; the latter checks the real two-row overview with translation controls. Review screenshots after the preload loading layer exits. Final evidence is indexed in docs/features/subtitle-studio/records/2026-09-12-acceptance-closeout.md.

## Related files

- src/pages/Tools/Subtitle/SubtitleStudio/studio.css
- src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslationOverview.css
- test/subtitle-studio/vertical-layout.test.ts
- test/subtitle-studio/acceptance-queue-overview-ui.test.ts
