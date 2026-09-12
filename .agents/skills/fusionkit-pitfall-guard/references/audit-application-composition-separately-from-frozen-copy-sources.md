# FK-PIT-0138: Audit application composition separately from frozen copy sources

## Area

Subtitle Studio / fixed source provenance / application integration.

## Triggers

Worktree drift, changed electron/main/index.ts, reference-only evidence,
application-composition, T05 shutdown integration, frozen replay preflight.

## Symptoms

Paired replay cannot start after an intentional application lifecycle wiring
change because the source worktree verifier also inventories the main application
entry. The file is recorded as reference-only application-composition evidence,
with no copy destination; the copied transcription implementation is unchanged.

## Root cause

The T01 inventory contains both immutable copy inputs and composition evidence.
Treating every inventoried current file as frozen prevents later integration,
but excluding all reference-only files would silently permit unrelated changes
to dependency, runtime, and legacy boundary evidence.

## Do

- Keep the T01 baseline and T02/T03/T04 copy manifests byte-identical. Replay
  continues to read historical Git blobs and verify their frozen hashes.
- Add independent current composition audit metadata for each fully reviewed
  integration file, recording the fixed source commit, source path, source blob
  OID/SHA-256, exact reviewed current Git blob OID, and concrete reason.
- Accept an audit only when the matching baseline entry is application-composition,
  reference-only, and has a null planned destination. Match an exact path;
  reject unknown, duplicate, malformed, stale, or unused entries.
- Keep Git responsible for current checkout normalization, with direct file
  hashing and bounded child processes. Continue rejecting symlinks and external
  clean filters before checking an audited current hash.
- Prove that an approved current composition leaves the entire generated copy
  plan unchanged, and that copied-source edits or further composition edits
  still fail. Re-run actual paired replay, not only synthetic verifier tests.

## Avoid

- Do not update the frozen source commit or regenerate copy manifests to include
  a later application integration change.
- Do not skip every reference-only path, permit whole directories, or accept any
  current hash merely because its historical baseline category was evidence.
- Do not silently accept a removed or reverted audit: changing the reviewed
  current file requires removing or renewing its independent audit explicitly.
- Do not mistake this maintenance metadata for proof that the newly wired
  application behavior or actual native ASR has passed acceptance.

## Validation

```text
node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance/copy.test.ts test/subtitle-studio-provenance/replay.test.ts test/subtitle-studio-provenance/transcript-executor-replay.test.ts --maxWorkers=1 --minWorkers=1
node scripts/subtitle-studio-provenance/copy.mjs --check
node scripts/subtitle-studio-provenance/transcript-executor-copy.mjs --check
```

Negative fixtures include copied-source mutation, wrong historical identity,
unknown/wildcard/duplicate entries, stale current content, removed audits,
symlinks, and clean filters. CRLF checkout conversion must still resolve to the
same reviewed Git blob without changing frozen SHA-256 checks.

## Related files

- `scripts/subtitle-studio-provenance/copy.mjs`
- `scripts/subtitle-studio-provenance/current-composition-audits.json`
- `test/subtitle-studio-provenance/copy.test.ts`
- `resources/subtitle-studio/provenance/transcription-baseline.json`
- `electron/main/index.ts`
