#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  buildSanitizedRuntimeEnvironment,
  inspectNativeBinaryFile,
  sha256File,
} from "./runtime-manifest.mjs";
import {
  FFMPEG_SOURCE_RELEASE,
  verifyPinnedFfmpegSourceRelease,
} from "./ffmpeg-source-release.mjs";

const execFileAsync = promisify(execFile);

export const WINDOWS_FFMPEG_CANDIDATE = Object.freeze({
  provider: "BtbN/FFmpeg-Builds",
  releaseTag: "autobuild-2026-06-30-13-34",
  releaseId: 346_858_151,
  providerCommit: "7a83528ea3431e9eca982a712bc3a7cd0789d5d0",
  assetId: 462_189_264,
  assetFileName: "ffmpeg-n8.1.2-21-gce3c09c101-win64-lgpl-8.1.zip",
  assetByteSize: 144_332_533,
  assetSha256:
    "3b9eceb438016b647e0755a51ce3a388cd4ed5679e2427cb83a01e1ae2cd0eba",
  version: "n8.1.2-21-gce3c09c101-20260630",
  ffmpegCommit: "ce3c09c101c83add623774d414a9f9498caf5c25",
  license: "LGPL-3.0-or-later",
  artifacts: Object.freeze({
    ffmpeg: Object.freeze({
      relativePath: "bin/ffmpeg.exe",
      byteSize: 112_509_440,
      sha256:
        "c623359f35e7db4820694b77d0f032f075e783a9c7207b81d908c28f148e8a68",
    }),
    ffprobe: Object.freeze({
      relativePath: "bin/ffprobe.exe",
      byteSize: 112_303_104,
      sha256:
        "35a823fb08470f6a1e91149e6c305ffbc5ee76c9901444c850f302ecee146a37",
    }),
  }),
  licenseFile: Object.freeze({
    relativePath: "LICENSE.txt",
    byteSize: 7_651,
    sha256:
      "da7eabb7bafdf7d3ae5e9f223aa5bdc1eece45ac569dc21b3b037520b4464768",
  }),
});

export async function auditWindowsFfmpegCandidate(options) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The Windows FFmpeg audit requires a native win32/x64 host.");
  }
  const archivePath = path.resolve(requirePath(options.archivePath, "archivePath"));
  const expandedRoot = path.resolve(
    requirePath(options.expandedRoot, "expandedRoot"),
  );
  await verifyPinnedFile(archivePath, {
    byteSize: WINDOWS_FFMPEG_CANDIDATE.assetByteSize,
    sha256: WINDOWS_FFMPEG_CANDIDATE.assetSha256,
    label: "BtbN Windows FFmpeg archive",
  });
  const sourceSignatureVerification = await verifyPinnedFfmpegSourceRelease({
    archivePath: options.sourceArchivePath,
    signaturePath: options.sourceSignaturePath,
    publicKeyPath: options.publicKeyPath,
    gpgPath: options.gpgPath,
    gpgvPath: options.gpgvPath,
    cygpathPath: options.cygpathPath,
    platform: "win32",
  });
  if (sourceSignatureVerification.status !== "verified") {
    throw new Error("The pinned FFmpeg source signature was not verified.");
  }

  const licensePath = path.join(
    expandedRoot,
    ...WINDOWS_FFMPEG_CANDIDATE.licenseFile.relativePath.split("/"),
  );
  await verifyPinnedFile(licensePath, {
    ...WINDOWS_FFMPEG_CANDIDATE.licenseFile,
    label: "BtbN LGPLv3 license text",
  });
  const licenseText = await readFile(licensePath, "utf8");
  if (!/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/u.test(licenseText)) {
    throw new Error("The BtbN candidate did not contain the pinned LGPLv3 text.");
  }

  const artifacts = [];
  let sharedConfiguration = null;
  for (const kind of ["ffmpeg", "ffprobe"]) {
    const expected = WINDOWS_FFMPEG_CANDIDATE.artifacts[kind];
    const candidatePath = path.join(
      expandedRoot,
      ...expected.relativePath.split("/"),
    );
    await verifyPinnedFile(candidatePath, {
      ...expected,
      label: `${kind} candidate`,
    });
    const inspection = await inspectNativeBinaryFile(candidatePath);
    if (
      inspection.format !== "pe" ||
      inspection.architectures.length !== 1 ||
      inspection.architectures[0] !== "x64"
    ) {
      throw new Error(`${kind} is not a Windows x64 PE executable.`);
    }
    const probe = await runCommand(candidatePath, ["-hide_banner", "-version"], {
      cwd: expandedRoot,
      env: buildSanitizedRuntimeEnvironment("win32"),
    });
    const configuration = validateWindowsFfmpegVersionOutput(
      kind,
      probe.stdout + probe.stderr,
    );
    if (sharedConfiguration && configuration !== sharedConfiguration) {
      throw new Error("ffmpeg and ffprobe do not report the same configuration.");
    }
    sharedConfiguration = configuration;
    artifacts.push({
      kind,
      relativePath: expected.relativePath,
      byteSize: expected.byteSize,
      sha256: expected.sha256,
      architecture: "x64",
      signatureKind: "unsigned_before_runtime_staging",
    });
  }

  const externalLibraryFlags = extractExternalLibraryFlags(sharedConfiguration);
  const receipt = {
    schemaVersion: 1,
    component: "FFmpeg",
    version: WINDOWS_FFMPEG_CANDIDATE.version,
    target: { platform: "win32", arch: "x64" },
    upstreamSource: {
      version: FFMPEG_SOURCE_RELEASE.version,
      archiveSha256: FFMPEG_SOURCE_RELEASE.archiveSha256,
      signingKeyFingerprint: FFMPEG_SOURCE_RELEASE.signingKeyFingerprint,
      signatureVerification: sourceSignatureVerification,
    },
    binaryDistribution: {
      provider: WINDOWS_FFMPEG_CANDIDATE.provider,
      releaseTag: WINDOWS_FFMPEG_CANDIDATE.releaseTag,
      releaseId: WINDOWS_FFMPEG_CANDIDATE.releaseId,
      providerCommit: WINDOWS_FFMPEG_CANDIDATE.providerCommit,
      assetId: WINDOWS_FFMPEG_CANDIDATE.assetId,
      assetFileName: WINDOWS_FFMPEG_CANDIDATE.assetFileName,
      assetByteSize: WINDOWS_FFMPEG_CANDIDATE.assetByteSize,
      assetSha256: WINDOWS_FFMPEG_CANDIDATE.assetSha256,
      ffmpegCommit: WINDOWS_FFMPEG_CANDIDATE.ffmpegCommit,
      immutableReleaseSelected: true,
    },
    buildAudit: {
      configurationSha256: sha256Text(sharedConfiguration),
      license: WINDOWS_FFMPEG_CANDIDATE.license,
      gplEnabled: false,
      nonfreeEnabled: false,
      version3Enabled: true,
      targetOs: "mingw32",
      architecture: "x86_64",
      externalLibraryFlags,
      externalLibraryCount: externalLibraryFlags.length,
      productionFreezeDeferredTo: "PRE-006",
    },
    licenseFile: WINDOWS_FFMPEG_CANDIDATE.licenseFile,
    artifacts,
    privacy: {
      absolutePathsRecorded: false,
      usernameRecorded: false,
      signingIdentityRecorded: false,
    },
  };
  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }
  return receipt;
}

export function validateWindowsFfmpegVersionOutput(kind, output) {
  const versionPrefix = `${kind} version ${WINDOWS_FFMPEG_CANDIDATE.version}`;
  if (!String(output).split(/\r?\n/u)[0]?.startsWith(versionPrefix)) {
    throw new Error(`${kind} does not report the pinned BtbN FFmpeg version.`);
  }
  const configuration = String(output).match(/^configuration:\s+(.+)$/mu)?.[1];
  if (!configuration) {
    throw new Error(`${kind} did not report its FFmpeg configuration.`);
  }
  for (const required of [
    "--arch=x86_64",
    "--target-os=mingw32",
    "--enable-version3",
    "--disable-libx264",
    "--disable-libx265",
    "--disable-libxvid",
  ]) {
    if (!configuration.includes(required)) {
      throw new Error(`${kind} is missing required Windows LGPL audit flag ${required}.`);
    }
  }
  for (const forbidden of ["--enable-gpl", "--enable-nonfree"]) {
    if (configuration.includes(forbidden)) {
      throw new Error(`${kind} enabled forbidden FFmpeg flag ${forbidden}.`);
    }
  }
  if (/(?:[A-Za-z]:\\Users\\|\/Users\/|\/private\/(?:tmp|var)\/)/u.test(output)) {
    throw new Error(`${kind} exposes a private build-host path.`);
  }
  return configuration;
}

export function extractExternalLibraryFlags(configuration) {
  return [...new Set(
    String(configuration)
      .split(/\s+/u)
      .filter((flag) =>
        /^--enable-(?:lib|gmp$|iconv$|lzma$|openal$|opencl$|sdl2$|vulkan$|zlib$)/u
          .test(flag),
      )
      .sort(),
  )];
}

async function verifyPinnedFile(filePath, expected) {
  const fileStat = await stat(filePath);
  if (
    !fileStat.isFile() ||
    fileStat.size !== expected.byteSize ||
    (await sha256File(filePath)) !== expected.sha256
  ) {
    throw new Error(`${expected.label} failed its pinned integrity check.`);
  }
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function runCommand(command, args, options) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch {
    throw new Error(`Windows FFmpeg audit command failed: ${path.basename(command)}.`);
  }
}

function requirePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function parseCliArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      archive: { type: "string" },
      expanded: { type: "string" },
      "source-archive": { type: "string" },
      "source-signature": { type: "string" },
      "public-key": { type: "string" },
      gpg: { type: "string" },
      gpgv: { type: "string" },
      cygpath: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    archivePath: values.archive,
    expandedRoot: values.expanded,
    sourceArchivePath: values["source-archive"],
    sourceSignaturePath: values["source-signature"],
    publicKeyPath: values["public-key"],
    gpgPath: values.gpg,
    gpgvPath: values.gpgv,
    cygpathPath: values.cygpath,
    outputPath: values.output,
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node audit-ffmpeg-windows-x64.mjs --archive <BtbN.zip> " +
        "--expanded <BtbN-directory> --source-archive <ffmpeg.tar.xz> " +
        "--source-signature <asc> --public-key <asc> --gpg <gpg.exe> " +
        "--gpgv <gpgv.exe> --cygpath <cygpath.exe> [--output <receipt.json>]\n",
    );
    return;
  }
  const receipt = await auditWindowsFfmpegCandidate(options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`windows_ffmpeg_audit_failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
