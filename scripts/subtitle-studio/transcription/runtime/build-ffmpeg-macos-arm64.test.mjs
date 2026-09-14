import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FFMPEG_BUILD_CONTRACT,
  FFMPEG_CONFIGURE_FLAGS,
  SOURCE_OFFER_PATH,
  snapshotFfmpegSourceInputs,
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
    `configuration: ${FFMPEG_CONFIGURE_FLAGS.join(" ")}\n`;
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

test("checks the entire reported configuration while accepting FFmpeg value quoting", () => {
  const report = (flags) => `ffmpeg version 8.1.2\nconfiguration: ${flags.join(" ")}\n`;
  const quoted = FFMPEG_CONFIGURE_FLAGS.map((flag) => flag.replace(/=(.*)$/u, "='$1'"));
  assert.equal(validateVersionOutput("ffmpeg", report(quoted)), true);
  for (const flags of [
    FFMPEG_CONFIGURE_FLAGS.filter((flag) => !flag.startsWith("--enable-decoder=")),
    [...FFMPEG_CONFIGURE_FLAGS, "--enable-network"],
    FFMPEG_CONFIGURE_FLAGS.map((flag) => flag === "--enable-static" ? "--enable-shared" : flag),
    FFMPEG_CONFIGURE_FLAGS.map((flag) => flag.startsWith("--enable-demuxer=") ? "--enable-demuxer=wav" : flag),
  ]) {
    assert.throws(() => validateVersionOutput("ffmpeg", report(flags)), /complete pinned build flags/u);
  }
  assert.throws(() => validateVersionOutput("ffmpeg", report(quoted) + report(quoted)), /one complete build configuration/u);
});

test("keeps the verified source inputs stable when caller paths are replaced", async () => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ffmpeg-snapshot-"));
  const originals = {};
  try {
    for (const key of ["archivePath", "signaturePath", "publicKeyPath"]) {
      originals[key] = path.join(workRoot, key);
      fs.writeFileSync(originals[key], `original ${key}`);
    }
    const snapshot = await snapshotFfmpegSourceInputs({ ...originals, workRoot });
    for (const key of Object.keys(originals)) {
      fs.unlinkSync(originals[key]);
      fs.writeFileSync(originals[key], `replacement ${key}`);
      assert.equal(fs.readFileSync(snapshot[key], "utf8"), `original ${key}`);
      assert.notEqual(snapshot[key], originals[key]);
      if (process.platform !== "win32") assert.equal(fs.statSync(snapshot[key]).mode & 0o777, 0o600);
    }
    await assert.rejects(snapshotFfmpegSourceInputs({ ...originals, workRoot }), { code: "EEXIST" });
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
});
