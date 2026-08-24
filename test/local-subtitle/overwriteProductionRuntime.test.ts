import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as productionRuntimeModule from "../../electron/main/local-subtitle/overwrite-production-runtime";
import {
  LocalSubtitleOverwriteNativeBackendError,
  type LocalSubtitleOverwriteNativeRuntime,
} from "../../electron/main/local-subtitle/overwrite-native-backend";
import {
  LocalSubtitleOverwriteNativeResourceError,
  type LocalSubtitleVerifiedOverwriteNativeAddon,
} from "../../electron/main/local-subtitle/overwrite-native-resource";
import {
  LOCAL_SUBTITLE_OVERWRITE_RECOVERY_REPOSITORY_RELATIVE_PATH,
  type LocalSubtitleOverwriteProductionRuntimeDependencies,
} from "../../electron/main/local-subtitle/overwrite-production-runtime-core";
import {
  initializeLocalSubtitleOverwriteProductionRuntimeForTest,
} from "../../electron/main/local-subtitle/overwrite-production-runtime-test-support";
import {
  LocalSubtitleOverwriteRecoveryError,
  LocalSubtitleOverwriteRecoveryFileRepository,
  LocalSubtitleOverwriteRecoveryOwner,
  createLocalSubtitleOverwriteRecoveryAuthority,
  type LocalSubtitleOverwriteRecoveryRepository,
} from "../../electron/main/local-subtitle/overwrite-recovery-owner";
import { createLocalSubtitleOverwriteTransactionCoordinator } from "../../electron/main/local-subtitle/overwrite-transaction";
import { LocalSubtitleArtifactRegistry } from "../../electron/main/local-subtitle/subtitle-artifact-registry";

const fixtureRoots: string[] = [];
const fakeProof = Object.freeze({
  addonGeneration: "a".repeat(64),
}) as LocalSubtitleVerifiedOverwriteNativeAddon;

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local subtitle overwrite production runtime composition", () => {
  it("keeps the production module export surface free of test injection", () => {
    expect(Object.keys(productionRuntimeModule)).toEqual([
      "initializeLocalSubtitleOverwriteProductionRuntime",
    ]);
  });

  it("builds one verified runtime, versioned repository, and recovery owner", async () => {
    const root = fixtureRoot();
    const artifacts = new LocalSubtitleArtifactRegistry();
    const nativeRuntime = createNativeRuntimeFixture();
    const order: string[] = [];
    let observedRepositoryPath: string | undefined;
    let observedArtifacts: unknown;
    let observedAuthority: unknown;
    const dependencies = createDependencies({
      onVerify: () => order.push("verify"),
      onCreateNativeRuntime: () => order.push("native"),
      nativeRuntime,
      createRepository: (absolutePath) => {
        order.push("repository");
        observedRepositoryPath = absolutePath;
        return new LocalSubtitleOverwriteRecoveryFileRepository(absolutePath, {
          syncParentDirectory: () => undefined,
        });
      },
      createRecoveryOwner: (repository, ownerArtifacts, authority) => {
        order.push("owner");
        observedArtifacts = ownerArtifacts;
        observedAuthority = authority;
        return new LocalSubtitleOverwriteRecoveryOwner(
          repository,
          ownerArtifacts,
          authority,
        );
      },
    });

    const result = await initializeLocalSubtitleOverwriteProductionRuntimeForTest(
      options(root, artifacts),
      dependencies,
    );

    expect(order).toEqual(["verify", "native", "repository", "owner"]);
    expect(observedRepositoryPath).toBe(
      path.join(
        root,
        "managed",
        LOCAL_SUBTITLE_OVERWRITE_RECOVERY_REPOSITORY_RELATIVE_PATH,
      ),
    );
    expect(observedArtifacts).toBe(artifacts);
    expect(result.status).toBe("ready");
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== "ready") throw new Error("Expected ready runtime.");
    expect(result.addonGeneration).toBe(fakeProof.addonGeneration);
    expect(result.transactions).toBe(nativeRuntime.transactions);
    expect(observedAuthority).toBe(nativeRuntime.recovery);
    expect(result.lifecycleTarget).toBe(result.recoveryOwner);
    expect(result.recoveryOwner.listPending()).toEqual([]);
    expect(dependencies.verifyNativeAddon).toHaveBeenCalledOnce();
    expect(dependencies.createNativeRuntime).toHaveBeenCalledOnce();
  });

  it("keeps lifecycle and IPC initialization ahead of every window activation path", () => {
    const source = readFileSync(
      new URL("../../electron/main/index.ts", import.meta.url),
      "utf8",
    );
    const lifecycleInstall = source.indexOf(
      "localSubtitleServerLifecycle.install({",
    );
    const localSubtitleIpcInstall = source.indexOf(
      "setupLocalSubtitleIPC(localSubtitleIpcService);",
    );
    const recoveryIpcBridge = source.indexOf(
      "new LocalSubtitleOverwriteRecoveryIpcBridge(localSubtitleOverwriteRuntime);",
    );
    const recoveryPublicHandlers = source.indexOf(
      "...localSubtitleOverwriteRecoveryIpcBridge.handlers.public,",
    );
    const runtimeIpcBridge = source.indexOf(
      "new LocalSubtitleRuntimeIpcBridge({",
    );
    const runtimePublicHandlers = source.indexOf(
      "...localSubtitleRuntimeIpcBridge.handlers.public,",
    );
    const recoveryInternalHandler = source.indexOf(
      "localSubtitleOverwriteRecoveryIpcBridge.handlers.overwriteRecovery,",
    );
    const initialWindow = source.indexOf("  createWindow();", localSubtitleIpcInstall);
    const activateInstall = source.indexOf(
      '  app.on("activate", () => {',
      initialWindow,
    );

    expect(lifecycleInstall).toBeGreaterThan(-1);
    expect(recoveryIpcBridge).toBeGreaterThan(lifecycleInstall);
    expect(runtimeIpcBridge).toBeGreaterThan(lifecycleInstall);
    expect(source).toContain("supportedOutputConflictPolicies:");
    expect(source).toContain(
      'localSubtitleOverwriteRuntime.status === "ready"',
    );
    expect(recoveryPublicHandlers).toBeGreaterThan(recoveryIpcBridge);
    expect(runtimePublicHandlers).toBeGreaterThan(runtimeIpcBridge);
    expect(recoveryInternalHandler).toBeGreaterThan(recoveryIpcBridge);
    expect(localSubtitleIpcInstall).toBeGreaterThan(lifecycleInstall);
    expect(localSubtitleIpcInstall).toBeGreaterThan(recoveryPublicHandlers);
    expect(localSubtitleIpcInstall).toBeGreaterThan(runtimePublicHandlers);
    expect(localSubtitleIpcInstall).toBeGreaterThan(recoveryInternalHandler);
    expect(initialWindow).toBeGreaterThan(localSubtitleIpcInstall);
    expect(activateInstall).toBeGreaterThan(initialWindow);
    expect(source.indexOf('  app.on("activate", () => {')).toBe(
      activateInstall,
    );
  });

  it("loads path-free pending records without invoking native recovery", async () => {
    const root = fixtureRoot();
    const artifacts = new LocalSubtitleArtifactRegistry();
    const repositoryPath = path.join(
      root,
      "managed",
      LOCAL_SUBTITLE_OVERWRITE_RECOVERY_REPOSITORY_RELATIVE_PATH,
    );
    const repository = new LocalSubtitleOverwriteRecoveryFileRepository(
      repositoryPath,
      { syncParentDirectory: () => undefined },
    );
    repository.replace([
      {
        schemaVersion: 2,
        recoveryId: "pending-recovery",
        ownerFingerprint: "b".repeat(64),
        taskId: "task-pending",
        generation: 3,
        format: "SRT",
        decision: "rollback_unpublished",
        nativeState: "retry_failed",
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
    const recover = vi.fn(() => ({ state: "rolled_back" as const }));
    const dependencies = createDependencies({
      recover,
      createRepository: (absolutePath) =>
        new LocalSubtitleOverwriteRecoveryFileRepository(absolutePath, {
          syncParentDirectory: () => undefined,
        }),
    });

    const result = await initializeLocalSubtitleOverwriteProductionRuntimeForTest(
      options(root, artifacts),
      dependencies,
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected ready runtime.");
    expect(result.recoveryOwner.listPending()).toEqual([
      {
        recoveryId: "pending-recovery",
        displayCode: "17629E2A0387",
        taskId: "task-pending",
        generation: 3,
        format: "SRT",
        direction: "rollback",
        state: "retry_failed",
        createdAt: 10,
        requiresDirectorySelection: true,
      },
    ]);
    expect(recover).not.toHaveBeenCalled();
    expect(readFileSync(repositoryPath, "utf8")).not.toContain("directoryPath");
  });

  it("does not touch recovery state when canonical addon verification fails", async () => {
    const root = fixtureRoot();
    const dependencies = createDependencies({
      verifyFailure: new LocalSubtitleOverwriteNativeResourceError(
        "manifest_missing",
        "Missing canonical overwrite addon.",
      ),
    });

    const result = await initializeLocalSubtitleOverwriteProductionRuntimeForTest(
      options(root, new LocalSubtitleArtifactRegistry()),
      dependencies,
    );

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "native_resource_unavailable",
    });
    expect(() =>
      result.lifecycleTarget.releaseOwner("owner-unavailable"),
    ).not.toThrow();
    await expect(
      result.lifecycleTarget.shutdown("app_quit"),
    ).resolves.toBeUndefined();
    await expect(
      result.lifecycleTarget.shutdown("fatal"),
    ).resolves.toBeUndefined();
    await expect(result.lifecycleTarget.shutdown("update")).rejects.toMatchObject({
      code: "recovery_pending",
    });
    expect(dependencies.createNativeRuntime).not.toHaveBeenCalled();
    expect(dependencies.createRepository).not.toHaveBeenCalled();
    expect(dependencies.createRecoveryOwner).not.toHaveBeenCalled();
  });

  it("keeps recovery state unopened after a verified addon load failure", async () => {
    const root = fixtureRoot();
    const dependencies = createDependencies({
      nativeFailure: new LocalSubtitleOverwriteNativeBackendError(
        "module_load_failed",
        "The verified overwrite addon could not load.",
      ),
    });

    const result = await initializeLocalSubtitleOverwriteProductionRuntimeForTest(
      options(root, new LocalSubtitleArtifactRegistry()),
      dependencies,
    );

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "native_resource_unavailable",
    });
    expect(dependencies.createRepository).not.toHaveBeenCalled();
    expect(dependencies.createRecoveryOwner).not.toHaveBeenCalled();
  });

  it("blocks overwrite composition without rewriting an invalid repository", async () => {
    const root = fixtureRoot();
    const replace = vi.fn();
    const dependencies = createDependencies({
      createRepository: () => ({
        load: () => {
          throw new LocalSubtitleOverwriteRecoveryError(
            "invalid_record",
            "The recovery record is invalid.",
          );
        },
        replace,
      }),
    });

    const result = await initializeLocalSubtitleOverwriteProductionRuntimeForTest(
      options(root, new LocalSubtitleArtifactRegistry()),
      dependencies,
    );

    expect(result).toMatchObject({
      status: "blocked",
      reason: "recovery_state_unavailable",
    });
    await expect(result.lifecycleTarget.shutdown("update")).rejects.toMatchObject({
      code: "recovery_pending",
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("rethrows unknown bootstrap failures instead of hiding programming errors", async () => {
    const root = fixtureRoot();
    const failure = new Error("Unexpected verifier defect.");
    const dependencies = createDependencies({ verifyFailure: failure });

    await expect(
      initializeLocalSubtitleOverwriteProductionRuntimeForTest(
        options(root, new LocalSubtitleArtifactRegistry()),
        dependencies,
      ),
    ).rejects.toBe(failure);
    expect(dependencies.createNativeRuntime).not.toHaveBeenCalled();
  });

  it("rejects a non-absolute managed root before resource verification", async () => {
    const dependencies = createDependencies();

    await expect(
      initializeLocalSubtitleOverwriteProductionRuntimeForTest(
        {
          environment: { mode: "development", appRoot: fixtureRoot() },
          managedResourceRoot: "relative-state",
          artifacts: new LocalSubtitleArtifactRegistry(),
        },
        dependencies,
      ),
    ).rejects.toThrow("production runtime options are invalid");
    expect(dependencies.verifyNativeAddon).not.toHaveBeenCalled();
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "fusionkit-overwrite-production-runtime-"),
  );
  fixtureRoots.push(root);
  return root;
}

function options(root: string, artifacts: LocalSubtitleArtifactRegistry) {
  return {
    environment: {
      mode: "development" as const,
      appRoot: root,
    },
    managedResourceRoot: path.join(root, "managed"),
    artifacts,
  };
}

function createDependencies(overrides: {
  readonly onVerify?: () => void;
  readonly onCreateNativeRuntime?: () => void;
  readonly verifyFailure?: Error;
  readonly nativeFailure?: Error;
  readonly nativeRuntime?: LocalSubtitleOverwriteNativeRuntime;
  readonly recover?: () => { readonly state: "rolled_back" };
  readonly createRepository?: (
    absolutePath: string,
  ) => LocalSubtitleOverwriteRecoveryRepository;
  readonly createRecoveryOwner?: LocalSubtitleOverwriteProductionRuntimeDependencies<string>["createRecoveryOwner"];
} = {}): LocalSubtitleOverwriteProductionRuntimeDependencies<string> & {
  readonly verifyNativeAddon: ReturnType<typeof vi.fn>;
  readonly createNativeRuntime: ReturnType<typeof vi.fn>;
  readonly createRepository: ReturnType<typeof vi.fn>;
  readonly createRecoveryOwner: ReturnType<typeof vi.fn>;
} {
  const verifyNativeAddon = vi.fn(async () => {
    overrides.onVerify?.();
    if (overrides.verifyFailure) throw overrides.verifyFailure;
    return fakeProof;
  });
  const createNativeRuntime = vi.fn(() => {
    overrides.onCreateNativeRuntime?.();
    if (overrides.nativeFailure) throw overrides.nativeFailure;
    if (overrides.nativeRuntime) return overrides.nativeRuntime;
    return createNativeRuntimeFixture(overrides.recover);
  });
  const createRepository = vi.fn(
    overrides.createRepository ??
      ((absolutePath: string) =>
        new LocalSubtitleOverwriteRecoveryFileRepository(absolutePath, {
          syncParentDirectory: () => undefined,
        })),
  );
  const createRecoveryOwner = vi.fn(
    overrides.createRecoveryOwner ??
      ((repository, artifacts, authority) =>
        new LocalSubtitleOverwriteRecoveryOwner(
          repository,
          artifacts,
          authority,
        )),
  );
  return {
    verifyNativeAddon,
    createNativeRuntime,
    createRepository,
    createRecoveryOwner,
  };
}

function createNativeRuntimeFixture(
  recover: () => { readonly state: "rolled_back" } = () => ({
    state: "rolled_back",
  }),
): LocalSubtitleOverwriteNativeRuntime {
  return Object.freeze({
    transactions: createLocalSubtitleOverwriteTransactionCoordinator({
      begin: () => {
        throw new Error("The transaction fixture must not be invoked.");
      },
    }),
    recovery: createLocalSubtitleOverwriteRecoveryAuthority({
      recover,
      acknowledge: () => ({ state: "acknowledged" }),
    }),
  });
}
