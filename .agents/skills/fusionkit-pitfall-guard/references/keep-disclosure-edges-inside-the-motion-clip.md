# FK-PIT-0174: Keep disclosure edges inside the motion clip

## Area

Frontend / disclosure geometry / Motion clipping / modal density.

## Triggers

Inset square accordion, clipped rounded hover, text or chevron touching edges, negative margin inside DialogTransition, nested padding.

## Symptoms

Materials disclosures appear inset from their parent card but have square cut edges and no horizontal breathing room. A class-only check reports rounded corners and padding, yet the actual hover surface is clipped.

## Root cause

The disclosure uses negative horizontal margins to extend into parent padding, but a newly inserted measured motion wrapper clips overflow at the narrower content width. Its clip cuts off the trigger's corner and consumes the entire visible padding. Other record dialogs separately combine inset separators with negative margins and radius overrides.

## Do

- Assign an explicit edge model: a square section spans its owning surface; a rounded inset group retains outer space and internal padding.
- Make a full-width motion region and its section group share the same horizontal bounds. Put padding on the heading, ordinary fields and disclosure contents, not on an ancestor that requires children to escape its clip.
- Use KnowledgeDisclosure's section variant only within an explicitly styled section/group. Keep standalone panel and inline variants rounded.
- Retain measured height clipping, opacity, inert and mounted drafts. Fix the width/padding ownership instead of disabling clipping and exposing exiting content.
- Measure the visible left/right inset after intersecting all clipping ancestors. A trigger's own padding or radius alone cannot prove the visible result.
- For list screenshots, center the actual inner list in the dialog's outer scroll viewport. An expanded disclosure is taller than the viewport; scrolling the whole disclosure into view can leave the list below the fold.

## Avoid

- Compensating for clipping by adding another negative margin, removing trigger padding, or setting overflow visible on all motion regions.
- Placing a square, partially inset divider above an inset disclosure with no clear enclosing surface.
- Declaring list density validated from screenshots that show only the section title.

## Validation

Run the native materials-layout and record-dialog checks against the current renderer build. Inspect collapsed, expanded and focused triggers, outer clip bounds, 12px inner spacing, narrow/dark states, and the list's actual visible rows. Keep the content-motion regression for nested expansion and exit continuity.

## Related files

- src/pages/TranslationKnowledge/KnowledgeDisclosure.tsx
- src/pages/TranslationKnowledge/knowledge-record-dialog.css
- src/pages/Tools/Subtitle/SubtitleStudio/StudioMaterialsFields.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioMaterialsFields.css
- test/translation-knowledge/materials-layout-electron.test.ts
- [FK-PIT-0172: content flow](animate-content-flow-not-only-dialog-shells.md)
