import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  FFMPEG_BUILD_CONTRACT,
  FFMPEG_CONFIGURE_FLAGS,
  SOURCE_OFFER_PATH,
  validateArchiveEntries,
  validateConfiguredLicense,
  validateVersionOutput,
} from "./build-ffmpeg-macos-arm64.mjs";

test("keeps the FFmpeg build LGPL-only, offline, and independent of host libraries", () => {
  assert.equal(FFMPEG_CONFIGURE_FLAGS.includes("--disable-autodetect"), true);
  assert.equal(FFMPEG_CONFIGURE_FLAGS.includes("--disable-network"), true);
  assert.equal(FFMPEG_CONFIGURE_FLAGS.includes("--disable-everything"), true);
  assert.equal(FFMPEG_CONFIGURE_FLAGS.some((flag) => flag === "--enable-gpl"), false);
  assert.equal(FFMPEG_CONFIGURE_FLAGS.some((flag) => flag === "--enable-nonfree"), false);
  assert.equal(FFMPEG_CONFIGURE_FLAGS.some((flag) => flag === "--enable-version3"), false);
  assert.equal(FFMPEG_BUILD_CONTRACT.license, "LGPL-2.1-or-later");
  assert.equal(FFMPEG_BUILD_CONTRACT.logicalPrefix.startsWith("/opt/fusionkit/"), true);
});

test("source offer matches the pinned archive, signing key, and build contract", () => {
  const sourceOffer = JSON.parse(fs.readFileSync(SOURCE_OFFER_PATH, "utf8"));
  assert.equal(sourceOffer.version, FFMPEG_BUILD_CONTRACT.version);
  assert.equal(
    sourceOffer.sourceArchive.sha256,
    FFMPEG_BUILD_CONTRACT.sourceArchiveSha256,
  );
  assert.equal(
    sourceOffer.detachedSignature.sha256,
    FFMPEG_BUILD_CONTRACT.signatureSha256,
  );
  assert.equal(
    sourceOffer.detachedSignature.signingKeyFingerprint,
    FFMPEG_BUILD_CONTRACT.signingKeyFingerprint,
  );
  assert.equal(sourceOffer.build.logicalPrefix, FFMPEG_BUILD_CONTRACT.logicalPrefix);
  assert.equal(
    sourceOffer.build.macosDeploymentTarget,
    FFMPEG_BUILD_CONTRACT.deploymentTarget,
  );
  assert.equal(sourceOffer.license.gplEnabled, false);
  assert.equal(sourceOffer.license.nonfreeEnabled, false);
});

test("accepts only the pinned archive root and rejects traversal", () => {
  assert.equal(
    validateArchiveEntries([
      "ffmpeg-8.1.2/",
      "ffmpeg-8.1.2/configure",
      "ffmpeg-8.1.2/libavcodec/aac/aacdec.c",
    ]),
    true,
  );
  assert.throws(
    () => validateArchiveEntries(["ffmpeg-8.1.2/../outside"]),
    /unsafe path/u,
  );
  assert.throws(
    () => validateArchiveEntries(["/absolute/source"]),
    /unsafe path/u,
  );
  assert.throws(
    () => validateArchiveEntries(["other-project/file"]),
    /unsafe path/u,
  );
});

test("requires the three disabled license switches in generated config", () => {
  assert.equal(
    validateConfiguredLicense(
      "#define CONFIG_GPL 0\n" +
        "#define CONFIG_NONFREE 0\n" +
        "#define CONFIG_VERSION3 0\n",
    ),
    true,
  );
  assert.throws(
    () => validateConfiguredLicense(
      "#define CONFIG_GPL 1\n" +
        "#define CONFIG_NONFREE 0\n" +
        "#define CONFIG_VERSION3 0\n",
    ),
    /CONFIG_GPL 0/u,
  );
});

test("rejects version output that leaks a build path or enables GPL", () => {
  const valid =
    `ffmpeg version ${FFMPEG_BUILD_CONTRACT.version}\n` +
    `configuration: --prefix=${FFMPEG_BUILD_CONTRACT.logicalPrefix} ` +
    "--disable-autodetect --disable-network --disable-everything " +
    "--enable-ffmpeg --enable-ffprobe\n";
  assert.equal(validateVersionOutput("ffmpeg", valid), true);
  assert.throws(
    () => validateVersionOutput("ffmpeg", `${valid} /Users/builder/source\n`),
    /forbidden build setting/u,
  );
  assert.throws(
    () => validateVersionOutput("ffmpeg", `${valid} --enable-gpl\n`),
    /forbidden build setting/u,
  );
});
