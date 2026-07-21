import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from "../../src/type/localSubtitle";
import {
  verifyLocalSubtitleRuntimeBundle,
  type LocalSubtitleVerifiedRuntimeArtifact,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "../../electron/main/local-subtitle/resource-path";
import { LocalSubtitleServerContractError } from "../../electron/main/local-subtitle/server-contract";
import {
  LOCAL_SUBTITLE_SERVER_PROCESS_POLICY,
  buildLocalSubtitleServerEnvironment,
  canReuseLocalSubtitleServerLoadIdentity,
  createLocalSubtitleServerEndpoint,
  createLocalSubtitleServerLoadIdentity,
  createLocalSubtitleServerPrivatePath,
  createLocalSubtitleServerProcessDescriptor,
  isLocalSubtitleServerBackendCompatible,
  parseLocalSubtitleServerEndpoint,
  type CreateLocalSubtitleServerProcessDescriptorOptions,
  type LocalSubtitleServerLoadIdentity,
} from "../../electron/main/local-subtitle/server-process-contract";
import {
  createRuntimeFixture,
  type LocalSubtitleRuntimeFixture,
} from "./runtimeFixture";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const SERVER_ARTIFACT_ID = "whisper-server-mac-arm64-metal-cpu";
let runtimeFixture: LocalSubtitleRuntimeFixture;
let verifiedRuntime: LocalSubtitleVerifiedRuntimeBundle;

beforeAll(async () => {
  runtimeFixture = await createRuntimeFixture();
  verifiedRuntime = await verifyLocalSubtitleRuntimeBundle({
    environment: runtimeFixture.environment,
    scope: "server",
    signatureVerifier: async () => true,
  });
});

afterAll(async () => {
  await runtimeFixture.cleanup();
});

describe("local subtitle server process contract", () => {
  it("generates exactly 24 bytes of private path entropy", () => {
    const randomBytes = vi.fn((size: number) =>
      Uint8Array.from({ length: size }, (_, index) => index),
    );

    expect(createLocalSubtitleServerPrivatePath(randomBytes)).toBe(
      "/fusionkit-000102030405060708090a0b0c0d0e0f1011121314151617",
    );
    expect(randomBytes).toHaveBeenCalledTimes(1);
    expect(randomBytes).toHaveBeenCalledWith(24);
    expect(() =>
      createLocalSubtitleServerPrivatePath(() => new Uint8Array(23)),
    ).toThrow(LocalSubtitleServerContractError);
  });

  it("creates a strict deeply frozen loopback endpoint", () => {
    const endpoint = endpointFixture();

    expect(endpoint).toEqual({
      host: "127.0.0.1",
      port: 43_123,
      privatePath:
        "/fusionkit-000102030405060708090a0b0c0d0e0f1011121314151617",
    });
    expect(Object.isFrozen(endpoint)).toBe(true);

    for (const invalid of [
      { ...endpoint, host: "localhost" },
      { ...endpoint, port: 0 },
      { ...endpoint, port: 65_536 },
      { ...endpoint, privatePath: "/fusionkit-short" },
      { ...endpoint, extra: true },
    ]) {
      expect(() => parseLocalSubtitleServerEndpoint(invalid)).toThrow(
        LocalSubtitleServerContractError,
      );
    }
  });

  it("builds the exact pinned launch descriptor without lifecycle actions", () => {
    const options = validOptions();
    const descriptor = createLocalSubtitleServerProcessDescriptor(options);
    const serverArtifact = selectedServerArtifact(options);

    expect(descriptor.command).toBe(serverArtifact.absolutePath);
    expect(descriptor.args).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "43123",
      "--request-path",
      options.endpoint.privatePath,
      "--inference-path",
      "/inference",
      "--public",
      options.emptyPublicDirectory,
      "--tmp-dir",
      options.temporaryDirectory,
      "--model",
      options.model.absolutePath,
      "--threads",
      "6",
      "--processors",
      "1",
      "--vad-model",
      options.vadModel.absolutePath,
    ]);
    expect(descriptor.args).not.toEqual(
      expect.arrayContaining([
        "--convert",
        "--load",
        "/load",
        "--print-progress",
        "--no-gpu",
      ]),
    );
    expect(descriptor.spawnOptions).toMatchObject({
      cwd: path.dirname(serverArtifact.absolutePath),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(descriptor).not.toHaveProperty("spawn");
    expect(descriptor).not.toHaveProperty("kill");
    expect(descriptor).not.toHaveProperty("reservePort");
    expectDeeplyFrozen(descriptor);
  });

  it("adds --no-gpu only for an actual CPU load", () => {
    const metal = validOptions();
    const cpu = validOptions({ backend: "cpu" });

    expect(
      createLocalSubtitleServerProcessDescriptor(metal).args,
    ).not.toContain("--no-gpu");
    expect(createLocalSubtitleServerProcessDescriptor(cpu).args.slice(-1)).toEqual([
      "--no-gpu",
    ]);
    expect(isLocalSubtitleServerBackendCompatible("metal_cpu", "metal")).toBe(
      true,
    );
    expect(isLocalSubtitleServerBackendCompatible("metal_cpu", "cpu")).toBe(
      true,
    );
    expect(isLocalSubtitleServerBackendCompatible("cpu", "cuda")).toBe(false);
    expect(isLocalSubtitleServerBackendCompatible("cuda", "cpu")).toBe(false);
  });

  it("accepts only backend-compatible pinned server artifacts", () => {
    const base = validOptions();
    const baseArtifact = selectedServerArtifact(base);
    const invalidArtifacts: LocalSubtitleVerifiedRuntimeArtifact[] = [
      { ...baseArtifact, kind: "ffmpeg" },
      { ...baseArtifact, id: "ffmpeg-mac-arm64" },
      { ...baseArtifact, backend: "cpu" },
      { ...baseArtifact, version: "latest" },
      {
        ...baseArtifact,
        absolutePath: path.join(roots().outside, "whisper-server"),
      },
      {
        ...baseArtifact,
        absolutePath: path.join(roots().runtime, "renamed-server"),
      },
    ];

    for (const serverArtifact of invalidArtifacts) {
      expect(() =>
        createLocalSubtitleServerProcessDescriptor({
          ...base,
          verifiedRuntime: {
            ...base.verifiedRuntime,
            artifactPaths: {
              ...base.verifiedRuntime.artifactPaths,
              [base.serverArtifactId]: serverArtifact,
            },
          } as never,
        }),
      ).toThrow(LocalSubtitleServerContractError);
    }

    expect(() =>
      createLocalSubtitleServerProcessDescriptor({
        ...base,
        backend: "cuda",
      }),
    ).toThrow(/does not support/u);
  });

  it("requires a server-scoped verified manifest generation", () => {
    const base = validOptions();
    for (const verifiedRuntime of [
      {
        ...base.verifiedRuntime,
        runtimeGeneration: HASH_B,
      },
      {
        ...base.verifiedRuntime,
        scope: "media" as const,
      },
      {
        ...base.verifiedRuntime,
        manifestSha256: "not-a-hash",
      },
      {
        ...base.verifiedRuntime,
        target: { platform: "darwin" as const, arch: "x64" as const },
      },
    ]) {
      expect(() =>
        createLocalSubtitleServerProcessDescriptor({
          ...base,
          verifiedRuntime: verifiedRuntime as never,
        }),
      ).toThrow(LocalSubtitleServerContractError);
    }
  });

  it("rejects structural copies that lack the verifier proof", () => {
    const base = validOptions();
    const structuralCopy = { ...base.verifiedRuntime };

    expect(() =>
      createLocalSubtitleServerProcessDescriptor({
        ...base,
        verifiedRuntime: structuralCopy as never,
      }),
    ).toThrow(/verified ready bundle/u);
  });

  it("rejects paths outside their controlled roots and overlapping session dirs", () => {
    const base = validOptions();
    const root = roots();
    const invalidOptions: CreateLocalSubtitleServerProcessDescriptorOptions[] = [
      { ...base, managedResourceRoot: "relative/resources" },
      {
        ...base,
        model: { ...base.model, absolutePath: path.join(root.outside, "model.bin") },
      },
      {
        ...base,
        vadModel: {
          ...base.vadModel,
          absolutePath: path.join(root.outside, "vad.bin"),
        },
      },
      {
        ...base,
        emptyPublicDirectory: path.join(root.outside, "public"),
      },
      {
        ...base,
        temporaryDirectory: path.join(base.emptyPublicDirectory, "tmp"),
      },
      {
        ...base,
        model: {
          ...base.model,
          absolutePath: path.join(base.temporaryDirectory, "model.bin"),
        },
        managedResourceRoot: root.session,
      },
      {
        ...base,
        sessionRoot: base.verifiedRuntime.root,
        emptyPublicDirectory: path.join(base.verifiedRuntime.root, "public"),
        temporaryDirectory: path.join(base.verifiedRuntime.root, "tmp"),
      },
      {
        ...base,
        sessionRoot: path.parse(root.base).root,
        emptyPublicDirectory: path.join(path.parse(root.base).root, "public"),
        temporaryDirectory: path.join(path.parse(root.base).root, "tmp"),
      },
    ];

    for (const options of invalidOptions) {
      expect(() => createLocalSubtitleServerProcessDescriptor(options)).toThrow(
        LocalSubtitleServerContractError,
      );
    }
  });

  it("allows a private session below the managed temp root", () => {
    const base = validOptions();
    const sessionRoot = path.join(base.managedResourceRoot, "temp", "session-1");
    const descriptor = createLocalSubtitleServerProcessDescriptor({
      ...base,
      sessionRoot,
      emptyPublicDirectory: path.join(sessionRoot, "public"),
      temporaryDirectory: path.join(sessionRoot, "tmp"),
    });

    expect(descriptor.spawnOptions.env.TMPDIR).toBe(
      path.join(sessionRoot, "tmp"),
    );
  });

  it.each([0, 1.5, 9, Number.NaN])(
    "rejects invalid thread count %s",
    (threads) => {
      expect(() =>
        createLocalSubtitleServerProcessDescriptor({
          ...validOptions(),
          threads,
        }),
      ).toThrow(/thread count/u);
    },
  );

  it("requires the exact pinned VAD identity", () => {
    const base = validOptions();
    for (const vadModel of [
      { ...base.vadModel, id: "other-vad" },
      { ...base.vadModel, sha256: HASH_C },
      { ...base.vadModel, absolutePath: base.model.absolutePath },
    ]) {
      expect(() =>
        createLocalSubtitleServerProcessDescriptor({ ...base, vadModel }),
      ).toThrow(LocalSubtitleServerContractError);
    }
  });

  it("compares every process load identity field before model reuse", () => {
    const baseOptions = validOptions();
    const current = createLocalSubtitleServerLoadIdentity(baseOptions);
    const equivalent = createLocalSubtitleServerLoadIdentity(validOptions());

    expect(canReuseLocalSubtitleServerLoadIdentity(current, equivalent)).toBe(
      true,
    );

    const changedIdentities: LocalSubtitleServerLoadIdentity[] = [
      changed(current, { runtimeGeneration: HASH_B }),
      changed(current, {
        serverArtifact: {
          ...current.serverArtifact,
          sha256: HASH_B,
        },
      }),
      changed(current, { backend: "cpu" }),
      changed(current, {
        model: { ...current.model, id: "other-model" },
      }),
      changed(current, {
        model: { ...current.model, sha256: HASH_C },
      }),
      changed(current, {
        vadModel: {
          ...current.vadModel,
          absolutePath: path.join(roots().managed, "vad", "other-vad.bin"),
        },
      }),
      changed(current, {
        process: { ...current.process, threads: 4 },
      }),
    ];

    for (const identity of changedIdentities) {
      expect(canReuseLocalSubtitleServerLoadIdentity(current, identity)).toBe(
        false,
      );
    }
  });

  it("builds an allowlisted environment without app secrets or proxies", () => {
    const sourceEnvironment = {
      PATH: "/untrusted/bin",
      OPENAI_API_KEY: "sk-secret",
      API_TOKEN: "secret-token",
      HTTP_PROXY: "http://user:password@proxy.invalid",
      HTTPS_PROXY: "http://user:password@proxy.invalid",
      ALL_PROXY: "socks://proxy.invalid",
      NO_PROXY: "127.0.0.1",
      NODE_OPTIONS: "--require malicious",
      ELECTRON_RUN_AS_NODE: "1",
      CUSTOM_VALUE: "not-needed",
    };
    const options = validOptions({ sourceEnvironment });
    const serverArtifact = selectedServerArtifact(options);
    const environment = createLocalSubtitleServerProcessDescriptor(options)
      .spawnOptions.env;

    expect(environment).toEqual({
      PATH: path.dirname(serverArtifact.absolutePath),
      LANG: "C",
      LC_ALL: "C",
      TEMP: options.temporaryDirectory,
      TMP: options.temporaryDirectory,
      TMPDIR: options.temporaryDirectory,
    });
    expect(JSON.stringify(environment)).not.toContain("secret");
    expect(JSON.stringify(environment)).not.toContain("proxy.invalid");
    expect(Object.isFrozen(environment)).toBe(true);
  });

  it("preserves only required Windows system locations", () => {
    const root = roots();
    const environment = buildLocalSubtitleServerEnvironment({
      platform: "win32",
      serverDirectory: path.join(root.runtime, "win-x64", "cpu"),
      temporaryDirectory: root.temp,
      sourceEnvironment: {
        SystemRoot: path.join(root.base, "Windows"),
        WINDIR: path.join(root.base, "Windows"),
        ProgramFiles: path.join(root.base, "Program Files"),
        ProgramW6432: path.join(root.base, "Program Files"),
        COMSPEC: path.join(root.base, "Windows", "cmd.exe"),
        PATHEXT: ".EXE;.CMD",
        HTTPS_PROXY: "http://secret.invalid",
        NVIDIA_API_TOKEN: "secret",
      },
    });

    expect(environment).toMatchObject({
      SystemRoot: path.join(root.base, "Windows"),
      WINDIR: path.join(root.base, "Windows"),
      ProgramFiles: path.join(root.base, "Program Files"),
      ProgramW6432: path.join(root.base, "Program Files"),
    });
    expect(environment).not.toHaveProperty("COMSPEC");
    expect(environment).not.toHaveProperty("PATHEXT");
    expect(environment).not.toHaveProperty("HTTPS_PROXY");
    expect(environment).not.toHaveProperty("NVIDIA_API_TOKEN");
    expect(environment.PATH).toContain("System32");
  });

  it("freezes the complete load identity with verified runtime provenance", () => {
    const options = validOptions();
    const identity = createLocalSubtitleServerLoadIdentity(options);

    expect(identity).toMatchObject({
      contractVersion: 1,
      engineVersion: "v1.9.1",
      engineCommit: "f049fff95a089aa9969deb009cdd4892b3e74916",
      runtimeGeneration: options.verifiedRuntime.runtimeGeneration,
      backend: "metal",
      process: { threads: 6, processors: 1, noGpu: false },
      model: { id: "large-v3-q5_0", sha256: HASH_B },
      vadModel: {
        id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
        sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256,
      },
    });
    expectDeeplyFrozen(identity);
    expect(LOCAL_SUBTITLE_SERVER_PROCESS_POLICY).toMatchObject({
      maxThreads: 8,
      processors: 1,
      shell: false,
      allowConvert: false,
      allowLoadEndpoint: false,
      allowProgressParsing: false,
    });
    expectDeeplyFrozen(LOCAL_SUBTITLE_SERVER_PROCESS_POLICY);
  });
});

function validOptions(
  overrides: Partial<CreateLocalSubtitleServerProcessDescriptorOptions> = {},
): CreateLocalSubtitleServerProcessDescriptorOptions {
  const root = roots();
  const base: CreateLocalSubtitleServerProcessDescriptorOptions = {
    endpoint: endpointFixture(),
    verifiedRuntime,
    serverArtifactId: SERVER_ARTIFACT_ID,
    backend: "metal",
    managedResourceRoot: root.managed,
    model: {
      id: "large-v3-q5_0",
      absolutePath: path.join(
        root.managed,
        "models",
        "large-v3-q5_0",
        "model.bin",
      ),
      byteSize: 1_081_140_203,
      sha256: HASH_B,
    },
    vadModel: {
      id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
      absolutePath: path.join(
        root.managed,
        "vad",
        LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
        "vad.bin",
      ),
      byteSize: 885_098,
      sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256,
    },
    threads: 6,
    sessionRoot: root.session,
    emptyPublicDirectory: root.public,
    temporaryDirectory: root.temp,
  };
  return { ...base, ...overrides };
}

function selectedServerArtifact(
  options: CreateLocalSubtitleServerProcessDescriptorOptions,
): LocalSubtitleVerifiedRuntimeArtifact {
  const artifact = options.verifiedRuntime.artifactPaths[options.serverArtifactId];
  if (!artifact) throw new Error("The server artifact fixture is missing.");
  return artifact;
}

function endpointFixture() {
  return createLocalSubtitleServerEndpoint({
    port: 43_123,
    randomBytes: (size) =>
      Uint8Array.from({ length: size }, (_, index) => index),
  });
}

function roots() {
  const base = path.join(
    path.parse(process.cwd()).root,
    "fusionkit-server-process-contract",
  );
  const session = path.join(base, "session");
  return {
    base,
    runtime: path.join(base, "runtime"),
    managed: path.join(base, "managed"),
    session,
    public: path.join(session, "public"),
    temp: path.join(session, "tmp"),
    outside: path.join(base, "outside"),
  };
}

function changed(
  identity: LocalSubtitleServerLoadIdentity,
  overrides: Partial<LocalSubtitleServerLoadIdentity>,
): LocalSubtitleServerLoadIdentity {
  return { ...identity, ...overrides };
}

function expectDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectDeeplyFrozen(child);
  }
}
