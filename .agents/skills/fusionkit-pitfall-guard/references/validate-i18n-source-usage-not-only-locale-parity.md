# FK-PIT-0014: Validate i18n source usage, not only locale parity

## Area

i18n source analysis and Electron UI validation.

## Triggers

raw namespace:key, locale parity passes, defaultValue fallback, dynamic translation
key, indirect key map, IPC channel false positive

## Symptoms

- All locale files have identical key counts, but the UI renders a raw translation key.
- A missing key stays hidden because every call supplies a source-language fallback.
- A naive `namespace:*` scan reports IPC channels such as `audio:reveal-output`.
- Dynamic templates or metadata keys are absent from static checks.

## Root cause

Locale parity compares translation files only; it cannot prove that keys referenced by
source code exist. Regex scans also lack symbol context: they confuse unrelated `t`
callbacks and colon-delimited protocol strings with translation calls, while missing
keys returned by helpers, maps, or typed templates.

## Do

- Use the TypeScript AST to bind `useTranslation` results, the shared `i18n.t`, and
  explicitly typed translation helpers.
- Resolve relative keys with the bound namespace and match i18next namespace parsing,
  including its multi-colon canonicalization.
- Expand string literals, static branches, constant maps, and finite string-union
  templates; fail when a translation argument widens to arbitrary `string`.
- Keep runtime-dynamic keys in an exact, finite manifest and fail stale selectors;
  review the finite key list as a runtime contract because the manifest cannot
  prove the reachability of its own values.
- Treat a `defaultValue` as presentation fallback, never as proof that the key exists.
- In Electron smoke tests, scan both visible text and translated attributes such as
  `aria-label`, `title`, `placeholder`, and `alt` after preload loading exits.

## Avoid

- Do not equate equal locale key counts with source coverage.
- Do not scan every colon-containing literal or every function named `t`.
- Do not suppress false positives with a namespace-wide or prefix-wide ignore rule.
- Do not allow untrusted runtime strings to reach `t()` merely because a manifest can
  list the expected happy-path values; validate them at the input boundary.

## Validation

```text
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vitest run test/e2e.spec.ts -t "audio pages render across languages"
git diff --check
```

Confirm the usage checker reports a source location and unresolved expression for
unknown dynamic keys, rejects a missing key even when a fallback is present, and does
not classify exact IPC channel constants as translations.

## Related files

- `scripts/check-i18n.mjs`
- `scripts/check-i18n-usage.mjs`
- `test/e2e.spec.ts`
- `src/components/qiuye-ui/markdown-renderer/widgets/PendingExecutionWidget.tsx`
