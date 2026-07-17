#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RUNTIME_CONTRACT_VERSION,
  RUNTIME_HASH_PHASE,
  RUNTIME_MANIFEST_RELATIVE_PATH,
  RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildSanitizedRuntimeEnvironment,
  inspectNativeBinaryFile,
  sha256File,
  verifyRuntimeBundle,
} from "./runtime-manifest.mjs";
import {
  FFMPEG_BUILD_CONTRACT,
  validateVersionOutput,
} from "./build-ffmpeg-macos-arm64.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../../..");
const EVIDENCE_ROOT = path.join(
  PROJECT_ROOT,
  "resources/local-subtitle/licenses",
);
const WHISPER_VERSION = "v1.9.1";
const WHISPER_COMMIT = "f049fff95a089aa9969deb009cdd4892b3e74916";

export const RUNTIME_LAYOUTS = Object.freeze({
  "darwin-arm64": Object.freeze({
    targetId: "mac-arm64",
    server: "mac-arm64/metal/whisper-server",
    ffmpeg: "mac-arm64/media/ffmpeg",
    ffprobe: "mac-arm64/media/ffprobe",
    serverBackend: "metal_cpu",
  }),
  "win32-x64": Object.freeze({
    targetId: "win-x64",
    server: "win-x64/cpu/whisper-server.exe",
    ffmpeg: "win-x64/media/ffmpeg.exe",
    ffprobe: "win-x64/media/ffprobe.exe",
    dependencyRoot: "win-x64/cpu",
    serverBackend: "cpu",
  }),
});

const EVIDENCE_DEFINITIONS = Object.freeze({
  licenses: Object.freeze([
    Object.freeze({
      id: "whisper-cpp-mit",
      component: "whisper.cpp",
      spdxExpression: "MIT",
      licenseFiles: Object.freeze(["whisper.cpp-MIT.txt"]),
      noticeFiles: Object.freeze([]),
    }),
    Object.freeze({
      id: "ffmpeg-lgpl-2.1-or-later",
      component: "FFmpeg",
      spdxExpression: "LGPL-2.1-or-later",
      licenseFiles: Object.freeze(["FFmpeg-COPYING.LGPLv2.1.txt"]),
      noticeFiles: Object.freeze([
        "FFmpeg-LICENSE.md",
        "THIRD_PARTY_NOTICES.local-subtitle.md",
      ]),
    }),
  ]),
  sources: Object.freeze([
    Object.freeze({
      id: "whisper-cpp-v1.9.1",
      component: "whisper.cpp",
      version: WHISPER_VERSION,
      fileName: "whisper.cpp-v1.9.1-source.json",
    }),
    Object.freeze({
      id: "ffmpeg-8.1.2",
      component: "FFmpeg",
      version: FFMPEG_BUILD_CONTRACT.version,
      fileName: "FFmpeg-8.1.2-source-offer.json",
    }),
  ]),
});

export function getRuntimeLayout(platform, arch) {
  const layout = RUNTIME_LAYOUTS[`${platform}-${arch}`];
  if (!layout) {
    const code = platform === "darwin" || platform === "win32"
      ? "unsupported_architecture"
      : "unsupported_platform";
    const error = new Error("The requested runtime staging target is unsupported.");
    error.code = code;
    throw error;
  }
  return layout;
}

export async function stageMacosArm64Runtime(options) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS arm64 staging requires a native darwin/arm64 host.");
  }
  const layout = getRuntimeLayout("darwin", "arm64");
  const outputParent = path.resolve(requirePath(options.outputParent, "outputParent"));
  const finalRoot = path.join(outputParent, "local-subtitle");
  const partialRoot = path.join(
    outputParent,
    `local-subtitle.partial-${process.pid}-${Date.now()}`,
  );
  await assertMissing(finalRoot, "The final runtime staging directory already exists.");
  await assertMissing(partialRoot, "The temporary runtime staging directory already exists.");

  const serverPath = path.resolve(requirePath(options.serverPath, "serverPath"));
  const ffmpegPath = path.resolve(requirePath(options.ffmpegPath, "ffmpegPath"));
  const ffprobePath = path.resolve(requirePath(options.ffprobePath, "ffprobePath"));
  const buildReceiptPath = path.resolve(
    requirePath(options.ffmpegBuildReceiptPath, "ffmpegBuildReceiptPath"),
  );
  const signingIdentity = requirePath(options.signingIdentity, "signingIdentity");
  const buildReceipt = JSON.parse(await readFile(buildReceiptPath, "utf8"));
  await validateFfmpegBuildReceipt(buildReceipt, { ffmpegPath, ffprobePath });

  try {
    await mkdir(partialRoot, { recursive: true });
    const stagedInputs = [
      {
        id: "whisper-server-mac-arm64",
        kind: "server",
        inputPath: serverPath,
        relativePath: layout.server,
        version: `${WHISPER_VERSION}+${WHISPER_COMMIT.slice(0, 7)}`,
        backend: layout.serverBackend,
        licenseRef: "whisper-cpp-mit",
        sourceRef: "whisper-cpp-v1.9.1",
        codeIdentifier: "com.fusionkit.local-subtitle.whisper-server",
      },
      {
        id: "ffmpeg-mac-arm64",
        kind: "ffmpeg",
        inputPath: ffmpegPath,
        relativePath: layout.ffmpeg,
        version: FFMPEG_BUILD_CONTRACT.version,
        backend: "media",
        licenseRef: "ffmpeg-lgpl-2.1-or-later",
        sourceRef: "ffmpeg-8.1.2",
        codeIdentifier: "com.fusionkit.local-subtitle.ffmpeg",
      },
      {
        id: "ffprobe-mac-arm64",
        kind: "ffprobe",
        inputPath: ffprobePath,
        relativePath: layout.ffprobe,
        version: FFMPEG_BUILD_CONTRACT.version,
        backend: "media",
        licenseRef: "ffmpeg-lgpl-2.1-or-later",
        sourceRef: "ffmpeg-8.1.2",
        codeIdentifier: "com.fusionkit.local-subtitle.ffprobe",
      },
    ];

    const artifacts = [];
    for (const input of stagedInputs) {
      const outputPath = path.join(partialRoot, ...input.relativePath.split("/"));
      await mkdir(path.dirname(outputPath), { recursive: true });
      await copyFile(input.inputPath, outputPath);
      await chmod(outputPath, 0o755);
      const inspectionBeforeSigning = await inspectNativeBinaryFile(outputPath);
      if (
        inspectionBeforeSigning.format !== "mach-o" ||
        inspectionBeforeSigning.architectures.length !== 1 ||
        inspectionBeforeSigning.architectures[0] !== "arm64"
      ) {
        throw new Error(`${input.kind} is not a thin arm64 Mach-O executable.`);
      }
      const dependencies = await inspectMacosDependencies(outputPath);
      if (!dependencies.systemOnly) {
        throw new Error(`${input.kind} contains an uncontrolled dynamic dependency.`);
      }
      await signMacosExecutable(
        outputPath,
        input.codeIdentifier,
        signingIdentity,
      );
      const signatureKind = await verifyMacosSignature(outputPath);
      const outputStat = await stat(outputPath);
      artifacts.push({
        id: input.id,
        kind: input.kind,
        platform: "darwin",
        arch: "arm64",
        backend: input.backend,
        relativePath: input.relativePath,
        byteSize: outputStat.size,
        sha256: await sha256File(outputPath),
        version: input.version,
        licenseRef: input.licenseRef,
        sourceRef: input.sourceRef,
        executable: true,
        signatureKind,
      });
    }

    const evidence = await stageEvidence(partialRoot);
    const manifest = {
      schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
      runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
      manifestId: "local-subtitle-runtime-darwin-arm64-pre005",
      target: { platform: "darwin", arch: "arm64" },
      integrity: {
        algorithm: "sha256",
        binaryHashPhase: RUNTIME_HASH_PHASE,
        outerSignatureCoverage: "required",
      },
      artifacts,
      licenses: evidence.licenses,
      sources: evidence.sources,
    };
    const manifestPath = path.join(
      partialRoot,
      ...RUNTIME_MANIFEST_RELATIVE_PATH.split("/"),
    );
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const verification = await verifyRuntimeBundle({
      runtimeRoot: partialRoot,
      platform: "darwin",
      arch: "arm64",
      scope: "all",
      launch: true,
    });
    await rename(partialRoot, finalRoot);
    return {
      schemaVersion: 1,
      target: { platform: "darwin", arch: "arm64" },
      manifestSha256: await sha256File(
        path.join(finalRoot, ...RUNTIME_MANIFEST_RELATIVE_PATH.split("/")),
      ),
      artifactSummary: verification.artifactSummary,
      launchResults: verification.launchResults,
      licenseEvidenceValid: true,
      sourceEvidenceValid: true,
      nestedSigningCompletedBeforeHashing: true,
      outerSignatureCoveragePending: true,
      signatureKind: artifacts[0].signatureKind,
      ffmpegSourceSignatureVerification:
        buildReceipt.source.signatureVerification.status,
      readyForBuilderSpike: true,
      privacy: {
        absolutePathsRecorded: false,
        signingIdentityRecorded: false,
      },
    };
  } catch (error) {
    await rm(partialRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function validateFfmpegBuildReceipt(receipt, inputs) {
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.component !== "FFmpeg" ||
    receipt.version !== FFMPEG_BUILD_CONTRACT.version ||
    receipt.target?.platform !== "darwin" ||
    receipt.target?.arch !== "arm64" ||
    receipt.source?.archiveSha256 !== FFMPEG_BUILD_CONTRACT.sourceArchiveSha256 ||
    receipt.build?.license !== FFMPEG_BUILD_CONTRACT.license ||
    receipt.build?.gplEnabled !== false ||
    receipt.build?.nonfreeEnabled !== false ||
    receipt.build?.version3Enabled !== false ||
    receipt.build?.networkEnabled !== false ||
    !Array.isArray(receipt.artifacts)
  ) {
    throw new Error("The FFmpeg build receipt does not match PRE-005.");
  }
  for (const [kind, filePath] of [
    ["ffmpeg", inputs.ffmpegPath],
    ["ffprobe", inputs.ffprobePath],
  ]) {
    const record = receipt.artifacts.find((artifact) => artifact.kind === kind);
    const fileStat = await stat(filePath);
    if (
      !record ||
      record.byteSize !== fileStat.size ||
      record.sha256 !== await sha256File(filePath) ||
      record.architecture !== "arm64" ||
      record.minimumMacosVersion !== "11.0.0" ||
      record.dependencySummary?.systemOnly !== true
    ) {
      throw new Error(`The ${kind} input does not match its build receipt.`);
    }
    const probe = await runCommand(filePath, ["-hide_banner", "-version"], {
      cwd: path.dirname(filePath),
      env: buildSanitizedRuntimeEnvironment("darwin"),
      timeoutMs: 15_000,
    });
    validateVersionOutput(kind, probe.stdout + probe.stderr);
  }
  return true;
}

async function stageEvidence(partialRoot) {
  const licenses = [];
  for (const definition of EVIDENCE_DEFINITIONS.licenses) {
    licenses.push({
      id: definition.id,
      component: definition.component,
      spdxExpression: definition.spdxExpression,
      licenseFiles: await copyEvidenceFiles(
        partialRoot,
        definition.licenseFiles,
      ),
      noticeFiles: await copyEvidenceFiles(
        partialRoot,
        definition.noticeFiles,
      ),
    });
  }
  const sources = [];
  for (const definition of EVIDENCE_DEFINITIONS.sources) {
    const [evidenceFile] = await copyEvidenceFiles(partialRoot, [definition.fileName]);
    sources.push({
      id: definition.id,
      component: definition.component,
      version: definition.version,
      evidenceFile,
    });
  }
  return { licenses, sources };
}

async function copyEvidenceFiles(partialRoot, fileNames) {
  const records = [];
  for (const fileName of fileNames) {
    const inputPath = path.join(EVIDENCE_ROOT, fileName);
    const relativePath = `licenses/${fileName}`;
    const outputPath = path.join(partialRoot, "licenses", fileName);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await copyFile(inputPath, outputPath);
    await chmod(outputPath, 0o644);
    const outputStat = await stat(outputPath);
    records.push({
      relativePath,
      byteSize: outputStat.size,
      sha256: await sha256File(outputPath),
    });
  }
  return records;
}

async function signMacosExecutable(filePath, identifier, identity) {
  const args = [
    "--force",
    "--sign",
    identity,
    "--identifier",
    identifier,
  ];
  if (identity !== "-") args.push("--options", "runtime", "--timestamp");
  args.push(filePath);
  await runCommand("/usr/bin/codesign", args, {
    cwd: path.dirname(filePath),
    env: buildSanitizedRuntimeEnvironment("darwin"),
    timeoutMs: identity === "-" ? 30_000 : 120_000,
  });
}

async function verifyMacosSignature(filePath) {
  await runCommand(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--verbose=4", filePath],
    {
      cwd: path.dirname(filePath),
      env: buildSanitizedRuntimeEnvironment("darwin"),
      timeoutMs: 30_000,
    },
  );
  const details = await runCommand("/usr/bin/codesign", ["-dvvv", filePath], {
    cwd: path.dirname(filePath),
    env: buildSanitizedRuntimeEnvironment("darwin"),
    timeoutMs: 30_000,
    acceptStderr: true,
  });
  const output = `${details.stdout}${details.stderr}`;
  if (/^Signature=adhoc$/mu.test(output)) return "adhoc";
  if (/^Authority=Developer ID Application:/mu.test(output)) {
    return "developer_id";
  }
  throw new Error("The staged macOS executable does not have an accepted signature.");
}

async function inspectMacosDependencies(filePath) {
  const result = await runCommand("/usr/bin/otool", ["-L", filePath], {
    cwd: path.dirname(filePath),
    env: buildSanitizedRuntimeEnvironment("darwin"),
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
    nonSystemDependencyLabels: nonSystem.map((dependency) =>
      dependency.startsWith("@") ? dependency : path.basename(dependency)
    ),
    systemOnly: nonSystem.length === 0,
  };
}

async function runCommand(command, args, options) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (options.acceptStderr === true && error?.code === 0) {
      return {
        exitCode: 0,
        stdout: String(error?.stdout ?? ""),
        stderr: String(error?.stderr ?? ""),
      };
    }
    throw new Error(`Runtime staging command failed: ${path.basename(command)}.`);
  }
}

async function assertMissing(filePath, message) {
  try {
    await stat(filePath);
    throw new Error(message);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
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
      output: { type: "string" },
      server: { type: "string" },
      ffmpeg: { type: "string" },
      ffprobe: { type: "string" },
      "ffmpeg-build-receipt": { type: "string" },
      "sign-identity": { type: "string", default: "-" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    outputParent: values.output,
    serverPath: values.server,
    ffmpegPath: values.ffmpeg,
    ffprobePath: values.ffprobe,
    ffmpegBuildReceiptPath: values["ffmpeg-build-receipt"],
    signingIdentity: values["sign-identity"],
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node stage-runtime.mjs --output <ignored-parent> --server <file> " +
        "--ffmpeg <file> --ffprobe <file> --ffmpeg-build-receipt <json> " +
        "[--sign-identity <identity-or-dash>]\n",
    );
    return;
  }
  const report = await stageMacosArm64Runtime(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`runtime_staging_failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
