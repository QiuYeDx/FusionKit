export interface LocalSubtitleOverwritePosixIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

export interface LocalSubtitleOverwriteWindowsIdentity {
  readonly volumeSerialHex: string;
  readonly fileIdHex: string;
}

export type LocalSubtitleOverwriteDirectoryIdentity =
  | LocalSubtitleOverwritePosixIdentity
  | LocalSubtitleOverwriteWindowsIdentity;

export type LocalSubtitleOverwriteFileIdentity =
  LocalSubtitleOverwriteDirectoryIdentity;

import { isProxy } from "node:util/types";
export function snapshotLocalSubtitleOverwriteDirectoryIdentity(
  value: unknown,
): LocalSubtitleOverwriteDirectoryIdentity | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value)
  ) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length === 2 &&
    ["volumeSerialHex", "fileIdHex"].every((key) =>
      keys.includes(key)
    )
  ) {
    const volumeSerialHex = ownDataValue(value, "volumeSerialHex");
    const fileIdHex = ownDataValue(value, "fileIdHex");
    if (
      typeof volumeSerialHex !== "string" ||
      !/^[0-9a-f]{8}$/u.test(volumeSerialHex) ||
      typeof fileIdHex !== "string" ||
      !/^[0-9a-f]{32}$/u.test(fileIdHex)
    ) {
      return undefined;
    }
    return Object.freeze({ volumeSerialHex, fileIdHex });
  }
  if (
    keys.length !== 3 ||
    !["dev", "ino", "birthtimeMs"].every((key) => keys.includes(key))
  ) {
    return undefined;
  }
  const dev = ownDataValue(value, "dev");
  const ino = ownDataValue(value, "ino");
  const birthtimeMs = ownDataValue(value, "birthtimeMs");
  if (
    !isNonNegativeSafeInteger(dev) ||
    !isNonNegativeSafeInteger(ino) ||
    typeof birthtimeMs !== "number" ||
    !Number.isFinite(birthtimeMs) ||
    birthtimeMs < 0 ||
    Object.is(birthtimeMs, -0)
  ) {
    return undefined;
  }
  return Object.freeze({ dev, ino, birthtimeMs });
}

export function sameLocalSubtitleOverwriteDirectoryIdentity(
  left: LocalSubtitleOverwriteDirectoryIdentity,
  right: LocalSubtitleOverwriteDirectoryIdentity,
): boolean {
  if ("volumeSerialHex" in left || "volumeSerialHex" in right) {
    return "volumeSerialHex" in left &&
      "volumeSerialHex" in right &&
      left.volumeSerialHex === right.volumeSerialHex &&
      left.fileIdHex === right.fileIdHex;
  }
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs;
}

function ownDataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    !Object.is(value, -0);
}
