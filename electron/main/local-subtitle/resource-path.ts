import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  LOCAL_SUBTITLE_RUNTIME_MANIFEST_RELATIVE_PATH,
  LOCAL_SUBTITLE_STAGING_CONTRACT,
  LocalSubtitleResourceError,
  assertSupportedLocalSubtitleRuntimeTarget,
  inspectLocalSubtitleNativeBinary,
  isLocalSubtitleMediaArtifact,
  normalizeLocalSubtitleManifestRelativePath,
  parseLocalSubtitleRuntimeManifest,
  type LocalSubtitleRuntimeArtifact,
  type LocalSubtitleRuntimeManifest,
  type LocalSubtitleRuntimePlatform,
  type LocalSubtitleRuntimeSignatureKind,
  type LocalSubtitleResourceErrorCode,
} from "./resource-manifest";
import { LOCAL_SUBTITLE_LIMITS } from "@/type/localSubtitle";

const execFileAsync = promisify(execFile);
const MAX_NATIVE_HEADER_BYTES = 1024 * 1024;
const FILE_HASH_CHUNK_BYTES = 1024 * 1024;
const READ_ONLY_NOFOLLOW_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const MACOS_SIGNATURE_ENVIRONMENT = {
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
} as unknown as NodeJS.ProcessEnv;

interface LocalSubtitleResourceEnvironmentBase {
  readonly platform?: NodeJS.Platform | string;
  readonly arch?: string;
}

export type LocalSubtitleResourceEnvironment =
  | (LocalSubtitleResourceEnvironmentBase & {
      readonly mode: "development";
      readonly appRoot: string;
    })
  | (LocalSubtitleResourceEnvironmentBase & {
      readonly mode: "packaged";
      readonly resourcesPath: string;
    });

export type LocalSubtitleRuntimeVerificationScope =
  | "all"
  | "media"
  | "server";

export interface LocalSubtitleLoadedRuntimeManifest {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: LocalSubtitleRuntimeManifest;
}

export interface LocalSubtitleVerifiedRuntimeArtifact {
  readonly id: string;
  readonly kind: LocalSubtitleRuntimeArtifact["kind"];
  readonly backend: LocalSubtitleRuntimeArtifact["backend"];
  readonly absolutePath: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly version: string;
  readonly signatureKind: LocalSubtitleRuntimeSignatureKind;
}

export interface LocalSubtitleVerifiedRuntimeBundle {
  readonly schemaVersion: 1;
  readonly target: {
    readonly platform: LocalSubtitleRuntimePlatform;
    readonly arch: "arm64" | "x64";
  };
  readonly scope: LocalSubtitleRuntimeVerificationScope;
  readonly root: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly runtimeGeneration: string;
  readonly integrityProfile: LocalSubtitleRuntimeManifest["integrityProfile"];
  readonly artifactPaths: Readonly<
    Record<string, LocalSubtitleVerifiedRuntimeArtifact>
  >;
  readonly evidenceFileCount: number;
  readonly noPathFallback: true;
  readonly ready: true;
}

export type LocalSubtitleSignatureVerifier = (
  absolutePath: string,
  policy: {
    readonly platform: LocalSubtitleRuntimePlatform;
    readonly signatureKind: Exclude<
      LocalSubtitleRuntimeSignatureKind,
      "unsigned"
    >;
  },
) => Promise<boolean>;

export interface VerifyLocalSubtitleRuntimeBundleOptions {
  readonly environment: LocalSubtitleResourceEnvironment;
  readonly scope?: LocalSubtitleRuntimeVerificationScope;
  readonly signatureVerifier?: LocalSubtitleSignatureVerifier;
}

export function resolveLocalSubtitleRuntimeRoot(
  environment: LocalSubtitleResourceEnvironment,
): string {
  const platform = environment.platform ?? process.platform;
  const arch = environment.arch ?? process.arch;
  assertSupportedLocalSubtitleRuntimeTarget(platform, arch);

  const basePath = environment.mode === "packaged"
    ? environment.resourcesPath
    : environment.appRoot;
  assertAbsoluteRoot(basePath);
  const relativeRoot = environment.mode === "packaged"
    ? LOCAL_SUBTITLE_STAGING_CONTRACT.packagedRuntimeRoot
    : LOCAL_SUBTITLE_STAGING_CONTRACT.developmentRuntimeRoot;
  return resolveContainedPath(basePath, relativeRoot);
}

export function resolveLocalSubtitleResourcePath(
  bundle: LocalSubtitleVerifiedRuntimeBundle,
  artifactId: string,
): string {
  return resolveVerifiedLocalSubtitleArtifact(bundle, artifactId).absolutePath;
}

export async function loadLocalSubtitleRuntimeManifest(
  environment: LocalSubtitleResourceEnvironment,
): Promise<LocalSubtitleLoadedRuntimeManifest> {
  const platform = environment.platform ?? process.platform;
  const arch = environment.arch ?? process.arch;
  assertSupportedLocalSubtitleRuntimeTarget(platform, arch);

  const root = resolveLocalSubtitleRuntimeRoot(environment);
  await verifyRuntimeRoot(environment, root);
  const manifestPath = resolveContainedPath(
    root,
    LOCAL_SUBTITLE_RUNTIME_MANIFEST_RELATIVE_PATH,
  );
  const manifestStat = await safeLstat(
    manifestPath,
    "media_runtime_invalid",
    "manifest",
  );
  if (!manifestStat) {
    throw resourceFailure(
      "media_runtime_missing",
      "manifest",
      "The bundled local subtitle runtime manifest is missing.",
    );
  }
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size > LOCAL_SUBTITLE_LIMITS.maxRuntimeManifestBytes
  ) {
    throw resourceFailure(
      "media_runtime_invalid",
      "manifest",
      "The bundled local subtitle runtime manifest is invalid.",
    );
  }
  await assertNoSymbolicPathSegments(
    root,
    LOCAL_SUBTITLE_RUNTIME_MANIFEST_RELATIVE_PATH,
    "media_runtime_missing",
    "media_runtime_invalid",
  );
  await assertRealPathContained(root, manifestPath, "media_runtime_invalid");

  let manifestHandle: FileHandle;
  try {
    manifestHandle = await open(manifestPath, READ_ONLY_NOFOLLOW_FLAGS);
  } catch {
    throw resourceFailure(
      "media_runtime_invalid",
      "manifest",
      "The bundled local subtitle runtime manifest cannot be read.",
    );
  }
  let content: Buffer;
  try {
    const openedStat = await statOpenFile(
      manifestHandle,
      "media_runtime_invalid",
      "manifest",
    );
    assertMatchingFileIdentity(
      manifestStat,
      openedStat,
      "media_runtime_invalid",
      "manifest",
    );
    if (
      !openedStat.isFile() ||
      openedStat.size > LOCAL_SUBTITLE_LIMITS.maxRuntimeManifestBytes
    ) {
      throw resourceFailure(
        "media_runtime_invalid",
        "manifest",
        "The bundled local subtitle runtime manifest is invalid.",
      );
    }
    try {
      content = await manifestHandle.readFile();
    } catch {
      throw resourceFailure(
        "media_runtime_invalid",
        "manifest",
        "The bundled local subtitle runtime manifest cannot be read.",
      );
    }
    const completedStat = await statOpenFile(
      manifestHandle,
      "media_runtime_invalid",
      "manifest",
    );
    assertMatchingFileIdentity(
      openedStat,
      completedStat,
      "media_runtime_invalid",
      "manifest",
    );
    await assertNoSymbolicPathSegments(
      root,
      LOCAL_SUBTITLE_RUNTIME_MANIFEST_RELATIVE_PATH,
      "media_runtime_missing",
      "media_runtime_invalid",
    );
    await assertRealPathContained(root, manifestPath, "media_runtime_invalid");
    await assertFileIdentityUnchanged(
      manifestPath,
      completedStat,
      "media_runtime_invalid",
      "manifest",
    );
  } finally {
    await manifestHandle.close();
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(content.toString("utf8"));
  } catch {
    throw resourceFailure(
      "media_runtime_invalid",
      "manifest",
      "The bundled local subtitle runtime manifest is not valid JSON.",
    );
  }
  const manifest = parseLocalSubtitleRuntimeManifest(rawManifest, {
    platform,
    arch,
  });
  return Object.freeze({
    root,
    manifestPath,
    manifestSha256: createHash("sha256").update(content).digest("hex"),
    manifest,
  });
}

export async function verifyLocalSubtitleRuntimeBundle(
  options: VerifyLocalSubtitleRuntimeBundleOptions,
): Promise<LocalSubtitleVerifiedRuntimeBundle> {
  const scope = options.scope ?? "all";
  if (scope !== "all" && scope !== "media" && scope !== "server") {
    throw new TypeError("scope must be all, media, or server.");
  }
  const platform = options.environment.platform ?? process.platform;
  const arch = options.environment.arch ?? process.arch;
  const target = assertSupportedLocalSubtitleRuntimeTarget(platform, arch);
  const loaded = await loadLocalSubtitleRuntimeManifest(options.environment);
  const artifacts = loaded.manifest.artifacts.filter((artifact) => {
    if (scope === "media") return isLocalSubtitleMediaArtifact(artifact);
    if (scope === "server") return !isLocalSubtitleMediaArtifact(artifact);
    return true;
  });
  const licenseIds = new Set(artifacts.map((artifact) => artifact.licenseRef));
  const sourceIds = new Set(artifacts.map((artifact) => artifact.sourceRef));
  const evidenceFiles = [
    ...loaded.manifest.licenses
      .filter((record) => licenseIds.has(record.id))
      .flatMap((record) => [...record.licenseFiles, ...record.noticeFiles]),
    ...loaded.manifest.sources
      .filter((record) => sourceIds.has(record.id))
      .map((record) => record.evidenceFile),
  ];

  for (const evidence of evidenceFiles) {
    await verifyRegularContainedFile({
      root: loaded.root,
      relativePath: evidence.relativePath,
      expectedByteSize: evidence.byteSize,
      expectedSha256: evidence.sha256,
      missingCode: "media_runtime_missing",
      invalidCode: "media_runtime_invalid",
    });
  }

  const artifactPaths: Record<string, LocalSubtitleVerifiedRuntimeArtifact> = {};
  for (const artifact of artifacts) {
    const media = isLocalSubtitleMediaArtifact(artifact);
    const verificationOptions: VerifyRegularContainedFileOptions = {
      root: loaded.root,
      relativePath: artifact.relativePath,
      expectedByteSize: artifact.byteSize,
      expectedSha256: artifact.sha256,
      missingCode: media ? "media_runtime_missing" : "runtime_missing",
      invalidCode: media
        ? "media_runtime_invalid"
        : "runtime_protocol_mismatch",
      expectedArchitecture: target.arch,
      expectedPlatform: target.platform,
      requireExecutableBit:
        artifact.executable &&
        target.platform === "darwin" &&
        process.platform !== "win32",
    };
    let verified = await verifyRegularContainedFile(verificationOptions);
    if (artifact.signatureKind !== "unsigned") {
      const verifier =
        options.signatureVerifier ?? verifyLocalSubtitleArtifactSignature;
      let signatureValid = false;
      try {
        signatureValid = await verifier(verified.absolutePath, {
          platform: target.platform,
          signatureKind: artifact.signatureKind,
        });
      } catch {
        signatureValid = false;
      }
      if (!signatureValid) {
        throw resourceFailure(
          media ? "media_runtime_invalid" : "runtime_protocol_mismatch",
          "static_verification",
          "A bundled runtime artifact failed signature verification.",
        );
      }
      // Signature verification runs by path. Re-run the static gate so a path
      // replacement during that external check cannot inherit the prior hash.
      verified = await verifyRegularContainedFile(verificationOptions);
    }
    artifactPaths[artifact.id] = Object.freeze({
      id: artifact.id,
      kind: artifact.kind,
      backend: artifact.backend,
      absolutePath: verified.absolutePath,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      version: artifact.version,
      signatureKind: artifact.signatureKind,
    });
  }

  return Object.freeze({
    schemaVersion: 1,
    target: Object.freeze({ platform: target.platform, arch: target.arch }),
    scope,
    root: loaded.root,
    manifestPath: loaded.manifestPath,
    manifestSha256: loaded.manifestSha256,
    runtimeGeneration: loaded.manifestSha256,
    integrityProfile: loaded.manifest.integrityProfile,
    artifactPaths: Object.freeze(artifactPaths),
    evidenceFileCount: evidenceFiles.length,
    noPathFallback: true,
    ready: true,
  });
}

export function resolveVerifiedLocalSubtitleArtifact(
  bundle: LocalSubtitleVerifiedRuntimeBundle,
  artifactId: string,
): LocalSubtitleVerifiedRuntimeArtifact {
  const artifact = bundle.artifactPaths[artifactId];
  if (!artifact) {
    throw resourceFailure(
      "runtime_missing",
      "static_verification",
      "The requested bundled runtime artifact is not verified.",
    );
  }
  return artifact;
}

export async function verifyLocalSubtitleArtifactSignature(
  absolutePath: string,
  policy: {
    readonly platform: LocalSubtitleRuntimePlatform;
    readonly signatureKind: Exclude<
      LocalSubtitleRuntimeSignatureKind,
      "unsigned"
    >;
  },
): Promise<boolean> {
  if (policy.platform !== "darwin" || process.platform !== "darwin") {
    return false;
  }
  try {
    await execFileAsync(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--verbose=4", absolutePath],
      {
        cwd: path.dirname(absolutePath),
        env: MACOS_SIGNATURE_ENVIRONMENT,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const { stdout, stderr } = await execFileAsync(
      "/usr/bin/codesign",
      ["-dvvv", absolutePath],
      {
        cwd: path.dirname(absolutePath),
        env: MACOS_SIGNATURE_ENVIRONMENT,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const details = `${stdout}${stderr}`;
    if (policy.signatureKind === "adhoc") {
      return /^Signature=adhoc$/mu.test(details);
    }
    if (policy.signatureKind === "developer_id") {
      return /^Authority=Developer ID Application:/mu.test(details);
    }
    return false;
  } catch {
    return false;
  }
}

interface VerifyRegularContainedFileOptions {
  readonly root: string;
  readonly relativePath: string;
  readonly expectedByteSize: number;
  readonly expectedSha256: string;
  readonly missingCode: LocalSubtitleResourceErrorCode;
  readonly invalidCode: LocalSubtitleResourceErrorCode;
  readonly expectedArchitecture?: string;
  readonly expectedPlatform?: LocalSubtitleRuntimePlatform;
  readonly requireExecutableBit?: boolean;
}

async function verifyRegularContainedFile(
  options: VerifyRegularContainedFileOptions,
): Promise<{ readonly absolutePath: string }> {
  const relativePath = normalizeLocalSubtitleManifestRelativePath(
    options.relativePath,
  );
  const absolutePath = resolveContainedPath(options.root, relativePath);
  const fileStat = await safeLstat(absolutePath, options.invalidCode);
  if (!fileStat) {
    throw resourceFailure(
      options.missingCode,
      "static_verification",
      "A required bundled runtime resource is missing.",
    );
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw resourceFailure(
      options.invalidCode,
      "static_verification",
      "A bundled runtime resource is not a regular file.",
    );
  }
  await assertNoSymbolicPathSegments(
    options.root,
    relativePath,
    options.missingCode,
    options.invalidCode,
  );
  await assertRealPathContained(
    options.root,
    absolutePath,
    options.invalidCode,
  );
  let fileHandle: FileHandle;
  try {
    fileHandle = await open(absolutePath, READ_ONLY_NOFOLLOW_FLAGS);
  } catch {
    throw resourceFailure(
      options.invalidCode,
      "static_verification",
      "A bundled runtime resource cannot be opened.",
    );
  }
  try {
    const openedStat = await statOpenFile(
      fileHandle,
      options.invalidCode,
      "static_verification",
    );
    assertMatchingFileIdentity(
      fileStat,
      openedStat,
      options.invalidCode,
      "static_verification",
    );
    if (
      !openedStat.isFile() ||
      openedStat.size !== options.expectedByteSize ||
      (options.requireExecutableBit && (openedStat.mode & 0o111) === 0)
    ) {
      throw resourceFailure(
        options.invalidCode,
        "static_verification",
        "A bundled runtime resource failed its size or permission check.",
      );
    }
    const observed = await hashOpenFile(
      fileHandle,
      openedStat.size,
      Boolean(options.expectedArchitecture && options.expectedPlatform),
      options.invalidCode,
    );
    if (observed.sha256 !== options.expectedSha256) {
      throw resourceFailure(
        options.invalidCode,
        "static_verification",
        "A bundled runtime resource failed its SHA-256 check.",
      );
    }
    if (options.expectedArchitecture && options.expectedPlatform) {
      const identity = inspectLocalSubtitleNativeBinary(observed.header);
      const expectedFormat = options.expectedPlatform === "darwin"
        ? "mach-o"
        : "pe";
      if (
        identity.format !== expectedFormat ||
        identity.architectures.length !== 1 ||
        identity.architectures[0] !== options.expectedArchitecture
      ) {
        throw resourceFailure(
          options.invalidCode,
          "static_verification",
          "A bundled runtime artifact has the wrong binary identity.",
        );
      }
    }
    const completedStat = await statOpenFile(
      fileHandle,
      options.invalidCode,
      "static_verification",
    );
    assertMatchingFileIdentity(
      openedStat,
      completedStat,
      options.invalidCode,
      "static_verification",
    );
    await assertNoSymbolicPathSegments(
      options.root,
      relativePath,
      options.missingCode,
      options.invalidCode,
    );
    await assertRealPathContained(
      options.root,
      absolutePath,
      options.invalidCode,
    );
    await assertFileIdentityUnchanged(
      absolutePath,
      completedStat,
      options.invalidCode,
    );
  } finally {
    await fileHandle.close();
  }
  return { absolutePath };
}

async function verifyRuntimeRoot(
  environment: LocalSubtitleResourceEnvironment,
  root: string,
): Promise<void> {
  const basePath = environment.mode === "packaged"
    ? environment.resourcesPath
    : environment.appRoot;
  const relativeRoot = environment.mode === "packaged"
    ? LOCAL_SUBTITLE_STAGING_CONTRACT.packagedRuntimeRoot
    : LOCAL_SUBTITLE_STAGING_CONTRACT.developmentRuntimeRoot;
  const baseStat = await safeLstat(
    basePath,
    "media_runtime_invalid",
    "manifest",
  );
  if (!baseStat) {
    throw resourceFailure(
      "media_runtime_missing",
      "manifest",
      "The local subtitle resource base directory is missing.",
    );
  }
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    throw resourceFailure(
      "media_runtime_invalid",
      "manifest",
      "The local subtitle resource base directory is invalid.",
    );
  }
  await assertNoSymbolicDirectoryPathSegments(basePath, relativeRoot);
  await assertRealPathContained(basePath, root, "media_runtime_invalid");

  const rootStat = await safeLstat(
    root,
    "media_runtime_invalid",
    "manifest",
  );
  if (!rootStat) {
    throw resourceFailure(
      "media_runtime_missing",
      "manifest",
      "The bundled local subtitle runtime directory is missing.",
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw resourceFailure(
      "media_runtime_invalid",
      "manifest",
      "The bundled local subtitle runtime directory is invalid.",
    );
  }
}

async function assertNoSymbolicDirectoryPathSegments(
  root: string,
  relativePath: string,
): Promise<void> {
  let current = root;
  for (const segment of normalizeLocalSubtitleManifestRelativePath(
    relativePath,
  ).split("/")) {
    current = path.join(current, segment);
    const currentStat = await safeLstat(
      current,
      "media_runtime_invalid",
      "manifest",
    );
    if (!currentStat) {
      throw resourceFailure(
        "media_runtime_missing",
        "manifest",
        "The bundled local subtitle runtime directory is missing.",
      );
    }
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
      throw resourceFailure(
        "media_runtime_invalid",
        "manifest",
        "The bundled local subtitle runtime directory path is invalid.",
      );
    }
  }
}

async function assertNoSymbolicPathSegments(
  root: string,
  relativePath: string,
  missingCode: LocalSubtitleResourceErrorCode,
  invalidCode: LocalSubtitleResourceErrorCode,
): Promise<void> {
  let current = root;
  const segments = normalizeLocalSubtitleManifestRelativePath(relativePath).split(
    "/",
  );
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const currentStat = await safeLstat(current, invalidCode);
    if (!currentStat) {
      throw resourceFailure(
        missingCode,
        "static_verification",
        "A required bundled runtime resource is missing.",
      );
    }
    if (currentStat.isSymbolicLink()) {
      throw resourceFailure(
        invalidCode,
        "static_verification",
        "A bundled runtime resource path contains a symbolic link.",
      );
    }
    const isLeaf = index === segments.length - 1;
    if ((!isLeaf && !currentStat.isDirectory()) || (isLeaf && !currentStat.isFile())) {
      throw resourceFailure(
        invalidCode,
        "static_verification",
        "A bundled runtime resource path has an invalid file type.",
      );
    }
  }
}

async function assertRealPathContained(
  root: string,
  absolutePath: string,
  invalidCode: LocalSubtitleResourceErrorCode,
): Promise<void> {
  let rootRealPath: string;
  let fileRealPath: string;
  try {
    [rootRealPath, fileRealPath] = await Promise.all([
      realpath(root),
      realpath(absolutePath),
    ]);
  } catch {
    throw resourceFailure(
      invalidCode,
      "static_verification",
      "A bundled runtime resource cannot be resolved.",
    );
  }
  const relative = path.relative(rootRealPath, fileRealPath);
  if (!isContainedHostRelativePath(relative)) {
    throw resourceFailure(
      invalidCode,
      "static_verification",
      "A bundled runtime resource resolves outside its root.",
    );
  }
}

async function hashOpenFile(
  fileHandle: FileHandle,
  fileSize: number,
  captureHeader: boolean,
  invalidCode: LocalSubtitleResourceErrorCode,
): Promise<{ readonly sha256: string; readonly header: Buffer }> {
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
      if (bytesRead === 0) {
        throw new Error("unexpected end of file");
      }
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      if (position < header.length) {
        bytes.copy(header, position, 0, Math.min(bytesRead, header.length - position));
      }
      position += bytesRead;
    }
  } catch {
    throw resourceFailure(
      invalidCode,
      "static_verification",
      "A bundled runtime resource cannot be hashed.",
    );
  }
  return { sha256: hash.digest("hex"), header };
}

async function assertFileIdentityUnchanged(
  absolutePath: string,
  before: Stats,
  invalidCode: LocalSubtitleResourceErrorCode,
  stage: "manifest" | "static_verification" = "static_verification",
): Promise<void> {
  const after = await safeLstat(absolutePath, invalidCode);
  if (!after || !after.isFile() || after.isSymbolicLink()) {
    throw resourceFailure(
      invalidCode,
      stage,
      "A bundled runtime resource changed during verification.",
    );
  }
  assertMatchingFileIdentity(before, after, invalidCode, stage);
}

async function statOpenFile(
  fileHandle: FileHandle,
  invalidCode: LocalSubtitleResourceErrorCode,
  stage: "manifest" | "static_verification",
): Promise<Stats> {
  try {
    return await fileHandle.stat();
  } catch {
    throw resourceFailure(
      invalidCode,
      stage,
      "Bundled runtime filesystem metadata cannot be read.",
    );
  }
}

function assertMatchingFileIdentity(
  before: Stats,
  after: Stats,
  invalidCode: LocalSubtitleResourceErrorCode,
  stage: "manifest" | "static_verification",
): void {
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mode !== before.mode ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw resourceFailure(
      invalidCode,
      stage,
      "A bundled runtime resource changed during verification.",
    );
  }
}

function resolveContainedPath(root: string, relativePath: string): string {
  const normalized = normalizeLocalSubtitleManifestRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalized.split("/"));
  const relative = path.relative(resolvedRoot, resolved);
  if (!isContainedHostRelativePath(relative)) {
    throw resourceFailure(
      "media_runtime_invalid",
      "manifest",
      "A bundled runtime resource escapes its root.",
    );
  }
  return resolved;
}

function isContainedHostRelativePath(relative: string): boolean {
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertAbsoluteRoot(root: string): void {
  if (typeof root !== "string" || root.trim() === "" || !path.isAbsolute(root)) {
    throw resourceFailure(
      "media_runtime_invalid",
      "manifest",
      "The local subtitle resource root must be absolute.",
    );
  }
}

async function safeLstat(
  absolutePath: string,
  invalidCode: LocalSubtitleResourceErrorCode = "media_runtime_invalid",
  stage: "manifest" | "static_verification" = "static_verification",
): Promise<Stats | null> {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw resourceFailure(
      invalidCode,
      stage,
      "Bundled runtime filesystem metadata cannot be read.",
    );
  }
}

function resourceFailure(
  code: LocalSubtitleResourceErrorCode,
  stage: "manifest" | "static_verification",
  message: string,
): LocalSubtitleResourceError {
  return new LocalSubtitleResourceError(code, stage, message);
}
