# FK-PIT-0065: Load native addons from generation-bound content-addressed proofs

## Area

Electron / Node-API addon staging and production loading.

## Triggers

`.node`, `process.dlopen`, `createRequire`, runtime manifest, SHA-256,
generation, module cache, `extraResources`, native addon staging.

## Symptoms

- A loader verifies a native addon and later passes only its absolute path to
  `require()`.
- Updated bytes reuse the same addon path and Node returns the module cached for
  an older runtime generation.
- A structurally copied verification object or a developer build receipt is
  accepted as production load authority.
- A post-verification path replacement reaches `dlopen` without being tied to
  the manifest generation that was verified.

## Root cause

An absolute path is neither verification evidence nor a runtime generation.
Node caches native modules by resolved filename, while JavaScript cannot ask
`dlopen` or `LoadLibrary` to load directly from the already verified file
descriptor or HANDLE. Closing the verified handle and loading a mutable path
therefore loses the proof-to-load binding and can also reuse stale module state.

## Do

- Stage production addons under a no-clobber, content-addressed relative path;
  a new byte generation must get a new filename.
- Bind target, N-API version, native protocol, journal version, byte size,
  SHA-256, native format, signature profile and contained path in a strict,
  versioned manifest.
- Return an opaque, WeakSet-branded, deeply frozen verification proof and make
  the production loader reject raw paths, proxies and structural copies.
- Revalidate containment, no-symlink file identity, size, hash and target both
  before and after loading, then validate the exact production export surface.
- Keep the generation path alive for the process lifetime and reject attempts
  to bind one path to a different manifest generation.
- Treat final nested signing as part of the bytes: sign and independently
  verify macOS addons before freezing the content hash.
- State the threat boundary honestly: pre/post checks detect ordinary drift but
  do not linearize `require(path)` against a hostile same-user writer.

## Avoid

- Do not expose a production factory that accepts an arbitrary absolute
  `.node` path.
- Do not overwrite a staged addon in place or use a stable filename across
  different hashes.
- Do not use a build receipt alone as runtime trust authority.
- Do not stage test-only fault-injection exports with the production addon.
- Do not claim that JavaScript pre/post path checks eliminate the native
  loader's replacement window.

## Validation

```text
node --test scripts/local-subtitle/overwrite-native/*.test.mjs
node_modules/.bin/vitest run test/local-subtitle/overwriteNativeBackend.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover forged proof, same-path/different-generation rejection, content-address
drift, pre/post-load replacement, test-only extra exports, target/format/hash
drift, missing manifest/receipt/addon and a real fresh-process staged addon
load on each supported target.

## Related files

- `electron/main/local-subtitle/overwrite-native-backend.ts`
- `scripts/local-subtitle/overwrite-native/overwrite-native-staging.mjs`
- `electron-builder.json`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
