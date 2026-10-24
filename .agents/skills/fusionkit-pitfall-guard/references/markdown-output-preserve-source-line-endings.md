# FK-PIT-0005: Preserve source line endings in Markdown output

## Area

Long-text translation, Markdown rebuild, Windows test validation.

Historical: the old markdown-output-assembler (electron/main/text-translation/output/) and its tests under test/text-translation/ were removed 2026-10-22; the lesson now applies to `src/long-text/rebuild.ts`.

## Triggers

- Markdown assembler tests pass on LF checkouts but fail on Windows CRLF checkouts.
- Expected and received text differ only by `\r\n` versus `\n` around inserted translations.
- Bilingual Markdown contains mixed line endings after inserting translated blockquotes.

## Symptoms

- Protected fenced-code assertions fail even though the code block content is unchanged.
- Exact bilingual-output comparisons show carriage-return differences on source lines next to inserted blocks.
- Output files can contain source CRLF plus generated LF in the same document.

## Root cause

Markdown source ranges preserve the checkout's original line endings, while generated translation text and blockquote insertions were hard-coded with `\n`. Tests also compared raw platform-dependent fixture text with LF-only string literals.

## Do

- Detect the source document's preferred line ending.
- Normalize translated replacements and generated insertions to that line ending before assembly.
- Normalize both sides only in assertions whose purpose is semantic Markdown structure rather than byte-for-byte line-ending preservation.
- Keep at least one product-level test that verifies assembled output uses a consistent source-compatible line ending.

## Avoid

- Do not silence the failure by globally changing Git `autocrlf` during validation.
- Do not emit mixed CRLF/LF output and merely normalize it when writing to disk.
- Do not make protected-content assertions depend on the developer machine's checkout line ending.

## Validation

```text
vitest run test/long-text/rebuild.test.ts test/long-text/exporter.test.ts
```

After the targeted tests pass on Windows, run the other affected non-Electron Vitest files by name. A bare `vitest run` / `pnpm test` also runs `*.electron.test.ts` and `test/e2e.spec.ts`, which open Electron windows, so run those only with the user's consent.

## Related files

- `src/long-text/rebuild.ts` (`RebuildOptions.lineEnding`)
- `electron/main/long-text/exporter.ts`
- `test/long-text/rebuild.test.ts`
- `test/long-text/exporter.test.ts`
