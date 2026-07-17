#!/usr/bin/env node

import { execFile } from "node:child_process";
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
import { parseArgs, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildSanitizedRuntimeEnvironment,
  inspectNativeBinaryFile,
  sha256File,
} from "./runtime-manifest.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../../..");

export const FFMPEG_BUILD_CONTRACT = Object.freeze({
  version: "8.1.2",
  sourceArchiveFileName: "ffmpeg-8.1.2.tar.xz",
  sourceArchiveByteSize: 11_710_924,
  sourceArchiveSha256:
    "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
  signatureByteSize: 520,
  signatureSha256:
    "0a0963fccd70597838073f3e31b20f4a4d8cc2b5e577472c9a5a1f22624246f8",
  publicKeyByteSize: 1_709,
  publicKeySha256:
    "397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5",
  signingKeyFingerprint: "FCF986EA15E6E293A5644F10B4322F04D67658D8",
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

  await verifyPinnedFile(archivePath, {
    byteSize: FFMPEG_BUILD_CONTRACT.sourceArchiveByteSize,
    sha256: FFMPEG_BUILD_CONTRACT.sourceArchiveSha256,
    label: "source archive",
  });
  await verifyPinnedFile(signaturePath, {
    byteSize: FFMPEG_BUILD_CONTRACT.signatureByteSize,
    sha256: FFMPEG_BUILD_CONTRACT.signatureSha256,
    label: "detached signature",
  });
  await verifyPinnedFile(publicKeyPath, {
    byteSize: FFMPEG_BUILD_CONTRACT.publicKeyByteSize,
    sha256: FFMPEG_BUILD_CONTRACT.publicKeySha256,
    label: "release signing key",
  });

  const signatureVerification = await verifyDetachedSignature({
    archivePath,
    signaturePath,
    publicKeyPath,
    gpgPath: options.gpgPath,
  });
  if (options.requireSignature === true && signatureVerification.status !== "verified") {
    throw new Error(
      "Detached signature verification is required but no verified result is available.",
    );
  }

  const workRoot = await mkdtemp(
    path.join(os.tmpdir(), `fusionkit-ffmpeg-${FFMPEG_BUILD_CONTRACT.version}-`),
  );
  const outputPartial = `${outputRoot}.partial-${path.basename(workRoot)}`;
  try {
    const archiveList = await runCommand("/usr/bin/tar", ["-tf", archivePath], {
      cwd: workRoot,
      env: buildToolEnvironment(workRoot),
      timeoutMs: 30_000,
    });
    validateArchiveEntries(archiveList.stdout.split(/\r?\n/u).filter(Boolean));
    await runCommand("/usr/bin/tar", ["-xf", archivePath, "-C", workRoot], {
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
        recipe: "scripts/local-subtitle/runtime/build-ffmpeg-macos-arm64.mjs",
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
  for (const required of [
    `--prefix=${FFMPEG_BUILD_CONTRACT.logicalPrefix}`,
    "--disable-autodetect",
    "--disable-network",
    "--disable-everything",
    "--enable-ffmpeg",
    "--enable-ffprobe",
  ]) {
    if (!output.includes(required)) {
      throw new Error(`${kind} version output is missing a required build flag.`);
    }
  }
  if (
    output.includes("--enable-gpl") ||
    output.includes("--enable-nonfree") ||
    output.includes("--enable-version3") ||
    /(?:\/Users\/|\/private\/(?:tmp|var)\/|[A-Za-z]:\\Users\\)/u.test(output)
  ) {
    throw new Error(`${kind} version output contains a forbidden build setting.`);
  }
  return true;
}

async function verifyDetachedSignature(options) {
  if (!options.gpgPath) {
    return {
      status: "not_run_tool_unavailable",
      expectedFingerprint: FFMPEG_BUILD_CONTRACT.signingKeyFingerprint,
    };
  }
  const gpgHome = await mkdtemp(path.join(os.tmpdir(), "fusionkit-ffmpeg-gpg-"));
  await chmod(gpgHome, 0o700);
  try {
    await runCommand(
      path.resolve(options.gpgPath),
      ["--homedir", gpgHome, "--batch", "--import", options.publicKeyPath],
      {
        cwd: gpgHome,
        env: buildToolEnvironment(gpgHome),
        timeoutMs: 30_000,
      },
    );
    const verification = await runCommand(
      path.resolve(options.gpgPath),
      [
        "--homedir",
        gpgHome,
        "--batch",
        "--status-fd",
        "1",
        "--verify",
        options.signaturePath,
        options.archivePath,
      ],
      {
        cwd: gpgHome,
        env: buildToolEnvironment(gpgHome),
        timeoutMs: 30_000,
      },
    );
    const fingerprint = verification.stdout.match(
      /^\[GNUPG:\] VALIDSIG ([A-F0-9]{40})\b/mu,
    )?.[1];
    if (fingerprint !== FFMPEG_BUILD_CONTRACT.signingKeyFingerprint) {
      throw new Error("FFmpeg detached signature used an unexpected signing key.");
    }
    return { status: "verified", fingerprint };
  } finally {
    await rm(gpgHome, { recursive: true, force: true });
  }
}

async function verifyPinnedFile(filePath, expected) {
  const fileStat = await stat(filePath);
  if (
    !fileStat.isFile() ||
    fileStat.size !== expected.byteSize ||
    (await sha256File(filePath)) !== expected.sha256
  ) {
    throw new Error(`The pinned ${expected.label} failed its integrity check.`);
  }
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
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const result = {
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? ""),
    };
    if (options.allowFailure === true) return result;
    throw new Error(`Native build command failed: ${path.basename(command)}.`);
  }
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
      gpg: { type: "string" },
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
    gpgPath: values.gpg,
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
        "[--gpg <gpg>] [--require-signature] [--jobs <1-32>]\n",
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
  "resources/local-subtitle/licenses/FFmpeg-8.1.2-source-offer.json",
);
