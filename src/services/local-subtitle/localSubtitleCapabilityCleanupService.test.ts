import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalSubtitleError } from "@/type/localSubtitle";
import type {
  LocalSubtitleIpcResult,
  LocalSubtitleRendererApi,
} from "@/type/localSubtitleIpc";
import { LocalSubtitleCapabilityCleanupService } from "./localSubtitleCapabilityCleanupService";

type RevokeResult = LocalSubtitleIpcResult<{ revoked: boolean }>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("local subtitle capability cleanup service", () => {
  it("settles both revoked true and idempotent revoked false", async () => {
    const fake = createFakeApi();
    fake.revokeInputFile.mockResolvedValue({
      ok: true,
      data: { revoked: false },
    });
    fake.revokeOutputDirectory.mockResolvedValue({
      ok: true,
      data: { revoked: true },
    });
    const service = createService(fake.api);

    service.queueInputDraftRevocation({ fileToken: "same", expiresAt: 5_000 });
    service.queueOutputDraftRevocation({
      outputDirToken: "same",
      expiresAt: 5_000,
    });
    await service.flushPendingDraftRevocations();

    expect(fake.revokeInputFile).toHaveBeenCalledWith("same");
    expect(fake.revokeOutputDirectory).toHaveBeenCalledWith("same");
    expect(service.pendingCount).toBe(0);
    service.reset();
  });

  it("retries resolved failures and rejected promises", async () => {
    const fake = createFakeApi();
    fake.revokeInputFile
      .mockResolvedValueOnce({
        ok: false,
        error: createLocalSubtitleError(
          "invalid_ipc_request",
          "temporary transport failure",
        ),
      })
      .mockResolvedValueOnce({ ok: true, data: { revoked: true } });
    fake.revokeOutputDirectory
      .mockRejectedValueOnce(new Error("preload unavailable"))
      .mockResolvedValueOnce({ ok: true, data: { revoked: false } });
    const service = createService(fake.api);

    service.queueInputDraftRevocation({ fileToken: "input", expiresAt: 5_000 });
    service.queueOutputDraftRevocation({
      outputDirToken: "output",
      expiresAt: 5_000,
    });
    await service.flushPendingDraftRevocations();
    expect(service.pendingCount).toBe(2);

    await vi.advanceTimersByTimeAsync(100);

    expect(fake.revokeInputFile).toHaveBeenCalledTimes(2);
    expect(fake.revokeOutputDirectory).toHaveBeenCalledTimes(2);
    expect(service.pendingCount).toBe(0);
    service.reset();
  });

  it.each(["owner_released", "authorization_expired"] as const)(
    "treats %s as terminal cleanup",
    async (code) => {
      const fake = createFakeApi();
      fake.revokeInputFile.mockResolvedValue({
        ok: false,
        error: createLocalSubtitleError(code, "authority already ended"),
      });
      const service = createService(fake.api);

      service.queueInputDraftRevocation({ fileToken: code, expiresAt: 5_000 });
      await service.flushPendingDraftRevocations();

      expect(service.pendingCount).toBe(0);
      service.reset();
    },
  );

  it("does not invoke main at or after the authoritative expiry", async () => {
    const fake = createFakeApi();
    const service = createService(fake.api);

    service.queueInputDraftRevocation({ fileToken: "expired", expiresAt: 1_000 });
    await service.flushPendingDraftRevocations();

    expect(fake.revokeInputFile).not.toHaveBeenCalled();
    expect(service.pendingCount).toBe(0);
    service.reset();
  });

  it("keeps the earliest expiry when a token is queued twice", async () => {
    const fake = createFakeApi();
    fake.revokeInputFile.mockResolvedValue({
      ok: false,
      error: createLocalSubtitleError(
        "invalid_ipc_request",
        "temporary transport failure",
      ),
    });
    const service = createService(fake.api);

    service.queueInputDraftRevocation({ fileToken: "input", expiresAt: 1_200 });
    await service.flushPendingDraftRevocations();
    service.queueInputDraftRevocation({ fileToken: "input", expiresAt: 5_000 });
    await service.flushPendingDraftRevocations();

    await vi.advanceTimersByTimeAsync(200);
    expect(service.pendingCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.pendingCount).toBe(0);
    service.reset();
  });

  it("times out a hung revoke and retries while the TTL remains", async () => {
    const fake = createFakeApi();
    fake.revokeInputFile.mockImplementation(
      () => new Promise<RevokeResult>(() => undefined),
    );
    const service = createService(fake.api);

    service.queueInputDraftRevocation({ fileToken: "hung", expiresAt: 2_000 });
    await vi.advanceTimersByTimeAsync(50);
    expect(service.pendingCount).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(fake.revokeInputFile).toHaveBeenCalledTimes(2);
    expect(service.pendingCount).toBe(1);
    service.reset();
  });

  it("does not let a late pre-reset completion delete a new entry", async () => {
    const oldAttempt = deferred<RevokeResult>();
    const newAttempt = deferred<RevokeResult>();
    const fake = createFakeApi();
    fake.revokeInputFile
      .mockImplementationOnce(() => oldAttempt.promise)
      .mockImplementationOnce(() => newAttempt.promise);
    const service = createService(fake.api);

    service.queueInputDraftRevocation({ fileToken: "same", expiresAt: 5_000 });
    service.reset();
    service.queueInputDraftRevocation({ fileToken: "same", expiresAt: 5_000 });

    oldAttempt.resolve({ ok: true, data: { revoked: true } });
    await flushMicrotasks();
    expect(service.pendingCount).toBe(1);

    newAttempt.resolve({ ok: true, data: { revoked: true } });
    await flushMicrotasks();
    expect(service.pendingCount).toBe(0);
    service.reset();
  });
});

function createService(api: LocalSubtitleRendererApi) {
  return new LocalSubtitleCapabilityCleanupService({
    getApi: () => api,
    retryDelaysMs: [100],
    attemptTimeoutMs: 50,
  });
}

function createFakeApi() {
  const revokeInputFile = vi.fn<
    (token: string) => Promise<RevokeResult>
  >(() => Promise.resolve({ ok: true, data: { revoked: true } }));
  const revokeOutputDirectory = vi.fn<
    (token: string) => Promise<RevokeResult>
  >(() => Promise.resolve({ ok: true, data: { revoked: true } }));
  return {
    api: { revokeInputFile, revokeOutputDirectory } as unknown as LocalSubtitleRendererApi,
    revokeInputFile,
    revokeOutputDirectory,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
