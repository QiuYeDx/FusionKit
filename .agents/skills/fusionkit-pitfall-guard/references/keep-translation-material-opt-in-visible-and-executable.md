# FK-PIT-0161: Keep explicit translation material selection visible and executable

## Area

Subtitle Studio / consumer configuration / product scope

## Triggers

translation materials, knowledge library, explicit collection selection, empty selection, ordinary translation bypass, recipe target language, trial document topics, draft loss, classic subtitle translator

## Symptoms

Users assume saved materials are automatically used because the library does not explain task selection. A separate enable switch and secondary materials dialog coexist with an ordinary primary start button. Unrelated parent settings can erase the materials draft. A trial ignores the document topics selected in the same form, so it excludes content that full translation would include. A materials link in the classic subtitle translator implies support that the product does not provide.

## Root cause

Storage, approval and execution are separate contracts, but the UI exposes only storage. Adding a materials execution path without changing the primary action leaves conflicting ways to start. An independent enable flag creates another state that can disagree with the displayed selection. Conditional mounting ties draft lifetime to temporary validation success. Sharing a form does not automatically preserve semantics across full and trial APIs: document topics must be projected into the trial's cue-scoped contract. Entry points are added without respecting the product's tool boundary.

## Do

- Keep translation materials exclusive to Subtitle Studio. The classic subtitle translator must have no materials link, mode, hint, configuration, file transfer or navigation integration. The materials library's use action opens Subtitle Studio directly.
- State that saving/approving makes material eligible; only explicit task selection allows it into compilation. Keep the chosen collection/recipe summary visible in the unified Studio translation form. Selection itself determines use: no collection and no recipe means ordinary translation; a selected collection or recipe means material-aware checking and execution. Do not add an independent enable toggle.
- Use the same primary start action for either selection state and dispatch from the current selection in both UI and handler. Closing the inline picker preserves selection. Empty selection must never mean the whole library, and a failed material check must never fall back to ordinary translation.
- When adapting old automatic preferences, honor a saved `enabled: false` by returning an empty active selection even if old collection IDs remain. The legacy storage field is a compatibility boundary, not a second user-facing control.
- Keep one target language source of truth. A recipe must not silently change it; validate source and target tags with the materials execution contract before checking.
- Preserve explicit child text overrides, including an empty string, when unrelated parent settings change. Undefined overrides can continue inheriting parent or recipe defaults.
- Keep the materials draft mounted while parent language/budget inputs are temporarily invalid. Pass current draft values to invalidate old plans and gate actions in buttons and handlers; do not conditionally unmount on `config.success` or retain a stale executable configuration.
- Preserve document topics in trials by projecting each distinct explicitly selected topic into `role: 'topic'` bindings for the exact trial cue IDs. Intersect existing cue roles and condition confirmations with that same sample. A document topic grants neither speaker nor mentioned identity; keep the binding limit and reject excess instead of silently dropping scope. Full translation and trial must agree about topic authority for the sampled cues.
- Consume selector open requests once and clear them when the parent flow closes. Reopening the parent must not replay an old open request.
- Explain storage-only types and dormant preferences where they are configured. Hide empty advanced choices, and update rollout copy when capabilities become available.
- Use the shared Tour for first-use explanations, anchored to real controls, with a header help button to reopen it. Wait for the library, preload loading screen and business dialogs before automatically opening. Keep normal actions available after the guide is dismissed; do not place a permanent tutorial card above the working list.

## Avoid

- Do not equate a library-management link with an executable integration or add cross-tool integration outside the product scope.
- Do not let a recipe silently correct a test's target-language setup.
- Do not replace frozen request/approval rules with a global prompt append to make material selection work.
- Do not preserve a stale executable configuration merely to prevent draft loss.
- Do not infer trial scope from every cue in the document or discard explicit document topics because the trial API accepts only per-cue bindings.

## Validation

Use an isolated Electron profile and local HTTP fixture: create a collection and explicitly approve a term, enter Subtitle Studio from the library, import subtitles, select materials, check without network, then explicitly start. Assert an empty selection uses ordinary Studio requests without materials, selected materials affect only matching cues, and closing/reopening the picker preserves the selection. Cover recipe selection, old disabled automatic preferences, target mismatch, invalid custom languages, temporary invalid budgets and preserved explicit requirements. Verify that the classic subtitle translator has no materials controls, links or navigation behavior. Review the actual wide/narrow rendered states.

`src/services/subtitle-studio/translation-session.test.ts` covers empty-selection dispatch, disabled automatic-preference migration and trial topic projection. Its topic fixture includes duplicate document topics, a narrower existing topic binding, a speaker binding and a conditional confirmation extending beyond the sample; only the explicit topic is extended to all sampled cues. The 2026-09-18 focused session/draft suite passed all 12 tests. See [FK-PIT-0163](bind-translation-plan-authority-to-session-claims-and-current-draft-identity.md) for stale plans and cancellation ownership.

## Related files

- `src/pages/TranslationKnowledge/KnowledgeTour.tsx`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.tsx`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioMaterialsFields.tsx`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioKnowledgeTrial.tsx`
- `src/services/subtitle-studio/translation-session.ts`
- `src/services/subtitle-studio/translation-draft.ts`
- `src/services/subtitle-studio/translation-session.test.ts`
- `test/translation-knowledge/consumer-ux-electron.test.ts`
- `test/translation-knowledge/trial-electron.test.ts`
- `docs/v0.3.1/ai-translation-knowledge/consumer-redesign.md`
