# Keep translation material opt-in visible and executable

## Area

Subtitle Studio / consumer configuration / product scope

## Triggers

translation materials, knowledge library, task opt-in, ordinary translation bypass, recipe target language, draft loss, classic subtitle translator

## Symptoms

Users assume saved materials are automatically used because the library does not explain task selection. A secondary materials dialog coexists with an ordinary primary start button. Unrelated parent settings can erase the materials draft. A materials link in the classic subtitle translator implies support that the product does not provide.

## Root cause

Storage, approval and execution are separate contracts, but the UI exposes only storage. Adding a materials execution path without changing the primary action leaves conflicting ways to start. Conditional mounting ties draft lifetime to temporary validation success. Entry points are added without respecting the product's tool boundary.

## Do

- Keep translation materials exclusive to Subtitle Studio. The classic subtitle translator must have no materials link, mode, hint, configuration, file transfer or navigation integration. The materials library's use action opens Subtitle Studio directly.
- State that saving/approving makes material eligible; only explicit task selection allows it into compilation. Keep opt-in and the chosen collection/recipe summary visible in Studio translation settings.
- Gate ordinary prepare/start in both UI and handler when materials are enabled. Closing a selector must not silently opt out, and an empty choice must not mean the whole library.
- Keep one target language source of truth. A recipe must not silently change it; validate source and target tags with the materials execution contract before checking.
- Preserve explicit child text overrides, including an empty string, when unrelated parent settings change. Undefined overrides can continue inheriting parent or recipe defaults.
- Keep the materials draft mounted while parent language/budget inputs are temporarily invalid. Pass current draft values to invalidate old plans and gate actions in buttons and handlers; do not conditionally unmount on `config.success` or retain a stale executable configuration.
- Consume selector open requests once and clear them when the parent flow closes. Reopening the parent must not replay an old open request.
- Explain storage-only types and dormant preferences where they are configured. Hide empty advanced choices, and update rollout copy when capabilities become available.

## Avoid

- Do not equate a library-management link with an executable integration or add cross-tool integration outside the product scope.
- Do not let a recipe silently correct a test's target-language setup.
- Do not replace frozen request/approval rules with a global prompt append to make a UI switch work.
- Do not preserve a stale executable configuration merely to prevent draft loss.

## Validation

Use an isolated Electron profile and local HTTP fixture: create a collection and explicitly approve a term, enter Subtitle Studio from the library, import subtitles, opt in and select materials, check without network, then explicitly start. Assert ordinary Studio requests contain no materials and selected materials affect only matching cues. Cover empty selection, closing/reopening, target mismatch, invalid custom languages, temporary invalid budgets and preserved explicit requirements. Verify that the classic subtitle translator has no materials controls, links or navigation behavior. Review the actual wide/narrow rendered states.

## Related files

- `src/pages/TranslationKnowledge/UsageGuide.tsx`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.tsx`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioKnowledgeTrial.tsx`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioKnowledgeBatch.tsx`
- `test/translation-knowledge/consumer-ux-electron.test.ts`
- `docs/v0.3.1/ai-translation-knowledge/consumer-ux-review.md`
