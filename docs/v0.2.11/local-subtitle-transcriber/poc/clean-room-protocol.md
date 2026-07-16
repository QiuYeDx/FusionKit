# Local Subtitle PoC Clean-room Protocol

## Scope

This protocol covers behavior research against the local read-only
`faster-whisper-GUI` snapshot and the independent FusionKit PoC. The reference
application is AGPL-3.0-only; no source, UI implementation, exporter, subtitle
splitter, configuration file or credential may be copied into FusionKit.

## Allowed observations

- Publicly documented dependency versions and command parameters.
- User-visible configuration choices and resulting behavior.
- Sanitized timing, memory, output hash, error category and cancellation data.
- Public upstream documentation for whisper.cpp, model artifacts, Silero VAD,
  FFmpeg and CUDA.

## Prohibited material

- Reference source code, patches, snippets, tests or translated rewrites.
- Reference configuration files or their absolute local paths.
- API tokens, download headers, cookies, account identifiers or usernames.
- Media, reference transcripts, models, binaries or generated subtitles in Git.
- Human-readable upstream CLI logs as the only protocol or correctness proof.

## Observation record

Each observation must record:

1. A stable evidence ID and date.
2. The observable action and parameter names without copying implementation.
3. The sanitized result or artifact hash.
4. The independent FusionKit requirement derived from the observation.
5. The reviewer who confirms the implementation was written from the design
   contract and public APIs rather than from reference code.

Do not record the reference application's machine path. Use
`local_read_only_snapshot` as its location label and keep any detailed custody
record outside the repository.

## Review gate

Before PRE-002 code is accepted, review the diff for reference project names,
copied comments, identical helper names, exporter structure and credential-like
strings. Any ambiguous provenance blocks the PoC until the implementation can be
recreated from public upstream APIs and this design contract.
