# FK-PIT-0029: Isolate extracted native source from ancestor Git metadata

## Area

Native build provenance / CMake / source archives.

## Triggers

codeload, source tarball, CMake, `git rev-parse`, wrong build commit, ancestor
repository, whisper.cpp, native artifact manifest.

## Symptoms

- CMake configures an extracted upstream archive successfully but reports the
  current FusionKit commit as the upstream engine or ggml commit.
- `--version`, build info, or an artifact manifest claims a FusionKit SHA for
  third-party code.
- A source archive and a real upstream clone produce different provenance even
  though their source files match.

## Root cause

Git discovers repositories by walking up parent directories. An extracted
archive has no `.git`, so an upstream CMake `git rev-parse` executed inside a
FusionKit ignored directory can resolve the enclosing FusionKit repository.
The build then embeds valid-looking but false provenance.

## Do

- Build release/PRE evidence from an exact upstream clone or worktree whose
  `HEAD` equals the pinned upstream commit.
- Check the configure log and generated build metadata before compiling; the
  reported upstream SHA must match the pinned candidate.
- Keep the source URL/tag, full upstream commit and downloaded archive hash in
  the PoC record or signed artifact manifest.
- Treat an archive-only build as `unknown` provenance unless the build system
  has an explicit, tested commit override that cannot consult an ancestor Git
  tree.
- Reconfigure from a fresh build directory after fixing provenance.

## Avoid

- Do not accept a short SHA merely because it is syntactically valid.
- Do not build an extracted tarball nested under FusionKit without checking how
  upstream build scripts discover Git.
- Do not patch generated metadata after compilation and call the artifact
  reproducible.

## Validation

```text
git -C <upstream-source> rev-parse HEAD
cmake -S <upstream-source> -B <fresh-build> <fixed flags>
cmake --build <fresh-build> --target whisper-server
```

Confirm the clone reports the pinned full upstream commit and the CMake log or
generated build info reports its matching short SHA, never FusionKit `HEAD`.

## Related files

- `scripts/local-subtitle/whisper-server/verify-macos-runtime.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/poc/third-party-candidates.json`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
