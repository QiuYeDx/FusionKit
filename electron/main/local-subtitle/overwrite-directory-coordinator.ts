import { isProxy } from "node:util/types";
import type { LocalSubtitleOverwriteDirectoryIdentity } from "./overwrite-transaction";

const directoryTails = new Map<string, Promise<void>>();
const directoryFences = new Map<string, Set<string>>();

export class LocalSubtitleOverwriteDirectoryFencedError extends Error {
  readonly name = "LocalSubtitleOverwriteDirectoryFencedError";

  constructor() {
    super("The local subtitle output directory has a pending overwrite recovery.");
  }
}

export function localSubtitleOverwriteDirectoryKey(identity: {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
} | {
  readonly volumeSerialHex: string;
  readonly fileIdHex: string;
}): string {
  const snapshot = snapshotLocalSubtitleOverwriteDirectoryIdentity(identity);
  if (!snapshot) {
    throw new TypeError("The local subtitle overwrite directory identity is invalid.");
  }
  return "volumeSerialHex" in snapshot
    ? JSON.stringify([
        "win32",
        snapshot.volumeSerialHex,
        snapshot.fileIdHex,
      ])
    : JSON.stringify(["posix", snapshot.dev, snapshot.ino, snapshot.birthtimeMs]);
}

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

export function fenceLocalSubtitleOverwriteDirectory(
  key: string,
  recoveryId: string,
): void {
  const fences = directoryFences.get(key) ?? new Set<string>();
  fences.add(recoveryId);
  directoryFences.set(key, fences);
}

export function releaseLocalSubtitleOverwriteDirectoryFence(
  key: string,
  recoveryId: string,
): void {
  const fences = directoryFences.get(key);
  if (!fences) return;
  fences.delete(recoveryId);
  if (fences.size === 0) directoryFences.delete(key);
}

export async function withLocalSubtitleOverwriteDirectory<T>(
  key: string,
  operation: () => Promise<T> | T,
  options: { readonly recoveryId?: string } = {},
): Promise<T> {
  const previous = directoryTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  directoryTails.set(key, tail);
  await previous;
  try {
    const fences = directoryFences.get(key);
    if (
      fences &&
      [...fences].some((recoveryId) => recoveryId !== options.recoveryId)
    ) {
      throw new LocalSubtitleOverwriteDirectoryFencedError();
    }
    return await operation();
  } finally {
    release();
    if (directoryTails.get(key) === tail) directoryTails.delete(key);
  }
}

function ownDataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    !Object.is(value, -0);
}
