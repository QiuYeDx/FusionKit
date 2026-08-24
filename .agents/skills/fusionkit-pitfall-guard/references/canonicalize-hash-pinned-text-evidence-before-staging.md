# FK-PIT-0070: Canonicalize hash-pinned text evidence before staging

## Area

Windows release staging / runtime manifests / license and source evidence.

## Triggers

`core.autocrlf`, CRLF, LF, license evidence, source offer, SHA-256, runtime
manifest, canonical staging

## Symptoms

- A runtime stager succeeds on an LF checkout but its strict manifest verifier
  rejects the same evidence files on Windows.
- License or source files have the expected text yet differ from the pinned
  byte size and SHA-256 by roughly one byte per line.
- Binary artifacts and their hashes are correct while canonical publication
  fails only at evidence verification.

## Root cause

Git checkout policy can convert committed LF text to CRLF in the working tree.
Copying those working-tree bytes into a release staging root makes the staged
artifact depend on developer configuration even though the source content is
unchanged. A strict manifest correctly rejects those bytes because its size and
SHA-256 describe one canonical representation.

## Do

- Define one canonical byte representation for hash-pinned text evidence.
- Normalize trusted repository text to those bytes during staging, then verify
  the result against the exact contract size and SHA-256.
- Keep binary artifacts byte-for-byte and never run text normalization over
  executables, archives, models, or arbitrary downloaded content.
- Add a Windows regression test with mixed CRLF, lone CR, and LF input.
- Run the real canonical stager on a Windows checkout with `core.autocrlf`
  enabled before claiming target readiness.

## Avoid

- Do not weaken or skip the manifest evidence hash on Windows.
- Do not generate manifest hashes from the current checkout and thereby freeze
  machine-dependent bytes.
- Do not assume `.gitattributes` alone repairs files already materialized in a
  working tree.
- Do not silently normalize untrusted binary or unknown-encoding inputs.

## Validation

Stage the Windows canonical runtime from a CRLF checkout, then run the strict
runtime and builder preflight verifiers. Confirm all evidence records match the
shared LF contract exactly and that a non-line-ending content change still
fails closed.

## Related files

- `scripts/local-subtitle/runtime/stage-runtime-windows-x64.mjs`
- `scripts/local-subtitle/runtime/stage-runtime-windows-x64.test.mjs`
- `resources/local-subtitle/manifests/local-subtitle-staging.v1.json`
- `scripts/local-subtitle/runtime/runtime-manifest.mjs`
