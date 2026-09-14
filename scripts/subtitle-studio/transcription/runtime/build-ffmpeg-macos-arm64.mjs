#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { cpus } from "node:os";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildSanitizedRuntimeEnvironment,
  inspectNativeBinaryFile,
  sha256File,
} from "./runtime-manifest.mjs";
import {
  FFMPEG_SOURCE_RELEASE,
} from "./ffmpeg-source-release.mjs";
import { verifyPinnedFfmpegSignature } from "./verify-ffmpeg-source-signature.mjs";
import { runBoundedBuildCommand } from "./build-whisper-server-macos-arm64.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../../../..");

export const FFMPEG_BUILD_CONTRACT = Object.freeze({
  version: FFMPEG_SOURCE_RELEASE.version,
  sourceArchiveFileName: FFMPEG_SOURCE_RELEASE.archiveFileName,
  sourceArchiveByteSize: FFMPEG_SOURCE_RELEASE.archiveByteSize,
  sourceArchiveSha256: FFMPEG_SOURCE_RELEASE.archiveSha256,
  signatureByteSize: FFMPEG_SOURCE_RELEASE.signatureByteSize,
  signatureSha256: FFMPEG_SOURCE_RELEASE.signatureSha256,
  publicKeyByteSize: FFMPEG_SOURCE_RELEASE.publicKeyByteSize,
  publicKeySha256: FFMPEG_SOURCE_RELEASE.publicKeySha256,
  signingKeyFingerprint: FFMPEG_SOURCE_RELEASE.signingKeyFingerprint,
  logicalPrefix: "/opt/fusionkit/local-subtitle/ffmpeg/8.1.2",
  deploymentTarget: "11.0",
  license: "LGPL-2.1-or-later",
});

export const FFMPEG_CONFIGURE_FLAGS = Object.freeze([
  `--prefix=${FFMPEG_BUILD_CONTRACT.logicalPrefix}`,
  "--arch=arm64",
  "--target-os=darwin",
  "--cc=clang",
  "--disable-autodetect",
  "--disable-doc",
  "--disable-debug",
  "--disable-programs",
  "--disable-network",
  "--disable-avdevice",
  "--disable-swscale",
  "--disable-everything",
  "--enable-static",
  "--disable-shared",
  "--enable-ffmpeg",
  "--enable-ffprobe",
  "--enable-protocol=file,pipe",
  "--enable-demuxer=aac,ac3,aiff,eac3,flac,matroska,mov,mp3,ogg,wav",
  "--enable-decoder=aac,aac_fixed,aac_latm,ac3,ac3_fixed,eac3,alac,flac,mp3,mp3float,opus,vorbis,pcm_alaw,pcm_f32be,pcm_f32le,pcm_f64be,pcm_f64le,pcm_mulaw,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_s8,pcm_u16be,pcm_u16le,pcm_u24be,pcm_u24le,pcm_u32be,pcm_u32le,pcm_u8",
  "--enable-parser=aac,aac_latm,ac3,flac,mpegaudio,opus,vorbis",
  "--enable-filter=aformat,aresample,anull",
  "--enable-encoder=pcm_s16le",
  "--enable-muxer=wav,null",
  "--enable-bsf=aac_adtstoasc,null",
  `--extra-cflags=-mmacosx-version-min=${FFMPEG_BUILD_CONTRACT.deploymentTarget}`,
  `--extra-ldflags=-mmacosx-version-min=${FFMPEG_BUILD_CONTRACT.deploymentTarget}`,
]);

export async function buildFfmpegMacosArm64(options) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The FFmpeg macOS build requires a native darwin/arm64 host.");
  }
  const archivePath = path.resolve(requirePath(options.archivePath, "archivePath"));
  const signaturePath = path.resolve(
    requirePath(options.signaturePath, "signaturePath"),
  );
  const publicKeyPath = path.resolve(
    requirePath(options.publicKeyPath, "publicKeyPath"),
  );
  const outputRoot = path.resolve(requirePath(options.outputRoot, "outputRoot"));
  await assertOutputDoesNotExist(outputRoot);

  const workRoot = await mkdtemp(
    path.join(os.tmpdir(), `fusionkit-studio-ffmpeg-${FFMPEG_BUILD_CONTRACT.version}-`),
  );
  const outputPartial = `${outputRoot}.partial-${path.basename(workRoot)}`;
  try {
    // Verification and extraction use the same private snapshot, even if the
    // caller replaces an original source input while the build is running.
    const sourceInputs = await snapshotFfmpegSourceInputs({ archivePath, signaturePath, publicKeyPath, workRoot });
    const signatureVerification = await verifyPinnedFfmpegSignature(sourceInputs);
    const archiveList = await runCommand("/usr/bin/tar", ["-tf", sourceInputs.archivePath], {
      cwd: workRoot,
      env: buildToolEnvironment(workRoot),
      timeoutMs: 30_000,
    });
    validateArchiveEntries(archiveList.stdout.split(/\r?\n/u).filter(Boolean));
    await runCommand("/usr/bin/tar", ["-xf", sourceInputs.archivePath, "-C", workRoot], {
      cwd: workRoot,
      env: buildToolEnvironment(workRoot),
      timeoutMs: 60_000,
    });

    const sourceRoot = path.join(
      workRoot,
      `ffmpeg-${FFMPEG_BUILD_CONTRACT.version}`,
    );
    const release = (await readFile(path.join(sourceRoot, "RELEASE"), "utf8")).trim();
    if (release !== FFMPEG_BUILD_CONTRACT.version) {
      throw new Error("The extracted FFmpeg RELEASE value is not pinned.");
    }
    const gitProbe = await runCommand(
      "/usr/bin/git",
      ["-C", sourceRoot, "rev-parse", "--show-toplevel"],
      {
        cwd: sourceRoot,
        env: buildToolEnvironment(workRoot),
        timeoutMs: 10_000,
        allowFailure: true,
      },
    );
    if (gitProbe.exitCode === 0) {
      throw new Error(
        "The extracted FFmpeg source unexpectedly inherited Git repository metadata.",
      );
    }

    const buildRoot = path.join(workRoot, "build");
    const installRoot = path.join(workRoot, "install-root");
    await mkdir(buildRoot, { recursive: true });
    const buildEnvironment = buildToolEnvironment(workRoot);
    await runCommand(
      path.join(sourceRoot, "configure"),
      FFMPEG_CONFIGURE_FLAGS,
      {
        cwd: buildRoot,
        env: buildEnvironment,
        timeoutMs: 120_000,
      },
    );

    const configHeader = await readFile(path.join(buildRoot, "config.h"), "utf8");
    validateConfiguredLicense(configHeader);
    const jobs = normalizeJobs(options.jobs);
    await runCommand("/usr/bin/make", [`-j${jobs}`], {
      cwd: buildRoot,
      env: buildEnvironment,
      timeoutMs: 15 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    await runCommand("/usr/bin/make", ["install"], {
      cwd: buildRoot,
      env: { ...buildEnvironment, DESTDIR: installRoot },
      timeoutMs: 5 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });

    const installedBinRoot = path.join(
      installRoot,
      FFMPEG_BUILD_CONTRACT.logicalPrefix.slice(1),
      "bin",
    );
    await mkdir(path.join(outputPartial, "bin"), { recursive: true });
    const artifactRecords = [];
    for (const kind of ["ffmpeg", "ffprobe"]) {
      const sourcePath = path.join(installedBinRoot, kind);
      const outputPath = path.join(outputPartial, "bin", kind);
      await copyFile(sourcePath, outputPath);
      await chmod(outputPath, 0o755);
      const versionProbe = await runCommand(
        outputPath,
        ["-hide_banner", "-version"],
        {
          cwd: outputPartial,
          env: buildSanitizedRuntimeEnvironment("darwin", {
            TMPDIR: workRoot,
          }),
          timeoutMs: 15_000,
        },
      );
      validateVersionOutput(kind, versionProbe.stdout + versionProbe.stderr);
      const inspection = await inspectNativeBinaryFile(outputPath);
      if (
        inspection.format !== "mach-o" ||
        inspection.architectures.length !== 1 ||
        inspection.architectures[0] !== "arm64" ||
        inspection.minimumOsVersion !== "11.0.0"
      ) {
        throw new Error(`${kind} did not preserve the arm64/macOS 11 build contract.`);
      }
      await assertNoPrivateBuildPath(outputPath);
      const dependencySummary = await inspectMacosDependencies(outputPath);
      if (!dependencySummary.systemOnly) {
        throw new Error(`${kind} contains a non-system dynamic dependency.`);
      }
      const artifactStat = await stat(outputPath);
      artifactRecords.push({
        kind,
        byteSize: artifactStat.size,
        sha256: await sha256File(outputPath),
        architecture: "arm64",
        minimumMacosVersion: inspection.minimumOsVersion,
        dependencySummary,
        signatureKind: "unsigned_before_runtime_staging",
      });
    }

    const receipt = {
      schemaVersion: 1,
      component: "FFmpeg",
      version: FFMPEG_BUILD_CONTRACT.version,
      target: { platform: "darwin", arch: "arm64" },
      source: {
        archiveFileName: FFMPEG_BUILD_CONTRACT.sourceArchiveFileName,
        archiveByteSize: FFMPEG_BUILD_CONTRACT.sourceArchiveByteSize,
        archiveSha256: FFMPEG_BUILD_CONTRACT.sourceArchiveSha256,
        signatureSha256: FFMPEG_BUILD_CONTRACT.signatureSha256,
        signingKeyFingerprint: FFMPEG_BUILD_CONTRACT.signingKeyFingerprint,
        signatureVerification,
        isolatedFromAncestorGitMetadata: true,
      },
      build: {
        recipe: "scripts/subtitle-studio/transcription/runtime/build-ffmpeg-macos-arm64.mjs",
        logicalPrefix: FFMPEG_BUILD_CONTRACT.logicalPrefix,
        deploymentTarget: FFMPEG_BUILD_CONTRACT.deploymentTarget,
        configureFlags: FFMPEG_CONFIGURE_FLAGS,
        license: FFMPEG_BUILD_CONTRACT.license,
        gplEnabled: false,
        nonfreeEnabled: false,
        version3Enabled: false,
        networkEnabled: false,
        externalLibraries: [],
      },
      artifacts: artifactRecords,
      privacy: {
        absolutePathsRecorded: false,
        usernameRecorded: false,
        signingIdentityRecorded: false,
      },
    };
    await writeFile(
      path.join(outputPartial, "build-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    await mkdir(path.dirname(outputRoot), { recursive: true });
    await rename(outputPartial, outputRoot);
    return receipt;
  } finally {
    await rm(outputPartial, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
  }
}

export async function snapshotFfmpegSourceInputs(options) {
  const inputRoot = path.join(options.workRoot, "source-inputs");
  await mkdir(inputRoot, { mode: 0o700 });
  const snapshot = {};
  for (const [key, fileName] of [
    ["archivePath", FFMPEG_SOURCE_RELEASE.archiveFileName],
    ["signaturePath", "source.tar.xz.asc"],
    ["publicKeyPath", "source-signing-key.asc"],
  ]) {
    const destination = path.join(inputRoot, fileName);
    await copyFile(options[key], destination, fsConstants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
    snapshot[key] = destination;
  }
  return snapshot;
}

export function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("The FFmpeg source archive is empty.");
  }
  const expectedRoot = `ffmpeg-${FFMPEG_BUILD_CONTRACT.version}/`;
  for (const entry of entries) {
    if (
      entry.includes("\0") ||
      entry.includes("\\") ||
      path.posix.isAbsolute(entry) ||
      !entry.startsWith(expectedRoot) ||
      path.posix.normalize(entry) !== entry ||
      entry.split("/").includes("..")
    ) {
      throw new Error("The FFmpeg source archive contains an unsafe path.");
    }
  }
  return true;
}

export function validateConfiguredLicense(configHeader) {
  for (const assertion of [
    "#define CONFIG_GPL 0",
    "#define CONFIG_NONFREE 0",
    "#define CONFIG_VERSION3 0",
  ]) {
    if (!configHeader.includes(assertion)) {
      throw new Error(`FFmpeg configure did not preserve ${assertion}.`);
    }
  }
  if (
    configHeader.includes("--enable-gpl") ||
    configHeader.includes("--enable-nonfree") ||
    configHeader.includes("--enable-version3")
  ) {
    throw new Error("FFmpeg configure enabled a forbidden license mode.");
  }
  return true;
}

export function validateVersionOutput(kind, output) {
  const escapedVersion = FFMPEG_BUILD_CONTRACT.version.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  if (!new RegExp(`^${kind} version ${escapedVersion}(?:\\s|$)`, "mu").test(output)) {
    throw new Error(`${kind} does not report the pinned FFmpeg version.`);
  }
  if (
    output.includes("--enable-gpl") ||
    output.includes("--enable-nonfree") ||
    output.includes("--enable-version3") ||
    /(?:\/Users\/|\/private\/(?:tmp|var)\/|[A-Za-z]:\\Users\\)/u.test(output)
  ) {
    throw new Error(`${kind} version output contains a forbidden build setting.`);
  }
  const configurations = [...output.matchAll(/^configuration:\s*(.*)$/gmu)];
  if (configurations.length !== 1) {
    throw new Error(`${kind} version output must report one complete build configuration.`);
  }
  // The fixed flags contain no whitespace or literal quote characters. FFmpeg
  // quotes comma-separated values and extra compiler flags in its self-report.
  const flags = configurations[0][1].trim().split(/\s+/u).map((flag) =>
    flag.replace(/=(['"])([^'"\s]*)\1$/u, "=$2")
  );
  if (flags.length !== FFMPEG_CONFIGURE_FLAGS.length ||
    flags.some((flag, index) => flag !== FFMPEG_CONFIGURE_FLAGS[index])) {
    throw new Error(`${kind} version output does not match the complete pinned build flags.`);
  }
  return true;
}

async function inspectMacosDependencies(filePath) {
  const result = await runCommand("/usr/bin/otool", ["-L", filePath], {
    cwd: path.dirname(filePath),
    env: buildToolEnvironment(path.dirname(filePath)),
    timeoutMs: 30_000,
  });
  const dependencies = result.stdout
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(" (", 1)[0])
    .filter(Boolean);
  const nonSystem = dependencies.filter(
    (dependency) =>
      !dependency.startsWith("/System/Library/") &&
      !dependency.startsWith("/usr/lib/"),
  );
  return {
    dependencyCount: dependencies.length,
    systemDependencyCount: dependencies.length - nonSystem.length,
    nonSystemDependencyLabels: nonSystem.map((dependency) =>
      dependency.startsWith("@") ? dependency : path.basename(dependency)
    ),
    systemOnly: nonSystem.length === 0,
  };
}

async function assertNoPrivateBuildPath(filePath) {
  const bytes = await readFile(filePath);
  for (const marker of ["/Users/", "/private/tmp/", "/private/var/"]) {
    if (bytes.includes(Buffer.from(marker))) {
      throw new Error("A native artifact contains a private build-host path.");
    }
  }
}

function buildToolEnvironment(tempDirectory) {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: tempDirectory,
    MACOSX_DEPLOYMENT_TARGET: FFMPEG_BUILD_CONTRACT.deploymentTarget,
    ZERO_AR_DATE: "1",
  };
}

async function runCommand(command, args, options) {
  return runBoundedBuildCommand(command, args, {
    ...options,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
}

function normalizeJobs(value) {
  if (value === undefined) return Math.max(1, Math.min(8, cpus().length));
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 32) {
    throw new Error("jobs must be an integer between 1 and 32.");
  }
  return parsed;
}

function requirePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value;
}

async function assertOutputDoesNotExist(outputRoot) {
  try {
    await stat(outputRoot);
    throw new Error("The FFmpeg build output already exists.");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function parseCliArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      archive: { type: "string" },
      signature: { type: "string" },
      "public-key": { type: "string" },
      output: { type: "string" },
      jobs: { type: "string" },
      "require-signature": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    archivePath: values.archive,
    signaturePath: values.signature,
    publicKeyPath: values["public-key"],
    outputRoot: values.output,
    jobs: values.jobs,
    requireSignature: values["require-signature"],
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node build-ffmpeg-macos-arm64.mjs --archive <tar.xz> " +
        "--signature <tar.xz.asc> --public-key <asc> --output <ignored-directory> " +
        "[--require-signature] [--jobs <1-32>] (fixed source signature always verified)\n",
    );
    return;
  }
  const receipt = await buildFfmpegMacosArm64(options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`ffmpeg_build_failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const SOURCE_OFFER_PATH = path.join(
  PROJECT_ROOT,
  "resources/subtitle-studio/transcription/licenses/FFmpeg-8.1.2-source-offer.json",
);
