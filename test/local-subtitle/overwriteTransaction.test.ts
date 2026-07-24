import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LocalSubtitleOverwriteTransactionCoordinator,
  LocalSubtitleOverwriteTransactionError,
  LocalSubtitleOverwriteTransactionReceipt,
  createLocalSubtitleOverwriteTransactionCoordinator,
  isLocalSubtitleOverwriteTransactionCoordinator,
  type LocalSubtitleOverwriteTransactionBackend,
  type LocalSubtitleOverwriteTransactionBackendReceipt,
  type LocalSubtitleOverwriteTransactionRequest,
} from "../../electron/main/local-subtitle/overwrite-transaction";

describe("local subtitle overwrite transaction contract", () => {
  it.each([
    undefined,
    null,
    {},
    { begin: 1 },
  ])("rejects an invalid backend %#", (backend) => {
    expect(() =>
      new LocalSubtitleOverwriteTransactionCoordinator(backend as never)
    ).toThrowError(expect.objectContaining({ code: "invalid_backend" }));
  });

  it("preserves a backend method receiver", () => {
    class Backend implements LocalSubtitleOverwriteTransactionBackend {
      readonly marker = "backend";

      begin(): LocalSubtitleOverwriteTransactionBackendReceipt {
        expect(this.marker).toBe("backend");
        return validRawReceipt();
      }
    }

    const receipt = createLocalSubtitleOverwriteTransactionCoordinator(
      new Backend(),
    ).begin(validRequest());
    expect(receipt.state).toBe("open");
  });

  it("brands only coordinators created by the validated constructor", () => {
    const coordinator = createLocalSubtitleOverwriteTransactionCoordinator({
      begin: () => validRawReceipt(),
    });
    const prototypeSpoof = Object.create(Object.getPrototypeOf(coordinator));
    class CoordinatorSubclass extends LocalSubtitleOverwriteTransactionCoordinator {}
    const subclass = new CoordinatorSubclass({ begin: () => validRawReceipt() });

    expect(isLocalSubtitleOverwriteTransactionCoordinator(coordinator)).toBe(true);
    expect(isLocalSubtitleOverwriteTransactionCoordinator(prototypeSpoof)).toBe(false);
    expect(isLocalSubtitleOverwriteTransactionCoordinator(subclass)).toBe(false);
    expect(isLocalSubtitleOverwriteTransactionCoordinator({ begin() {} })).toBe(false);
    expect(Object.isFrozen(LocalSubtitleOverwriteTransactionCoordinator.prototype)).toBe(true);
    expect(Object.isFrozen(LocalSubtitleOverwriteTransactionReceipt.prototype)).toBe(true);
  });

  it("captures the validated begin method before backend mutation", () => {
    const backend = { begin: vi.fn(() => validRawReceipt()) };
    const originalBegin = backend.begin;
    const coordinator = new LocalSubtitleOverwriteTransactionCoordinator(backend);
    backend.begin = vi.fn(() => {
      throw new Error("mutated begin");
    });

    coordinator.begin(validRequest());

    expect(originalBegin).toHaveBeenCalledTimes(1);
    expect(backend.begin).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing field", mutate: (request: Record<string, unknown>) => delete request.finalLeaf },
    { label: "extra field", mutate: (request: Record<string, unknown>) => { request.finalPath = "/private/result.srt"; } },
    { label: "empty transaction id", mutate: (request: Record<string, unknown>) => { request.transactionId = ""; } },
    { label: "unsafe transaction id", mutate: (request: Record<string, unknown>) => { request.transactionId = "../redirect"; } },
    { label: "relative directory", mutate: (request: Record<string, unknown>) => { request.directoryPath = "relative"; } },
    { label: "NUL directory", mutate: (request: Record<string, unknown>) => { request.directoryPath = `${absoluteDirectory()}\0redirect`; } },
    { label: "empty partial leaf", mutate: (request: Record<string, unknown>) => { request.partialLeaf = ""; } },
    { label: "dot partial leaf", mutate: (request: Record<string, unknown>) => { request.partialLeaf = "."; } },
    { label: "dot-dot final leaf", mutate: (request: Record<string, unknown>) => { request.finalLeaf = ".."; } },
    { label: "POSIX separator", mutate: (request: Record<string, unknown>) => { request.finalLeaf = "nested/result.srt"; } },
    { label: "Windows separator", mutate: (request: Record<string, unknown>) => { request.finalLeaf = "nested\\result.srt"; } },
    { label: "identical leaves", mutate: (request: Record<string, unknown>) => { request.finalLeaf = request.partialLeaf; } },
    { label: "negative directory device", mutate: (request: Record<string, unknown>) => { (request.expectedDirectoryIdentity as Record<string, unknown>).dev = -1; } },
    { label: "unsafe directory inode", mutate: (request: Record<string, unknown>) => { (request.expectedDirectoryIdentity as Record<string, unknown>).ino = Number.MAX_SAFE_INTEGER + 1; } },
    { label: "fractional partial device", mutate: (request: Record<string, unknown>) => { (request.expectedPartialIdentity as Record<string, unknown>).dev = 1.5; } },
    { label: "negative partial birth time", mutate: (request: Record<string, unknown>) => { (request.expectedPartialIdentity as Record<string, unknown>).birthtimeMs = -1; } },
    { label: "non-finite directory birth time", mutate: (request: Record<string, unknown>) => { (request.expectedDirectoryIdentity as Record<string, unknown>).birthtimeMs = Number.POSITIVE_INFINITY; } },
    { label: "expanded partial identity", mutate: (request: Record<string, unknown>) => { (request.expectedPartialIdentity as Record<string, unknown>).path = "/private/partial"; } },
    { label: "zero byte size", mutate: (request: Record<string, unknown>) => { request.expectedByteSize = 0; } },
    { label: "unsafe byte size", mutate: (request: Record<string, unknown>) => { request.expectedByteSize = Number.MAX_SAFE_INTEGER + 1; } },
  ])("rejects a $label request before calling the backend", ({ mutate }) => {
    const begin = vi.fn(() => validRawReceipt());
    const coordinator = new LocalSubtitleOverwriteTransactionCoordinator({ begin });
    const request = mutableRequest();
    mutate(request);

    expect(() => coordinator.begin(request as never)).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(begin).not.toHaveBeenCalled();
  });

  it("rejects a proxied request without invoking reflection traps", () => {
    const begin = vi.fn(() => validRawReceipt());
    const coordinator = new LocalSubtitleOverwriteTransactionCoordinator({ begin });
    const ownKeys = vi.fn(() => {
      throw new Error("proxy trap must not run");
    });

    expect(() => coordinator.begin(new Proxy(validRequest(), { ownKeys }))).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(ownKeys).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it("rejects accessor-backed request fields without invoking getters", () => {
    const begin = vi.fn(() => validRawReceipt());
    const coordinator = new LocalSubtitleOverwriteTransactionCoordinator({ begin });
    const request = mutableRequest();
    const dev = vi.fn(() => 1);
    const identityWithAccessor = { ino: 2, birthtimeMs: 3.25 } as Record<
      string,
      unknown
    >;
    Object.defineProperty(identityWithAccessor, "dev", { enumerable: true, get: dev });
    request.expectedDirectoryIdentity = identityWithAccessor as never;

    expect(() => coordinator.begin(request as never)).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(dev).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it("passes a detached, deeply frozen request snapshot to the backend", () => {
    const request = mutableRequest();
    let observed: LocalSubtitleOverwriteTransactionRequest | undefined;
    const coordinator = new LocalSubtitleOverwriteTransactionCoordinator({
      begin(snapshot) {
        observed = snapshot;
        expect(snapshot).not.toBe(request);
        expect(snapshot.expectedDirectoryIdentity).not.toBe(
          request.expectedDirectoryIdentity,
        );
        expect(snapshot.expectedPartialIdentity).not.toBe(
          request.expectedPartialIdentity,
        );
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.expectedDirectoryIdentity)).toBe(true);
        expect(Object.isFrozen(snapshot.expectedPartialIdentity)).toBe(true);
        expect(() => {
          (snapshot as { directoryPath: string }).directoryPath = "/redirect";
        }).toThrow(TypeError);
        expect(() => {
          (snapshot.expectedPartialIdentity as { ino: number }).ino = 999;
        }).toThrow(TypeError);
        return validRawReceipt();
      },
    });

    coordinator.begin(request as unknown as LocalSubtitleOverwriteTransactionRequest);
    request.directoryPath = path.join(absoluteDirectory(), "replacement");
    request.expectedDirectoryIdentity.ino = 999;
    request.expectedPartialIdentity.ino = 999;

    expect(observed).toMatchObject({
      directoryPath: absoluteDirectory(),
      expectedDirectoryIdentity: { ino: 2 },
      expectedPartialIdentity: { ino: 5 },
    });
  });

  it("preserves lossless Windows request and receipt identities", () => {
    const expectedDirectoryIdentity = windowsIdentity(
      "0a0b0c0d",
      "00112233445566778899aabbccddeeff",
    );
    const expectedPartialIdentity = windowsIdentity(
      "0a0b0c0d",
      "10112233445566778899aabbccddeeff",
    );
    const expectedFinalIdentity = windowsIdentity(
      "0a0b0c0d",
      "20112233445566778899aabbccddeeff",
    );
    let observed: LocalSubtitleOverwriteTransactionRequest | undefined;
    const coordinator = new LocalSubtitleOverwriteTransactionCoordinator({
      begin(request) {
        observed = request;
        return {
          expectedFinalIdentity,
          finalize() {},
          rollback() {},
        };
      },
    });
    const request = {
      ...validRequest(),
      expectedDirectoryIdentity,
      expectedPartialIdentity,
    };

    const receipt = coordinator.begin(request);

    expect(observed?.expectedDirectoryIdentity).toEqual(expectedDirectoryIdentity);
    expect(observed?.expectedPartialIdentity).toEqual(expectedPartialIdentity);
    expect(receipt.expectedFinalIdentity).toEqual(expectedFinalIdentity);
    expect(receipt.expectedFinalIdentity).not.toBe(expectedFinalIdentity);
    expect(Object.isFrozen(receipt.expectedFinalIdentity)).toBe(true);
  });

  it.each([
    windowsIdentity("0A0B0C0D", "00112233445566778899aabbccddeeff"),
    windowsIdentity("0a0b0c0d", "00112233445566778899AABBCCDDEEFF"),
    windowsIdentity("0a0b0c0d", "00112233445566778899aabbccddee"),
    {
      ...windowsIdentity("0a0b0c0d", "00112233445566778899aabbccddeeff"),
      birthtimeMs: 3,
    },
  ])("rejects a malformed Windows request identity %#", (invalidIdentity) => {
    const begin = vi.fn(() => validRawReceipt());
    const coordinator = new LocalSubtitleOverwriteTransactionCoordinator({ begin });
    expect(() => coordinator.begin({
      ...validRequest(),
      expectedPartialIdentity: invalidIdentity,
    } as never)).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(begin).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", receipt: undefined },
    { label: "expanded", receipt: { ...validRawReceipt(), finalPath: "/private/result.srt" } },
    { label: "missing finalize", receipt: { expectedFinalIdentity: identity(7, 8), rollback() {} } },
    { label: "non-function rollback", receipt: { ...validRawReceipt(), rollback: true } },
    { label: "negative final device", receipt: { ...validRawReceipt(), expectedFinalIdentity: identity(-1, 8) } },
    { label: "unsafe final inode", receipt: { ...validRawReceipt(), expectedFinalIdentity: identity(7, Number.MAX_SAFE_INTEGER + 1) } },
    { label: "non-finite final birth time", receipt: { ...validRawReceipt(), expectedFinalIdentity: identity(7, 8, Number.NaN) } },
    { label: "expanded final identity", receipt: { ...validRawReceipt(), expectedFinalIdentity: { ...identity(7, 8), size: 4_096 } } },
  ])("rejects a $label backend receipt", ({ receipt }) => {
    const coordinator = new LocalSubtitleOverwriteTransactionCoordinator({
      begin: () => receipt as never,
    });
    expect(() => coordinator.begin(validRequest())).toThrowError(
      expect.objectContaining({ code: "invalid_receipt" }),
    );
  });

  it("rejects a proxied backend receipt without invoking reflection traps", () => {
    const ownKeys = vi.fn(() => {
      throw new Error("proxy trap must not run");
    });
    const coordinator = new LocalSubtitleOverwriteTransactionCoordinator({
      begin: () => new Proxy(validRawReceipt(), { ownKeys }),
    });

    expect(() => coordinator.begin(validRequest())).toThrowError(
      expect.objectContaining({ code: "invalid_receipt" }),
    );
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", () => new Promise(() => undefined)],
    ["resolved", () => Promise.resolve(validRawReceipt())],
    ["rejected", () => Promise.reject(new Error("late begin failure"))],
  ] as const)("rejects and absorbs a %s asynchronous begin result", async (_case, result) => {
    const coordinator = new LocalSubtitleOverwriteTransactionCoordinator({
      begin: result as never,
    });
    expect(() => coordinator.begin(validRequest())).toThrowError(
      expect.objectContaining({ code: "invalid_receipt" }),
    );
    await Promise.resolve();
  });

  it("freezes a detached final identity on the public receipt", () => {
    const raw = validRawReceipt();
    const receipt = new LocalSubtitleOverwriteTransactionReceipt(raw);

    expect(receipt.expectedFinalIdentity).not.toBe(raw.expectedFinalIdentity);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.expectedFinalIdentity)).toBe(true);
    (raw.expectedFinalIdentity as { ino: number }).ino = 999;
    expect(receipt.expectedFinalIdentity).toEqual(identity(7, 8));
  });

  it("finalizes exactly once and rejects rollback after finalization", () => {
    const raw = validRawReceipt();
    const finalize = vi.spyOn(raw, "finalize");
    const rollback = vi.spyOn(raw, "rollback");
    const receipt = new LocalSubtitleOverwriteTransactionReceipt(raw);

    receipt.finalize();
    receipt.finalize();
    expect(receipt.state).toBe("finalized");
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(() => receipt.rollback()).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back exactly once and rejects finalization after rollback", () => {
    const raw = validRawReceipt();
    const finalize = vi.spyOn(raw, "finalize");
    const rollback = vi.spyOn(raw, "rollback");
    const receipt = new LocalSubtitleOverwriteTransactionReceipt(raw);

    receipt.rollback();
    receipt.rollback();
    expect(receipt.state).toBe("rolled_back");
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(() => receipt.finalize()).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
    expect(finalize).not.toHaveBeenCalled();
  });

  it("locks finalize failures into finalize_pending until retry converges", () => {
    const finalize = vi.fn()
      .mockImplementationOnce(() => { throw new Error("retry finalize"); })
      .mockImplementationOnce(() => undefined);
    const rollback = vi.fn();
    const receipt = new LocalSubtitleOverwriteTransactionReceipt({
      expectedFinalIdentity: identity(7, 8),
      finalize,
      rollback,
    });

    expect(() => receipt.finalize()).toThrow("retry finalize");
    expect(receipt.state).toBe("finalize_pending");
    expect(() => receipt.rollback()).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
    receipt.finalize();
    expect(receipt.state).toBe("finalized");
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("locks rollback failures into rollback_pending until retry converges", () => {
    const rollback = vi.fn()
      .mockImplementationOnce(() => { throw new Error("retry rollback"); })
      .mockImplementationOnce(() => undefined);
    const receipt = new LocalSubtitleOverwriteTransactionReceipt({
      expectedFinalIdentity: identity(7, 8),
      finalize() {},
      rollback,
    });

    expect(() => receipt.rollback()).toThrow("retry rollback");
    expect(receipt.state).toBe("rollback_pending");
    expect(() => receipt.finalize()).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
    receipt.rollback();
    expect(receipt.state).toBe("rolled_back");
    expect(rollback).toHaveBeenCalledTimes(2);
  });

  it.each(["finalize", "rollback"] as const)(
    "rejects same-method and cross-terminal reentry while %s is running",
    (method) => {
      let receipt!: LocalSubtitleOverwriteTransactionReceipt;
      const finalize = vi.fn(() => {
        expect(() => receipt.finalize()).toThrowError(
          expect.objectContaining({ code: "invalid_state" }),
        );
        expect(receipt.state).toBe("open");
        expect(() => receipt.rollback()).toThrowError(
          expect.objectContaining({ code: "invalid_state" }),
        );
        expect(receipt.state).toBe("open");
      });
      const rollback = vi.fn(() => {
        expect(() => receipt.rollback()).toThrowError(
          expect.objectContaining({ code: "invalid_state" }),
        );
        expect(receipt.state).toBe("open");
        expect(() => receipt.finalize()).toThrowError(
          expect.objectContaining({ code: "invalid_state" }),
        );
        expect(receipt.state).toBe("open");
      });
      receipt = new LocalSubtitleOverwriteTransactionReceipt({
        expectedFinalIdentity: identity(7, 8),
        finalize,
        rollback,
      });

      receipt[method]();

      expect(receipt.state).toBe(method === "finalize" ? "finalized" : "rolled_back");
      expect(finalize).toHaveBeenCalledTimes(method === "finalize" ? 1 : 0);
      expect(rollback).toHaveBeenCalledTimes(method === "rollback" ? 1 : 0);
    },
  );

  it("locks only the invoked finalize direction when rollback reentry is rejected", () => {
    let receipt!: LocalSubtitleOverwriteTransactionReceipt;
    const rollback = vi.fn();
    const finalize = vi.fn(() => receipt.rollback());
    receipt = new LocalSubtitleOverwriteTransactionReceipt({
      expectedFinalIdentity: identity(7, 8),
      finalize,
      rollback,
    });

    expect(() => receipt.finalize()).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );

    expect(receipt.state).toBe("finalize_pending");
    expect(finalize).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(() => receipt.rollback()).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
  });

  it("captures validated receipt methods before backend mutation", () => {
    const raw = validRawReceipt();
    const originalFinalize = vi.spyOn(raw, "finalize");
    const receipt = new LocalSubtitleOverwriteTransactionReceipt(raw);
    raw.finalize = vi.fn(() => {
      throw new Error("mutated finalize");
    });

    receipt.finalize();

    expect(originalFinalize).toHaveBeenCalledTimes(1);
    expect(raw.finalize).not.toHaveBeenCalled();
  });

  it.each([
    ["finalize", "pending", () => new Promise(() => undefined)],
    ["finalize", "resolved", () => Promise.resolve()],
    ["finalize", "rejected", () => Promise.reject(new Error("late finalize failure"))],
    ["rollback", "pending", () => new Promise(() => undefined)],
    ["rollback", "resolved", () => Promise.resolve()],
    ["rollback", "rejected", () => Promise.reject(new Error("late rollback failure"))],
  ] as const)(
    "rejects an asynchronous %s %s result without losing its terminal decision",
    async (method, _case, result) => {
      const raw = validRawReceipt();
      raw[method] = result as never;
      const receipt = new LocalSubtitleOverwriteTransactionReceipt(raw);

      expect(() => receipt[method]()).toThrowError(
        expect.objectContaining({ code: "invalid_receipt" }),
      );
      expect(receipt.state).toBe(
        method === "rollback" ? "rollback_pending" : "finalize_pending",
      );
      await Promise.resolve();
    },
  );

  it("exposes stable contract error identity", () => {
    const error = new LocalSubtitleOverwriteTransactionError(
      "invalid_request",
      "invalid",
    );
    expect(error).toMatchObject({
      name: "LocalSubtitleOverwriteTransactionError",
      code: "invalid_request",
      message: "invalid",
    });
  });
});

function validRequest(): LocalSubtitleOverwriteTransactionRequest {
  return mutableRequest() as unknown as LocalSubtitleOverwriteTransactionRequest;
}

function mutableRequest() {
  return {
    transactionId: "01234567-89ab-4cde-8fab-0123456789ab",
    directoryPath: absoluteDirectory(),
    expectedDirectoryIdentity: { ...identity(1, 2, 3.25) },
    partialLeaf: ".meeting.srt.fusionkit.partial",
    finalLeaf: "meeting.srt",
    expectedPartialIdentity: { ...identity(4, 5, 6.5) },
    expectedByteSize: 4_096,
  };
}

function validRawReceipt(): LocalSubtitleOverwriteTransactionBackendReceipt {
  return {
    expectedFinalIdentity: { ...identity(7, 8) },
    finalize() {},
    rollback() {},
  };
}

function identity(dev: number, ino: number, birthtimeMs = 9.75) {
  return { dev, ino, birthtimeMs };
}

function windowsIdentity(volumeSerialHex: string, fileIdHex: string) {
  return { volumeSerialHex, fileIdHex };
}

function absoluteDirectory(): string {
  return path.join(path.parse(process.cwd()).root, "fusionkit-overwrite-contract");
}
