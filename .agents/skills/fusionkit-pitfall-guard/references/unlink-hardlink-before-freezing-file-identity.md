# FK-PIT-0044: Unlink hard-link partials before freezing file identity

## Area

Node atomic artifact writes / filesystem identity validation.

## Triggers

hard link, no-clobber, indexed output, `.partial`, ctime, file identity,
`artifact_changed`

## Symptoms

- An indexed artifact commits successfully through `link(partial, final)` but its
  registry ref immediately fails with `artifact_changed`.
- The final file has the expected bytes, size, inode and hash, while only `ctime`
  differs from the identity captured during activation.
- Overwrite-by-rename works, but the no-clobber hard-link path fails on its first
  read.

## Root cause

The temporary and final names refer to the same inode after a hard-link commit.
Removing the temporary name changes that inode's link metadata and can update
`ctime`. If the registry freezes `dev/ino/size/mtime/ctime` before unlinking the
temporary name, its own cleanup invalidates the newly issued artifact reference.

## Do

- Use an exclusive same-directory partial and hard-link it to the indexed final
  name for atomic no-clobber semantics.
- After the link succeeds, verify that the partial name still refers to the
  expected inode and unlink it before capturing the final identity.
- Keep unlink and synchronous registry activation in one event-loop segment; do
  not insert cancellation checks or awaited work between them.
- If detach fails, roll back the identity-matching final link synchronously,
  revoke the pending reservation, and do not activate an artifact reference.
- Test the committed artifact through the real registry with at least two reads,
  not only by reading the final path directly.

## Avoid

- Do not activate the registry record and then unlink the temporary hard link.
- Do not swallow detach errors and continue to registry activation.
- Do not weaken identity checks by dropping `ctime` merely to hide the ordering
  bug.
- Do not implement index mode with a check-then-rename sequence that can overwrite
  a concurrent winner.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/subtitleExporter.test.ts test/local-subtitle/subtitleArtifactRegistry.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

Require a real-registry integration test that uses index mode, leaves no
`.partial`, and repeatedly reads the activated ref without `artifact_changed`.

## Related files

- `electron/main/local-subtitle/subtitle-exporter.ts`
- `electron/main/local-subtitle/subtitle-artifact-registry.ts`
- `test/local-subtitle/subtitleExporter.test.ts`
