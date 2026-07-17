import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RUNTIME_MANIFEST_RELATIVE_PATH =
  "manifests/local-subtitle-runtime.v1.json";
export const RUNTIME_MANIFEST_SCHEMA_VERSION = 1;
export const RUNTIME_CONTRACT_VERSION = 1;
export const RUNTIME_HASH_PHASE =
  "after_nested_code_signing_before_outer_bundle_signing";

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
  darwin: Object.freeze({ arch: "arm64", targetId: "mac-arm64" }),
  win32: Object.freeze({ arch: "x64", targetId: "win-x64" }),
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
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value)
  ) {
    throw invalidManifest(`${label} must be a non-empty POSIX relative path.`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
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
  assertNonEmptyString(manifest.manifestId, "manifestId");
  rejectPrivatePath(manifest.manifestId, "manifestId");

  assertPlainObject(manifest.target, "target");
  assertExactKeys(manifest.target, ["platform", "arch"], "target");
  if (manifest.target.platform !== platform || manifest.target.arch !== arch) {
    throw invalidManifest("Runtime manifest target does not match the host target.");
  }

  assertPlainObject(manifest.integrity, "integrity");
  assertExactKeys(
    manifest.integrity,
    ["algorithm", "binaryHashPhase", "outerSignatureCoverage"],
    "integrity",
  );
  if (
    manifest.integrity.algorithm !== "sha256" ||
    manifest.integrity.binaryHashPhase !== RUNTIME_HASH_PHASE ||
    manifest.integrity.outerSignatureCoverage !== "required"
  ) {
    throw invalidManifest("Runtime integrity policy is not supported.");
  }

  const licenses = validateLicenseRecords(manifest.licenses);
  const sources = validateSourceRecords(manifest.sources);
  validateArtifactRecords(manifest.artifacts, {
    platform,
    arch,
    licenses,
    sources,
  });
  return manifest;
}

export async function loadRuntimeManifest(runtimeRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  assertSupportedRuntimeTarget(platform, arch);
  const root = path.resolve(runtimeRoot);
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
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw invalidManifest("The runtime manifest is not a regular file.");
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw invalidManifest("The runtime manifest is not valid JSON.");
  }
  validateRuntimeManifest(manifest, { platform, arch });
  return {
    root,
    manifestPath,
    manifest,
    manifestSha256: await sha256File(manifestPath),
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
    const verified = await verifyRegularFile(loaded.root, artifact, {
      missingCode: media ? "media_runtime_missing" : "runtime_missing",
      invalidCode: media
        ? "media_runtime_invalid"
        : "runtime_protocol_mismatch",
      requireExecutableBit: artifact.executable && platform !== "win32",
      expectedArch: artifact.arch,
      platform,
      signatureKind: artifact.signatureKind,
      signatureVerifier: options.signatureVerifier,
    });
    verifiedArtifacts.push({ artifact, ...verified });
  }

  const launchResults = [];
  if (options.launch === true) {
    const runner = options.commandRunner ?? runArtifactCommand;
    for (const verified of verifiedArtifacts) {
      if (verified.artifact.kind === "dynamic_library") continue;
      const result = await probeArtifact(
        verified,
        loaded.root,
        runner,
        platform,
        options.launchTimeoutMs,
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
    signatureVerification:
      platform === process.platform ? "verified_on_target_host" : "deferred_to_target_host",
    launchResults,
    noPathFallback: true,
    ready: true,
    privacy: {
      absolutePathsRecorded: false,
      signingIdentityRecorded: false,
    },
  };
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

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifyRegularFile(runtimeRoot, record, policy) {
  const filePath = resolveContainedResourcePath(runtimeRoot, record.relativePath);
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
  const [rootRealPath, fileRealPath] = await Promise.all([
    realpath(runtimeRoot),
    realpath(filePath),
  ]);
  const realRelative = path.relative(rootRealPath, fileRealPath);
  if (
    realRelative === "" ||
    realRelative === ".." ||
    realRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelative)
  ) {
    throw new LocalSubtitleRuntimeError(
      policy.invalidCode,
      "static_verification",
      "A bundled runtime resource resolves outside the resource root.",
    );
  }
  if (
    fileStat.size !== record.byteSize ||
    (await sha256File(filePath)) !== record.sha256
  ) {
    throw new LocalSubtitleRuntimeError(
      policy.invalidCode,
      "static_verification",
      "A bundled runtime resource failed its size or SHA-256 check.",
    );
  }
  if (policy.requireExecutableBit && (fileStat.mode & 0o111) === 0) {
    throw new LocalSubtitleRuntimeError(
      policy.invalidCode,
      "static_verification",
      "A bundled runtime executable is not executable.",
    );
  }

  let inspection = {
    format: "evidence",
    architectures: [],
    minimumOsVersion: null,
  };
  if (policy.expectedArch) {
    inspection = await inspectNativeBinaryFile(filePath);
    if (
      inspection.architectures.length !== 1 ||
      inspection.architectures[0] !== policy.expectedArch
    ) {
      throw new LocalSubtitleRuntimeError(
        policy.invalidCode,
        "static_verification",
        "A bundled runtime executable has the wrong architecture.",
      );
    }
  }
  if (policy.signatureKind && policy.signatureKind !== "unsigned") {
    const verifier = policy.signatureVerifier ?? verifyArtifactSignature;
    const signatureValid = await verifier(filePath, {
      platform: policy.platform,
      expectedKind: policy.signatureKind,
    });
    if (!signatureValid) {
      throw new LocalSubtitleRuntimeError(
        policy.invalidCode,
        "static_verification",
        "A bundled runtime executable failed code-signature verification.",
      );
    }
  }
  return { filePath, inspection };
}

async function verifyArtifactSignature(filePath, policy) {
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
    try {
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "if ((Get-AuthenticodeSignature -LiteralPath $args[0]).Status -eq 'Valid') { exit 0 } else { exit 1 }",
          filePath,
        ],
        {
          cwd: path.dirname(filePath),
          env: buildSanitizedRuntimeEnvironment("win32"),
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

function validateLicenseRecords(records) {
  if (!Array.isArray(records) || records.length < 2) {
    throw invalidManifest("At least two license records are required.");
  }
  const byId = new Map();
  const paths = new Set();
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
    assertNonEmptyString(record.component, "license.component");
    assertNonEmptyString(record.spdxExpression, "license.spdxExpression");
    if (!Array.isArray(record.licenseFiles) || record.licenseFiles.length === 0) {
      throw invalidManifest("Every license record needs a license file.");
    }
    if (!Array.isArray(record.noticeFiles)) {
      throw invalidManifest("license.noticeFiles must be an array.");
    }
    for (const file of [...record.licenseFiles, ...record.noticeFiles]) {
      validateEvidenceFile(file, "license evidence", paths);
    }
    byId.set(record.id, record);
  }
  return byId;
}

function validateSourceRecords(records) {
  if (!Array.isArray(records) || records.length < 2) {
    throw invalidManifest("At least two source records are required.");
  }
  const byId = new Map();
  const paths = new Set();
  for (const record of records) {
    assertPlainObject(record, "source");
    assertExactKeys(
      record,
      ["id", "component", "version", "evidenceFile"],
      "source",
    );
    assertUniqueId(record.id, byId, "source");
    assertNonEmptyString(record.component, "source.component");
    assertNonEmptyString(record.version, "source.version");
    validateEvidenceFile(record.evidenceFile, "source evidence", paths);
    byId.set(record.id, record);
  }
  return byId;
}

function validateArtifactRecords(records, context) {
  if (!Array.isArray(records) || records.length < 3) {
    throw invalidManifest("Runtime manifest artifacts are incomplete.");
  }
  const byId = new Map();
  const paths = new Set();
  const kinds = new Set();
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
    if (typeof record.executable !== "boolean") {
      throw invalidManifest("Runtime artifact executable must be boolean.");
    }
    if (record.kind !== "dynamic_library" && record.executable !== true) {
      throw invalidManifest("Runtime programs must be executable.");
    }
    validateSizedHashRecord(record, "artifact");
    if (paths.has(record.relativePath)) {
      throw invalidManifest("Runtime artifact paths must be unique.");
    }
    paths.add(record.relativePath);
    assertNonEmptyString(record.version, "artifact.version");
    if (!context.licenses.has(record.licenseRef)) {
      throw invalidManifest("Runtime artifact licenseRef is unknown.");
    }
    if (!context.sources.has(record.sourceRef)) {
      throw invalidManifest("Runtime artifact sourceRef is unknown.");
    }
    validateExpectedArtifactPath(record, context.platform);
    if (isMediaArtifact(record) && record.backend !== "media") {
      throw invalidManifest("Media tools must use the media backend.");
    }
    kinds.add(record.kind);
    byId.set(record.id, record);
  }
  for (const required of ["server", "ffmpeg", "ffprobe"]) {
    if (!kinds.has(required)) {
      throw invalidManifest(`Runtime manifest is missing ${required}.`);
    }
  }
}

function validateExpectedArtifactPath(record, platform) {
  const expected = platform === "darwin"
    ? {
        server: "mac-arm64/metal/whisper-server",
        ffmpeg: "mac-arm64/media/ffmpeg",
        ffprobe: "mac-arm64/media/ffprobe",
      }
    : {
        server: "win-x64/cpu/whisper-server.exe",
        ffmpeg: "win-x64/media/ffmpeg.exe",
        ffprobe: "win-x64/media/ffprobe.exe",
      };
  if (expected[record.kind] && record.relativePath !== expected[record.kind]) {
    throw invalidManifest("A required runtime artifact uses an unexpected path.");
  }
  if (
    record.kind === "dynamic_library" &&
    !record.relativePath.startsWith(
      platform === "darwin" ? "mac-arm64/" : "win-x64/",
    )
  ) {
    throw invalidManifest("A dynamic dependency uses an unexpected target path.");
  }
}

function validateEvidenceFile(file, label, paths) {
  assertPlainObject(file, label);
  assertExactKeys(file, ["relativePath", "byteSize", "sha256"], label);
  validateSizedHashRecord(file, label);
  if (paths.has(file.relativePath)) {
    throw invalidManifest("Evidence file paths must be unique within their section.");
  }
  paths.add(file.relativePath);
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

function rejectPrivatePath(value, label) {
  if (PRIVATE_PATH_PATTERN.test(String(value))) {
    throw invalidManifest(`${label} contains a private machine path.`);
  }
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
