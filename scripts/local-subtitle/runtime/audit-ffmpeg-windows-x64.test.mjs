import assert from "node:assert/strict";
import test from "node:test";
import {
  WINDOWS_FFMPEG_CANDIDATE,
  extractExternalLibraryFlags,
  validateWindowsFfmpegVersionOutput,
} from "./audit-ffmpeg-windows-x64.mjs";

function validOutput(kind = "ffmpeg") {
  return (
    `${kind} version ${WINDOWS_FFMPEG_CANDIDATE.version}\n` +
    "configuration: --prefix=/ffbuild/prefix --arch=x86_64 " +
    "--target-os=mingw32 --enable-version3 --enable-libopus " +
    "--enable-zlib --disable-libx264 --disable-libx265 --disable-libxvid\n"
  );
}

test("pins an immutable Windows x64 LGPL candidate", () => {
  assert.equal(WINDOWS_FFMPEG_CANDIDATE.releaseTag, "autobuild-2026-06-30-13-34");
  assert.equal(WINDOWS_FFMPEG_CANDIDATE.assetSha256.length, 64);
  assert.equal(WINDOWS_FFMPEG_CANDIDATE.license, "LGPL-3.0-or-later");
  assert.equal(WINDOWS_FFMPEG_CANDIDATE.artifacts.ffmpeg.byteSize, 112_509_440);
});

test("accepts version3 LGPL configuration and rejects GPL or private paths", () => {
  assert.match(
    validateWindowsFfmpegVersionOutput("ffmpeg", validOutput()),
    /--enable-version3/u,
  );
  assert.throws(
    () => validateWindowsFfmpegVersionOutput(
      "ffmpeg",
      validOutput().replace("--enable-version3", "--enable-version3 --enable-gpl"),
    ),
    /forbidden FFmpeg flag/u,
  );
  assert.throws(
    () => validateWindowsFfmpegVersionOutput(
      "ffmpeg",
      `${validOutput()} C:\\Users\\builder\\secret\n`,
    ),
    /private build-host path/u,
  );
});

test("records enabled external-library flags without duplicates", () => {
  assert.deepEqual(
    extractExternalLibraryFlags(
      "--enable-libopus --enable-zlib --enable-libopus --disable-libx264",
    ),
    ["--enable-libopus", "--enable-zlib"],
  );
});
