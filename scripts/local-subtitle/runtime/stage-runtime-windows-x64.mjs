#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
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
  RUNTIME_MANIFEST_RELATIVE_PATH,
  RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildSanitizedRuntimeEnvironment,
  getWindowsPowerShellPath,
  inspectNativeBinaryFile,
  sha256File,
  verifyRuntimeBundle,
} from "./runtime-manifest.mjs";
import { WINDOWS_FFMPEG_CANDIDATE } from "./audit-ffmpeg-windows-x64.mjs";
import { FFMPEG_SOURCE_RELEASE } from "./ffmpeg-source-release.mjs";
import {
  getRuntimeLayout,
  resolveRuntimeOutputParent,
  verifyStagedCopyMatches,
} from "./stage-runtime.mjs";
import { getLocalSubtitleStagingTarget } from "./staging-contract.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = path.dirname(SCRIPT_PATH);
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "../../..");
const EVIDENCE_ROOT = path.join(
  PROJECT_ROOT,
  "resources/local-subtitle/licenses",
);
const SIGNING_SCRIPT = path.join(
  SCRIPT_DIRECTORY,
  "authenticode-sign-file.ps1",
);

export const WHISPER_WINDOWS_CPU_CONTRACT = Object.freeze({
  version: "v1.9.1",
  commit: "f049fff95a089aa9969deb009cdd4892b3e74916",
  archiveFileName: "whisper-bin-x64.zip",
  archiveByteSize: 7_982_101,
  archiveSha256:
    "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
  artifacts: Object.freeze([
    Object.freeze({
      fileName: "whisper-server.exe",
      kind: "server",
      byteSize: 725_504,
      sha256:
        "2c1ef08694756eda280e79b8217da63ee2af33c87ac3d5f27d68f9f3f966fd32",
    }),
    Object.freeze({
      fileName: "ggml-base.dll",
      kind: "dynamic_library",
      byteSize: 656_384,
      sha256:
        "8be6f3e06388b3a9aac75d29bec86363e2e2f5b0cee86ce6438866bcac0bcf86",
    }),
    Object.freeze({
      fileName: "ggml-cpu-alderlake.dll",
      kind: "dynamic_library",
      byteSize: 790_528,
      sha256:
        "323408503da53ccc67248b26d711f16d73d2d6239f7703a00a6a18b60ed5b8b8",
    }),
    Object.freeze({
      fileName: "ggml-cpu-cannonlake.dll",
      kind: "dynamic_library",
      byteSize: 833_536,
      sha256:
        "0f659d98b823bb871c7845787bba7485facd220099cf58aa773652b9b842ab2e",
    }),
    Object.freeze({
      fileName: "ggml-cpu-cascadelake.dll",
      kind: "dynamic_library",
      byteSize: 830_976,
      sha256:
        "8116b0e516134139de29400c536ecf06fe708ce1a078a96d30b562b30d524fbe",
    }),
    Object.freeze({
      fileName: "ggml-cpu-haswell.dll",
      kind: "dynamic_library",
      byteSize: 791_552,
      sha256:
        "e5925923a47672392f9e9c8c92e4b9b65ea473948bf4f568a0300a3a42485135",
    }),
    Object.freeze({
      fileName: "ggml-cpu-icelake.dll",
      kind: "dynamic_library",
      byteSize: 830_976,
      sha256:
        "b726d528bee0c811c6b2ad8775357379d651cabb487bbf800331697fe73da187",
    }),
    Object.freeze({
      fileName: "ggml-cpu-sandybridge.dll",
      kind: "dynamic_library",
      byteSize: 783_360,
      sha256:
        "1c49c64817233b2447ca305b41c66afa4bed31b058bc190a98af2a30cc703542",
    }),
    Object.freeze({
      fileName: "ggml-cpu-skylakex.dll",
      kind: "dynamic_library",
      byteSize: 833_536,
      sha256:
        "06082dc62a09a82fbba4aab49b2c049b96db84c5fc561a446a8ddbfb9b20bf86",
    }),
    Object.freeze({
      fileName: "ggml-cpu-sse42.dll",
      kind: "dynamic_library",
      byteSize: 772_096,
      sha256:
        "9a8f55ff1dfad231aa6250ac52c330c5bfa5c4c37691c8b591a68b52090ce40c",
    }),
    Object.freeze({
      fileName: "ggml-cpu-x64.dll",
      kind: "dynamic_library",
      byteSize: 776_704,
      sha256:
        "45ff644d301b8a1fffc7c5e3864205047360eb197814c7311f366d106bb5b19f",
    }),
    Object.freeze({
      fileName: "ggml.dll",
      kind: "dynamic_library",
      byteSize: 67_584,
      sha256:
        "db753141098018ab482796052a61e727ee0106cbc280f28397f6a111b5e667d7",
    }),
    Object.freeze({
      fileName: "whisper.dll",
      kind: "dynamic_library",
      byteSize: 1_366_016,
      sha256:
        "b31690c12461517fe9774e61318ab63a69972b948151feed98b913be35f708b6",
    }),
  ]),
});

const WINDOWS_EVIDENCE_DEFINITIONS = Object.freeze({
  licenses: Object.freeze([
    Object.freeze({
      id: "whisper-cpp-mit",
      component: "whisper.cpp",
      spdxExpression: "MIT",
      licenseFiles: Object.freeze(["whisper.cpp-MIT.txt"]),
      noticeFiles: Object.freeze([]),
    }),
    Object.freeze({
      id: "ffmpeg-windows-lgpl-3.0-or-later",
      component: "FFmpeg Windows candidate",
      spdxExpression: "LGPL-3.0-or-later",
      licenseFiles: Object.freeze(["FFmpeg-COPYING.LGPLv3.txt"]),
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
      version: WHISPER_WINDOWS_CPU_CONTRACT.version,
      fileName: "whisper.cpp-v1.9.1-source.json",
    }),
    Object.freeze({
      id: "ffmpeg-windows-n8.1.2-btbn",
      component: "FFmpeg Windows candidate",
      version: WINDOWS_FFMPEG_CANDIDATE.version,
      fileName: "FFmpeg-n8.1.2-windows-x64-btbn-source.json",
    }),
  ]),
});

export async function stageWindowsX64Runtime(options) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Windows x64 staging requires a native win32/x64 host.");
  }
  const layout = getRuntimeLayout("win32", "x64");
  const targetContract = getLocalSubtitleStagingTarget("win32", "x64");
  const outputParent = resolveRuntimeOutputParent(options.outputParent);
  const finalRoot = path.join(outputParent, "local-subtitle");
  const partialRoot = path.join(
    outputParent,
    `local-subtitle.partial-${process.pid}-${Date.now()}`,
  );
  await assertMissing(finalRoot, "The final runtime staging directory already exists.");
  await assertMissing(partialRoot, "The temporary runtime staging directory already exists.");

  const whisperArchivePath = path.resolve(
    requirePath(options.whisperArchivePath, "whisperArchivePath"),
  );
  const whisperRoot = path.resolve(
    requirePath(options.whisperRoot, "whisperRoot"),
  );
  const ffmpegRoot = path.resolve(requirePath(options.ffmpegRoot, "ffmpegRoot"));
  const ffmpegAuditReceiptPath = path.resolve(
    requirePath(options.ffmpegAuditReceiptPath, "ffmpegAuditReceiptPath"),
  );
  const signingProfile = resolveWindowsSigningProfile(
    options.signingMode ?? "unsigned",
    options.certificateThumbprint,
  );
  if (!targetContract.allowedSignatureKinds.includes(
    signingProfile.signatureKind,
  )) {
    throw new Error(
      "The selected Windows staging contract only permits unsigned final bytes.",
    );
  }
  await verifyPinnedFile(whisperArchivePath, {
    byteSize: WHISPER_WINDOWS_CPU_CONTRACT.archiveByteSize,
    sha256: WHISPER_WINDOWS_CPU_CONTRACT.archiveSha256,
    label: "whisper.cpp Windows CPU archive",
  });
  await validateWhisperInputs(whisperRoot);
  const ffmpegAuditReceipt = JSON.parse(
    await readFile(ffmpegAuditReceiptPath, "utf8"),
  );
  await validateWindowsFfmpegAuditReceipt(ffmpegAuditReceipt, ffmpegRoot);

  try {
    await mkdir(partialRoot, { recursive: true });
    const whisperInputs = WHISPER_WINDOWS_CPU_CONTRACT.artifacts.map(
      (artifact) => ({
        id: artifactIdForWhisper(artifact.fileName),
        kind: artifact.kind,
        inputPath: path.join(whisperRoot, artifact.fileName),
        relativePath: artifact.kind === "server"
          ? layout.server
          : `${layout.dependencyRoot}/${artifact.fileName}`,
        version:
          `${WHISPER_WINDOWS_CPU_CONTRACT.version}+` +
          WHISPER_WINDOWS_CPU_CONTRACT.commit.slice(0, 7),
        backend: layout.serverBackend,
        licenseRef: "whisper-cpp-mit",
        sourceRef: "whisper-cpp-v1.9.1",
        executable: artifact.kind === "server",
        expectedByteSize: artifact.byteSize,
        expectedSha256: artifact.sha256,
      }),
    );
    const mediaInputs = ["ffmpeg", "ffprobe"].map((kind) => ({
      id: `${kind}-win-x64`,
      kind,
      inputPath: path.join(
        ffmpegRoot,
        ...WINDOWS_FFMPEG_CANDIDATE.artifacts[kind].relativePath.split("/"),
      ),
      relativePath: layout[kind],
      version: WINDOWS_FFMPEG_CANDIDATE.version,
      backend: "media",
      licenseRef: "ffmpeg-windows-lgpl-3.0-or-later",
      sourceRef: "ffmpeg-windows-n8.1.2-btbn",
      executable: true,
      expectedByteSize: WINDOWS_FFMPEG_CANDIDATE.artifacts[kind].byteSize,
      expectedSha256: WINDOWS_FFMPEG_CANDIDATE.artifacts[kind].sha256,
    }));

    const artifacts = [];
    for (const input of [...whisperInputs, ...mediaInputs]) {
      const outputPath = path.join(partialRoot, ...input.relativePath.split("/"));
      await mkdir(path.dirname(outputPath), { recursive: true });
      await copyFile(input.inputPath, outputPath);
      await verifyStagedCopyMatches(outputPath, {
        byteSize: input.expectedByteSize,
        sha256: input.expectedSha256,
      }, input.id);
      const inspection = await inspectNativeBinaryFile(outputPath);
      if (
        inspection.format !== "pe" ||
        inspection.architectures.length !== 1 ||
        inspection.architectures[0] !== "x64"
      ) {
        throw new Error(`${input.id} is not a Windows x64 PE artifact.`);
      }
      if (signingProfile.mode === "authenticode") {
        await signWindowsArtifact(
          outputPath,
          signingProfile.certificateThumbprint,
        );
      }
      const outputStat = await stat(outputPath);
      const outputSha256 = await sha256File(outputPath);
      if (
        outputStat.size !== input.expectedByteSize ||
        outputSha256 !== input.expectedSha256
      ) {
        throw new Error(`${input.id} changed while its manifest record was created.`);
      }
      artifacts.push({
        id: input.id,
        kind: input.kind,
        platform: "win32",
        arch: "x64",
        backend: input.backend,
        relativePath: input.relativePath,
        byteSize: outputStat.size,
        sha256: outputSha256,
        version: input.version,
        licenseRef: input.licenseRef,
        sourceRef: input.sourceRef,
        executable: input.executable,
        signatureKind: signingProfile.signatureKind,
      });
    }

    const evidence = await stageEvidence(partialRoot);
    const manifest = {
      schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
      runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
      manifestId: "local-subtitle-runtime-win32-x64-v1",
      target: { platform: "win32", arch: "x64" },
      integrityProfile: targetContract.integrityProfile,
      integrity: { ...targetContract.integrity },
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
      platform: "win32",
      arch: "x64",
      scope: "all",
      launch: true,
    });
    await rename(partialRoot, finalRoot);
    return {
      schemaVersion: 1,
      target: { platform: "win32", arch: "x64" },
      manifestSha256: await sha256File(
        path.join(finalRoot, ...RUNTIME_MANIFEST_RELATIVE_PATH.split("/")),
      ),
      artifactSummary: verification.artifactSummary,
      launchResults: verification.launchResults,
      licenseEvidenceValid: true,
      sourceEvidenceValid: true,
      sourceSignatureVerification:
        ffmpegAuditReceipt.upstreamSource.signatureVerification.status,
      nestedSigningCompletedBeforeHashing:
        signingProfile.mode === "authenticode",
      finalArtifactBytesHashedBeforePackaging: true,
      signatureKind: signingProfile.signatureKind,
      signingProfile: signingProfile.reportName,
      integrityProfile: targetContract.integrityProfile,
      outerSignatureCoveragePending: signingProfile.mode === "authenticode",
      readyForBuilderSpike: true,
      productionDecisionId: "local-subtitle-production-freeze-v1",
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

export async function validateWindowsFfmpegAuditReceipt(receipt, ffmpegRoot) {
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.component !== "FFmpeg" ||
    receipt.version !== WINDOWS_FFMPEG_CANDIDATE.version ||
    receipt.target?.platform !== "win32" ||
    receipt.target?.arch !== "x64" ||
    receipt.upstreamSource?.archiveSha256 !== FFMPEG_SOURCE_RELEASE.archiveSha256 ||
    receipt.upstreamSource?.signingKeyFingerprint !==
      FFMPEG_SOURCE_RELEASE.signingKeyFingerprint ||
    receipt.upstreamSource?.signatureVerification?.status !== "verified" ||
    receipt.upstreamSource?.signatureVerification?.fingerprint !==
      FFMPEG_SOURCE_RELEASE.signingKeyFingerprint ||
    receipt.binaryDistribution?.releaseTag !==
      WINDOWS_FFMPEG_CANDIDATE.releaseTag ||
    receipt.binaryDistribution?.assetId !== WINDOWS_FFMPEG_CANDIDATE.assetId ||
    receipt.binaryDistribution?.assetSha256 !==
      WINDOWS_FFMPEG_CANDIDATE.assetSha256 ||
    receipt.buildAudit?.license !== WINDOWS_FFMPEG_CANDIDATE.license ||
    receipt.buildAudit?.gplEnabled !== false ||
    receipt.buildAudit?.nonfreeEnabled !== false ||
    receipt.buildAudit?.version3Enabled !== true ||
    !Array.isArray(receipt.artifacts)
  ) {
    throw new Error("The Windows FFmpeg audit receipt does not match PRE-005.");
  }
  for (const kind of ["ffmpeg", "ffprobe"]) {
    const expected = WINDOWS_FFMPEG_CANDIDATE.artifacts[kind];
    const record = receipt.artifacts.find((artifact) => artifact.kind === kind);
    const filePath = path.join(ffmpegRoot, ...expected.relativePath.split("/"));
    const fileStat = await stat(filePath);
    if (
      !record ||
      record.byteSize !== expected.byteSize ||
      record.sha256 !== expected.sha256 ||
      record.architecture !== "x64" ||
      fileStat.size !== expected.byteSize ||
      await sha256File(filePath) !== expected.sha256
    ) {
      throw new Error(`The Windows ${kind} input does not match its audit receipt.`);
    }
  }
  return true;
}

async function validateWhisperInputs(whisperRoot) {
  for (const artifact of WHISPER_WINDOWS_CPU_CONTRACT.artifacts) {
    await verifyPinnedFile(path.join(whisperRoot, artifact.fileName), {
      ...artifact,
      label: `whisper.cpp ${artifact.fileName}`,
    });
    const inspection = await inspectNativeBinaryFile(
      path.join(whisperRoot, artifact.fileName),
    );
    if (
      inspection.format !== "pe" ||
      inspection.architectures.length !== 1 ||
      inspection.architectures[0] !== "x64"
    ) {
      throw new Error(`${artifact.fileName} is not a Windows x64 PE artifact.`);
    }
  }
}

async function stageEvidence(partialRoot) {
  const licenses = [];
  for (const definition of WINDOWS_EVIDENCE_DEFINITIONS.licenses) {
    licenses.push({
      id: definition.id,
      component: definition.component,
      spdxExpression: definition.spdxExpression,
      licenseFiles: await copyEvidenceFiles(partialRoot, definition.licenseFiles),
      noticeFiles: await copyEvidenceFiles(partialRoot, definition.noticeFiles),
    });
  }
  const sources = [];
  for (const definition of WINDOWS_EVIDENCE_DEFINITIONS.sources) {
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
    const outputStat = await stat(outputPath);
    records.push({
      relativePath,
      byteSize: outputStat.size,
      sha256: await sha256File(outputPath),
    });
  }
  return records;
}

async function signWindowsArtifact(filePath, certificateThumbprint) {
  await runCommand(
    getWindowsPowerShellPath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      SIGNING_SCRIPT,
      "-LiteralPath",
      filePath,
      "-CertificateThumbprint",
      certificateThumbprint,
    ],
    {
      cwd: path.dirname(filePath),
      env: buildSanitizedRuntimeEnvironment("win32"),
      timeoutMs: 60_000,
    },
  );
}

async function verifyPinnedFile(filePath, expected) {
  const fileStat = await stat(filePath);
  if (
    !fileStat.isFile() ||
    fileStat.size !== expected.byteSize ||
    await sha256File(filePath) !== expected.sha256
  ) {
    throw new Error(`${expected.label} failed its pinned integrity check.`);
  }
}

function artifactIdForWhisper(fileName) {
  if (fileName === "whisper-server.exe") {
    return "whisper-server-win-x64-cpu";
  }
  return `whisper-dependency-${fileName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")}`;
}

function normalizeThumbprint(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new Error("certificateThumbprint must be a 40-character SHA-1 thumbprint.");
  }
  return value.toUpperCase();
}

export function resolveWindowsSigningProfile(mode, certificateThumbprint) {
  if (mode === "unsigned") {
    if (certificateThumbprint !== undefined && certificateThumbprint !== "") {
      throw new Error(
        "certificateThumbprint is not accepted in unsigned signing mode.",
      );
    }
    return {
      mode: "unsigned",
      signatureKind: "unsigned",
      reportName: "unsigned_personal_distribution",
      certificateThumbprint: null,
    };
  }
  if (mode === "authenticode") {
    return {
      mode: "authenticode",
      signatureKind: "authenticode",
      reportName: "authenticode_release_or_controlled_test",
      certificateThumbprint: normalizeThumbprint(certificateThumbprint),
    };
  }
  throw new Error("signingMode must be unsigned or authenticode.");
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
    return { stdout, stderr };
  } catch {
    throw new Error(`Windows runtime staging command failed: ${path.basename(command)}.`);
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
      "whisper-archive": { type: "string" },
      "whisper-root": { type: "string" },
      "ffmpeg-root": { type: "string" },
      "ffmpeg-audit-receipt": { type: "string" },
      "certificate-thumbprint": { type: "string" },
      "signing-mode": { type: "string", default: "unsigned" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    outputParent: values.output,
    whisperArchivePath: values["whisper-archive"],
    whisperRoot: values["whisper-root"],
    ffmpegRoot: values["ffmpeg-root"],
    ffmpegAuditReceiptPath: values["ffmpeg-audit-receipt"],
    certificateThumbprint: values["certificate-thumbprint"],
    signingMode: values["signing-mode"],
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node stage-runtime-windows-x64.mjs [--output <ignored-parent>] " +
        "--whisper-archive <whisper-bin-x64.zip> --whisper-root <Release> " +
        "--ffmpeg-root <BtbN-directory> --ffmpeg-audit-receipt <json> " +
        "[--signing-mode unsigned]\n",
    );
    return;
  }
  const report = await stageWindowsX64Runtime(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`windows_runtime_staging_failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
