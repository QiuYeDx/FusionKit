# FK-PIT-0136: Pin exact Studio text hashes to LF checkout bytes

## Area

Subtitle Studio / provenance / Windows Git checkout.

## Triggers

core.autocrlf, CRLF, LF, audited source changed, immutable evidence changed,
baseline differs, frozen copy content differs, hash check passes on macOS only.

## Symptoms

The real boundary checker rejects unchanged native sources or evidence on a
Windows checkout. Repairing just those audited paths makes the boundary check
pass while T02/T03/T04 provenance checks still reject the CRLF baseline JSON or
other frozen destinations.

## Root cause

The source inventory identifies Git blob bytes, but derived copies and audit
manifests deliberately compare exact working-tree bytes. Without repository
attributes, core.autocrlf can materialize LF blobs as CRLF. Normalizing inside
these verifiers would weaken their exact-byte contract; fixing only the first
reported audit leaves the rest of the frozen graph platform-dependent.

## Do

- Pin the narrowly scoped frozen/audited text paths to `text eol=lf` in the root
  `.gitattributes`, including provenance JSON, native sources, copied tooling,
  copied tests, and resource evidence. Keep binaries outside text rules.
- For an already materialized checkout, preflight every selected regular file
  against its HEAD blob. Restore exact HEAD bytes only when CRLF-to-LF conversion
  accounts for the entire difference; stop on any other change and preserve it.
- Keep SHA-256 values and all verifier byte comparisons unchanged.
- Validate both the real boundary checker and every applicable provenance CLI.
  Test attributes with an isolated Git checkout under `core.autocrlf=true`, and
  prove unrelated text and adjacent binary bytes retain their expected policy.
- Use installed Node directly for these checks. If Git reports dubious ownership
  only in the sandbox, use a per-process safe.directory with a normalized
  forward-slash path; do not rewrite global Git configuration.
- Git status may retain stat-only changes after a byte-identical size change,
  including after `update-index --refresh`. Confirm the current canonical blob
  equals the index blob and inspect the actual diff; do not stage a mass
  renormalization merely to clear that display.

## Avoid

- Do not regenerate provenance, update audit digests, or normalize verifier input
  merely to accommodate a host checkout policy.
- Do not assume `.gitattributes` retroactively repairs existing checkout bytes.
- Do not apply a repository-wide line-ending change or run text normalization on
  native executables, models, archives, or downloaded evidence.
- Do not restore an entire directory over concurrent source edits.

## Validation

```text
node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance/checkout-bytes.test.ts
node scripts/subtitle-studio/check-boundaries.mjs
node scripts/subtitle-studio-provenance/copy.mjs --check
node scripts/subtitle-studio-provenance/tooling-copy.mjs --check
node scripts/subtitle-studio-provenance/native-copy.mjs --check
node scripts/subtitle-studio-provenance/transcript-executor-copy.mjs --check
git diff --check
```

The regression derives its target inventory from the current provenance and
boundary manifests, so newly recorded destinations also require LF coverage.
Existing provenance and boundary negative fixtures continue to reject changed
content rather than accepting equivalent-looking text.

## Related files

- `.gitattributes`
- `test/subtitle-studio-provenance/checkout-bytes.test.ts`
- `scripts/subtitle-studio/check-boundaries.mjs`
- `scripts/subtitle-studio/boundaries.json`
- `scripts/subtitle-studio-provenance/`
- `resources/subtitle-studio/provenance/`
- [Canonicalize release-stage text evidence](canonicalize-hash-pinned-text-evidence-before-staging.md)
