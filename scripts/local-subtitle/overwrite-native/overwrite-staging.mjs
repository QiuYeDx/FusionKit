#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { inspectNativeBinaryFile } from "../runtime/runtime-manifest.mjs";
import {
  OVERWRITE_STAGING_CONTRACT,
  canonicalOverwriteJson,
  getOverwriteStagingTarget,
  overwriteStagingError,
  parseOverwriteAddonManifest,
  parseOverwriteBuildReceipt,
} from "./overwrite-staging-contract.mjs";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ADDON_BYTES = 64 * 1024 * 1024;
const READ_ONLY_NOFOLLOW =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const EXPECTED_MODULE_KEYS = Object.freeze([
  "protocolVersion",
  "platform",
  "architecture",
  "begin",
  "recover",
  "acknowledge",
]);
const MACOS_COMMAND_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
});

export async function stageOverwriteNativeAddon(options, dependencies = {}) {
  assertExactOptions(
    options,
    [
      "root",
      "addonPath",
      "buildReceiptPath",
      "platform",
      "arch",
      "signingIdentity",
    ],
    ["root", "addonPath", "buildReceiptPath", "platform", "arch"],
  );
  const target = getOverwriteStagingTarget(options.platform, options.arch);
  const root = await verifyDirectoryRoot(options.root);
  const addonPath = await verifyAbsoluteRegularFile(
    options.addonPath,
    "overwrite_addon_missing",
  );
  const receiptPath = await verifyAbsoluteRegularFile(
    options.buildReceiptPath,
    "overwrite_build_receipt_invalid",
  );
  const rawReceipt = await readJsonFileNoFollow(
    receiptPath,
    MAX_RECEIPT_BYTES,
    "overwrite_build_receipt_invalid",
  );
  const receipt = parseOverwriteBuildReceipt(rawReceipt.value, target);
  await assertFileMatchesRecord(addonPath, receipt.artifact, {
    code: "overwrite_build_receipt_invalid",
    maxBytes: MAX_ADDON_BYTES,
  });

  const overwriteRoot = path.join(root, "overwrite");
  await ensureOwnedDirectory(overwriteRoot);
  const finalSubtree = path.join(root, ...OVERWRITE_STAGING_CONTRACT.stagingSubtree.split("/"));
  const lockPath = `${finalSubtree}.publish-lock`;
  const partialSubtree = path.join(
    overwriteRoot,
    `.v1.partial-${process.pid}-${randomUUID()}`,
  );
  let lockHandle;
  let published = false;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
  } catch (cause) {
    throw failure(
      "overwrite_staging_exists",
      "The overwrite staging publication is already reserved.",
      cause,
    );
  }

  try {
    await assertPathMissing(finalSubtree, "overwrite_staging_exists");
    await mkdir(partialSubtree, { recursive: false, mode: 0o700 });
    const temporaryAddonPath = path.join(
      partialSubtree,
      "local-subtitle-overwrite.node",
    );
    await copyFile(addonPath, temporaryAddonPath, fsConstants.COPYFILE_EXCL);
    await chmod(temporaryAddonPath, 0o755);
    await assertFileMatchesRecord(temporaryAddonPath, receipt.artifact, {
      code: "overwrite_build_receipt_invalid",
      maxBytes: MAX_ADDON_BYTES,
    });

    let signatureKind = "unsigned";
    if (target.platform === "darwin") {
      const signingIdentity = normalizeSigningIdentity(options.signingIdentity);
      const signer = dependencies.signer ?? signMacosAddon;
      signatureKind = await signer(temporaryAddonPath, {
        identity: signingIdentity,
        identifier: "com.fusionkit.local-subtitle.overwrite",
      });
      if (!target.integrity.allowedSignatureKinds.includes(signatureKind)) {
        throw failure(
          "overwrite_signature_invalid",
          "The staged overwrite addon signature is not allowed.",
        );
      }
    } else if (options.signingIdentity !== undefined) {
      throw failure(
        "overwrite_staging_invalid",
        "Windows personal staging does not accept a signing identity.",
      );
    }

    const nativeInspector = dependencies.nativeInspector ?? inspectOverwriteNativeArtifact;
    const inspection = await nativeInspector(temporaryAddonPath);
    assertNativeInspection(inspection, target);
    const artifactBytes = await readBoundedRegularFile(
      temporaryAddonPath,
      MAX_ADDON_BYTES,
      "overwrite_addon_invalid",
    );
    const artifactSha256 = sha256(artifactBytes);
    const artifactLeaf = OVERWRITE_STAGING_CONTRACT.artifactLeafPattern.replace(
      "<sha256>",
      artifactSha256,
    );
    const artifactRelativePath = `${target.artifact.relativeDirectory}/${artifactLeaf}`;
    const contentAddressedPath = resolveContained(
      partialSubtree,
      artifactRelativePath,
    );
    await mkdir(path.dirname(contentAddressedPath), {
      recursive: true,
      mode: 0o700,
    });
    await rename(temporaryAddonPath, contentAddressedPath);
    await assertFileMatchesRecord(
      contentAddressedPath,
      { byteSize: artifactBytes.byteLength, sha256: artifactSha256 },
      { code: "overwrite_addon_invalid", maxBytes: MAX_ADDON_BYTES },
    );

    const stagedReceiptContent = canonicalOverwriteJson(receipt);
    const stagedReceiptPath = resolveContained(
      partialSubtree,
      OVERWRITE_STAGING_CONTRACT.buildReceiptRelativePath,
    );
    await writeFile(stagedReceiptPath, stagedReceiptContent, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(stagedReceiptPath, 0o644);
    const stagedReceiptBytes = Buffer.from(stagedReceiptContent, "utf8");
    const manifest = {
      schemaVersion: 1,
      component: OVERWRITE_STAGING_CONTRACT.component,
      target: { platform: target.platform, arch: target.arch },
      compatibility: { ...target.compatibility },
      integrity: {
        algorithm: target.integrity.algorithm,
        binaryHashPhase: target.integrity.binaryHashPhase,
        signatureKind,
      },
      artifact: {
        relativePath: artifactRelativePath,
        byteSize: artifactBytes.byteLength,
        sha256: artifactSha256,
        format: inspection.format,
        architecture: inspection.architectures[0],
        minimumOsVersion: inspection.minimumOsVersion,
        hasLoadCommandUuid: inspection.hasLoadCommandUuid,
      },
      buildReceipt: {
        relativePath: OVERWRITE_STAGING_CONTRACT.buildReceiptRelativePath,
        byteSize: stagedReceiptBytes.byteLength,
        sha256: sha256(stagedReceiptBytes),
        artifactHashPhase: "unsigned_link_output",
      },
    };
    parseOverwriteAddonManifest(manifest, {
      platform: target.platform,
      arch: target.arch,
    });
    const manifestContent = canonicalOverwriteJson(manifest);
    const manifestPath = path.join(
      partialSubtree,
      path.basename(OVERWRITE_STAGING_CONTRACT.manifestRelativePath),
    );
    await writeFile(manifestPath, manifestContent, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });

    const verification = await verifySubtree(
      {
        subtreeRoot: partialSubtree,
        platform: target.platform,
        arch: target.arch,
        signatureVerifier: dependencies.signatureVerifier,
      },
      dependencies,
    );
    await rename(partialSubtree, finalSubtree);
    published = true;
    return Object.freeze({
      ...verification,
      staged: true,
      atomicNoClobberPublication: true,
      privacy: Object.freeze({
        absolutePathsRecorded: false,
        signingIdentityRecorded: false,
      }),
    });
  } catch (cause) {
    if (!published) {
      await rm(partialSubtree, { recursive: true, force: true });
    }
    if (cause?.code) throw cause;
    throw failure(
      "overwrite_staging_invalid",
      "The overwrite addon could not be staged.",
      cause,
    );
  } finally {
    if (lockHandle) await lockHandle.close();
    try {
      await unlink(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw failure(
          "overwrite_staging_cleanup_failed",
          "The overwrite staging publication lock could not be removed.",
          error,
        );
      }
    }
  }
}

export async function verifyStagedOverwriteNativeAddon(
  options,
  dependencies = {},
) {
  assertExactOptions(
    options,
    ["root", "platform", "arch", "signatureVerifier"],
    ["root", "platform", "arch"],
  );
  const target = getOverwriteStagingTarget(options.platform, options.arch);
  const root = await verifyDirectoryRoot(options.root);
  const subtreeRoot = resolveContained(
    root,
    OVERWRITE_STAGING_CONTRACT.stagingSubtree,
  );
  await verifyDirectoryRoot(subtreeRoot);
  return verifySubtree(
    {
      subtreeRoot,
      platform: target.platform,
      arch: target.arch,
      signatureVerifier: options.signatureVerifier,
    },
    dependencies,
  );
}

async function verifySubtree(options, dependencies) {
  const target = getOverwriteStagingTarget(options.platform, options.arch);
  const manifestPath = path.join(
    options.subtreeRoot,
    path.basename(OVERWRITE_STAGING_CONTRACT.manifestRelativePath),
  );
  await assertNoSymbolicPathSegments(
    options.subtreeRoot,
    path.basename(OVERWRITE_STAGING_CONTRACT.manifestRelativePath),
  );
  const rawManifest = await readJsonFileNoFollow(
    manifestPath,
    MAX_MANIFEST_BYTES,
    "overwrite_manifest_invalid",
  );
  const manifest = parseOverwriteAddonManifest(rawManifest.value, {
    platform: target.platform,
    arch: target.arch,
  });
  const receiptPath = resolveContained(
    options.subtreeRoot,
    manifest.buildReceipt.relativePath,
  );
  await assertNoSymbolicPathSegments(
    options.subtreeRoot,
    manifest.buildReceipt.relativePath,
  );
  const receiptFile = await readJsonFileNoFollow(
    receiptPath,
    MAX_RECEIPT_BYTES,
    "overwrite_build_receipt_invalid",
  );
  if (
    receiptFile.bytes.byteLength !== manifest.buildReceipt.byteSize ||
    sha256(receiptFile.bytes) !== manifest.buildReceipt.sha256
  ) {
    throw failure(
      "overwrite_build_receipt_invalid",
      "The staged build receipt does not match the overwrite manifest.",
    );
  }
  const receipt = parseOverwriteBuildReceipt(receiptFile.value, target);

  const artifactPath = resolveContained(
    options.subtreeRoot,
    manifest.artifact.relativePath,
  );
  await assertNoSymbolicPathSegments(
    options.subtreeRoot,
    manifest.artifact.relativePath,
  );
  await assertFileMatchesRecord(artifactPath, manifest.artifact, {
    code: "overwrite_addon_invalid",
    maxBytes: MAX_ADDON_BYTES,
  });
  if (
    target.platform === "win32" &&
    (receipt.artifact.byteSize !== manifest.artifact.byteSize ||
      receipt.artifact.sha256 !== manifest.artifact.sha256)
  ) {
    throw failure(
      "overwrite_build_receipt_invalid",
      "The unsigned Windows addon does not match its build receipt.",
    );
  }
  const nativeInspector = dependencies.nativeInspector ?? inspectOverwriteNativeArtifact;
  const inspection = await nativeInspector(artifactPath);
  assertNativeInspection(inspection, target);

  if (target.platform === "darwin") {
    const signatureVerifier =
      options.signatureVerifier ?? dependencies.signatureVerifier ?? verifyMacosSignature;
    let signatureValid = false;
    try {
      signatureValid = await signatureVerifier(artifactPath, {
        platform: target.platform,
        signatureKind: manifest.integrity.signatureKind,
      });
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      throw failure(
        "overwrite_signature_invalid",
        "The staged overwrite addon signature is invalid.",
      );
    }
    await assertFileMatchesRecord(artifactPath, manifest.artifact, {
      code: "overwrite_addon_invalid",
      maxBytes: MAX_ADDON_BYTES,
    });
  }

  const moduleProbe = dependencies.moduleProbe ?? probeOverwriteNativeModule;
  const moduleIdentity = await moduleProbe(artifactPath);
  assertProductionModuleIdentity(moduleIdentity, target);
  await assertFileMatchesRecord(artifactPath, manifest.artifact, {
    code: "overwrite_addon_invalid",
    maxBytes: MAX_ADDON_BYTES,
  });

  return Object.freeze({
    schemaVersion: 1,
    ready: true,
    target: Object.freeze({ platform: target.platform, arch: target.arch }),
    generation: sha256(rawManifest.bytes),
    manifestRelativePath: OVERWRITE_STAGING_CONTRACT.manifestRelativePath,
    artifact: Object.freeze({
      relativePath: manifest.artifact.relativePath,
      byteSize: manifest.artifact.byteSize,
      sha256: manifest.artifact.sha256,
      signatureKind: manifest.integrity.signatureKind,
    }),
    buildReceiptSha256: manifest.buildReceipt.sha256,
    moduleExportsVerified: true,
    contentAddressed: true,
    noPathFallback: true,
  });
}

export async function inspectOverwriteNativeArtifact(filePath) {
  const [inspection, bytes] = await Promise.all([
    inspectNativeBinaryFile(filePath),
    readBoundedRegularFile(
      filePath,
      MAX_ADDON_BYTES,
      "overwrite_addon_invalid",
    ),
  ]);
  return Object.freeze({
    ...inspection,
    hasLoadCommandUuid:
      inspection.format === "mach-o" ? hasMachOLoadCommandUuid(bytes) : false,
  });
}

export async function probeOverwriteNativeModule(filePath) {
  const script = [
    "const addon = require(process.argv[1]);",
    "const keys = Reflect.ownKeys(addon);",
    "if (keys.some((key) => typeof key !== 'string')) process.exit(91);",
    "const result = {",
    "keys,",
    "protocolVersion: addon.protocolVersion,",
    "platform: addon.platform,",
    "architecture: addon.architecture,",
    "types: { begin: typeof addon.begin, recover: typeof addon.recover, acknowledge: typeof addon.acknowledge },",
    "};",
    "process.stdout.write(JSON.stringify(result));",
  ].join("");
  const result = spawnSync(process.execPath, ["-e", script, filePath], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: sanitizedModuleEnvironment(),
  });
  if (result.status !== 0 || result.signal || result.stderr !== "") {
    throw failure(
      "overwrite_module_invalid",
      "The staged overwrite addon could not be loaded in a fresh process.",
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw failure(
      "overwrite_module_invalid",
      "The staged overwrite addon probe returned invalid output.",
      cause,
    );
  }
}

async function signMacosAddon(filePath, options) {
  const args = [
    "--force",
    "--sign",
    options.identity,
    "--identifier",
    options.identifier,
  ];
  if (options.identity !== "-") args.push("--options", "runtime", "--timestamp");
  args.push(filePath);
  runMacosCommand("/usr/bin/codesign", args, options.identity === "-" ? 30_000 : 120_000);
  const details = runMacosCommand("/usr/bin/codesign", ["-dvvv", filePath], 30_000, true);
  const output = `${details.stdout}${details.stderr}`;
  if (/^Signature=adhoc$/mu.test(output)) return "adhoc";
  if (/^Authority=Developer ID Application:/mu.test(output)) return "developer_id";
  throw failure(
    "overwrite_signature_invalid",
    "The staged overwrite addon does not have an accepted macOS signature.",
  );
}

async function verifyMacosSignature(filePath, policy) {
  if (policy.platform !== "darwin") return false;
  const verify = runMacosCommand(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--verbose=4", filePath],
    30_000,
  );
  if (verify.status !== 0) return false;
  const details = runMacosCommand(
    "/usr/bin/codesign",
    ["-dvvv", filePath],
    30_000,
    true,
  );
  const output = `${details.stdout}${details.stderr}`;
  return policy.signatureKind === "adhoc"
    ? /^Signature=adhoc$/mu.test(output)
    : /^Authority=Developer ID Application:/mu.test(output);
}

function runMacosCommand(command, args, timeout, acceptStderr = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: MACOS_COMMAND_ENVIRONMENT,
  });
  if (
    result.status !== 0 ||
    result.signal ||
    result.error ||
    (!acceptStderr && typeof result.stderr !== "string")
  ) {
    throw failure(
      "overwrite_signature_invalid",
      "A required macOS signature command failed.",
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assertNativeInspection(inspection, target) {
  if (
    !inspection ||
    inspection.format !== target.artifact.format ||
    !Array.isArray(inspection.architectures) ||
    inspection.architectures.length !== 1 ||
    inspection.architectures[0] !== target.artifact.architecture ||
    inspection.minimumOsVersion !== target.artifact.minimumOsVersion ||
    inspection.hasLoadCommandUuid !== target.artifact.requiresLoadCommandUuid
  ) {
    throw failure(
      "overwrite_addon_invalid",
      "The staged overwrite addon native identity is invalid.",
    );
  }
}

function assertProductionModuleIdentity(value, target) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.keys) ||
    value.keys.length !== EXPECTED_MODULE_KEYS.length ||
    EXPECTED_MODULE_KEYS.some((key) => !value.keys.includes(key)) ||
    value.protocolVersion !== target.compatibility.nativeProtocolVersion ||
    value.platform !== target.platform ||
    value.architecture !== target.arch ||
    value.types?.begin !== "function" ||
    value.types?.recover !== "function" ||
    value.types?.acknowledge !== "function"
  ) {
    throw failure(
      "overwrite_module_invalid",
      "The staged overwrite addon exports are not the production module surface.",
    );
  }
}

function hasMachOLoadCommandUuid(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 32) return false;
  const magicLe = bytes.readUInt32LE(0);
  const magicBe = bytes.readUInt32BE(0);
  if (magicLe !== 0xfeedfacf && magicBe !== 0xfeedfacf) return false;
  const read32 = magicLe === 0xfeedfacf
    ? (offset) => bytes.readUInt32LE(offset)
    : (offset) => bytes.readUInt32BE(offset);
  const commandCount = read32(16);
  let offset = 32;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > bytes.byteLength) return false;
    const command = read32(offset);
    const commandSize = read32(offset + 4);
    if (commandSize < 8 || offset + commandSize > bytes.byteLength) return false;
    if (command === 0x1b && commandSize >= 24) return true;
    offset += commandSize;
  }
  return false;
}

async function verifyDirectoryRoot(value) {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) {
    throw failure(
      "overwrite_staging_invalid",
      "The overwrite staging root must be an absolute directory.",
    );
  }
  let proof;
  let canonical;
  try {
    [proof, canonical] = await Promise.all([lstat(value), realpath(value)]);
  } catch (cause) {
    throw failure(
      "overwrite_staging_missing",
      "The overwrite staging root is missing.",
      cause,
    );
  }
  if (
    !proof.isDirectory() ||
    proof.isSymbolicLink()
  ) {
    throw failure(
      "overwrite_staging_invalid",
      "The overwrite staging root is not a canonical directory.",
    );
  }
  return canonical;
}

async function verifyAbsoluteRegularFile(value, code) {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) {
    throw failure(code, "A required overwrite staging input path is invalid.");
  }
  let proof;
  let canonical;
  try {
    [proof, canonical] = await Promise.all([lstat(value), realpath(value)]);
  } catch (cause) {
    throw failure(code, "A required overwrite staging input is missing.", cause);
  }
  if (
    !proof.isFile() ||
    proof.isSymbolicLink()
  ) {
    throw failure(code, "A required overwrite staging input is invalid.");
  }
  return canonical;
}

async function ensureOwnedDirectory(directoryPath) {
  try {
    await mkdir(directoryPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const proof = await lstat(directoryPath);
  const canonical = await realpath(directoryPath);
  if (
    !proof.isDirectory() ||
    proof.isSymbolicLink() ||
    normalizePath(canonical) !== normalizePath(path.resolve(directoryPath))
  ) {
    throw failure(
      "overwrite_staging_invalid",
      "The overwrite staging parent is not a canonical directory.",
    );
  }
}

async function readJsonFileNoFollow(filePath, maxBytes, code) {
  const bytes = await readBoundedRegularFile(filePath, maxBytes, code);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (cause) {
    throw failure(code, "A staged overwrite JSON file is invalid.", cause);
  }
}

async function readBoundedRegularFile(filePath, maxBytes, code) {
  let before;
  try {
    before = await lstat(filePath, { bigint: true });
  } catch (cause) {
    throw failure(code, "A staged overwrite file is missing.", cause);
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(maxBytes)
  ) {
    throw failure(code, "A staged overwrite file is invalid.");
  }
  let handle;
  try {
    handle = await open(filePath, READ_ONLY_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    assertSameStat(before, opened, code);
    const bytes = await handle.readFile();
    const completed = await handle.stat({ bigint: true });
    assertSameStat(opened, completed, code);
    const after = await lstat(filePath, { bigint: true });
    assertSameStat(completed, after, code);
    if (BigInt(bytes.byteLength) !== completed.size) {
      throw failure(code, "A staged overwrite file changed while being read.");
    }
    return bytes;
  } catch (cause) {
    if (cause?.code === code) throw cause;
    throw failure(code, "A staged overwrite file could not be read safely.", cause);
  } finally {
    await handle?.close();
  }
}

async function assertFileMatchesRecord(filePath, expected, options) {
  const bytes = await readBoundedRegularFile(
    filePath,
    options.maxBytes,
    options.code,
  );
  if (
    bytes.byteLength !== expected.byteSize ||
    sha256(bytes) !== expected.sha256
  ) {
    throw failure(
      options.code,
      "A staged overwrite file does not match its integrity record.",
    );
  }
}

function assertSameStat(expected, actual, code) {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.size !== actual.size ||
    expected.mtimeNs !== actual.mtimeNs ||
    expected.ctimeNs !== actual.ctimeNs ||
    !actual.isFile() ||
    actual.nlink !== 1n
  ) {
    throw failure(code, "A staged overwrite file identity changed.");
  }
}

function resolveContained(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath.includes(":") ||
    relativePath.startsWith("/") ||
    relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw failure(
      "overwrite_manifest_invalid",
      "A staged overwrite relative path is invalid.",
    );
  }
  const resolved = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw failure(
      "overwrite_manifest_invalid",
      "A staged overwrite path escaped its root.",
    );
  }
  return resolved;
}

async function assertPathMissing(filePath, code) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw failure(code, "The overwrite staging destination already exists.");
}

async function assertNoSymbolicPathSegments(root, relativePath) {
  let current = root;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let proof;
    try {
      proof = await lstat(current);
    } catch (cause) {
      throw failure(
        "overwrite_staging_missing",
        "A staged overwrite path is missing.",
        cause,
      );
    }
    const leaf = index === segments.length - 1;
    if (
      proof.isSymbolicLink() ||
      (leaf ? !proof.isFile() : !proof.isDirectory())
    ) {
      throw failure(
        "overwrite_staging_invalid",
        "A staged overwrite path contains an invalid or symbolic segment.",
      );
    }
  }
}

function assertExactOptions(value, allowedKeys, requiredKeys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw failure(
      "overwrite_staging_invalid",
      "Overwrite staging options must be a plain object.",
    );
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !keys.includes(key))
  ) {
    throw failure(
      "overwrite_staging_invalid",
      "Overwrite staging options do not match the contract.",
    );
  }
  if (
    Object.hasOwn(value, "signatureVerifier") &&
    typeof value.signatureVerifier !== "function"
  ) {
    throw failure(
      "overwrite_staging_invalid",
      "signatureVerifier must be a function when supplied.",
    );
  }
}

function normalizeSigningIdentity(value) {
  if (value === undefined) return "-";
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes("\0") ||
    value.trim() !== value
  ) {
    throw failure(
      "overwrite_staging_invalid",
      "The macOS signing identity is invalid.",
    );
  }
  return value;
}

function sanitizedModuleEnvironment() {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    return {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: [path.dirname(process.execPath), path.join(systemRoot, "System32")].join(
        path.delimiter,
      ),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
  }
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };
}

function normalizePath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function failure(code, message, cause) {
  return overwriteStagingError(code, message, cause);
}

function parseCliArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      addon: { type: "string" },
      receipt: { type: "string" },
      platform: { type: "string", default: process.platform },
      arch: { type: "string", default: process.arch },
      "sign-identity": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    root: values.root,
    addonPath: values.addon,
    buildReceiptPath: values.receipt,
    platform: values.platform,
    arch: values.arch,
    ...(values["sign-identity"] === undefined
      ? {}
      : { signingIdentity: values["sign-identity"] }),
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node overwrite-staging.mjs --root <canonical-runtime-root> " +
        "--addon <production.node> --receipt <production-receipt.json> " +
        "[--platform darwin|win32] [--arch arm64|x64] " +
        "[--sign-identity <identity-or-dash>]\n",
    );
    return;
  }
  const report = await stageOverwriteNativeAddon(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`overwrite_staging_failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
