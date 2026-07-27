# FK-PIT-0066: Validate safe-integer timestamps before Date formatting

## Area

Frontend / renderer schema boundaries

## Triggers

`createdAt`, `updatedAt`, `Number.isSafeInteger`, `Date`, `Intl.DateTimeFormat`,
`RangeError`, app-scoped prompt

## Symptoms

- A strict IPC or persisted-state schema accepts a nonnegative safe integer timestamp.
- Renderer code passes that value directly to `new Date()` and
  `Intl.DateTimeFormat.format()`.
- An extreme but schema-valid value produces an invalid Date or throws during
  render, taking down an app-scoped prompt or the whole React tree.

## Root cause

`Number.isSafeInteger(value)` proves exact integer representation, not that the
value falls inside JavaScript's narrower Date time-value range. Schema validity
and display-library validity are separate contracts.

## Do

- Construct the Date once and check `Number.isNaN(date.getTime())` before
  formatting.
- Wrap locale formatting in a final non-throwing boundary because locale data
  and formatter construction are renderer concerns.
- Render a stable fallback such as the original integer when the timestamp
  cannot be represented as a Date.
- Test `Number.MAX_SAFE_INTEGER` or another value outside the Date range.

## Avoid

- Do not assume a safe-integer Zod schema makes a value safe for `Date`.
- Do not let an app-scoped recovery, update, or notification surface throw from
  presentation-only timestamp formatting.
- Do not silently delete or mutate durable state merely because its timestamp
  cannot be displayed as a localized date.

## Validation

```bash
node_modules/.bin/vitest run src/components/local-subtitle/LocalSubtitleOverwriteRecoveryPrompt.test.tsx
node_modules/.bin/tsc --noEmit --pretty false
```

Confirm the extreme timestamp renders via fallback and the component does not
throw.

## Related files

- `src/components/local-subtitle/LocalSubtitleOverwriteRecoveryPrompt.tsx`
- `src/components/local-subtitle/LocalSubtitleOverwriteRecoveryPrompt.test.tsx`
- `src/type/localSubtitleIpc.ts`
