# FK-PIT-0151: Keep route insets with the exiting page

## Area and triggers

Frontend routing, AnimatePresence mode=wait, route-specific padding, :has descendant layout, tool page jumps vertically during enter/exit.

## Symptoms and root cause

A shared wrapper changed pt-10 as soon as location.pathname changed while AnimatePresence still retained the old route. The outgoing tool list jumped up 40px; the outgoing Studio jumped down 40px. A descendant-dependent :has(.studio) rule also changed shared flex sizing when the child entered or left. Settled screenshots and same-page tab checks missed both transition-time effects.

## Do

Keep route-dependent insets on the pathname-keyed page itself so the exiting element retains its geometry. Give the application title-bar spacer a stable shrink-0 contract and the scroll region min-height:0 independently of route presence. Preserve the intended insets of other tool pages. Sample the outgoing content rectangle on every animation frame until it disconnects, in both directions. Review narrow and wide settled pages and nearby tools as well.

## Avoid

Do not put next-route spacing outside the exiting tree, use a timeout to guess when to switch the spacing, or disable motion to conceal a shared-layout jump. Do not change shared flex geometry using a transient descendant selector.

## Validation and related files

Subtitle Studio I8, 2026-09-13. src/App.tsx, SubtitleStudio/studio.css, test/subtitle-studio/interaction-workspace-ui.test.ts. Both outgoing sequences retain their content top (40px Studio, 80px tool list) until unmount. See docs/features/subtitle-studio/records/2026-09-13-polish.md for exact final evidence and broader geometry coverage.
