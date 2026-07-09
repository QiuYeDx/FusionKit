# FK-PIT-0004: Repair Markdown Placeholder Drift Before Failing Tasks

## Area

Text translation / Markdown.

## Triggers

- Long-text Markdown translation returns `partially_completed`.
- Failure details include `placeholder_mismatch`.
- Error mentions unknown, missing, duplicated, or reordered `FKP` placeholders.
- Real model output changes `⟦FKP:...⟧` tokens, emits an extra placeholder such as `:0031`, or uses an ASCII bracket variant.

## Symptoms

- A mostly successful Markdown translation fails one segment because the model did not copy protected placeholders byte-for-byte.
- The user sees an internal protocol token instead of a useful successful translation.
- Retrying the same task may fail again because the prompt still asks the model to copy a dense placeholder list perfectly.

## Root Cause

Markdown translation protects code, URLs, HTML, and similar spans by replacing them with `FKP` placeholders. Dense Markdown blocks can contain dozens of placeholders. Real models may add, omit, duplicate, reorder, or slightly rewrite these internal tokens even after a correction retry.

## Do

- Keep strict placeholder validation for diagnostics and first-attempt quality.
- In the runtime service, retry once with correction instructions.
- On the retry attempt, apply deterministic placeholder reconciliation before failing:
  - rewrite observed placeholder-like tokens to the expected source order,
  - remove extra internal placeholders,
  - insert missing expected placeholders as a last-resort preservation step,
  - validate again before accepting the result.
- Preserve original protected source spans through the output assembler; never trust model-written placeholder source text.
- Add protocol and service E2E coverage for extra unknown placeholders such as `:0031`.

## Avoid

- Do not fail a whole Markdown segment solely because the model emitted a repairable placeholder drift.
- Do not accept first-attempt placeholder-mismatched sequential Markdown responses without a correction retry; this can commit a low-quality memory patch.
- Do not store source text, translated text, request body, API keys, or raw model payloads in failure diagnostics.

## Validation

```bash
corepack pnpm@8.7.0 exec vitest run \
  test/text-translation/parsing/markdownParser.test.ts \
  test/text-translation/protocol/markdownTranslationResponseProtocol.test.ts \
  test/text-translation/output/markdownOutputAssembler.test.ts \
  test/text-translation/service/textTranslationService.e2e.test.ts
```

## Related Files

- `electron/main/text-translation/parsing/protected-placeholders.ts`
- `electron/main/text-translation/model/translation-response-protocol.ts`
- `electron/main/text-translation/text-translation-service.ts`
- `test/text-translation/protocol/markdownTranslationResponseProtocol.test.ts`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
