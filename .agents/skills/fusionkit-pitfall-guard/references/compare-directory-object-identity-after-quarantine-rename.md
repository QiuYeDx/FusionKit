# FK-PIT-0041: Compare directory object identity after quarantine rename

## Area

Private session filesystems, identity-bound cleanup, quarantine rename.

## Triggers

`cleanup_failed`, quarantine rename, `realpath`, inode, birthtime, private temp session.

## Symptoms

- Every normal cleanup renames the owned session successfully and then reports identity
  mismatch.
- `.cleanup-*` directories remain after abort, decode failure, or owner release.
- Retrying cleanup cannot rediscover a quarantine that belongs to the same session.

## Root cause

`realpath` identifies the current pathname, not only the filesystem object. A quarantine
rename intentionally changes that pathname, while device, inode and birthtime continue
to identify the same directory object.

## Do

- Before rename, require the original realpath and object identity to match the proof.
- After rename, compare device, inode and birthtime, then separately require containment
  under the verified private base root.
- Rediscover only a quarantine whose object identity matches the retained proof.
- Keep missing or replaced roots fail-closed until an identity-matching quarantine is
  found and removed.

## Avoid

- Do not require the pre-rename and post-rename realpaths to be equal.
- Do not weaken post-rename checks to a filename prefix alone.
- Do not discard a cleanup proof after rename or recursive removal fails.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/mediaNormalizer.test.ts test/local-subtitle/serverSession.test.ts
node_modules/.bin/tsc --noEmit
```

Cover success, abort, decode failure, owner release, replacement, missing original root,
quarantine rediscovery and cleanup retry.

## Related files

- `electron/main/local-subtitle/media-normalizer.ts`
- `electron/main/local-subtitle/server-session.ts`
- `test/local-subtitle/mediaNormalizer.test.ts`
- `test/local-subtitle/serverSession.test.ts`
