# FK-PIT-0158: Normalize optional IPC fields before hashing JSON knowledge selections

## Area

Electron IPC / translation knowledge / canonical JSON

## Triggers

blank translation requirements, undefined, structured clone, optional Zod fields, JCS accepts only JSON values, document_unavailable after reopening

## Symptoms

Batch checking worked when translation requirements were filled in, but checking the same files after reopening with empty defaults failed for every file. A generic document error concealed the actual canonicalization failure.

## Root cause

Electron structured cloning and Zod optional fields retain own properties whose value is `undefined`. JavaScript UI state commonly includes `instructions: undefined` or clears a recipe with `recipeId: undefined`. Strict JCS accepts JSON values only and must reject these objects. JSON-file fixtures omit those fields, so they missed the real renderer shape. Using an empty string as a substitute would incorrectly suppress inherited recipe requirements/context.

## Do

- Normalize only the documented optional selection keys at the main/domain boundary: omit `recipeId`, `instructions` and `context` when undefined; preserve explicit empty strings.
- Apply the same normalization before environment digests, full-document preparation, trials and frozen snapshot construction so identity and execution agree.
- Preserve strict DTO field validation and the strict portable canonicalizer. Never silently normalize arbitrary knowledge file fields.
- Verify omitted and explicitly undefined options produce equal digests and inherit recipe text, while explicit empty strings override it.
- Include native checks with untouched empty defaults, recipe selection and removal, reopen/reload, and local model fixtures. Do not always fill every optional field in end-to-end tests.

## Avoid

- Do not loosen JCS to accept undefined, use truthiness for user overrides, or rely on JSON.stringify to hide invalid input throughout the protocol.
- Do not infer that a document is corrupt just because a broad error mapper reports document_unavailable. Trace the preparation error separately.

## Validation

Selection resolver, frozen snapshot, full-document, batch and trial tests cover absent/undefined/empty-string behavior. The native batch test checks English defaults after reopening and retains the same isolated protocol and main-process services. Build and portable artifact consistency checks remain required; stop owned Electron processes after testing.

## Related files

- `src/translation-knowledge/execution-contract.ts`
- `src/translation-knowledge/execution.ts`
- `src/translation-knowledge/snapshot-contract.ts`
- `electron/main/subtitle-studio/knowledge-translation.ts`
- `electron/main/subtitle-studio/knowledge-trial.ts`
- `test/translation-knowledge/batch-electron.test.ts`
