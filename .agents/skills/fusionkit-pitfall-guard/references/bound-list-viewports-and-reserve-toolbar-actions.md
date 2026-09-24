# FK-PIT-0183: Bound list viewports and reserve toolbar actions

- Area: Translation knowledge / list layout / compact subtitle toolbar
- Triggers: pagination still stretches the page, edge fade, management selector below header, execution record wraps onto its own row

## Symptoms

Paged lists can still grow taller than the window when rows wrap. A status strip using nested flex-wrap containers can put a single action on a second line after another icon is added.

## Root cause

Pagination limits item count, not rendered height. Independent wrapping groups do not share the width budget. Scroll fades attached to scrolling content drift away from the viewport edges.

## Do

- Bound the actual list viewport, keep headings, search, column labels and pagination outside, and retain natural short-list heights.
- Reuse the existing StudioScrollFade measurement of both viewport and content; overlays are noninteractive viewport siblings, use the owning card color and disappear at the corresponding edge or when overflow ends.
- Reset list scroll when search, category, or page changes. Test overflow-to-empty transitions as well as top/middle/bottom wheel scrolling.
- Put management category tabs beside New and keep primary navigation directly accessible. Update tours and selectors when moving secondary actions.
- Reserve space for track controls and execution actions; let secondary token text shrink with an accessible full-text tooltip instead of independently wrapping the action.
- Verify wide Chinese/light and narrow English/dark lists, plus a constrained subtitle preview with realistic token counts and multiple track actions.

## Avoid

- Assuming a page size is a CSS height limit.
- Permanently fading the last item or placing overlays inside the scrolling content.
- Solving status overflow by clipping action buttons or shrinking all text.
- Removing legacy package data when removing an obsolete browsing view.

## Validation

- test/translation-knowledge/workspace-layout-electron.test.ts
- test/translation-knowledge/materials-layout-electron.test.ts
- test/translation-knowledge/collection-maintenance-electron.test.ts
- test/subtitle-studio/remove-translation-ui.test.ts

## Related files

- src/pages/TranslationKnowledge/KnowledgeScrollList.tsx
- src/pages/TranslationKnowledge/KnowledgeSidebar.tsx
- src/pages/TranslationKnowledge/index.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/studio.css
