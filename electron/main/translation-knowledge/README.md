# Translation knowledge service (P0.1)

`KnowledgeService` owns an independent `userData/translation-knowledge` directory. It imports only the shared FK-TK protocol; it does not access either subtitle tool's private data, settings, model credentials or runtime.

## Persistence and concurrency

Every successful mutation writes a complete immutable `generation-N-UUID.json`, flushes it, then publishes one `current.json` pointer by replacement. The pointer includes the exact file digest and previous pointer. Generation files are retained for inspection and future recovery tooling. Missing or corrupt current data is an error, never an empty library or automatic fallback. One service owns each canonical root within the Electron main process, and reads and writes join the same queue.

The pointer replacement is the publication cutoff. Caller guards run after reading the transaction and immediately before replacement. Failures before replacement leave the old generation; failures after replacement report `PUBLICATION_UNCERTAIN` and retain the new generation and import identity. Repeating that import first reads its persisted receipt, before checking the original plan's generation. An owner or decision mismatch cannot reuse the receipt. Plans expire after 15 minutes or when the owner selects another file, and owner release fences pending imports.

Node provides file flushing and atomic rename on supported filesystems. On Windows it does not expose a portable directory flush primitive; known directory-open/fsync limitations are handled without deleting the old pointer. The automated suite exercises publication faults on the host filesystem; it does **not** establish power-loss durability or a real Windows filesystem guarantee. Native Windows acceptance remains separate work. Cross-process concurrent writers and network filesystems are not supported by this increment.

## Revisions, trust and imports

New manual records start at revision 1. Edits require the current generation and record revision. Exact no-op saves return the unchanged snapshot. A content edit produces a new revision and revokes its approval; evidence/required-scope dependency changes also suspend affected ready descendants for review. Display-only `aboutSubjectIds` do not activate or pause knowledge. Human adoption is explicit, and approvals bind the exact entry revision and JCS digest. File declarations and provenance never supply approvals.

Import previews contain all entities and warning diagnostics. Local conflicts are retained by default; same-revision content disagreements cannot be directly overwritten. Explicit different-revision replacement produces `max(local, incoming) + 1`; an explicit copy receives a new UUID and revision 1. All declared references are remapped, and a previously new incoming record whose content changes through remapping receives a new local revision. Current derived-parent claims are recomputed against final versions; historical claims retain evidence. The entire resulting graph is validated before publication.

Bulk import adoption accepts only ready, available entries and excludes required/core records. Any identity-conflict import is saved for subsequent individual review. Explicit bulk review likewise requires individual handling for required/core entries. Potential term disagreements remain diagnostics; separate collections and subject scopes may maintain and approve different meanings. Translation-time conflict enforcement belongs to P1.

## Portable metadata and export

Top-level unknown extension namespaces are preserved verbatim. Different values for an existing namespace produce an explicit preview diagnostic and reject commit; this increment does not offer a metadata conflict editor. Source-package author/sharing declarations and package extensions are kept in the non-executing `org.fusionkit.package-provenance` extension, shaped as `{ "version": 1, "packages": [ /* original FK-TK package headers */ ] }`. Exact headers are deduplicated by JCS digest. These declarations describe their own source package, never the merged library or a trust decision. The same protocol resource limits apply to retained metadata.

Backup exports preserve every current entity, status, reference and extension. They exclude local approvals, import ownership and receipts, and do not promise a complete revision history. Share exports select trusted ready entries from chosen unarchived collections; reference memories require explicit opt-in. Necessary sources and subjects are included. Because this increment's share request selects collections, it does not implicitly include styles, recipes, preference templates or unrelated package provenance. Whole-library backup preserves those types.

The native save boundary writes and flushes a temporary file, then atomically publishes it with an exclusive hard link. Existing destinations are never overwritten. Filesystems that cannot publish hard links (including FAT32/exFAT) receive an actionable `unsupported_destination` error and no partial output; save to a writable local folder and copy the complete file to that drive. Portable replacement on those filesystems remains follow-up work. Shutdown stops waiting for open native dialogs, fences late selections, and still joins admitted filesystem and repository operations.

No source URL is fetched automatically. Export detects local paths and credential-like values and blocks with field diagnostics; it never silently scrubs versioned content under the same ID. Portable/redacted-copy editing and a richer privacy preview remain follow-up work.

## Increment boundaries and validation

This service implements the foundational management and interchange slice, not the whole P0/P1 design. Import compensation/undo, permanent deletion, full revision-history recovery UI, archive-impact previews, advanced metadata conflicts, cross-process locking, physical crash testing, native Windows acceptance, translation retrieval/compilation, task snapshots and automatic learning remain future increments.

Run `node node_modules/vitest/vitest.mjs run test/translation-knowledge/service.test.ts --maxWorkers=1 --minWorkers=1`. Tests use isolated real filesystem roots and cover all protocol entity kinds, backups/shares, trust, revision conflicts, dependency copies, unchanged saves, same-name meanings, source invalidation, owner fences, concurrent receipts, restart idempotency, each publication failure stage and corruption. No frontend service is needed.
