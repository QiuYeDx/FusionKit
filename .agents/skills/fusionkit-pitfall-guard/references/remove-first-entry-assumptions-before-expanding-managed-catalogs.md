# FK-PIT-0092: Remove first-entry assumptions before expanding managed catalogs

## Area

Electron / managed resource catalogs

## Triggers

multi-model,model catalog,catalog[0],import target,defaultRecommended,resource allowlist

## Symptoms

A multi-entry manifest is incomplete until every import, default, smoke, and selection path resolves an explicit resource identity instead of assuming the first catalog entry.

## Root cause

A feature may already render catalog entries with `map()`, which makes the UI look
multi-resource-ready, while older imperative paths still select `catalog[0]` or
`resources.find(type)`. Imports are especially risky: a file can be verified
against or committed under the wrong manifest entry unless the selected identity
is carried across renderer, preload, IPC validation, and the main-process manager.

## Do

- Search for positional access and first-match lookup whenever an allowlisted
  catalog gains another production entry.
- Resolve defaults through an explicit manifest field such as
  `defaultRecommended`; preserve list order only as a final defensive fallback.
- Carry the exact resource ID through every import/install request and resolve it
  again against the trusted main-process catalog before starting work.
- Match renderer conveniences, such as file-size detection, only for UX; retain
  full size, header, and hash verification in the main process.
- Test a non-first catalog entry through the complete import or install path.

## Avoid

- Do not let an internal manager silently choose `catalog[0]` once multiple
  entries are possible.
- Do not infer resource identity from an untrusted filename or MIME type.
- Do not treat a multi-item selector as proof that backend lifecycle paths support
  the same set of items.

## Validation

```text
rg -n 'catalog\[0\]|resources\.find' electron src test
node_modules/.bin/vitest run test/local-subtitle/modelManifest.test.ts test/local-subtitle/modelManager.test.ts test/local-subtitle/modelManagerIpc.test.ts test/local-subtitle/preloadApi.test.ts
node_modules/.bin/tsc --noEmit
```

Verify that a non-first resource can be downloaded, imported, selected, resolved,
and removed without mutating or selecting the default entry. Reject imports whose
resource ID is absent, unknown, or does not match the verified file.

## Related files

- `resources/local-subtitle/manifests/local-subtitle-models.v1.json`
- `electron/main/local-subtitle/model-manifest.ts`
- `electron/main/local-subtitle/model-manager.ts`
- `electron/preload/local-subtitle-api.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleEnvironmentManager.tsx`
