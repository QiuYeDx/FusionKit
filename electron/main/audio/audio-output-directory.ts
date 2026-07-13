import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createAudioRuntimeError } from "./audio-errors";

export const AUDIO_OUTPUT_DIRECTORY_AUTHORIZATION_TTL_MS = 30 * 60 * 1000;

export interface AuthorizedAudioOutputDirectory {
  outputDirToken: string;
  directoryName: string;
  expiresAt: number;
}

export interface AudioOutputDirectoryAuthorizationStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

interface AudioOutputDirectoryAuthorizationEntry
  extends AuthorizedAudioOutputDirectory {
  ownerId: number;
  directoryPath: string;
}

export class AudioOutputDirectoryAuthorizationStore {
  private readonly entries = new Map<
    string,
    AudioOutputDirectoryAuthorizationEntry
  >();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: AudioOutputDirectoryAuthorizationStoreOptions = {}) {
    this.ttlMs =
      options.ttlMs ?? AUDIO_OUTPUT_DIRECTORY_AUTHORIZATION_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async authorize(
    ownerId: number,
    directoryPath: string,
  ): Promise<AuthorizedAudioOutputDirectory> {
    this.removeExpired();
    await assertOutputDirectory(directoryPath, "outputDir");

    const outputDirToken = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    const entry: AudioOutputDirectoryAuthorizationEntry = {
      ownerId,
      outputDirToken,
      directoryPath,
      directoryName: getDirectoryName(directoryPath),
      expiresAt,
    };
    this.entries.set(outputDirToken, entry);

    return toPublicAuthorization(entry);
  }

  async resolve(ownerId: number, outputDirToken: string): Promise<string> {
    this.removeExpired();
    const entry = this.entries.get(outputDirToken);
    if (!entry || entry.ownerId !== ownerId) {
      throw invalidDirectoryAuthorization();
    }

    try {
      await assertOutputDirectory(entry.directoryPath, "outputDirToken");
    } catch {
      this.entries.delete(outputDirToken);
      throw unavailableOutputDirectory();
    }

    return entry.directoryPath;
  }

  revoke(ownerId: number, outputDirToken: string): void {
    const entry = this.entries.get(outputDirToken);
    if (entry?.ownerId === ownerId) this.entries.delete(outputDirToken);
  }

  releaseOwner(ownerId: number): void {
    for (const [token, entry] of this.entries) {
      if (entry.ownerId === ownerId) this.entries.delete(token);
    }
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
  }
}

async function assertOutputDirectory(
  directoryPath: string,
  field: "outputDir" | "outputDirToken",
): Promise<void> {
  let directoryStat;
  try {
    directoryStat = await stat(directoryPath);
  } catch {
    throw unavailableOutputDirectory(field);
  }
  if (!directoryStat.isDirectory()) throw unavailableOutputDirectory(field);
}

function invalidDirectoryAuthorization() {
  return createAudioRuntimeError({
    code: "invalid_ipc_request",
    message: "Audio output directory authorization is invalid or expired.",
    field: "outputDirToken",
  });
}

function unavailableOutputDirectory(
  field: "outputDir" | "outputDirToken" = "outputDirToken",
) {
  return createAudioRuntimeError({
    code: "output_write_failed",
    message: "The authorized audio output directory is unavailable.",
    field,
  });
}

function getDirectoryName(directoryPath: string): string {
  const normalizedPath = path.resolve(directoryPath);
  return path.basename(normalizedPath) || path.parse(normalizedPath).root;
}

function toPublicAuthorization(
  entry: AudioOutputDirectoryAuthorizationEntry,
): AuthorizedAudioOutputDirectory {
  return {
    outputDirToken: entry.outputDirToken,
    directoryName: entry.directoryName,
    expiresAt: entry.expiresAt,
  };
}
