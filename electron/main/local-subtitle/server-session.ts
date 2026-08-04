import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import type { LocalSubtitleErrorCode } from "@/type/localSubtitle";

const SERVER_SESSION_BRAND: unique symbol = Symbol(
  "fusionkit.local-subtitle.server-session",
);
const PRIVATE_DIRECTORY_MODE = 0o700;
const SESSION_PREFIX = "server-";
const CLEANUP_MARKER = ".cleanup-";
const CLEANUP_SUFFIX_PATTERN = /^[a-f0-9]{32}$/u;
const REMOVED_SESSIONS = new WeakSet<LocalSubtitleServerSession>();

export const LOCAL_SUBTITLE_SERVER_SESSION_POLICY = Object.freeze({
  managedTempLeaf: "temp",
  publicLeaf: "public",
  temporaryLeaf: "tmp",
  sessionPrefix: SESSION_PREFIX,
  privateDirectoryMode: PRIVATE_DIRECTORY_MODE,
  cleanupMaxRetries: 5,
  cleanupRetryDelayMs: 200,
} as const);

export type LocalSubtitleServerSessionErrorCode =
  | "invalid_configuration"
  | "session_identity_mismatch"
  | "session_cleanup_failed";

export class LocalSubtitleServerSessionError extends Error {
  readonly code: LocalSubtitleServerSessionErrorCode;
  readonly localSubtitleCode: LocalSubtitleErrorCode;

  constructor(
    code: LocalSubtitleServerSessionErrorCode,
    message: string,
    options: {
      readonly localSubtitleCode: LocalSubtitleErrorCode;
      readonly cause?: unknown;
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "LocalSubtitleServerSessionError";
    this.code = code;
    this.localSubtitleCode = options.localSubtitleCode;
  }
}

interface LocalSubtitleDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
  readonly mode: number;
  readonly realPath: string;
}

export interface LocalSubtitleServerSession {
  readonly [SERVER_SESSION_BRAND]: true;
  readonly managedResourceRoot: string;
  readonly baseRoot: string;
  readonly root: string;
  readonly publicDirectory: string;
  readonly temporaryDirectory: string;
  readonly identities: Readonly<{
    managedResourceRoot: LocalSubtitleDirectoryIdentity;
    baseRoot: LocalSubtitleDirectoryIdentity;
    root: LocalSubtitleDirectoryIdentity;
    publicDirectory: LocalSubtitleDirectoryIdentity;
    temporaryDirectory: LocalSubtitleDirectoryIdentity;
  }>;
}

export async function createLocalSubtitleServerSession(
  managedResourceRoot: string,
): Promise<LocalSubtitleServerSession> {
  assertAbsoluteNormalizedNonRoot(managedResourceRoot, "managed resource root");
  await ensurePrivateDirectory(managedResourceRoot, true);
  const managedStat = await requirePrivateDirectory(
    managedResourceRoot,
    "managed resource root",
  );
  const managedRealPath = await realpath(managedResourceRoot);

  const baseRoot = path.join(
    managedResourceRoot,
    LOCAL_SUBTITLE_SERVER_SESSION_POLICY.managedTempLeaf,
  );
  await ensurePrivateDirectory(baseRoot, false);
  const baseStat = await requirePrivateDirectory(baseRoot, "server temp root");
  const baseRealPath = await realpath(baseRoot);
  if (!isStrictlyWithin(managedRealPath, baseRealPath)) {
    throw sessionIdentityError(
      "The server temp root is outside the managed resource root.",
    );
  }

  let root: string | undefined;
  let rootIdentity: LocalSubtitleDirectoryIdentity | undefined;
  try {
    root = await mkdtemp(path.join(baseRoot, SESSION_PREFIX));
    rootIdentity = toIdentity(
      await requirePrivateDirectory(root, "server session root"),
      await realpath(root),
    );
    const publicDirectory = path.join(
      root,
      LOCAL_SUBTITLE_SERVER_SESSION_POLICY.publicLeaf,
    );
    const temporaryDirectory = path.join(
      root,
      LOCAL_SUBTITLE_SERVER_SESSION_POLICY.temporaryLeaf,
    );
    await Promise.all([
      mkdir(publicDirectory, { mode: PRIVATE_DIRECTORY_MODE }),
      mkdir(temporaryDirectory, { mode: PRIVATE_DIRECTORY_MODE }),
    ]);

    const [rootStat, publicStat, temporaryStat] = await Promise.all([
      requirePrivateDirectory(root, "server session root"),
      requirePrivateDirectory(publicDirectory, "server public directory"),
      requirePrivateDirectory(
        temporaryDirectory,
        "server temporary directory",
      ),
    ]);
    const [rootRealPath, publicRealPath, temporaryRealPath] = await Promise.all([
      realpath(root),
      realpath(publicDirectory),
      realpath(temporaryDirectory),
    ]);
    if (
      !sameIdentity(rootStat, rootIdentity) ||
      rootRealPath !== rootIdentity.realPath
    ) {
      throw sessionIdentityError("The server session root identity changed.");
    }

    const session = createBrandedSession({
      managedResourceRoot,
      baseRoot,
      root,
      publicDirectory,
      temporaryDirectory,
      identities: {
        managedResourceRoot: toIdentity(managedStat, managedRealPath),
        baseRoot: toIdentity(baseStat, baseRealPath),
        root: rootIdentity,
        publicDirectory: toIdentity(publicStat, publicRealPath),
        temporaryDirectory: toIdentity(temporaryStat, temporaryRealPath),
      },
    });
    await verifyLocalSubtitleServerSession(session, { requireEmpty: true });
    return session;
  } catch (error) {
    if (root && rootIdentity) {
      await quarantineOwnedDirectory(
        baseRealPath,
        root,
        rootIdentity,
      ).catch(() => undefined);
    }
    if (error instanceof LocalSubtitleServerSessionError) throw error;
    throw new LocalSubtitleServerSessionError(
      "invalid_configuration",
      "The private local inference session could not be created.",
      { localSubtitleCode: "runtime_unresponsive", cause: error },
    );
  }
}

export async function verifyLocalSubtitleServerSession(
  session: LocalSubtitleServerSession,
  options: { readonly requireEmpty?: boolean } = {},
): Promise<void> {
  assertBrandedSession(session);
  const records = [
    [
      session.managedResourceRoot,
      session.identities.managedResourceRoot,
      "managed resource root",
    ],
    [session.baseRoot, session.identities.baseRoot, "server temp root"],
    [session.root, session.identities.root, "server session root"],
    [
      session.publicDirectory,
      session.identities.publicDirectory,
      "server public directory",
    ],
    [
      session.temporaryDirectory,
      session.identities.temporaryDirectory,
      "server temporary directory",
    ],
  ] as const;

  for (const [candidate, identity, label] of records) {
    const stat = await requirePrivateDirectory(candidate, label);
    const resolved = await realpath(candidate);
    if (!sameIdentity(stat, identity) || resolved !== identity.realPath) {
      throw sessionIdentityError(`The ${label} identity changed.`);
    }
  }

  if (
    !isStrictlyWithin(
      session.identities.managedResourceRoot.realPath,
      session.identities.baseRoot.realPath,
    ) ||
    !isStrictlyWithin(
      session.identities.baseRoot.realPath,
      session.identities.root.realPath,
    ) ||
    !isStrictlyWithin(
      session.identities.root.realPath,
      session.identities.publicDirectory.realPath,
    ) ||
    !isStrictlyWithin(
      session.identities.root.realPath,
      session.identities.temporaryDirectory.realPath,
    )
  ) {
    throw sessionIdentityError("The server session containment changed.");
  }

  const rootEntries = (await readdir(session.root)).sort();
  if (
    rootEntries.length !== 2 ||
    rootEntries[0] !== LOCAL_SUBTITLE_SERVER_SESSION_POLICY.publicLeaf ||
    rootEntries[1] !== LOCAL_SUBTITLE_SERVER_SESSION_POLICY.temporaryLeaf
  ) {
    throw sessionIdentityError("The server session root contains unknown entries.");
  }
  if (options.requireEmpty) {
    const [publicEntries, temporaryEntries] = await Promise.all([
      readdir(session.publicDirectory),
      readdir(session.temporaryDirectory),
    ]);
    if (publicEntries.length > 0 || temporaryEntries.length > 0) {
      throw sessionIdentityError(
        "The server public and temporary directories must start empty.",
      );
    }
  }
}

export async function cleanupLocalSubtitleServerSession(
  session: LocalSubtitleServerSession,
): Promise<{ readonly removed: boolean }> {
  assertBrandedSession(session);
  if (REMOVED_SESSIONS.has(session)) {
    return Object.freeze({ removed: false });
  }
  const current = await lstat(session.root).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );

  try {
    if (!current) {
      const removed = await cleanupQuarantinedSession(session);
      if (!removed) {
        throw sessionIdentityError(
          "The owned server session path disappeared before cleanup.",
        );
      }
      REMOVED_SESSIONS.add(session);
      return Object.freeze({ removed });
    }
    await verifyLocalSubtitleServerSession(session);
    const removed = await quarantineOwnedDirectory(
      session.identities.baseRoot.realPath,
      session.root,
      session.identities.root,
    );
    if (!removed) {
      throw sessionIdentityError(
        "The server session was not quarantined for cleanup.",
      );
    }
    REMOVED_SESSIONS.add(session);
    return Object.freeze({ removed });
  } catch (error) {
    if (error instanceof LocalSubtitleServerSessionError) throw error;
    throw new LocalSubtitleServerSessionError(
      "session_cleanup_failed",
      "The private local inference session could not be removed safely.",
      { localSubtitleCode: "runtime_unresponsive", cause: error },
    );
  }
}

async function cleanupQuarantinedSession(
  session: LocalSubtitleServerSession,
): Promise<boolean> {
  const baseStat = await requirePrivateDirectory(
    session.baseRoot,
    "server temp root",
  );
  const baseRealPath = await realpath(session.baseRoot);
  if (
    !sameIdentity(baseStat, session.identities.baseRoot) ||
    baseRealPath !== session.identities.baseRoot.realPath
  ) {
    throw sessionIdentityError("The server temp root identity changed.");
  }

  const quarantinePrefix = `${path.basename(session.root)}${CLEANUP_MARKER}`;
  const candidates = (await readdir(session.baseRoot)).filter((entry) => {
    if (!entry.startsWith(quarantinePrefix)) return false;
    return CLEANUP_SUFFIX_PATTERN.test(entry.slice(quarantinePrefix.length));
  });
  for (const entry of candidates) {
    const candidate = path.join(session.baseRoot, entry);
    const candidateStat = await lstat(candidate).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!candidateStat || !sameIdentity(candidateStat, session.identities.root)) {
      continue;
    }
    const candidateRealPath = await realpath(candidate);
    if (!isStrictlyWithin(baseRealPath, candidateRealPath)) {
      throw sessionIdentityError(
        "The quarantined server session containment changed.",
      );
    }
    await removeSessionDirectory(candidate);
    return true;
  }
  return false;
}

export function isLocalSubtitleServerSession(
  input: unknown,
): input is LocalSubtitleServerSession {
  return (
    typeof input === "object" &&
    input !== null &&
    Object.isFrozen(input) &&
    (input as { readonly [SERVER_SESSION_BRAND]?: unknown })[
      SERVER_SESSION_BRAND
    ] === true
  );
}

function createBrandedSession(
  value: Omit<LocalSubtitleServerSession, typeof SERVER_SESSION_BRAND>,
): LocalSubtitleServerSession {
  const identities = Object.freeze({
    managedResourceRoot: Object.freeze(value.identities.managedResourceRoot),
    baseRoot: Object.freeze(value.identities.baseRoot),
    root: Object.freeze(value.identities.root),
    publicDirectory: Object.freeze(value.identities.publicDirectory),
    temporaryDirectory: Object.freeze(value.identities.temporaryDirectory),
  });
  const session = { ...value, identities };
  Object.defineProperty(session, SERVER_SESSION_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(session) as LocalSubtitleServerSession;
}

function assertBrandedSession(
  session: LocalSubtitleServerSession,
): asserts session is LocalSubtitleServerSession {
  if (!isLocalSubtitleServerSession(session)) {
    throw new LocalSubtitleServerSessionError(
      "invalid_configuration",
      "The local inference session proof is invalid.",
      { localSubtitleCode: "runtime_protocol_mismatch" },
    );
  }
}

async function ensurePrivateDirectory(
  candidate: string,
  recursive: boolean,
): Promise<void> {
  try {
    await mkdir(candidate, { recursive, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await requirePrivateDirectory(candidate, "local inference directory");
}

async function requirePrivateDirectory(
  candidate: string,
  label: string,
): Promise<Stats> {
  let stat: Stats;
  try {
    stat = await lstat(candidate);
  } catch (error) {
    throw sessionIdentityError(`The ${label} is unavailable.`, error);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw sessionIdentityError(`The ${label} must be a private directory.`);
  }
  if (
    process.platform !== "win32" &&
    (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw sessionIdentityError(`The ${label} permissions must be mode 0700.`);
  }
  return stat;
}

function toIdentity(
  stat: Stats,
  realPath: string,
): LocalSubtitleDirectoryIdentity {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    mode: stat.mode & 0o777,
    realPath,
  });
}

function sameIdentity(
  stat: Stats,
  identity: LocalSubtitleDirectoryIdentity,
): boolean {
  return (
    stat.dev === identity.dev &&
    stat.ino === identity.ino &&
    stat.birthtimeMs === identity.birthtimeMs &&
    (process.platform === "win32" || (stat.mode & 0o777) === identity.mode)
  );
}

function assertAbsoluteNormalizedNonRoot(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new LocalSubtitleServerSessionError(
      "invalid_configuration",
      `The ${label} is invalid.`,
      { localSubtitleCode: "runtime_protocol_mismatch" },
    );
  }
}

function isStrictlyWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function quarantineOwnedDirectory(
  baseRealPath: string,
  root: string,
  identity: LocalSubtitleDirectoryIdentity,
): Promise<boolean> {
  const current = await lstat(root).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (!current) {
    throw sessionIdentityError(
      "The server session disappeared before quarantine.",
    );
  }
  const currentRealPath = await realpath(root);
  if (
    !sameIdentity(current, identity) ||
    currentRealPath !== identity.realPath ||
    !isStrictlyWithin(baseRealPath, currentRealPath)
  ) {
    throw sessionIdentityError("The server session cleanup identity changed.");
  }

  const quarantinePath = `${root}${CLEANUP_MARKER}${randomBytes(16).toString(
    "hex",
  )}`;
  await rename(root, quarantinePath);
  const [quarantineStat, quarantineRealPath] = await Promise.all([
    lstat(quarantinePath),
    realpath(quarantinePath),
  ]);
  if (
    !sameIdentity(quarantineStat, identity) ||
    !isStrictlyWithin(baseRealPath, quarantineRealPath)
  ) {
    throw sessionIdentityError(
      "The quarantined server session identity is invalid.",
    );
  }
  await removeSessionDirectory(quarantinePath);
  return true;
}

function removeSessionDirectory(absolutePath: string): Promise<void> {
  return rm(absolutePath, {
    recursive: true,
    force: false,
    maxRetries: LOCAL_SUBTITLE_SERVER_SESSION_POLICY.cleanupMaxRetries,
    retryDelay: LOCAL_SUBTITLE_SERVER_SESSION_POLICY.cleanupRetryDelayMs,
  });
}

function sessionIdentityError(
  message: string,
  cause?: unknown,
): LocalSubtitleServerSessionError {
  return new LocalSubtitleServerSessionError(
    "session_identity_mismatch",
    message,
    {
      localSubtitleCode: "runtime_protocol_mismatch",
      ...(cause === undefined ? {} : { cause }),
    },
  );
}
