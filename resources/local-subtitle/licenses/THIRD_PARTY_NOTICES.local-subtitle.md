# Local Subtitle Runtime Third-Party Notices

The local subtitle runtime uses the following independently distributed
components. This file records the PRE-005 engineering selection and does not
replace the full license texts shipped beside it.

## whisper.cpp v1.9.1

- License: MIT
- Source commit: `f049fff95a089aa9969deb009cdd4892b3e74916`
- License text: `whisper.cpp-MIT.txt`
- Source record: `whisper.cpp-v1.9.1-source.json`

## FFmpeg 8.1.2 — macOS arm64 candidate

- License for the selected build: LGPL-2.1-or-later
- GPL, nonfree and version-3-only components: disabled
- Network protocols and external libraries: disabled
- License text: `FFmpeg-COPYING.LGPLv2.1.txt`
- Upstream license notes: `FFmpeg-LICENSE.md`
- Exact source and build record: `FFmpeg-8.1.2-source-offer.json`

## FFmpeg n8.1.2-21-gce3c09c101 — Windows x64 PRE-005 candidate

- Binary provider: BtbN/FFmpeg-Builds immutable release
  `autobuild-2026-06-30-13-34`
- License for the selected build: LGPL-3.0-or-later
- GPL and nonfree components: disabled
- Version-3-compatible components and a broad external-library set: enabled
- License text: `FFmpeg-COPYING.LGPLv3.txt`
- Upstream license notes: `FFmpeg-LICENSE.md`
- Exact upstream-source and binary-distribution record:
  `FFmpeg-n8.1.2-windows-x64-btbn-source.json`
- Scope: PRE-005 packaging, unsigned integrity and media-format evidence only. PRE-006
  must make the production size/dependency/build selection.

The applicable FFmpeg source record requires the exact upstream source archive,
detached signature and either the build recipe or immutable binary-distribution
record to accompany every release that distributes these binaries. Final legal
and release review remains owned by QA-005.
