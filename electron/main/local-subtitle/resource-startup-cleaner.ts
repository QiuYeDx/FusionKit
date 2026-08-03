import { randomUUID } from "node:crypto";
import { type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST } from "./accelerator-manifest";
import { LOCAL_SUBTITLE_MODEL_MANIFEST } from "./model-manifest";
import {
  reconcileLocalSubtitleResourceDownloadState,
  type ReconcileLocalSubtitleResourceDownloadStateOptions,
} from "./resource-download";
import { LOCAL_SUBTITLE_VAD_MANIFEST } from "./vad-manifest";

const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const MKDTEMP_SUFFIX_SOURCE = "[A-Za-z0-9]{6}";

export const LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY = Object.freeze({
  downloadsDirectoryName: "downloads",
  modelStagingDirectoryName: "model-staging",
  vadStagingDirectoryName: "vad-staging",
  acceleratorDownloadsDirectoryName: "accelerator-downloads",
  acceleratorStagingDirectoryName: "accelerator-staging",
  cleanupMaxRetries: 5,
  cleanupRetryDelayMs: 200,
} as const);

export interface LocalSubtitleStartupDownloadDefinition {
  readonly resourceId: string;
  readonly sourceUrl: string;
  readonly allowedHosts: readonly string[];
  readonly expectedBytes: number;
  readonly downloadDirectoryName: string;
}

export interface CleanupLocalSubtitleResourceStartupOptions {
  readonly managedResourceRoot: string;
  readonly platform?: NodeJS.Platform | string;
  readonly arch?: string;
  readonly downloadDefinitions?: readonly LocalSubtitleStartupDownloadDefinition[];
  readonly quarantineIdFactory?: () => string;
  readonly renameDirectory?: (source: string, destination: string) => Promise<void>;
  readonly removeDirectory?: (absolutePath: string) => Promise<void>;
}

export interface LocalSubtitleResourceStartupCleanupResult {
  readonly preservedDownloads: number;
  readonly removedDownloadStates: number;
  readonly removedMetadataTemporaries: number;
  readonly removedStagingDirectories: number;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

interface PrivateDirectoryProof extends DirectoryIdentity {
  readonly absolutePath: string;
  readonly realPath: string;
  readonly mode: number;
}

interface OwnedFileReceipt extends DirectoryIdentity {
  readonly absolutePath: string;
}

interface StagingRootDefinition {
  readonly directoryName: string;
  readonly ownedLeafPatterns: readonly RegExp[];
}

export async function cleanupLocalSubtitleResourceStartupOrphans(
  options: CleanupLocalSubtitleResourceStartupOptions,
): Promise<Readonly<LocalSubtitleResourceStartupCleanupResult>> {
  const managedResourceRoot = validateAbsoluteRoot(options?.managedResourceRoot);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const definitions = validateDownloadDefinitions(
    options.downloadDefinitions ?? productionDownloadDefinitions(platform, arch),
  );
  const stagingDefinitions = productionStagingDefinitions(platform, arch);
  const quarantineIdFactory = options.quarantineIdFactory ?? randomUUID;
  const renameDirectory = options.renameDirectory ?? rename;
  const removeDirectory = options.removeDirectory ?? ((absolutePath) =>
    rm(absolutePath, {
      recursive: true,
      force: false,
      maxRetries:
        LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY.cleanupMaxRetries,
      retryDelay:
        LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY.cleanupRetryDelayMs,
    }));

  const managed = await ensurePrivateDirectory(managedResourceRoot, platform);
  const childNames = new Set([
    ...definitions.map((definition) => definition.downloadDirectoryName),
    ...stagingDefinitions.map((definition) => definition.directoryName),
  ]);
  const childResults = await Promise.allSettled(
    [...childNames].map(async (directoryName) => [
      directoryName,
      await ensurePrivateDirectory(
        resolvePrivateChild(managedResourceRoot, directoryName),
        platform,
      ),
    ] as const),
  );
  throwFirstFailure(childResults);
  const children = new Map(
    childResults.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []),
  );
  assertIndependentRoots(managed, [...children.values()], platform);
  await verifyRootProofs(managed, [...children.values()], platform);

  let preservedDownloads = 0;
  let removedDownloadStates = 0;
  let removedMetadataTemporaries = 0;
  let removedStagingDirectories = 0;
  const operations: Array<Promise<void>> = [];

  for (const definition of definitions) {
    const downloads = children.get(definition.downloadDirectoryName)!;
    operations.push((async () => {
      await verifyRootProofs(managed, [downloads], platform);
      const state = await reconcileLocalSubtitleResourceDownloadState(
        downloadStateOptions(definition, downloads.absolutePath),
      );
      if (state.status === "resumable") preservedDownloads += 1;
      if (state.status === "removed") removedDownloadStates += 1;
    })());
  }

  for (const [directoryName, groupedDefinitions] of groupDownloadDefinitions(
    definitions,
  )) {
    const downloads = children.get(directoryName)!;
    operations.push(cleanMetadataTemporaries(
      managed,
      downloads,
      groupedDefinitions,
      platform,
      () => {
        removedMetadataTemporaries += 1;
      },
    ));
  }

  for (const definition of stagingDefinitions) {
    const staging = children.get(definition.directoryName)!;
    operations.push(cleanStagingRoot(
      managed,
      staging,
      definition,
      platform,
      quarantineIdFactory,
      renameDirectory,
      removeDirectory,
      () => {
        removedStagingDirectories += 1;
      },
    ));
  }

  const results = await Promise.allSettled(operations);
  throwFirstFailure(results);
  await verifyRootProofs(managed, [...children.values()], platform);
  return Object.freeze({
    preservedDownloads,
    removedDownloadStates,
    removedMetadataTemporaries,
    removedStagingDirectories,
  });
}

function productionDownloadDefinitions(
  platform: string,
  arch: string,
): readonly LocalSubtitleStartupDownloadDefinition[] {
  const definitions: LocalSubtitleStartupDownloadDefinition[] = [
    ...LOCAL_SUBTITLE_MODEL_MANIFEST.models.map((model) => ({
      resourceId: model.id,
      sourceUrl: model.downloadUrl,
      allowedHosts: model.allowedDownloadHosts,
      expectedBytes: model.byteSize,
      downloadDirectoryName:
        LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY.downloadsDirectoryName,
    })),
    {
      resourceId: LOCAL_SUBTITLE_VAD_MANIFEST.vad.id,
      sourceUrl: LOCAL_SUBTITLE_VAD_MANIFEST.vad.downloadUrl,
      allowedHosts: LOCAL_SUBTITLE_VAD_MANIFEST.vad.allowedDownloadHosts,
      expectedBytes: LOCAL_SUBTITLE_VAD_MANIFEST.vad.byteSize,
      downloadDirectoryName:
        LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY.downloadsDirectoryName,
    },
  ];
  if (platform === "win32" && arch === "x64") {
    definitions.push({
      resourceId: LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.packId,
      sourceUrl: LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.sourceArchive.downloadUrl,
      allowedHosts:
        LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.sourceArchive.allowedDownloadHosts,
      expectedBytes:
        LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.sourceArchive.byteSize,
      downloadDirectoryName:
        LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY
          .acceleratorDownloadsDirectoryName,
    });
  }
  return Object.freeze(definitions);
}

function productionStagingDefinitions(
  platform: string,
  arch: string,
): readonly StagingRootDefinition[] {
  const modelPatterns = Object.freeze([
    ownedPattern(`\\.import-${UUID_SOURCE}-${MKDTEMP_SUFFIX_SOURCE}`),
    ownedPattern(`\\.cleanup-${UUID_SOURCE}`),
    ownedPattern(`\\.delete-${UUID_SOURCE}`),
    ownedPattern(`\\.startup-cleanup-${UUID_SOURCE}`),
  ]);
  const vadId = escapeRegExp(LOCAL_SUBTITLE_VAD_MANIFEST.vad.id);
  const definitions: StagingRootDefinition[] = [
    {
      directoryName:
        LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY.modelStagingDirectoryName,
      ownedLeafPatterns: modelPatterns,
    },
    {
      directoryName:
        LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY.vadStagingDirectoryName,
      ownedLeafPatterns: Object.freeze([
        ownedPattern(
          `\\.install-${vadId}-${UUID_SOURCE}-${MKDTEMP_SUFFIX_SOURCE}`,
        ),
        ownedPattern(`\\.cleanup-${UUID_SOURCE}`),
        ownedPattern(`\\.delete-${UUID_SOURCE}`),
        ownedPattern(`\\.startup-cleanup-${UUID_SOURCE}`),
      ]),
    },
  ];
  if (platform === "win32" && arch === "x64") {
    const packId = escapeRegExp(LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.packId);
    definitions.push({
      directoryName:
        LOCAL_SUBTITLE_RESOURCE_STARTUP_CLEANUP_POLICY
          .acceleratorStagingDirectoryName,
      ownedLeafPatterns: Object.freeze([
        ownedPattern(
          `\\.install-${packId}-${UUID_SOURCE}-${MKDTEMP_SUFFIX_SOURCE}`,
        ),
        ownedPattern(`\\.cleanup-${UUID_SOURCE}`),
        ownedPattern(`\\.delete-${UUID_SOURCE}`),
        ownedPattern(`\\.superseded-${packId}-${UUID_SOURCE}`),
        ownedPattern(`\\.startup-cleanup-${UUID_SOURCE}`),
      ]),
    });
  }
  return Object.freeze(definitions);
}

async function cleanMetadataTemporaries(
  managed: PrivateDirectoryProof,
  downloads: PrivateDirectoryProof,
  definitions: readonly LocalSubtitleStartupDownloadDefinition[],
  platform: string,
  onRemoved: () => void,
): Promise<void> {
  await verifyRootProofs(managed, [downloads], platform);
  const patterns = definitions.map((definition) =>
    ownedPattern(
      `${escapeRegExp(`${definition.resourceId}.part.json`)}\\.tmp-${UUID_SOURCE}`,
    ));
  const names = (await readdir(downloads.absolutePath)).sort();
  const results = await Promise.allSettled(names
    .filter((name) => patterns.some((pattern) => pattern.test(name)))
    .map(async (name) => {
      await verifyRootProofs(managed, [downloads], platform);
      const absolutePath = path.join(downloads.absolutePath, name);
      const receipt = ownedFileReceipt(absolutePath, await lstat(absolutePath));
      await unlinkOwnedFile(receipt);
      onRemoved();
    }));
  throwFirstFailure(results);
}

async function cleanStagingRoot(
  managed: PrivateDirectoryProof,
  staging: PrivateDirectoryProof,
  definition: StagingRootDefinition,
  platform: string,
  quarantineIdFactory: () => string,
  renameDirectory: (source: string, destination: string) => Promise<void>,
  removeDirectory: (absolutePath: string) => Promise<void>,
  onRemoved: () => void,
): Promise<void> {
  await verifyRootProofs(managed, [staging], platform);
  const names = (await readdir(staging.absolutePath)).sort();
  const results = await Promise.allSettled(names
    .filter((name) =>
      definition.ownedLeafPatterns.some((pattern) => pattern.test(name)))
    .map(async (name) => {
      await cleanupStagingDirectory(
        managed,
        staging,
        path.join(staging.absolutePath, name),
        platform,
        quarantineIdFactory,
        renameDirectory,
        removeDirectory,
      );
      onRemoved();
    }));
  throwFirstFailure(results);
}

async function cleanupStagingDirectory(
  managed: PrivateDirectoryProof,
  staging: PrivateDirectoryProof,
  candidate: string,
  platform: string,
  quarantineIdFactory: () => string,
  renameDirectory: (source: string, destination: string) => Promise<void>,
  removeDirectory: (absolutePath: string) => Promise<void>,
): Promise<void> {
  await verifyRootProofs(managed, [staging], platform);
  const before = await lstat(candidate);
  assertOwnedDirectory(before);
  const identity = directoryIdentity(before);
  const quarantine = path.join(
    staging.absolutePath,
    `.startup-cleanup-${validateUuid(quarantineIdFactory())}`,
  );
  if (await lstatOptional(quarantine)) {
    throw new Error("A local subtitle startup cleanup reservation already exists.");
  }
  await renameDirectory(candidate, quarantine);
  const after = await lstat(quarantine);
  assertOwnedDirectory(after);
  assertSameDirectory(identity, directoryIdentity(after));
  await verifyRootProofs(managed, [staging], platform);
  const quarantineRealPath = await realpath(quarantine);
  if (!isContainedPath(staging.realPath, quarantineRealPath)) {
    throw new Error("A local subtitle startup cleanup directory escaped its root.");
  }
  await removeDirectory(quarantine);
  if (await lstatOptional(quarantine)) {
    throw new Error("A local subtitle startup cleanup directory was not removed.");
  }
}

function downloadStateOptions(
  definition: LocalSubtitleStartupDownloadDefinition,
  downloadDirectory: string,
): ReconcileLocalSubtitleResourceDownloadStateOptions {
  return Object.freeze({
    sourceUrl: definition.sourceUrl,
    allowedHosts: definition.allowedHosts,
    expectedBytes: definition.expectedBytes,
    downloadDirectory,
    partFileName: `${definition.resourceId}.part`,
    metadataFileName: `${definition.resourceId}.part.json`,
  });
}

function validateDownloadDefinitions(
  definitions: readonly LocalSubtitleStartupDownloadDefinition[],
): readonly LocalSubtitleStartupDownloadDefinition[] {
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new TypeError("The local subtitle startup download catalog is invalid.");
  }
  const leaves = new Set<string>();
  return Object.freeze(definitions.map((definition) => {
    if (
      !definition ||
      !isSafeLeaf(definition.resourceId) ||
      !isSafeLeaf(definition.downloadDirectoryName) ||
      !Number.isSafeInteger(definition.expectedBytes) ||
      definition.expectedBytes <= 0 ||
      typeof definition.sourceUrl !== "string" ||
      !Array.isArray(definition.allowedHosts) ||
      definition.allowedHosts.length === 0
    ) {
      throw new TypeError("The local subtitle startup download catalog is invalid.");
    }
    const key = `${definition.downloadDirectoryName}/${definition.resourceId}`;
    if (leaves.has(key)) {
      throw new TypeError("The local subtitle startup download catalog is ambiguous.");
    }
    leaves.add(key);
    return Object.freeze({
      ...definition,
      allowedHosts: Object.freeze([...definition.allowedHosts]),
    });
  }));
}

function groupDownloadDefinitions(
  definitions: readonly LocalSubtitleStartupDownloadDefinition[],
): ReadonlyMap<string, readonly LocalSubtitleStartupDownloadDefinition[]> {
  const groups = new Map<string, LocalSubtitleStartupDownloadDefinition[]>();
  for (const definition of definitions) {
    const group = groups.get(definition.downloadDirectoryName) ?? [];
    group.push(definition);
    groups.set(definition.downloadDirectoryName, group);
  }
  return groups;
}

async function ensurePrivateDirectory(
  absolutePath: string,
  platform: string,
): Promise<PrivateDirectoryProof> {
  await mkdir(absolutePath, { recursive: true, mode: 0o700 });
  return readPrivateDirectoryProof(absolutePath, platform);
}

async function readPrivateDirectoryProof(
  absolutePath: string,
  platform: string,
): Promise<PrivateDirectoryProof> {
  const before = await lstat(absolutePath);
  assertPrivateDirectory(before, platform);
  const resolved = await realpath(absolutePath);
  const after = await lstat(absolutePath);
  assertPrivateDirectory(after, platform);
  assertSameDirectory(directoryIdentity(before), directoryIdentity(after));
  return Object.freeze({
    absolutePath,
    realPath: resolved,
    mode: after.mode & 0o777,
    ...directoryIdentity(after),
  });
}

async function verifyRootProofs(
  managed: PrivateDirectoryProof,
  children: readonly PrivateDirectoryProof[],
  platform: string,
): Promise<void> {
  const current = await Promise.all(
    [managed, ...children].map((proof) =>
      readPrivateDirectoryProof(proof.absolutePath, platform)),
  );
  for (let index = 0; index < current.length; index += 1) {
    const expected = index === 0 ? managed : children[index - 1]!;
    const actual = current[index]!;
    assertSameDirectory(expected, actual);
    if (
      expected.realPath !== actual.realPath ||
      (platform !== "win32" && expected.mode !== actual.mode)
    ) {
      throw new Error("A local subtitle startup cleanup root changed identity.");
    }
  }
  assertIndependentRoots(managed, children, platform);
}

function assertIndependentRoots(
  managed: PrivateDirectoryProof,
  children: readonly PrivateDirectoryProof[],
  platform: string,
): void {
  if (children.some((child) => !isContainedPath(managed.realPath, child.realPath))) {
    throw new Error("A local subtitle startup cleanup root escaped containment.");
  }
  const normalized = children.map((child) =>
    platform === "win32" ? child.realPath.toLowerCase() : child.realPath);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Local subtitle startup cleanup roots must be independent.");
  }
}

function ownedFileReceipt(absolutePath: string, stats: Stats): OwnedFileReceipt {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error("A local subtitle startup cleanup file is not owned.");
  }
  return Object.freeze({ absolutePath, ...directoryIdentity(stats) });
}

async function unlinkOwnedFile(receipt: OwnedFileReceipt): Promise<void> {
  const stats = await lstatOptional(receipt.absolutePath);
  if (!stats) return;
  const current = ownedFileReceipt(receipt.absolutePath, stats);
  assertSameDirectory(receipt, current);
  await unlink(receipt.absolutePath);
  if (await lstatOptional(receipt.absolutePath)) {
    throw new Error("A local subtitle startup cleanup file was not removed.");
  }
}

function directoryIdentity(
  stats: Pick<Stats, "dev" | "ino" | "birthtimeMs">,
): DirectoryIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  });
}

function assertSameDirectory(
  expected: DirectoryIdentity,
  actual: DirectoryIdentity,
): void {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.birthtimeMs !== actual.birthtimeMs
  ) {
    throw new Error("A local subtitle startup cleanup object changed identity.");
  }
}

function assertOwnedDirectory(stats: Stats): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("A local subtitle startup cleanup directory is not owned.");
  }
}

function assertPrivateDirectory(stats: Stats, platform: string): void {
  assertOwnedDirectory(stats);
  if (platform !== "win32" && (stats.mode & 0o777) !== 0o700) {
    throw new Error("A local subtitle startup cleanup directory is not private.");
  }
}

function throwFirstFailure(
  results: readonly PromiseSettledResult<unknown>[],
): void {
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

function resolvePrivateChild(root: string, leaf: string): string {
  if (!isSafeLeaf(leaf)) {
    throw new TypeError("The local subtitle startup cleanup root leaf is invalid.");
  }
  const candidate = path.resolve(root, leaf);
  if (path.dirname(candidate) !== path.resolve(root)) {
    throw new TypeError("The local subtitle startup cleanup root escaped.");
  }
  return candidate;
}

function validateAbsoluteRoot(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError("A host-absolute local subtitle cleanup root is required.");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError("The filesystem root cannot be a local subtitle cleanup root.");
  }
  return resolved;
}

function validateUuid(value: string): string {
  if (!new RegExp(`^${UUID_SOURCE}$`, "u").test(value)) {
    throw new TypeError("The local subtitle startup cleanup id is invalid.");
  }
  return value;
}

function ownedPattern(source: string): RegExp {
  return new RegExp(`^(?:${source})$`, "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isSafeLeaf(value: string): boolean {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/\0]/u.test(value) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(value);
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

async function lstatOptional(absolutePath: string): Promise<Stats | undefined> {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}
