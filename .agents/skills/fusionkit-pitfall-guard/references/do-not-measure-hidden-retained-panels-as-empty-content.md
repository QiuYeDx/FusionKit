# FK-PIT-0173: Do not measure hidden retained panels as empty content

## Area

Frontend / Motion / retained tab panels / natural-height measurement.

## Triggers

Scope tab height jump, display:none, forceMount, retained form drafts, nested DialogTransition, stale data-flow-animating.

## Symptoms

The entry editor's wording, language and metadata tabs interpolate correctly, while entering Scope snaps the tab container and dialog height. Scope contains nested animated role/condition fields; the other tabs do not.

## Root cause

Retained inactive panels finish their fade with display:none. ResizeObserver then reports no layout box, and an unconditional getBoundingClientRect() read stores a false natural height of zero. On reactivation, already-present nested fields animate from that false zero. The ancestor interprets them as a genuine in-flow expansion and directly follows their measured geometry, bypassing the tab change's own size interpolation.

A related race occurs when a tab becomes hidden while a child animation finishes: comparing its hidden zero rect with the nonzero target rejects completion and can leave a stale moving marker.

## Do

- Check getClientRects().length before accepting natural-size measurements. No layout box means unavailable measurement: preserve the last valid height, or initial null/auto.
- Continue accepting a real zero height when a rendered box exists. Empty content and collapsed regions still need to shrink.
- Only perform the latest-target geometry guard on rendered outer boxes. A hidden completion must still clear its moving marker.
- Keep panel identity and input subtrees stable across tab switches; this fix does not require remounting forms or disabling nested animation.
- Give the retained tab container a semantic transitionKey. A panel revealed at a new width can legitimately reflow its nested auto-sizing textarea; that child must not bypass the parent tab transition. Resume direct nested following only after the explicit parent transition finishes. This is an animation ownership key, not a React remount key.
- Exercise the tab with existing required subjects and a confirmation condition, not only an empty Scope panel.

## Avoid

- Filtering every height===0 value, which breaks real collapse.
- Forcing all ancestor transitions to zero or removing nested-flow coordination.
- Checking only wording↔language or only the dialog frame. The affected tab's real flow footprint and content opacity must have intermediate frames.

## Validation

Build renderer/main/preload with the root Vite config, then run the entry-scope native Electron regression with FUSIONKIT_KNOWLEDGE_E2E=1. Cover first and repeated entry from all three other tabs, rapid reversal, draft retention, hidden completion cleanup, a narrow capped dialog and reduced motion. Run the shared dialog-motion/content-flow tests for regression coverage.

## Related files

- src/components/qiuye-ui/dialog-motion.tsx
- src/pages/TranslationKnowledge/EntrySettingsPanel.tsx
- src/pages/TranslationKnowledge/EntryEditor.tsx
- test/translation-knowledge/entry-scope-motion-electron.test.ts
- test/dialog-content-motion.electron.test.ts
- [FK-PIT-0172: animate local content flow](animate-content-flow-not-only-dialog-shells.md)
