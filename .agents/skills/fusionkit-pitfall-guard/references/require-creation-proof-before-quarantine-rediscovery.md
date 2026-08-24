# FK-PIT-0049: Require creation proof before quarantine rediscovery

## Area

Node transactional file recovery, hard-link quarantine, and managed resource moves.

## Triggers

Hard-link quarantine, `EEXIST`, same inode, prefix scan, recovery receipt,
pre-existing hidden link.

## Symptoms

- A failed move import removes a pre-existing hidden hard link that the current
  transaction never created.
- A quarantine reservation collides with `EEXIST`, but rollback scans matching
  prefixes and claims another pathname solely because it names the same inode.
- Source recovery succeeds while causing an unrelated user-owned directory entry
  to disappear.

## Root cause

Device, inode, birth time and content metadata can prove that two names refer to
the same file object. They cannot prove which transaction created either name.
Prefix scanning without a retained creation receipt turns identity validation
into an ownership claim.

## Do

- Record the exact quarantine path immediately after a successful hard-link
  creation, before any awaited work or callback can intervene.
- Permit quarantine rediscovery only when that transaction already retained an
  exact path receipt and the recorded path subsequently disappeared or moved.
- Keep rediscovery inside the verified parent directory and require both the
  fixed quarantine prefix and stable object/content identity.
- Treat `EEXIST` before receipt creation as a failed reservation and leave the
  existing pathname untouched.

## Avoid

- Do not scan quarantine prefixes when the receipt has no previously owned path.
- Do not infer ownership from same-inode or same-content evidence alone.
- Do not delete an identity-matching path merely to make rollback appear clean.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/modelManager.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

Cover a deterministic quarantine name collision where the existing name is a
hard link to the selected source. The move must fail, while both the original
source and the pre-existing link retain their bytes.

## Related files

- `electron/main/local-subtitle/model-manager.ts`
- `test/local-subtitle/modelManager.test.ts`
