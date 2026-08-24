# FK-PIT-0034: Use a stable logical prefix for reproducible native builds

## Area

Native build provenance / FFmpeg / reproducibility

## Triggers

configure prefix,DESTDIR,private path,FFmpeg,reproducible build

## Symptoms

Using a host output directory as configure prefix can embed private machine paths in an otherwise releasable binary.

## Root cause

Autoconf-style builds can embed `--prefix` in generated configuration, help
text, lookup paths or binary string tables. Pointing `--prefix` at a developer
output directory therefore leaks `/Users/...` or a temporary build path and
makes otherwise identical builds depend on the host. `DESTDIR` exists to keep
the logical install prefix separate from the temporary filesystem destination.

## Do

- Pin a stable, product-owned logical prefix such as
  `/opt/fusionkit/local-subtitle/ffmpeg/<version>` in the build contract.
- Run `make install` with a temporary `DESTDIR`, then copy only the audited
  release artifacts from `DESTDIR/<logical-prefix>` into staging.
- Record the logical prefix and complete configure flags in the build receipt.
- Scan final binaries for private build-root markers such as `/Users/`,
  `/private/tmp/` and `/private/var/` before accepting them.
- Keep the build environment minimal and deterministic, including deployment
  target and archive timestamp controls.

## Avoid

- Do not use the repository, user home, ignored PoC directory or random temp
  directory as `--prefix`.
- Do not treat a clean receipt as proof if the actual binary has not been
  scanned for host paths.
- Do not patch leaked paths in a compiled binary and call it reproducible.

## Validation

```text
node --test scripts/local-subtitle/runtime/build-ffmpeg-macos-arm64.test.mjs
node scripts/local-subtitle/runtime/build-ffmpeg-macos-arm64.mjs <ignored source arguments>
```

The receipt must contain only the pinned logical prefix, and the build must
reject any final binary containing a private host path.

## Related files

- `scripts/local-subtitle/runtime/build-ffmpeg-macos-arm64.mjs`
- `resources/local-subtitle/licenses/FFmpeg-8.1.2-source-offer.json`
- `docs/v0.2.11/local-subtitle-transcriber/poc/third-party-candidates.json`
