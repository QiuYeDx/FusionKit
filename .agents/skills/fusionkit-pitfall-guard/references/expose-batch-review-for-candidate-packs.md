# FK-PIT-0177: Expose batch review for imported candidate packs

## Area
Translation knowledge / import usability / batch review / transaction identity.

## Triggers
Candidate packs, hundreds of pending materials, one-by-one approval, reviewEntries, cross-page selection, stale preview.

## Symptoms
The backend accepts multiple IDs but the UI exposes only single-record review. Importing a useful candidate pack creates impractical manual work; an import acceptance checkbox only handles externally declared ready records.

## Root cause
Protocol trust boundaries and the user-facing review workflow were treated as the same feature. Small fixtures did not expose the cost of approving a realistic pack.

## Do
- Keep imports untrusted while exposing filtered and cross-page bulk review of ordinary candidates.
- Show exact counts and preview contents, allowing exclusions. Explain required/core and archived-dependency exclusions before submission.
- Freeze both selected IDs and generation. On conflict, refresh only original identities and require a new submission; never add newly discovered records.
- Use the existing atomic service transaction, synchronous click guards, and visible error recovery. Same-state retries must not churn revisions.
- Share eligibility predicates with the service, which remains authoritative.
- Validate with more than one page of candidates and a strong entry, a stale generation, a new record, a write failure and long translated text.

## Avoid
Do not mark AI proposals ready to bypass the UI problem, confuse select-page with select-all, issue one independent write per selected entry, or report partial success for an atomic failure.

## Validation
`test/translation-knowledge/batch-review.test.ts`, `service.test.ts`, and `FUSIONKIT_KNOWLEDGE_E2E=1` with `bulk-review-electron.test.ts`; review wide/light and narrow/dark screenshots.

## Related files
- src/translation-knowledge/review-policy.ts
- src/pages/TranslationKnowledge/BatchReviewDialog.tsx
- src/pages/TranslationKnowledge/batch-review.ts
- src/pages/TranslationKnowledge/index.tsx
- electron/main/translation-knowledge/service.ts
