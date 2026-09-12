import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  LOCAL_SUBTITLE_STAGING_CONTRACT,
  STAGING_LIMITS,
  getLocalSubtitleStagingTarget,
} from "./staging-contract.mjs";

const execFileAsync = promisify(execFile);
const MAX_NATIVE_HEADER_BYTES = 1024 * 1024;
const FILE_HASH_CHUNK_BYTES = 1024 * 1024;
const READ_ONLY_NOFOLLOW_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

export const RUNTIME_MANIFEST_RELATIVE_PATH =
  LOCAL_SUBTITLE_STAGING_CONTRACT.runtimeManifestRelativePath;
export const RUNTIME_MANIFEST_SCHEMA_VERSION =
  LOCAL_SUBTITLE_STAGING_CONTRACT.runtimeManifestSchemaVersion;
export const RUNTIME_CONTRACT_VERSION =
  LOCAL_SUBTITLE_STAGING_CONTRACT.runtimeContractVersion;
export const RUNTIME_HASH_PHASE =
  "after_nested_code_signing_before_outer_bundle_signing";
export const RUNTIME_UNSIGNED_HASH_PHASE =
  "unsigned_final_bytes_before_outer_packaging";
export const PERSONAL_DISTRIBUTION_OUTER_COVERAGE =
  "not_required_personal_distribution";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PRIVATE_PATH_PATTERN =
  /(?:\/Users\/|\/private\/(?:tmp|var)\/|[A-Za-z]:\\Users\\)/u;
const ARTIFACT_KINDS = new Set([
  "server",
  "dynamic_library",
  "ffmpeg",
  "ffprobe",
]);
const BACKENDS = new Set(["cpu", "cuda", "metal_cpu", "media"]);
const SIGNATURE_KINDS = new Set([
  "adhoc",
  "developer_id",
  "authenticode",
  "unsigned",
]);
const SUPPORTED_TARGETS = Object.freeze({
  darwin: Object.freeze({ arch: "arm64", targetId: "darwin-arm64" }),
  win32: Object.freeze({ arch: "x64", targetId: "win32-x64" }),
});

export class LocalSubtitleRuntimeError extends Error {
  constructor(code, stage, detail) {
    super(detail);
    this.name = "LocalSubtitleRuntimeError";
    this.code = code;
    this.stage = stage;
  }
}

export function assertSupportedRuntimeTarget(platform, arch) {
  const expected = SUPPORTED_TARGETS[platform];
  if (!expected) {
    throw new LocalSubtitleRuntimeError(
      "unsupported_platform",
      "target",
      "The local subtitle runtime does not support this platform.",
    );
  }
  if (arch !== expected.arch) {
    throw new LocalSubtitleRuntimeError(
      "unsupported_architecture",
      "target",
      platform === "darwin"
        ? "The macOS local subtitle runtime requires arm64."
        : "The Windows local subtitle runtime requires x64.",
    );
  }
  return expected;
}

export function normalizeManifestRelativePath(value, label = "relativePath") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > STAGING_LIMITS.maxRelativePathChars ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes(":") ||
    path.posix.isAbsolute(value) ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidManifest(`${label} must be a non-empty POSIX relative path.`);
  }
  const normalized = path.posix.normalize(value);
  const segments = value.split("/");
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        isWindowsReservedName(segment),
    )
  ) {
    throw invalidManifest(`${label} is not a normalized contained path.`);
  }
  return normalized;
}

export function resolveContainedResourcePath(runtimeRoot, relativePath) {
  const normalized = normalizeManifestRelativePath(relativePath);
  const root = path.resolve(runtimeRoot);
  const resolved = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw invalidManifest("A runtime resource escapes the resource root.");
  }
  return resolved;
}

export function validateRuntimeManifest(manifest, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  assertSupportedRuntimeTarget(platform, arch);

  assertPlainObject(manifest, "manifest");
  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "runtimeContractVersion",
      "manifestId",
      "target",
      "integrityProfile",
      "integrity",
      "artifacts",
      "licenses",
      "sources",
    ],
    "manifest",
  );
  if (manifest.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION) {
    throw invalidManifest("Unsupported runtime manifest schemaVersion.");
  }
  if (manifest.runtimeContractVersion !== RUNTIME_CONTRACT_VERSION) {
    throw invalidManifest("Unsupported runtimeContractVersion.");
  }
  assertIdentifier(manifest.manifestId, "manifestId");

  assertPlainObject(manifest.target, "target");
  assertExactKeys(manifest.target, ["platform", "arch"], "target");
  if (manifest.target.platform !== platform || manifest.target.arch !== arch) {
    throw invalidManifest("Runtime manifest target does not match the host target.");
  }
  const targetContract = getLocalSubtitleStagingTarget(platform, arch);
  if (manifest.integrityProfile !== targetContract.integrityProfile) {
    throw invalidManifest(
      "Runtime integrity profile does not match the staging target.",
    );
  }

  assertPlainObject(manifest.integrity, "integrity");
  assertExactKeys(
    manifest.integrity,
    ["algorithm", "binaryHashPhase", "outerSignatureCoverage"],
    "integrity",
  );
  for (const key of [
    "algorithm",
    "binaryHashPhase",
    "outerSignatureCoverage",
  ]) {
    if (manifest.integrity[key] !== targetContract.integrity[key]) {
      throw invalidManifest(
        "Runtime integrity policy does not match the staging target.",
      );
    }
  }

  const evidenceFileCount = Array.isArray(manifest.licenses)
    ? manifest.licenses.reduce(
        (count, record) =>
          count +
          (Array.isArray(record?.licenseFiles) ? record.licenseFiles.length : 0) +
          (Array.isArray(record?.noticeFiles) ? record.noticeFiles.length : 0),
        0,
      ) + (Array.isArray(manifest.sources) ? manifest.sources.length : 0)
    : Number.POSITIVE_INFINITY;
  if (evidenceFileCount > STAGING_LIMITS.maxEvidenceFiles) {
    throw invalidManifest("Runtime manifest evidence files exceed the limit.");
  }

  const globalPaths = new Set();
  const licenses = validateLicenseRecords(
    manifest.licenses,
    targetContract.requiredLicenses,
    globalPaths,
  );
  const sources = validateSourceRecords(
    manifest.sources,
    targetContract.requiredSources,
    globalPaths,
  );
  validateArtifactRecords(manifest.artifacts, {
    platform,
    arch,
    licenses,
    sources,
    globalPaths,
    targetContract,
  });
  return manifest;
}

export async function loadRuntimeManifest(runtimeRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  assertSupportedRuntimeTarget(platform, arch);
  const root = path.resolve(runtimeRoot);
  await assertRuntimeRootDirectory(root, {
    missingCode: "media_runtime_missing",
    invalidCode: "media_runtime_invalid",
    stage: "manifest",
  });
  const manifestPath = resolveContainedResourcePath(
    root,
    RUNTIME_MANIFEST_RELATIVE_PATH,
  );
  const manifestStat = await safeLstat(manifestPath);
  if (!manifestStat) {
    throw new LocalSubtitleRuntimeError(
      "media_runtime_missing",
      "manifest",
      "The bundled local subtitle runtime manifest is missing.",
    );
  }
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size > STAGING_LIMITS.maxManifestBytes
  ) {
    throw invalidManifest("The runtime manifest is not a regular file.");
  }
  await assertNoSymbolicResourcePath(
    root,
    RUNTIME_MANIFEST_RELATIVE_PATH,
    {
      missingCode: "media_runtime_missing",
      invalidCode: "media_runtime_invalid",
      stage: "manifest",
    },
  );

  let manifestHandle;
  try {
    manifestHandle = await open(manifestPath, READ_ONLY_NOFOLLOW_FLAGS);
  } catch {
    throw invalidManifest("The runtime manifest cannot be opened.");
  }
  let content;
  try {
    const openedStat = await statOpenFile(manifestHandle, {
      invalidCode: "media_runtime_invalid",
      stage: "manifest",
    });
    assertMatchingFileIdentity(manifestStat, openedStat, {
      invalidCode: "media_runtime_invalid",
      stage: "manifest",
    });
    if (!openedStat.isFile() || openedStat.size > STAGING_LIMITS.maxManifestBytes) {
      throw invalidManifest("The runtime manifest is not a regular file.");
    }
    content = await manifestHandle.readFile();
    const completedStat = await statOpenFile(manifestHandle, {
      invalidCode: "media_runtime_invalid",
      stage: "manifest",
    });
    assertMatchingFileIdentity(openedStat, completedStat, {
      invalidCode: "media_runtime_invalid",
      stage: "manifest",
    });
    await assertNoSymbolicResourcePath(
      root,
      RUNTIME_MANIFEST_RELATIVE_PATH,
      {
        missingCode: "media_runtime_missing",
        invalidCode: "media_runtime_invalid",
        stage: "manifest",
      },
    );
    await assertPathFileIdentity(manifestPath, completedStat, {
      invalidCode: "media_runtime_invalid",
      stage: "manifest",
    });
  } catch (error) {
    if (error instanceof LocalSubtitleRuntimeError) throw error;
    throw invalidManifest("The runtime manifest is not valid JSON.");
  } finally {
    await manifestHandle.close();
  }

  let manifest;
  try {
    manifest = JSON.parse(content.toString("utf8"));
  } catch {
    throw invalidManifest("The runtime manifest is not valid JSON.");
  }
  validateRuntimeManifest(manifest, { platform, arch });
  return {
    root,
    manifestPath,
    manifest,
    manifestSha256: createHash("sha256").update(content).digest("hex"),
  };
}

export async function verifyRuntimeBundle(options) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const scope = options.scope ?? "all";
  if (!new Set(["all", "media", "server"]).has(scope)) {
    throw new TypeError("scope must be all, media, or server.");
  }
  const loaded = await loadRuntimeManifest(options.runtimeRoot, {
    platform,
    arch,
  });
  const selectedArtifacts = loaded.manifest.artifacts.filter((artifact) => {
    if (scope === "media") return isMediaArtifact(artifact);
    if (scope === "server") return !isMediaArtifact(artifact);
    return true;
  });
  const referencedLicenseIds = new Set(
    selectedArtifacts.map((artifact) => artifact.licenseRef),
  );
  const referencedSourceIds = new Set(
    selectedArtifacts.map((artifact) => artifact.sourceRef),
  );

  const evidenceFiles = [];
  for (const license of loaded.manifest.licenses) {
    if (!referencedLicenseIds.has(license.id)) continue;
    for (const file of [...license.licenseFiles, ...license.noticeFiles]) {
      evidenceFiles.push({ ...file, evidenceKind: "license" });
    }
  }
  for (const source of loaded.manifest.sources) {
    if (!referencedSourceIds.has(source.id)) continue;
    evidenceFiles.push({
      ...source.evidenceFile,
      evidenceKind: "source",
    });
  }
  for (const evidence of evidenceFiles) {
    await verifyRegularFile(loaded.root, evidence, {
      missingCode: "media_runtime_missing",
      invalidCode: "media_runtime_invalid",
      requireExecutableBit: false,
      expectedArch: null,
      platform,
      signatureKind: null,
      signatureVerifier: options.signatureVerifier,
    });
  }

  const verifiedArtifacts = [];
  for (const artifact of selectedArtifacts) {
    const media = isMediaArtifact(artifact);
    const verificationPolicy = {
      missingCode: media ? "media_runtime_missing" : "runtime_missing",
      invalidCode: media
        ? "media_runtime_invalid"
        : "runtime_protocol_mismatch",
      // A Windows filesystem cannot represent POSIX execute bits. Cross-host
      // validation therefore defers this one check to the native macOS gate.
      requireExecutableBit:
        artifact.executable && platform !== "win32" && process.platform !== "win32",
      expectedArch: artifact.arch,
      platform,
      signatureKind: artifact.signatureKind,
      signatureVerifier: options.signatureVerifier,
    };
    const verified = await verifyRegularFile(
      loaded.root,
      artifact,
      verificationPolicy,
    );
    verifiedArtifacts.push({
      artifact,
      verificationPolicy,
      ...verified,
    });
  }

  const launchResults = [];
  if (options.launch === true) {
    const runner = options.commandRunner ?? runArtifactCommand;
    for (const verified of verifiedArtifacts) {
      if (verified.artifact.kind === "dynamic_library") continue;
      const launchClosure = await verifyArtifactClosure(
        loaded.root,
        verifiedArtifacts,
      );
      const launchReady = launchClosure.get(verified.artifact.id);
      if (!launchReady) {
        throw launchErrorFor(verified.artifact);
      }
      const result = await probeArtifact(
        { artifact: verified.artifact, ...launchReady },
        loaded.root,
        runner,
        platform,
        options.launchTimeoutMs,
      );
      await verifyArtifactClosure(
        loaded.root,
        verifiedArtifacts,
      );
      launchResults.push(result);
    }
  }

  return {
    schemaVersion: 1,
    target: { platform, arch },
    scope,
    manifestSha256: loaded.manifestSha256,
    artifactCount: verifiedArtifacts.length,
    artifactSummary: verifiedArtifacts.map(({ artifact, inspection }) => ({
      id: artifact.id,
      kind: artifact.kind,
      relativePath: artifact.relativePath,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      architectures: inspection.architectures,
      signatureKind: artifact.signatureKind,
    })),
    evidenceFileCount: evidenceFiles.length,
    signatureVerification: selectedArtifacts.every(
      (artifact) => artifact.signatureKind === "unsigned",
    )
      ? "not_required_unsigned_personal_distribution"
      : platform === process.platform
        ? "verified_on_target_host"
        : "deferred_to_target_host",
    launchResults,
    noPathFallback: true,
    ready: true,
    privacy: {
      absolutePathsRecorded: false,
      signingIdentityRecorded: false,
    },
  };
}

async function verifyArtifactClosure(runtimeRoot, verifiedArtifacts) {
  const refreshed = new Map();
  for (const verified of verifiedArtifacts) {
    refreshed.set(
      verified.artifact.id,
      await verifyRegularFile(
        runtimeRoot,
        verified.artifact,
        verified.verificationPolicy,
      ),
    );
  }
  return refreshed;
}

export function inspectNativeBinary(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return { format: "unknown", architectures: [], minimumOsVersion: null };
  }

  const magicBe = buffer.readUInt32BE(0);
  if (magicBe === 0xcafebabe || magicBe === 0xcafebabf) {
    const is64 = magicBe === 0xcafebabf;
    const entrySize = is64 ? 32 : 20;
    const count = buffer.readUInt32BE(4);
    if (count < 1 || count > 16 || buffer.length < 8 + count * entrySize) {
      return { format: "mach-o-fat-invalid", architectures: [], minimumOsVersion: null };
    }
    const architectures = [];
    for (let index = 0; index < count; index += 1) {
      architectures.push(mapMachCpuType(buffer.readUInt32BE(8 + index * entrySize)));
    }
    return {
      format: "mach-o-fat",
      architectures: [...new Set(architectures)],
      minimumOsVersion: null,
    };
  }

  const magicLe = buffer.readUInt32LE(0);
  if (magicLe === 0xfeedfacf || magicBe === 0xfeedfacf) {
    const littleEndian = magicLe === 0xfeedfacf;
    const read32 = littleEndian
      ? (offset) => buffer.readUInt32LE(offset)
      : (offset) => buffer.readUInt32BE(offset);
    const architecture = mapMachCpuType(read32(4));
    const commandCount = read32(16);
    let offset = 32;
    let minimumOsVersion = null;
    for (let index = 0; index < commandCount; index += 1) {
      if (offset + 8 > buffer.length) break;
      const command = read32(offset);
      const commandSize = read32(offset + 4);
      if (commandSize < 8 || offset + commandSize > buffer.length) break;
      if (command === 0x32 && commandSize >= 24) {
        minimumOsVersion = decodePackedVersion(read32(offset + 12));
      } else if (command === 0x24 && commandSize >= 16) {
        minimumOsVersion = decodePackedVersion(read32(offset + 8));
      }
      offset += commandSize;
    }
    return {
      format: "mach-o",
      architectures: [architecture],
      minimumOsVersion,
    };
  }

  if (buffer[0] === 0x4d && buffer[1] === 0x5a && buffer.length >= 64) {
    const peOffset = buffer.readUInt32LE(0x3c);
    if (
      peOffset + 6 <= buffer.length &&
      buffer.toString("binary", peOffset, peOffset + 4) === "PE\0\0"
    ) {
      const machine = buffer.readUInt16LE(peOffset + 4);
      return {
        format: "pe",
        architectures: [mapPeMachine(machine)],
        minimumOsVersion: null,
      };
    }
  }

  return { format: "unknown", architectures: [], minimumOsVersion: null };
}

export async function inspectNativeBinaryFile(filePath) {
  return inspectNativeBinary(await readFile(filePath));
}

export function buildSanitizedRuntimeEnvironment(platform, source = process.env) {
  if (platform === "win32") {
    const systemRoot = source.SystemRoot ?? source.WINDIR ?? "C:\\Windows";
    const environment = {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: `${systemRoot}\\System32`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PSModulePath: path.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "Modules",
      ),
    };
    for (const key of ["TEMP", "TMP", "ProgramFiles", "ProgramW6432"]) {
      if (typeof source[key] === "string" && source[key] !== "") {
        environment[key] = source[key];
      }
    }
    return environment;
  }
  const environment = {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };
  if (typeof source.TMPDIR === "string" && source.TMPDIR !== "") {
    environment.TMPDIR = source.TMPDIR;
  }
  return environment;
}

export function getWindowsPowerShellPath(source = process.env) {
  const systemRoot = source.SystemRoot ?? source.WINDIR ?? "C:\\Windows";
  return path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function sha256File(filePath) {
  return sha256ReadableStream(createReadStream(filePath));
}

export function sha256ReadableStream(stream) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let digest;
    let ended = false;
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => {
      ended = true;
      digest = hash.digest("hex");
    });
    stream.once("close", () => {
      if (!ended) {
        reject(new Error("The SHA-256 input stream closed before end."));
        return;
      }
      resolve(digest);
    });
  });
}

async function verifyRegularFile(runtimeRoot, record, policy) {
  let verified = await verifyRegularFileStatic(runtimeRoot, record, policy);
  if (policy.signatureKind && policy.signatureKind !== "unsigned") {
    const verifier = policy.signatureVerifier ?? verifyArtifactSignature;
    let signatureValid = false;
    try {
      signatureValid = await verifier(verified.filePath, {
        platform: policy.platform,
        expectedKind: policy.signatureKind,
      });
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      throw new LocalSubtitleRuntimeError(
        policy.invalidCode,
        "static_verification",
        "A bundled runtime executable failed code-signature verification.",
      );
    }
    verified = await verifyRegularFileStatic(runtimeRoot, record, policy);
  }
  return verified;
}

async function verifyRegularFileStatic(runtimeRoot, record, policy) {
  const filePath = resolveContainedResourcePath(runtimeRoot, record.relativePath);
  await assertRuntimeRootDirectory(runtimeRoot, {
    ...policy,
    stage: "static_verification",
  });
  await assertNoSymbolicResourcePath(runtimeRoot, record.relativePath, {
    ...policy,
    stage: "static_verification",
  });
  const fileStat = await safeLstat(filePath);
  if (!fileStat) {
    throw new LocalSubtitleRuntimeError(
      policy.missingCode,
      "static_verification",
      "A required bundled runtime resource is missing.",
    );
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new LocalSubtitleRuntimeError(
      policy.invalidCode,
      "static_verification",
      "A bundled runtime resource is not a regular file.",
    );
  }
  await assertContainedRealPath(runtimeRoot, filePath, policy);
  let inspection = {
    format: "evidence",
    architectures: [],
    minimumOsVersion: null,
  };
  let fileHandle;
  try {
    fileHandle = await open(filePath, READ_ONLY_NOFOLLOW_FLAGS);
  } catch {
    throw new LocalSubtitleRuntimeError(
      policy.invalidCode,
      "static_verification",
      "A bundled runtime resource cannot be opened.",
    );
  }
  try {
    const openedStat = await statOpenFile(fileHandle, {
      invalidCode: policy.invalidCode,
      stage: "static_verification",
    });
    assertMatchingFileIdentity(fileStat, openedStat, {
      invalidCode: policy.invalidCode,
      stage: "static_verification",
    });
    if (
      !openedStat.isFile() ||
      openedStat.size !== record.byteSize ||
      (policy.requireExecutableBit && (openedStat.mode & 0o111) === 0)
    ) {
      throw new LocalSubtitleRuntimeError(
        policy.invalidCode,
        "static_verification",
        "A bundled runtime resource failed its size or permission check.",
      );
    }
    const observed = await hashOpenFile(
      fileHandle,
      openedStat.size,
      Boolean(policy.expectedArch),
      policy.invalidCode,
    );
    if (observed.sha256 !== record.sha256) {
      throw new LocalSubtitleRuntimeError(
        policy.invalidCode,
        "static_verification",
        "A bundled runtime resource failed its SHA-256 check.",
      );
    }
    if (policy.expectedArch) {
      inspection = inspectNativeBinary(observed.header);
      const expectedFormat = policy.platform === "darwin" ? "mach-o" : "pe";
      if (
        inspection.format !== expectedFormat ||
        inspection.architectures.length !== 1 ||
        inspection.architectures[0] !== policy.expectedArch
      ) {
        throw new LocalSubtitleRuntimeError(
          policy.invalidCode,
          "static_verification",
          "A bundled runtime executable has the wrong binary identity.",
        );
      }
    }
    const completedStat = await statOpenFile(fileHandle, {
      invalidCode: policy.invalidCode,
      stage: "static_verification",
    });
    assertMatchingFileIdentity(openedStat, completedStat, {
      invalidCode: policy.invalidCode,
      stage: "static_verification",
    });
    await assertRuntimeRootDirectory(runtimeRoot, {
      ...policy,
      stage: "static_verification",
    });
    await assertNoSymbolicResourcePath(runtimeRoot, record.relativePath, {
      ...policy,
      stage: "static_verification",
    });
    await assertContainedRealPath(runtimeRoot, filePath, policy);
    await assertPathFileIdentity(filePath, completedStat, {
      invalidCode: policy.invalidCode,
      stage: "static_verification",
    });
  } finally {
    await fileHandle.close();
  }
  return { filePath, inspection };
}

export async function verifyArtifactSignature(filePath, policy) {
  if (policy.platform === "darwin") {
    try {
      await execFileAsync(
        "/usr/bin/codesign",
        ["--verify", "--strict", "--verbose=4", filePath],
        {
          cwd: path.dirname(filePath),
          env: buildSanitizedRuntimeEnvironment("darwin"),
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const { stdout, stderr } = await execFileAsync(
        "/usr/bin/codesign",
        ["-dvvv", filePath],
        {
          cwd: path.dirname(filePath),
          env: buildSanitizedRuntimeEnvironment("darwin"),
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const output = `${stdout}${stderr}`;
      if (policy.expectedKind === "adhoc") {
        return /^Signature=adhoc$/mu.test(output);
      }
      if (policy.expectedKind === "developer_id") {
        return /^Authority=Developer ID Application:/mu.test(output);
      }
      return false;
    } catch {
      return false;
    }
  }
  if (policy.platform === "win32" && process.platform === "win32") {
    if (policy.expectedKind !== "authenticode") return false;
    try {
      const environment = {
        ...buildSanitizedRuntimeEnvironment("win32"),
        FUSIONKIT_SIGNATURE_TARGET: filePath,
      };
      await execFileAsync(
        getWindowsPowerShellPath(environment),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$signature = Get-AuthenticodeSignature -LiteralPath $env:FUSIONKIT_SIGNATURE_TARGET; " +
            "if ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) " +
            "{ exit 0 } else { exit 1 }",
        ],
        {
          cwd: path.dirname(filePath),
          env: environment,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      return true;
    } catch {
      return false;
    }
  }
  // Cross-host PE checks verify layout/hash/architecture only. Windows must
  // re-run this gate before its result can become packaged evidence.
  return policy.platform === "win32";
}

async function probeArtifact(
  verified,
  runtimeRoot,
  runner,
  platform,
  launchTimeoutMs = 15_000,
) {
  const { artifact, filePath } = verified;
  const args = artifact.kind === "server"
    ? ["--help"]
    : ["-hide_banner", "-version"];
  let result;
  try {
    result = await runner(filePath, args, {
      cwd: runtimeRoot,
      env: buildSanitizedRuntimeEnvironment(platform),
      timeoutMs: launchTimeoutMs,
    });
  } catch {
    throw launchErrorFor(artifact);
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.exitCode !== 0 || !matchesArtifactIdentity(artifact, output)) {
    throw launchErrorFor(artifact);
  }
  return {
    id: artifact.id,
    kind: artifact.kind,
    versionMatched: true,
    exitCode: 0,
  };
}

async function runArtifactCommand(command, args, options) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? ""),
    };
  }
}

function matchesArtifactIdentity(artifact, output) {
  const escapedVersion = artifact.version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (artifact.kind === "ffmpeg") {
    return new RegExp(`^ffmpeg version ${escapedVersion}(?:\\s|$)`, "mu").test(output);
  }
  if (artifact.kind === "ffprobe") {
    return new RegExp(`^ffprobe version ${escapedVersion}(?:\\s|$)`, "mu").test(output);
  }
  return /(?:whisper-server|whisper server|usage:)/iu.test(output);
}

function launchErrorFor(artifact) {
  return new LocalSubtitleRuntimeError(
    isMediaArtifact(artifact)
      ? "media_runtime_launch_failed"
      : "runtime_unresponsive",
    "launch_probe",
    "A bundled runtime executable could not complete its identity probe.",
  );
}

function validateLicenseRecords(records, requiredRecords, globalPaths) {
  if (!Array.isArray(records) || records.length !== requiredRecords.length) {
    throw invalidManifest("Runtime manifest licenses do not match the target contract.");
  }
  const requiredById = new Map(
    requiredRecords.map((record) => [record.id, record]),
  );
  const byId = new Map();
  for (const record of records) {
    assertPlainObject(record, "license");
    assertExactKeys(
      record,
      [
        "id",
        "component",
        "spdxExpression",
        "licenseFiles",
        "noticeFiles",
      ],
      "license",
    );
    assertUniqueId(record.id, byId, "license");
    const required = requiredById.get(record.id);
    if (
      !required ||
      record.component !== required.component ||
      record.spdxExpression !== required.spdxExpression
    ) {
      throw invalidManifest(
        "Runtime license metadata does not match the target contract.",
      );
    }
    assertNonEmptyString(record.component, "license.component");
    assertNonEmptyString(record.spdxExpression, "license.spdxExpression");
    if (!Array.isArray(record.licenseFiles) || record.licenseFiles.length === 0) {
      throw invalidManifest("Every license record needs a license file.");
    }
    if (!Array.isArray(record.noticeFiles)) {
      throw invalidManifest("license.noticeFiles must be an array.");
    }
    assertEvidenceRecordsMatch(
      record.licenseFiles,
      required.licenseFiles,
      "license files",
    );
    assertEvidenceRecordsMatch(
      record.noticeFiles,
      required.noticeFiles,
      "notice files",
    );
    for (const file of [...record.licenseFiles, ...record.noticeFiles]) {
      validateEvidenceFile(file, "license evidence", globalPaths);
    }
    byId.set(record.id, record);
  }
  return byId;
}

function validateSourceRecords(records, requiredRecords, globalPaths) {
  if (!Array.isArray(records) || records.length !== requiredRecords.length) {
    throw invalidManifest("Runtime manifest sources do not match the target contract.");
  }
  const requiredById = new Map(
    requiredRecords.map((record) => [record.id, record]),
  );
  const byId = new Map();
  for (const record of records) {
    assertPlainObject(record, "source");
    assertExactKeys(
      record,
      ["id", "component", "version", "evidenceFile"],
      "source",
    );
    assertUniqueId(record.id, byId, "source");
    const required = requiredById.get(record.id);
    if (
      !required ||
      record.component !== required.component ||
      record.version !== required.version
    ) {
      throw invalidManifest(
        "Runtime source metadata does not match the target contract.",
      );
    }
    assertNonEmptyString(record.component, "source.component");
    assertNonEmptyString(record.version, "source.version");
    assertEvidenceRecordsMatch(
      [record.evidenceFile],
      [required.evidenceFile],
      "source evidence",
    );
    validateEvidenceFile(record.evidenceFile, "source evidence", globalPaths);
    byId.set(record.id, record);
  }
  return byId;
}

function validateArtifactRecords(records, context) {
  const requiredArtifacts = context.targetContract.requiredArtifacts;
  if (!Array.isArray(records) || records.length !== requiredArtifacts.length) {
    throw invalidManifest(
      "Runtime manifest artifacts do not match the target contract.",
    );
  }
  const requiredById = new Map(
    requiredArtifacts.map((record) => [record.id, record]),
  );
  const byId = new Map();
  for (const record of records) {
    assertPlainObject(record, "artifact");
    assertExactKeys(
      record,
      [
        "id",
        "kind",
        "platform",
        "arch",
        "backend",
        "relativePath",
        "byteSize",
        "sha256",
        "version",
        "licenseRef",
        "sourceRef",
        "executable",
        "signatureKind",
      ],
      "artifact",
    );
    assertUniqueId(record.id, byId, "artifact");
    const required = requiredById.get(record.id);
    if (!required) {
      throw invalidManifest("Runtime manifest contains an unexpected artifact.");
    }
    if (!ARTIFACT_KINDS.has(record.kind)) {
      throw invalidManifest("Runtime artifact kind is not allowed.");
    }
    if (record.platform !== context.platform || record.arch !== context.arch) {
      throw invalidManifest("Runtime artifact target does not match the manifest.");
    }
    if (!BACKENDS.has(record.backend)) {
      throw invalidManifest("Runtime artifact backend is not allowed.");
    }
    if (!SIGNATURE_KINDS.has(record.signatureKind)) {
      throw invalidManifest("Runtime artifact signatureKind is not allowed.");
    }
    if (!context.targetContract.allowedSignatureKinds.includes(
      record.signatureKind,
    )) {
      throw invalidManifest(
        "Runtime artifact signatureKind does not match the integrity profile.",
      );
    }
    if (typeof record.executable !== "boolean") {
      throw invalidManifest("Runtime artifact executable must be boolean.");
    }
    if (record.kind !== "dynamic_library" && record.executable !== true) {
      throw invalidManifest("Runtime programs must be executable.");
    }
    validateSizedHashRecord(record, "artifact");
    registerGlobalPath(context.globalPaths, record.relativePath);
    assertNonEmptyString(record.version, "artifact.version");
    if (!context.licenses.has(record.licenseRef)) {
      throw invalidManifest("Runtime artifact licenseRef is unknown.");
    }
    if (!context.sources.has(record.sourceRef)) {
      throw invalidManifest("Runtime artifact sourceRef is unknown.");
    }
    for (const key of [
      "kind",
      "backend",
      "relativePath",
      "licenseRef",
      "sourceRef",
      "executable",
      "version",
    ]) {
      const expected = key === "version"
        ? expectedArtifactVersion(required, context.targetContract)
        : required[key];
      if (record[key] !== expected) {
        throw invalidManifest(
          "Runtime artifact metadata does not match the target contract.",
        );
      }
    }
    byId.set(record.id, record);
  }
}

function expectedArtifactVersion(artifact, targetContract) {
  return artifact.kind === "ffmpeg" || artifact.kind === "ffprobe"
    ? targetContract.artifactVersions.media
    : targetContract.artifactVersions.runner;
}

function assertEvidenceRecordsMatch(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw invalidManifest(`Runtime ${label} do not match the target contract.`);
  }
  const expectedByPath = new Map(
    expected.map((record) => [record.relativePath.toLowerCase(), record]),
  );
  for (const record of actual) {
    const required = expectedByPath.get(
      String(record?.relativePath ?? "").toLowerCase(),
    );
    if (
      !required ||
      record.relativePath !== required.relativePath ||
      record.byteSize !== required.byteSize ||
      record.sha256 !== required.sha256
    ) {
      throw invalidManifest(`Runtime ${label} do not match the target contract.`);
    }
  }
}

function validateEvidenceFile(file, label, globalPaths) {
  assertPlainObject(file, label);
  assertExactKeys(file, ["relativePath", "byteSize", "sha256"], label);
  validateSizedHashRecord(file, label);
  registerGlobalPath(globalPaths, file.relativePath);
}

function registerGlobalPath(paths, relativePath) {
  const key = relativePath.toLowerCase();
  if (paths.has(key)) {
    throw invalidManifest(
      "Runtime resource paths must be globally unique ignoring case.",
    );
  }
  paths.add(key);
}

function validateSizedHashRecord(record, label) {
  normalizeManifestRelativePath(record.relativePath, `${label}.relativePath`);
  if (!Number.isSafeInteger(record.byteSize) || record.byteSize <= 0) {
    throw invalidManifest(`${label}.byteSize must be a positive safe integer.`);
  }
  if (!SHA256_PATTERN.test(record.sha256 ?? "")) {
    throw invalidManifest(`${label}.sha256 must be lowercase SHA-256.`);
  }
  rejectPrivatePath(record.relativePath, `${label}.relativePath`);
}

function assertUniqueId(id, collection, label) {
  assertNonEmptyString(id, `${label}.id`);
  if (collection.has(id)) {
    throw invalidManifest(`${label} IDs must be unique.`);
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidManifest(`${label} must be an object.`);
  }
}

function assertExactKeys(value, allowedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...allowedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw invalidManifest(`${label} has missing or unknown fields.`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidManifest(`${label} must be a non-empty string.`);
  }
  rejectPrivatePath(value, label);
}

function assertIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > STAGING_LIMITS.maxIdChars ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value)
  ) {
    throw invalidManifest(`${label} must be a bounded lowercase identifier.`);
  }
}

function rejectPrivatePath(value, label) {
  if (PRIVATE_PATH_PATTERN.test(String(value))) {
    throw invalidManifest(`${label} contains a private machine path.`);
  }
}

function isWindowsReservedName(segment) {
  const base = segment.split(".", 1)[0]?.toUpperCase() ?? "";
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base);
}

function invalidManifest(detail) {
  return new LocalSubtitleRuntimeError(
    "media_runtime_invalid",
    "manifest",
    detail,
  );
}

function isMediaArtifact(artifact) {
  return artifact.kind === "ffmpeg" || artifact.kind === "ffprobe";
}

async function hashOpenFile(fileHandle, fileSize, captureHeader, invalidCode) {
  const header = Buffer.alloc(
    captureHeader ? Math.min(fileSize, MAX_NATIVE_HEADER_BYTES) : 0,
  );
  const chunk = Buffer.alloc(FILE_HASH_CHUNK_BYTES);
  const hash = createHash("sha256");
  let position = 0;
  try {
    while (position < fileSize) {
      const requested = Math.min(chunk.length, fileSize - position);
      const { bytesRead } = await fileHandle.read(
        chunk,
        0,
        requested,
        position,
      );
      if (bytesRead === 0) throw new Error("unexpected end of file");
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      if (position < header.length) {
        bytes.copy(header, position, 0, Math.min(bytesRead, header.length - position));
      }
      position += bytesRead;
    }
  } catch {
    throw new LocalSubtitleRuntimeError(
      invalidCode,
      "static_verification",
      "A bundled runtime resource cannot be hashed.",
    );
  }
  return { sha256: hash.digest("hex"), header };
}

async function assertRuntimeRootDirectory(runtimeRoot, policy) {
  const rootStat = await safeLstat(runtimeRoot);
  if (!rootStat) {
    throw new LocalSubtitleRuntimeError(
      policy.missingCode,
      policy.stage,
      "The bundled runtime root is missing.",
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new LocalSubtitleRuntimeError(
      policy.invalidCode,
      policy.stage,
      "The bundled runtime root is not a regular directory.",
    );
  }
}

async function assertNoSymbolicResourcePath(runtimeRoot, relativePath, policy) {
  await assertRuntimeRootDirectory(runtimeRoot, policy);
  let current = runtimeRoot;
  const segments = normalizeManifestRelativePath(relativePath).split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const currentStat = await safeLstat(current);
    if (!currentStat) {
      throw new LocalSubtitleRuntimeError(
        policy.missingCode,
        policy.stage,
        "A required bundled runtime resource is missing.",
      );
    }
    const leaf = index === segments.length - 1;
    if (
      currentStat.isSymbolicLink() ||
      (!leaf && !currentStat.isDirectory()) ||
      (leaf && !currentStat.isFile())
    ) {
      throw new LocalSubtitleRuntimeError(
        policy.invalidCode,
        policy.stage,
        "A bundled runtime resource path has an invalid file type.",
      );
    }
  }
}

async function assertContainedRealPath(runtimeRoot, filePath, policy) {
  let rootRealPath;
  let fileRealPath;
  try {
    [rootRealPath, fileRealPath] = await Promise.all([
      realpath(runtimeRoot),
      realpath(filePath),
    ]);
  } catch {
    throw new LocalSubtitleRuntimeError(
      policy.invalidCode,
      "static_verification",
      "A bundled runtime resource cannot be resolved.",
    );
  }
  const relative = path.relative(rootRealPath, fileRealPath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LocalSubtitleRuntimeError(
      policy.invalidCode,
      "static_verification",
      "A bundled runtime resource resolves outside the resource root.",
    );
  }
}

async function statOpenFile(fileHandle, policy) {
  try {
    return await fileHandle.stat();
  } catch {
    throw new LocalSubtitleRuntimeError(
      policy.invalidCode,
      policy.stage,
      "Bundled runtime filesystem metadata cannot be read.",
    );
  }
}

function assertMatchingFileIdentity(before, after, policy) {
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mode !== before.mode ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw new LocalSubtitleRuntimeError(
      policy.invalidCode,
      policy.stage,
      "A bundled runtime resource changed during verification.",
    );
  }
}

async function assertPathFileIdentity(filePath, expected, policy) {
  const observed = await safeLstat(filePath);
  if (!observed || !observed.isFile() || observed.isSymbolicLink()) {
    throw new LocalSubtitleRuntimeError(
      policy.invalidCode,
      policy.stage,
      "A bundled runtime resource changed during verification.",
    );
  }
  assertMatchingFileIdentity(expected, observed, policy);
}

async function safeLstat(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function mapMachCpuType(value) {
  if (value === 0x0100000c) return "arm64";
  if (value === 0x01000007) return "x64";
  return `mach-${value.toString(16)}`;
}

function mapPeMachine(value) {
  if (value === 0x8664) return "x64";
  if (value === 0xaa64) return "arm64";
  return `pe-${value.toString(16)}`;
}

function decodePackedVersion(value) {
  return `${(value >>> 16) & 0xffff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}
