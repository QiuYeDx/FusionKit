# FK-PIT-0164: Keep page Escape behind local interactions

## Area

Frontend / keyboard navigation

## Triggers

Escape,Radix,dialog,menu,editing,drag cancellation,event order

## Symptoms

Adding a page-level Escape shortcut can close a dialog/menu and navigate away on the same keystroke. A listener registered before a tour or drag handler can also navigate before the local handler prevents the event.

## Root cause

Radix and custom layers handle Escape on different event targets/phases. Some unmount synchronously; some do not prevent the default. Reading only the final DOM or relying on listener registration order cannot establish which interaction owned the key.

## Do

- Capture whether an editable target or visible dismissible layer owns Escape before local handlers change the DOM.
- Run page navigation from the bubbling phase, after a deferred check of `defaultPrevented`, so target propagation stops and later window handlers take precedence.
- Make drag cancellation consume Escape only while a drag is active. Ignore composition, held-key repeats and modified shortcuts.
- Clean up both listeners and pending navigation on route changes. Reuse the visible Back action, including its direct-entry fallback.

## Avoid

- Do not navigate unconditionally from a document/window Escape listener.
- Do not depend only on the presence of a dialog after the event has already closed it.
- Do not let a dormant drag listener prevent every Escape and disable page navigation.

## Validation

Run `FUSIONKIT_TOOL_UI_E2E=1 node_modules/.bin/vitest run test/tool-navigation.electron.test.ts` after the root Vite test build. Check real dialog plus nested selector, menu, tour, editable input, drag cancellation, a later window consumer, normal Escape, direct reload and tool-list no-op. Geometry assertions also check every tool's header and outgoing route frames.

## Related files

- `src/pages/Tools/_shared/useToolPageEscape.ts`
- `src/pages/components/BottomNavigation.tsx`
- `src/pages/Tools/_shared/ui/ToolFileDropScope.tsx`
- `test/tool-navigation.electron.test.ts`
