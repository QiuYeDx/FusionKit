import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AudioOutputDirectoryAuthorizationStore,
} from "../../electron/main/audio/audio-output-directory";
import type { AudioRuntimeClientError } from "../../electron/main/audio/audio-errors";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-audio-output-directory-test-"),
  );
  tempRoots.push(tempRoot);
  return tempRoot;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) =>
      rm(tempRoot, { recursive: true, force: true }),
    ),
  );
});

describe("AudioOutputDirectoryAuthorizationStore", () => {
  it("returns only a token, display name, and expiry while resolving internally", async () => {
    const tempRoot = await createTempRoot();
    const directoryPath = path.join(tempRoot, "exports");
    await mkdir(directoryPath);
    const now = 1_000;
    const store = new AudioOutputDirectoryAuthorizationStore({
      ttlMs: 500,
      now: () => now,
    });

    const authorization = await store.authorize(7, directoryPath);

    expect(Object.keys(authorization).sort()).toEqual([
      "directoryName",
      "expiresAt",
      "outputDirToken",
    ]);
    expect(authorization).toMatchObject({
      directoryName: "exports",
      expiresAt: 1_500,
    });
    expect(authorization.outputDirToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.stringify(authorization)).not.toContain(directoryPath);
    await expect(store.resolve(7, authorization.outputDirToken)).resolves.toBe(
      directoryPath,
    );
  });

  it("keeps authorizations scoped to their owner without invalidating another owner", async () => {
    const directoryPath = await createTempRoot();
    const store = new AudioOutputDirectoryAuthorizationStore();
    const authorization = await store.authorize(11, directoryPath);

    const error = await captureError(
      store.resolve(12, authorization.outputDirToken),
    );

    expectAuthorizationError(error, "invalid_ipc_request", directoryPath);
    await expect(store.resolve(11, authorization.outputDirToken)).resolves.toBe(
      directoryPath,
    );
  });

  it("expires tokens at the configured TTL boundary", async () => {
    const directoryPath = await createTempRoot();
    let now = 2_000;
    const store = new AudioOutputDirectoryAuthorizationStore({
      ttlMs: 100,
      now: () => now,
    });
    const authorization = await store.authorize(21, directoryPath);

    now = 2_099;
    await expect(store.resolve(21, authorization.outputDirToken)).resolves.toBe(
      directoryPath,
    );

    now = 2_100;
    const error = await captureError(
      store.resolve(21, authorization.outputDirToken),
    );
    expectAuthorizationError(error, "invalid_ipc_request", directoryPath);
  });

  it("releases only the selected owner's authorizations", async () => {
    const firstDirectory = path.join(await createTempRoot(), "first");
    const secondDirectory = path.join(await createTempRoot(), "second");
    await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
    const store = new AudioOutputDirectoryAuthorizationStore();
    const first = await store.authorize(31, firstDirectory);
    const second = await store.authorize(32, secondDirectory);

    store.releaseOwner(31);

    const error = await captureError(store.resolve(31, first.outputDirToken));
    expectAuthorizationError(error, "invalid_ipc_request", firstDirectory);
    await expect(store.resolve(32, second.outputDirToken)).resolves.toBe(
      secondDirectory,
    );
  });

  it("revokes only the requested token for its legitimate owner", async () => {
    const firstDirectory = path.join(await createTempRoot(), "first");
    const secondDirectory = path.join(await createTempRoot(), "second");
    await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
    const store = new AudioOutputDirectoryAuthorizationStore();
    const first = await store.authorize(33, firstDirectory);
    const second = await store.authorize(33, secondDirectory);

    store.revoke(34, first.outputDirToken);
    await expect(store.resolve(33, first.outputDirToken)).resolves.toBe(
      firstDirectory,
    );
    store.revoke(33, first.outputDirToken);

    await expect(store.resolve(33, first.outputDirToken)).rejects.toMatchObject({
      code: "invalid_ipc_request",
    });
    await expect(store.resolve(33, second.outputDirToken)).resolves.toBe(
      secondDirectory,
    );
  });

  it("rejects missing paths and files without exposing their paths", async () => {
    const tempRoot = await createTempRoot();
    const filePath = path.join(tempRoot, "not-a-directory.txt");
    const missingPath = path.join(tempRoot, "missing");
    await writeFile(filePath, "content");
    const store = new AudioOutputDirectoryAuthorizationStore();

    const fileError = await captureError(store.authorize(41, filePath));
    expectAuthorizationError(fileError, "output_write_failed", filePath);
    expect(fileError.field).toBe("outputDir");

    const missingError = await captureError(store.authorize(41, missingPath));
    expectAuthorizationError(missingError, "output_write_failed", missingPath);
    expect(missingError.field).toBe("outputDir");
  });

  it("revalidates the directory on resolve and revokes a changed target", async () => {
    const tempRoot = await createTempRoot();
    const directoryPath = path.join(tempRoot, "exports");
    await mkdir(directoryPath);
    const store = new AudioOutputDirectoryAuthorizationStore();
    const authorization = await store.authorize(51, directoryPath);

    await rm(directoryPath, { recursive: true });
    await writeFile(directoryPath, "replacement file");

    const changedError = await captureError(
      store.resolve(51, authorization.outputDirToken),
    );
    expectAuthorizationError(changedError, "output_write_failed", directoryPath);
    expect(changedError.field).toBe("outputDirToken");

    await rm(directoryPath);
    await mkdir(directoryPath);
    const revokedError = await captureError(
      store.resolve(51, authorization.outputDirToken),
    );
    expectAuthorizationError(revokedError, "invalid_ipc_request", directoryPath);
  });
});

async function captureError(
  promise: Promise<unknown>,
): Promise<AudioRuntimeClientError> {
  try {
    await promise;
  } catch (error) {
    return error as AudioRuntimeClientError;
  }
  throw new Error("Expected promise to reject.");
}

function expectAuthorizationError(
  error: AudioRuntimeClientError,
  code: "invalid_ipc_request" | "output_write_failed",
  sensitivePath: string,
): void {
  expect(error).toMatchObject({ code });
  expect(error.details).toBeUndefined();
  expect(error.message).not.toContain(sensitivePath);
  expect(JSON.stringify(error)).not.toContain(sensitivePath);
}
