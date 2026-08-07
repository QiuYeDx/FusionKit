import {
  lstatSync,
  type BigIntStats,
  type PathLike,
  type Stats,
} from "node:fs";
import {
  lstat,
  type FileHandle,
} from "node:fs/promises";
import {
  sameLocalSubtitleOverwriteDirectoryIdentity,
  snapshotLocalSubtitleOverwriteDirectoryIdentity,
} from "./overwrite-directory-coordinator";
import type {
  LocalSubtitleOverwriteFileIdentity,
  LocalSubtitleOverwritePosixIdentity,
  LocalSubtitleOverwriteWindowsIdentity,
} from "./overwrite-transaction";

export type LocalSubtitleFilesystemObjectIdentity =
  LocalSubtitleOverwriteFileIdentity;

export interface LocalSubtitleFileIdentity {
  readonly objectIdentity: LocalSubtitleFilesystemObjectIdentity;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export async function localSubtitleFilesystemObjectIdentityForPath(
  filePath: PathLike,
): Promise<LocalSubtitleFilesystemObjectIdentity> {
  return process.platform === "win32"
    ? localSubtitleWindowsObjectIdentityFromStats(
        await lstat(filePath, { bigint: true }),
      )
    : localSubtitlePosixObjectIdentityFromStats(await lstat(filePath));
}

export function localSubtitleFilesystemObjectIdentityForPathSync(
  filePath: PathLike,
): LocalSubtitleFilesystemObjectIdentity {
  return process.platform === "win32"
    ? localSubtitleWindowsObjectIdentityFromStats(
        lstatSync(filePath, { bigint: true }),
      )
    : localSubtitlePosixObjectIdentityFromStats(lstatSync(filePath));
}

export async function localSubtitleFilesystemObjectIdentityForHandle(
  handle: FileHandle,
): Promise<LocalSubtitleFilesystemObjectIdentity> {
  return process.platform === "win32"
    ? localSubtitleWindowsObjectIdentityFromStats(
        await handle.stat({ bigint: true }),
      )
    : localSubtitlePosixObjectIdentityFromStats(await handle.stat());
}

export async function localSubtitleFileIdentityForPath(
  filePath: PathLike,
): Promise<LocalSubtitleFileIdentity> {
  return localSubtitleFileIdentityFromBigIntStats(
    await lstat(filePath, { bigint: true }),
  );
}

export function localSubtitleFileIdentityForPathSync(
  filePath: PathLike,
): LocalSubtitleFileIdentity {
  return localSubtitleFileIdentityFromBigIntStats(
    lstatSync(filePath, { bigint: true }),
  );
}

export async function localSubtitleFileIdentityForHandle(
  handle: FileHandle,
): Promise<LocalSubtitleFileIdentity> {
  return localSubtitleFileIdentityFromBigIntStats(
    await handle.stat({ bigint: true }),
  );
}

export function localSubtitleFileIdentityFromBigIntStats(
  value: Pick<
    BigIntStats,
    "dev" | "ino" | "size" | "birthtimeNs" | "mtimeNs" | "ctimeNs"
  >,
  platform: NodeJS.Platform | string = process.platform,
): LocalSubtitleFileIdentity {
  const objectIdentity = platform === "win32"
    ? localSubtitleWindowsObjectIdentityFromStats(value)
    : localSubtitlePosixObjectIdentityFromStats({
        dev: safeIntegerFromBigInt(value.dev),
        ino: safeIntegerFromBigInt(value.ino),
        birthtimeMs: millisecondsFromNanoseconds(value.birthtimeNs),
      });
  const identity = snapshotLocalSubtitleFileIdentity({
    objectIdentity,
    size: safeIntegerFromBigInt(value.size),
    mtimeMs: millisecondsFromNanoseconds(value.mtimeNs),
    ctimeMs: millisecondsFromNanoseconds(value.ctimeNs),
  });
  if (!identity) {
    throw new TypeError("The filesystem file identity is invalid.");
  }
  return identity;
}

export function snapshotLocalSubtitleFileIdentity(
  value: unknown,
): LocalSubtitleFileIdentity | undefined {
  if (!isExactRecord(value, ["objectIdentity", "size", "mtimeMs", "ctimeMs"])) {
    return undefined;
  }
  const objectIdentity = snapshotLocalSubtitleFilesystemObjectIdentity(
    value.objectIdentity,
  );
  if (
    !objectIdentity ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    !isNonNegativeFiniteNumber(value.mtimeMs) ||
    !isNonNegativeFiniteNumber(value.ctimeMs)
  ) {
    return undefined;
  }
  return Object.freeze({
    objectIdentity,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  });
}

export function sameLocalSubtitleFileIdentity(
  left: LocalSubtitleFileIdentity,
  right: LocalSubtitleFileIdentity,
): boolean {
  return (
    sameLocalSubtitleFilesystemObjectIdentity(
      left.objectIdentity,
      right.objectIdentity,
    ) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function localSubtitlePosixObjectIdentityFromStats(
  value: Pick<Stats, "dev" | "ino" | "birthtimeMs">,
): LocalSubtitleOverwritePosixIdentity {
  const identity = snapshotLocalSubtitleOverwriteDirectoryIdentity({
    dev: value.dev,
    ino: value.ino,
    birthtimeMs: value.birthtimeMs,
  });
  if (!identity || !("dev" in identity)) {
    throw new TypeError("The POSIX filesystem object identity is invalid.");
  }
  return identity;
}

export function localSubtitleWindowsObjectIdentityFromStats(
  value: Pick<BigIntStats, "dev" | "ino">,
): LocalSubtitleOverwriteWindowsIdentity {
  const identity = snapshotLocalSubtitleOverwriteDirectoryIdentity({
    volumeSerialHex: fixedWidthHex(value.dev, 8),
    fileIdHex: fixedWidthHex(value.ino, 32),
  });
  if (!identity || !("volumeSerialHex" in identity)) {
    throw new TypeError("The Windows filesystem object identity is invalid.");
  }
  return identity;
}

export function snapshotLocalSubtitleFilesystemObjectIdentity(
  value: unknown,
): LocalSubtitleFilesystemObjectIdentity | undefined {
  return snapshotLocalSubtitleOverwriteDirectoryIdentity(value);
}

export function sameLocalSubtitleFilesystemObjectIdentity(
  left: LocalSubtitleFilesystemObjectIdentity,
  right: LocalSubtitleFilesystemObjectIdentity,
): boolean {
  return sameLocalSubtitleOverwriteDirectoryIdentity(left, right);
}

function fixedWidthHex(value: bigint, width: number): string {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError("The Windows filesystem identity component is invalid.");
  }
  const hex = value.toString(16);
  if (hex.length > width) {
    throw new TypeError("The Windows filesystem identity component is invalid.");
  }
  return hex.padStart(width, "0");
}

function safeIntegerFromBigInt(value: bigint): number {
  if (typeof value !== "bigint") {
    throw new TypeError("The filesystem integer field is invalid.");
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || BigInt(result) !== value) {
    throw new TypeError("The filesystem integer field exceeds the safe range.");
  }
  return result;
}

function millisecondsFromNanoseconds(value: bigint): number {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError("The filesystem timestamp field is invalid.");
  }
  const result = Number(value) / 1_000_000;
  if (!Number.isFinite(result) || result < 0) {
    throw new TypeError("The filesystem timestamp field is invalid.");
  }
  return result;
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === "string" && keys.includes(key));
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
