import assert from "node:assert/strict";
import test from "node:test";
import {
  FFMPEG_SOURCE_RELEASE,
  parseValidSignatureFingerprint,
} from "./ffmpeg-source-release.mjs";

test("pins the official FFmpeg 8.1.2 source release and signing key", () => {
  assert.equal(FFMPEG_SOURCE_RELEASE.version, "8.1.2");
  assert.equal(FFMPEG_SOURCE_RELEASE.archiveByteSize, 11_710_924);
  assert.equal(FFMPEG_SOURCE_RELEASE.archiveSha256.length, 64);
  assert.equal(FFMPEG_SOURCE_RELEASE.signingKeyFingerprint.length, 40);
});

test("accepts only the fixed FFmpeg release signing fingerprint", () => {
  assert.equal(
    parseValidSignatureFingerprint(
      `[GNUPG:] GOODSIG B4322F04D67658D8 FFmpeg release signing key\n` +
        `[GNUPG:] VALIDSIG ${FFMPEG_SOURCE_RELEASE.signingKeyFingerprint} 2026-07-01 0 4 0 1 10 00 ${FFMPEG_SOURCE_RELEASE.signingKeyFingerprint}\n`,
    ),
    FFMPEG_SOURCE_RELEASE.signingKeyFingerprint,
  );
  assert.throws(
    () => parseValidSignatureFingerprint(
      "[GNUPG:] VALIDSIG 0000000000000000000000000000000000000000 2026-07-01",
    ),
    /unexpected signing key/u,
  );
});
