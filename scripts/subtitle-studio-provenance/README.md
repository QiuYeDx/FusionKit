# Subtitle Studio transcription provenance

This maintenance tool freezes the I2 production source at the commit in `policy.mjs`.
It reads Git blobs and TypeScript ASTs; it never imports the legacy application,
loads native addons, starts services, or reads userData/media/model staging.
Studio runtime and business tests must not import this directory.

From the repository root, use the installed Node/TypeScript without invoking pnpm:

```sh
node scripts/subtitle-studio-provenance/generate.mjs --write resources/subtitle-studio/provenance/transcription-baseline.json
node scripts/subtitle-studio-provenance/generate.mjs
node scripts/subtitle-studio-provenance/generate.mjs --check
node scripts/subtitle-studio-provenance/generate.mjs --check-worktree
node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance
```

`--write` requires an explicit output path. `--check` (also the default) rebuilds
the selected historical commit and compares the entire canonical JSON byte for
byte; it does not update a baseline. `--check-worktree` performs that historical
check first, then rejects changed, deleted and newly selected tracked/unignored
files. Both checks accept an optional baseline path. `--root <repository>` and
`--source-commit <full commit ID>` are explicit overrides; changing the historical
source also requires reviewing policy, snapshots and computed-loader audit hashes.
The command refuses to overwrite inventoried source files.

The manifest contains Git blob OIDs, SHA-256, byte sizes, file modes, classifications,
unique proposed destinations, import/type/require/URL edges, explicit resource
edges, default expressions and statically extracted values, and complete tracked
resource JSON snapshots. Keys and file lists are stably ordered; there are no
timestamps or host-specific paths; canonical logical build prefixes in source
receipts remain verbatim. Proposed destinations are not existing copies
and have no copied-file digest. Reference-only files have no proposed destination.

`policy.mjs` is the reviewed selection and mapping policy. Local module dependencies
extend its roots; missing targets, unclassified files, syntax errors, unknown
packages, conflicting destinations and unaudited computed loaders fail generation.
Computed-loader exceptions match an exact source/expression and source SHA-256,
so changing surrounding target construction also requires renewed review. Native
C++, embedded child-process JavaScript, resource strings, brand identities and
application composition have explicit manual audit records. AST analysis alone
does not prove these boundaries. Relative import paths must later be recalculated
from both source and target mappings, rather than mechanically replacing names.

Historical PoC/spike tools and old renderer/IPC composition are reference evidence;
benchmark code is excluded unless a selected test actually imports its helper.
Frozen manifest pins and license statuses remain claims of their source manifests,
not proof of installed binaries, native execution, platform acceptance or new
release approval. The later copy task must resolve reference-only test dependencies,
replace output/translation handoffs and introduce independent resource ownership.

Git blobs define cross-platform byte identity. Worktree comparison delegates CRLF
and encoding normalization to `git hash-object --path --stdin` without writing
objects. It refuses clean-filter attributes before hashing (to avoid executing
external filters), and refuses symlinked source paths. Ignored staging/model artifacts
are not enumerated. This check reports content drift separately from historical
reconstruction and does not change the index, source, baseline or lockfile.

## T02 independent source copy

```sh
node scripts/subtitle-studio-provenance/copy.mjs --write
node scripts/subtitle-studio-provenance/copy.mjs --check
node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance/copy.test.ts
node node_modules/vitest/vitest.mjs run test/subtitle-studio/transcription
```

The copier reconstructs the 84-file production closure from the frozen main
composition edges, then adds 9 unchanged licenses and the selected normal test
roots with their actual helper/fixture dependencies. The initial result is 120
files, including 24 test suites. Unselected native tooling, old composition and
historical PoC sources are recorded as deferred/reference-only.

`copy-policy.mjs` owns selection and the two explicit source-reading test edits.
`copy-literals.json` lists exact source file/token/count edits; `copy-json.json`
lists exact manifest field pointers and old/new values. Module and relative URL
paths are recalculated from both ends of the mapping. The code does not apply
global string replacements, rename arbitrary identifiers or change algorithms,
default inference parameters, upstream content hashes or historical license bytes.

Both modes first validate the frozen baseline and current source worktree.
All source Git blobs are checked against their byte size and SHA-256 again.
T02 hashes worktree sources through Git file arguments with a 10-second timeout
per subprocess, preserving Git's CRLF/encoding rules and clean-filter/symlink
rejection. This avoids a host-observed stall in Node's large synchronous stdin
pipes while keeping the T01 freezing tool unchanged.
The entire destination set is checked before writing: missing targets are created
only with explicit `--write`, and a differing existing file, conflicting target
or symlink is rejected. Verification never restores user edits. After writing,
every destination is read back and checked. The generated
`resources/subtitle-studio/provenance/transcription-fork.json` records the actual
source/target identities and each precise transformation, with no time or host
path. A changed recipe or adapted destination requires an explicit reviewed
update; `--write` does not forcibly reset the prior generated result.

The source copy remains unregistered. Its independent IPC and resource roots
are not permission to invoke legacy move behavior or to load an old addon.
No ready resource receipt is generated. Later native rebuilding/signing, model
copy-only import, document sink and packaging composition remain separate work.
Normal tests consume only the new copy. Migration replay stays in the separate
maintenance test directory and may use isolated frozen Git sources for comparison.
