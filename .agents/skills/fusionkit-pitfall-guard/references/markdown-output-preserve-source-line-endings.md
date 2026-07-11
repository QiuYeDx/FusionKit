# FK-PIT-0005: Preserve source line endings in Markdown output

## Area

Text translation, Markdown assembly, Windows test validation.

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
vitest run test/text-translation/markdown/markdownAstProbe.test.ts test/text-translation/output/markdownOutputAssembler.test.ts
```

Run the full Vitest suite on Windows after the targeted tests pass.

## Related files

- `electron/main/text-translation/output/markdown-output-assembler.ts`
- `test/text-translation/markdown/markdownAstProbe.test.ts`
- `test/text-translation/output/markdownOutputAssembler.test.ts`
