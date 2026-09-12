# FK-PIT-0131: Audit module factories alongside direct imports

## Area

Subtitle Studio / dependency boundaries

## Triggers

createRequire, computed native loader, alias, source hash, AST boundary

## Symptoms

Direct import checks miss createRequire aliases and computed loaders; bind module factory access and the reviewed call to exact source hashes.

## Root cause

A checker that recognizes only import and direct require calls misses createRequire factories, aliases, parentheses and namespace member access. An expression-only exception also remains valid after its surrounding path validation changes.

## Do

- Require a source hash audit for any access to node:module. Bind the permitted native loader to its exact source path, expression, occurrence count and full source hash.
- Keep the embedded Windows child-process loader in a separate exact source audit; ordinary AST import traversal cannot inspect JavaScript assembled in strings.
- Unwrap parenthesized require expressions and track simple aliases and assignments. Keep negative fixtures for forms the static walker does not resolve; unaudited module factory access must still fail.
- Scan the real source tree after adding the exact audit. Reassess the surrounding verification and ownership checks before updating a changed hash.

## Avoid

- Do not allow every computed loader in a directory or permit every node:module user because one native loader is legitimate.
- Do not describe an AST checker as a complete JavaScript sandbox. Runtime verification and branded ownership still need independent tests.

## Validation

Run the Studio boundary CLI and boundary tests. Negative fixtures cover direct factories, aliases, assignment, parentheses, namespace destructuring, computed properties, dynamic module imports, changed source bytes, altered expressions, repeated calls and calls copied to a different source path. The actual new overwrite backend must pass its narrow audit.

## Related files

- `scripts/subtitle-studio/check-boundaries.mjs`
- `scripts/subtitle-studio/boundaries.json`
- `test/subtitle-studio/boundaries.test.ts`
- `electron/main/subtitle-studio/transcription/native/overwrite-native-backend.ts`
- `electron/main/subtitle-studio/transcription/native/overwrite-native-host-preflight.ts`
