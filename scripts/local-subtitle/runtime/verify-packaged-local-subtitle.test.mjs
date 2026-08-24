import assert from "node:assert/strict";
import {
  mkdir,
  chmod,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolvePackagedAppAsarPath,
  resolvePackagedExecutablePath,
  resolvePackagedRuntimeRoot,
  verifyPackagedLocalSubtitle,
} from "./verify-packaged-local-subtitle.mjs";

test("resolves only the two supported packaged resource layouts", () => {
  const macApp = path.resolve("ignored/FusionKit.app");
  assert.equal(
    resolvePackagedRuntimeRoot(macApp, "darwin", "arm64"),
    path.join(macApp, "Contents", "Resources", "local-subtitle"),
  );
  assert.equal(
    resolvePackagedExecutablePath(macApp, "darwin", "arm64"),
    path.join(macApp, "Contents", "MacOS", "FusionKit"),
  );
  assert.equal(
    resolvePackagedAppAsarPath(macApp, "darwin", "arm64"),
    path.join(macApp, "Contents", "Resources", "app.asar"),
  );
  const windowsApp = path.resolve("ignored/FusionKit-win32-x64");
  assert.equal(
    resolvePackagedRuntimeRoot(windowsApp, "win32", "x64"),
    path.join(windowsApp, "resources", "local-subtitle"),
  );
  assert.equal(
    resolvePackagedAppAsarPath(windowsApp, "win32", "x64"),
    path.join(windowsApp, "resources", "app.asar"),
  );
  assert.equal(
    resolvePackagedExecutablePath(windowsApp, "win32", "x64"),
    path.join(windowsApp, "FusionKit.exe"),
  );
  assert.throws(
    () => resolvePackagedRuntimeRoot(macApp, "darwin", "x64"),
    (error) => error?.code === "packaged_runtime_invalid",
  );
  assert.throws(
    () => resolvePackagedRuntimeRoot("ignored/not-an-app", "darwin", "arm64"),
    (error) => error?.code === "packaged_runtime_invalid",
  );
});

test("verifies the exact packaged root and emits a path-free component report", async (t) => {
  const fixture = await createMacFixture(t);
  const calls = [];
  const report = await verifyPackagedLocalSubtitle(
    {
      appPath: fixture.appPath,
      platform: "darwin",
      arch: "arm64",
      faultsTempParent: fixture.root,
    },
    {
      inspectNativeBinaryFile: async () => ({
        format: "mach-o",
        architectures: ["arm64"],
      }),
      verifyRuntimeBundle: async (options) => {
        calls.push(["runtime", options]);
        return {
          ready: true,
          manifestSha256: "runtime-generation",
          artifactCount: 4,
          launchResults: [{ id: "server", launched: true }],
          noPathFallback: true,
        };
      },
      verifyStagedOverwriteNativeAddon: async (options) => {
        calls.push(["overwrite", options]);
        return {
          ready: true,
          generation: "addon-generation",
          artifact: { sha256: "addon-hash" },
          moduleExportsVerified: true,
          contentAddressed: true,
          noPathFallback: true,
        };
      },
      runFaultMatrix: async (root, target, options) => {
        calls.push(["faults", { root, target, options }]);
        return createFaultMatrix("darwin");
      },
    },
  );

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ["runtime", {
    runtimeRoot: fixture.runtimeRoot,
    platform: "darwin",
    arch: "arm64",
    scope: "all",
    launch: true,
  }]);
  assert.deepEqual(calls[1], ["overwrite", {
    root: fixture.runtimeRoot,
    platform: "darwin",
    arch: "arm64",
  }]);
  assert.equal(calls[2][1].root, fixture.runtimeRoot);
  assert.deepEqual(calls[2][1].target, {
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(report.workPackage, "NATIVE-002C");
  assert.equal(report.packagedLayout, "Contents/Resources/local-subtitle");
  assert.deepEqual(report.packagedExecutable, {
    format: "mach-o",
    architectures: ["arm64"],
    executable: true,
  });
  assert.equal(report.productionGateChanged, false);
  assert.equal(report.packagedProductE2EClaimed, false);
  assert.equal(report.releaseReady, false);
  assert.equal(JSON.stringify(report).includes(fixture.root), false);
});

test("freezes the Windows x64 executable and fault-matrix contract", async (t) => {
  const fixture = await createWindowsFixture(t);
  const report = await verifyPackagedLocalSubtitle(
    { appPath: fixture.appPath, platform: "win32", arch: "x64" },
    {
      inspectNativeBinaryFile: async () => ({
        format: "pe",
        architectures: ["x64"],
      }),
      verifyRuntimeBundle: async () => ({
        ready: true,
        noPathFallback: true,
      }),
      verifyStagedOverwriteNativeAddon: async () => ({
        ready: true,
        moduleExportsVerified: true,
        contentAddressed: true,
        noPathFallback: true,
      }),
      runFaultMatrix: async () => createFaultMatrix("win32"),
    },
  );
  assert.equal(report.workPackage, "NATIVE-002D");
  assert.equal(report.packagedLayout, "resources/local-subtitle");
  assert.deepEqual(report.packagedExecutable, {
    format: "pe",
    architectures: ["x64"],
    executable: true,
  });
  assert.equal(
    report.faultMatrix.some(
      (entry) => entry.fault === "ffmpeg_signature_policy_invalid",
    ),
    true,
  );
});

test("fails closed when a verifier or fault matrix is not explicitly ready", async (t) => {
  const fixture = await createMacFixture(t);
  const inspectExecutable = async () => ({
    format: "mach-o",
    architectures: ["arm64"],
  });
  const readyRuntime = async () => ({ ready: true, noPathFallback: true });
  const readyOverwrite = async () => ({
    ready: true,
    moduleExportsVerified: true,
    contentAddressed: true,
    noPathFallback: true,
  });
  const readyFaults = async () => createFaultMatrix("darwin");

  await assert.rejects(
    verifyPackagedLocalSubtitle(
      { appPath: fixture.appPath, platform: "darwin", arch: "arm64" },
      {
        inspectNativeBinaryFile: inspectExecutable,
        verifyRuntimeBundle: async () => ({ ready: false }),
        verifyStagedOverwriteNativeAddon: readyOverwrite,
        runFaultMatrix: readyFaults,
      },
    ),
    (error) => error?.code === "packaged_runtime_invalid",
  );
  await assert.rejects(
    verifyPackagedLocalSubtitle(
      { appPath: fixture.appPath, platform: "darwin", arch: "arm64" },
      {
        inspectNativeBinaryFile: inspectExecutable,
        verifyRuntimeBundle: readyRuntime,
        verifyStagedOverwriteNativeAddon: async () => ({ ready: false }),
        runFaultMatrix: readyFaults,
      },
    ),
    (error) => error?.code === "packaged_runtime_invalid",
  );
  await assert.rejects(
    verifyPackagedLocalSubtitle(
      { appPath: fixture.appPath, platform: "darwin", arch: "arm64" },
      {
        inspectNativeBinaryFile: inspectExecutable,
        verifyRuntimeBundle: readyRuntime,
        verifyStagedOverwriteNativeAddon: readyOverwrite,
        runFaultMatrix: async () => createFaultMatrix("darwin").slice(1),
      },
    ),
    (error) => error?.code === "packaged_runtime_invalid",
  );
});

test("rejects a symbolic packaged application root", async (t) => {
  const fixture = await createMacFixture(t);
  const linkedApp = path.join(fixture.root, "Linked.app");
  await symlink(fixture.appPath, linkedApp, "dir");
  await assert.rejects(
    verifyPackagedLocalSubtitle(
      { appPath: linkedApp, platform: "darwin", arch: "arm64" },
      {
        inspectNativeBinaryFile: async () => ({
          format: "mach-o",
          architectures: ["arm64"],
        }),
        verifyRuntimeBundle: async () => ({ ready: true }),
        verifyStagedOverwriteNativeAddon: async () => ({ ready: true }),
        runFaultMatrix: async () => [{ blockedBeforeEnqueue: true }],
      },
    ),
    (error) => error?.code === "packaged_runtime_invalid",
  );
});

async function createMacFixture(t) {
  const root = await mkdtemp(path.join(
    await realpath(os.tmpdir()),
    "fusionkit-packaged-runtime-",
  ));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = path.join(root, "FusionKit.app");
  const runtimeRoot = path.join(
    appPath,
    "Contents",
    "Resources",
    "local-subtitle",
  );
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(
    path.join(appPath, "Contents", "Resources", "app.asar"),
    "fixture",
    "utf8",
  );
  const executablePath = path.join(appPath, "Contents", "MacOS", "FusionKit");
  await mkdir(path.dirname(executablePath), { recursive: true });
  await writeFile(executablePath, "fixture", "utf8");
  await chmod(executablePath, 0o755);
  return { root, appPath, runtimeRoot };
}

async function createWindowsFixture(t) {
  const root = await mkdtemp(path.join(
    await realpath(os.tmpdir()),
    "fusionkit-packaged-runtime-win-",
  ));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = path.join(root, "FusionKit-win32-x64");
  const runtimeRoot = path.join(appPath, "resources", "local-subtitle");
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(appPath, "resources", "app.asar"), "fixture", "utf8");
  await writeFile(path.join(appPath, "FusionKit.exe"), "fixture", "utf8");
  return { root, appPath, runtimeRoot };
}

function createFaultMatrix(platform) {
  const faults = {
    manifest_missing: "media_runtime_missing",
    ffmpeg_missing: "media_runtime_missing",
    license_missing: "media_runtime_missing",
    source_offer_missing: "media_runtime_missing",
    ffmpeg_hash_changed: "media_runtime_invalid",
    ffmpeg_wrong_architecture: "media_runtime_invalid",
    ...(platform === "darwin"
      ? { ffmpeg_not_executable: "media_runtime_invalid" }
      : { ffmpeg_signature_policy_invalid: "media_runtime_invalid" }),
    ffmpeg_launch_identity_failed: "media_runtime_launch_failed",
    server_missing: "runtime_missing",
  };
  return Object.entries(faults).map(([fault, errorCode]) => ({
    fault,
    errorCode,
    blockedBeforeEnqueue: true,
  }));
}
