import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeLoader = vi.hoisted(() => vi.fn());

vi.mock("node:module", () => ({
  createRequire: () => nativeLoader,
}));

import * as nativeAdapter from "../../electron/main/local-subtitle/overwrite-native-backend";
import {
  LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION,
  LocalSubtitleOverwriteNativeBackendError,
  createLocalSubtitleOverwriteNativeRuntime,
  createLocalSubtitleOverwriteNativeTransactionCoordinator,
} from "../../electron/main/local-subtitle/overwrite-native-backend";
import {
  isLocalSubtitleOverwriteTransactionCoordinator,
  type LocalSubtitleOverwriteTransactionBackendReceipt,
  type LocalSubtitleOverwriteTransactionRequest,
} from "../../electron/main/local-subtitle/overwrite-transaction";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArchitecture = Object.getOwnPropertyDescriptor(process, "arch")!;
const absoluteNodePath = path.join(
  path.parse(process.cwd()).root,
  "trusted-runtime",
  "local-subtitle-overwrite.node",
);
const absoluteDirectory = path.join(
  path.parse(process.cwd()).root,
  "trusted-output",
);

describe.sequential("local subtitle overwrite native backend loader", () => {
  beforeEach(() => {
    setProcessTarget("darwin", "arm64");
    nativeLoader.mockReset();
    nativeLoader.mockReturnValue(validRawModule());
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    Object.defineProperty(process, "arch", originalArchitecture);
  });

  it("exports only a branded Coordinator factory, never a raw backend loader", () => {
    expect(nativeAdapter).not.toHaveProperty("loadLocalSubtitleOverwriteNativeBackend");

    const coordinator = createLocalSubtitleOverwriteNativeTransactionCoordinator(
      absoluteNodePath,
    );

    expect(isLocalSubtitleOverwriteTransactionCoordinator(coordinator)).toBe(true);
  });

  it("separates begin-only transactions from the main-only recovery authority", () => {
    const runtime = createLocalSubtitleOverwriteNativeRuntime(absoluteNodePath);

    expect(isLocalSubtitleOverwriteTransactionCoordinator(runtime.transactions)).toBe(true);
    expect(runtime.transactions).not.toHaveProperty("recover");
    expect(runtime.recovery).not.toHaveProperty("begin");
  });

  it("captures, binds, snapshots, and validates the synchronous recover export", () => {
    let observedRequest: unknown;
    const rawModule = validRawModule();
    rawModule.recover = vi.fn(function (request) {
      expect(this).toBe(rawModule);
      observedRequest = request;
      return { state: "decision_required" };
    });
    nativeLoader.mockReturnValue(rawModule);
    const runtime = createLocalSubtitleOverwriteNativeRuntime(absoluteNodePath);
    const recover = runtime.recovery.claim();

    expect(recover(validRecoveryRequest())).toEqual({ state: "decision_required" });
    expect(observedRequest).toEqual(validRecoveryRequest());
    expect(Object.isFrozen(observedRequest)).toBe(true);
    expect(Object.isFrozen(
      (observedRequest as ReturnType<typeof validRecoveryRequest>)
        .expectedDirectoryIdentity,
    )).toBe(true);

    rawModule.recover = vi.fn(() => ({ state: "not_found" }));
    expect(recover(validRecoveryRequest())).toEqual({ state: "decision_required" });
    expect(rawModule.recover).not.toHaveBeenCalled();
  });

  it("rejects proxied and expanded recovery requests before native invocation", () => {
    const rawModule = validRawModule();
    rawModule.recover = vi.fn(() => ({ state: "rolled_back" }));
    nativeLoader.mockReturnValue(rawModule);
    const recover = createLocalSubtitleOverwriteNativeRuntime(
      absoluteNodePath,
    ).recovery.claim();
    const ownKeys = vi.fn(() => {
      throw new Error("proxy trap must not run");
    });

    expect(() => recover(new Proxy(validRecoveryRequest(), { ownKeys }))).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(ownKeys).not.toHaveBeenCalled();
    expect(() => recover({
      ...validRecoveryRequest(),
      fallbackPath: absoluteDirectory,
    } as ReturnType<typeof validRecoveryRequest>)).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(() => recover({
      ...validRecoveryRequest(),
      expectedDirectoryIdentity: {
        ...validRecoveryRequest().expectedDirectoryIdentity,
        path: absoluteDirectory,
      },
    } as ReturnType<typeof validRecoveryRequest>)).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(rawModule.recover).not.toHaveBeenCalled();
  });

  it.each([
    ["extra key", { state: "rolled_back", finalPath: "/private/result.srt" }],
    ["unknown state", { state: "finalized" }],
    ["primitive", "rolled_back"],
  ])("rejects an invalid native recovery result: %s", (_label, result) => {
    const rawModule = validRawModule();
    rawModule.recover = () => result;
    nativeLoader.mockReturnValue(rawModule);
    const recover = createLocalSubtitleOverwriteNativeRuntime(
      absoluteNodePath,
    ).recovery.claim();

    expect(() => recover(validRecoveryRequest())).toThrowError(
      expect.objectContaining({ code: "invalid_result" }),
    );
  });

  it.each([
    ["pending", () => new Promise(() => undefined)],
    ["resolved", () => Promise.resolve({ state: "rolled_back" })],
    ["rejected", () => Promise.reject(new Error("late recovery failure"))],
  ] as const)("rejects and absorbs an asynchronous native recovery %s", async (_label, result) => {
    const rawModule = validRawModule();
    rawModule.recover = result;
    nativeLoader.mockReturnValue(rawModule);
    const recover = createLocalSubtitleOverwriteNativeRuntime(
      absoluteNodePath,
    ).recovery.claim();

    expect(() => recover(validRecoveryRequest())).toThrowError(
      expect.objectContaining({ code: "invalid_result" }),
    );
    await Promise.resolve();
  });

  it("loads only the supplied path, preserves the receiver, and snapshots requests", () => {
    let observedRequest: LocalSubtitleOverwriteTransactionRequest | undefined;
    const rawModule = validRawModule(function (request) {
      expect(this).toBe(rawModule);
      observedRequest = request;
      return validRawReceipt();
    });
    nativeLoader.mockReturnValue(rawModule);
    const coordinator = createLocalSubtitleOverwriteNativeTransactionCoordinator(
      absoluteNodePath,
    );
    const request = validRequest();

    const receipt = coordinator.begin(request);

    expect(nativeLoader).toHaveBeenCalledOnce();
    expect(nativeLoader).toHaveBeenCalledWith(absoluteNodePath);
    expect(observedRequest).not.toBe(request);
    expect(Object.isFrozen(observedRequest)).toBe(true);
    expect(Object.isFrozen(observedRequest?.expectedDirectoryIdentity)).toBe(true);
    expect(receipt.expectedFinalIdentity).toEqual(identity(7, 8));
    expect(receipt.state).toBe("open");
  });

  it("captures begin before native module mutation", () => {
    const originalBegin = vi.fn(() => validRawReceipt());
    const rawModule = validRawModule(originalBegin);
    nativeLoader.mockReturnValue(rawModule);
    const coordinator = createLocalSubtitleOverwriteNativeTransactionCoordinator(
      absoluteNodePath,
    );
    rawModule.begin = vi.fn(() => {
      throw new Error("mutated begin");
    });

    coordinator.begin(validRequest());

    expect(originalBegin).toHaveBeenCalledOnce();
    expect(rawModule.begin).not.toHaveBeenCalled();
  });

  it("ignores a runtime second-argument injection surface", () => {
    const injectedLoader = vi.fn(() => validRawModule());
    const callWithInjectedOptions = createLocalSubtitleOverwriteNativeTransactionCoordinator as unknown as (
      modulePath: string,
      options: unknown,
    ) => unknown;

    callWithInjectedOptions(absoluteNodePath, {
      expectedPlatform: "win32",
      expectedArchitecture: "x64",
      loadModule: injectedLoader,
    });

    expect(injectedLoader).not.toHaveBeenCalled();
    expect(nativeLoader).toHaveBeenCalledOnce();
  });

  it.each([
    ["relative path", "local-subtitle-overwrite.node"],
    ["package name", "local-subtitle-overwrite"],
    ["wrong extension", path.join(path.dirname(absoluteNodePath), "overwrite.js")],
    ["wrong extension case", path.join(path.dirname(absoluteNodePath), "overwrite.NODE")],
    ["NUL path", `${absoluteNodePath}\0redirect.node`],
  ])("rejects a %s before invoking createRequire", (_label, modulePath) => {
    expect(() =>
      createLocalSubtitleOverwriteNativeTransactionCoordinator(modulePath)
    ).toThrowError(expect.objectContaining({ code: "invalid_module_path" }));
    expect(nativeLoader).not.toHaveBeenCalled();
  });

  it.each([
    ["darwin x64", "darwin", "x64"],
    ["win32 arm64", "win32", "arm64"],
    ["linux x64", "linux", "x64"],
  ])("fails closed for the unsupported current %s target", (_label, platform, architecture) => {
    setProcessTarget(platform, architecture);

    expect(() =>
      createLocalSubtitleOverwriteNativeTransactionCoordinator(absoluteNodePath)
    ).toThrowError(expect.objectContaining({ code: "unsupported_target" }));
    expect(nativeLoader).not.toHaveBeenCalled();
  });

  it("maps a createRequire exception without retrying another source", () => {
    const cause = new Error("native dlopen failed");
    nativeLoader.mockImplementation(() => {
      throw cause;
    });

    let observed: unknown;
    try {
      createLocalSubtitleOverwriteNativeTransactionCoordinator(absoluteNodePath);
    } catch (error) {
      observed = error;
    }

    expect(nativeLoader).toHaveBeenCalledOnce();
    expect(observed).toBeInstanceOf(LocalSubtitleOverwriteNativeBackendError);
    expect(observed).toMatchObject({ code: "module_load_failed", cause });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["array", []],
    ["function", Object.assign(() => undefined, validRawModule())],
    ["null prototype", Object.assign(Object.create(null), validRawModule())],
    ["custom prototype", Object.assign(Object.create({}), validRawModule())],
  ])("rejects invalid %s module exports", (_label, rawModule) => {
    nativeLoader.mockReturnValue(rawModule);

    expect(() =>
      createLocalSubtitleOverwriteNativeTransactionCoordinator(absoluteNodePath)
    ).toThrowError(expect.objectContaining({ code: "invalid_module" }));
  });

  it("rejects a Proxy without invoking validation traps or spoofed errors", () => {
    const trapError = new LocalSubtitleOverwriteNativeBackendError(
      "target_mismatch",
      "spoofed",
    );
    const ownKeys = vi.fn(() => {
      throw trapError;
    });
    nativeLoader.mockReturnValue(new Proxy(validRawModule(), { ownKeys }));

    expect(() =>
      createLocalSubtitleOverwriteNativeTransactionCoordinator(absoluteNodePath)
    ).toThrowError(expect.objectContaining({ code: "invalid_module" }));
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it.each([
    ["missing architecture", () => {
      const raw = validRawModule() as Record<PropertyKey, unknown>;
      delete raw.architecture;
      return raw;
    }],
    ["extra string key", () => ({ ...validRawModule(), fallback: "package-name" })],
    ["test-only fault export", () => ({
      ...validRawModule(),
      testFaultInjection: true,
    })],
    ["extra symbol key", () => {
      const raw: Record<PropertyKey, unknown> = validRawModule();
      raw[Symbol("fallback")] = true;
      return raw;
    }],
    ["inherited begin", () => {
      const raw = Object.create({ begin: validRawModule().begin }) as Record<string, unknown>;
      raw.protocolVersion = LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION;
      raw.platform = "darwin";
      raw.architecture = "arm64";
      return raw;
    }],
    ["accessor begin", () => {
      const raw = validRawModule() as Record<string, unknown>;
      Object.defineProperty(raw, "begin", { get: () => validRawModule().begin });
      return raw;
    }],
  ])("rejects %s instead of widening the raw protocol", (_label, factory) => {
    nativeLoader.mockReturnValue(factory());

    expect(() =>
      createLocalSubtitleOverwriteNativeTransactionCoordinator(absoluteNodePath)
    ).toThrowError(expect.objectContaining({ code: "invalid_module" }));
  });

  it.each([0, -1, 1.5, "1", 1n])(
    "rejects malformed protocol version %#",
    (protocolVersion) => {
      nativeLoader.mockReturnValue({ ...validRawModule(), protocolVersion });

      expect(() =>
        createLocalSubtitleOverwriteNativeTransactionCoordinator(absoluteNodePath)
      ).toThrowError(expect.objectContaining({ code: "invalid_module" }));
    },
  );

  it("distinguishes a well-formed incompatible protocol version", () => {
    nativeLoader.mockReturnValue({ ...validRawModule(), protocolVersion: 2 });

    expect(() =>
      createLocalSubtitleOverwriteNativeTransactionCoordinator(absoluteNodePath)
    ).toThrowError(expect.objectContaining({ code: "protocol_mismatch" }));
  });

  it.each([
    ["platform domain", { platform: "linux" }],
    ["architecture domain", { architecture: "ia32" }],
    ["unsupported pair", { platform: "darwin", architecture: "x64" }],
    ["platform type", { platform: 1 }],
    ["architecture type", { architecture: null }],
  ])("rejects malformed module %s as invalid", (_label, override) => {
    nativeLoader.mockReturnValue({ ...validRawModule(), ...override });

    expect(() =>
      createLocalSubtitleOverwriteNativeTransactionCoordinator(absoluteNodePath)
    ).toThrowError(expect.objectContaining({ code: "invalid_module" }));
  });

  it("reports a valid supported module for another target as mismatched", () => {
    nativeLoader.mockReturnValue(validRawModule(undefined, "win32", "x64"));

    expect(() =>
      createLocalSubtitleOverwriteNativeTransactionCoordinator(absoluteNodePath)
    ).toThrowError(expect.objectContaining({ code: "target_mismatch" }));
  });

  it.each([undefined, null, 1, "begin", {}])(
    "rejects invalid begin export %#",
    (begin) => {
      nativeLoader.mockReturnValue({ ...validRawModule(), begin });

      expect(() =>
        createLocalSubtitleOverwriteNativeTransactionCoordinator(absoluteNodePath)
      ).toThrowError(expect.objectContaining({ code: "invalid_module" }));
    },
  );

  it.each([undefined, null, 1, "recover", {}])(
    "rejects invalid recover export %#",
    (recover) => {
      nativeLoader.mockReturnValue({ ...validRawModule(), recover });

      expect(() =>
        createLocalSubtitleOverwriteNativeRuntime(absoluteNodePath)
      ).toThrowError(expect.objectContaining({ code: "invalid_module" }));
    },
  );

  it.each([
    ["pending", () => new Promise(() => undefined)],
    ["resolved", () => Promise.resolve(validRawModule())],
    ["rejected", () => Promise.reject(new Error("late module failure"))],
  ] as const)("rejects and absorbs a native %s Promise", async (_label, factory) => {
    nativeLoader.mockReturnValue(factory());

    expect(() =>
      createLocalSubtitleOverwriteNativeTransactionCoordinator(absoluteNodePath)
    ).toThrowError(expect.objectContaining({ code: "invalid_module" }));
    await Promise.resolve();
  });

  it("rejects a generic thenable without reading or invoking then", () => {
    const then = vi.fn();
    const thenGetter = vi.fn(() => then);
    const rawModule = validRawModule() as Record<string, unknown>;
    Object.defineProperty(rawModule, "then", { get: thenGetter });
    nativeLoader.mockReturnValue(rawModule);

    expect(() =>
      createLocalSubtitleOverwriteNativeTransactionCoordinator(absoluteNodePath)
    ).toThrowError(expect.objectContaining({ code: "invalid_module" }));
    expect(thenGetter).not.toHaveBeenCalled();
    expect(then).not.toHaveBeenCalled();
  });

  it("validates every raw receipt through the branded Coordinator", () => {
    nativeLoader.mockReturnValue(validRawModule(() => ({
      ...validRawReceipt(),
      finalPath: path.join(absoluteDirectory, "result.srt"),
    }) as never));
    const coordinator = createLocalSubtitleOverwriteNativeTransactionCoordinator(
      absoluteNodePath,
    );

    expect(() => coordinator.begin(validRequest())).toThrowError(
      expect.objectContaining({ code: "invalid_receipt" }),
    );
  });

  it.each([
    ["pending", () => new Promise(() => undefined)],
    ["resolved", () => Promise.resolve(validRawReceipt())],
    ["rejected", () => Promise.reject(new Error("late begin failure"))],
  ] as const)(
    "lets the Coordinator reject and absorb a %s native begin result",
    async (_label, begin) => {
      nativeLoader.mockReturnValue(validRawModule(begin as never));
      const coordinator = createLocalSubtitleOverwriteNativeTransactionCoordinator(
        absoluteNodePath,
      );

      expect(() => coordinator.begin(validRequest())).toThrowError(
        expect.objectContaining({ code: "invalid_receipt" }),
      );
      await Promise.resolve();
    },
  );
});

function setProcessTarget(platform: string, architecture: string): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  Object.defineProperty(process, "arch", {
    value: architecture,
    configurable: true,
  });
}

function validRawModule(
  begin: (
    this: unknown,
    request: LocalSubtitleOverwriteTransactionRequest,
  ) => LocalSubtitleOverwriteTransactionBackendReceipt = () => validRawReceipt(),
  platform: "darwin" | "win32" = "darwin",
  architecture: "arm64" | "x64" = "arm64",
) {
  return {
    protocolVersion: LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION,
    platform,
    architecture,
    begin,
    recover() {
      return { state: "not_found" };
    },
  };
}

function validRawReceipt(): LocalSubtitleOverwriteTransactionBackendReceipt {
  return {
    expectedFinalIdentity: identity(7, 8),
    finalize() {},
    rollback() {},
  };
}

function validRequest(): LocalSubtitleOverwriteTransactionRequest {
  return {
    transactionId: "01234567-89ab-4cde-8fab-0123456789ab",
    directoryPath: absoluteDirectory,
    expectedDirectoryIdentity: identity(1, 2),
    partialLeaf: ".result.srt.partial",
    finalLeaf: "result.srt",
    expectedPartialIdentity: identity(4, 5),
    expectedByteSize: 4_096,
  };
}

function validRecoveryRequest() {
  return {
    transactionId: "01234567-89ab-4cde-8fab-0123456789ab",
    directoryPath: absoluteDirectory,
    expectedDirectoryIdentity: identity(1, 2),
  };
}

function identity(dev: number, ino: number, birthtimeMs = 3) {
  return { dev, ino, birthtimeMs };
}
