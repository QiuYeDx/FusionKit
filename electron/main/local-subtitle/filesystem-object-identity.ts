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
