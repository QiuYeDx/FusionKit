import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertBackendEvidence,
  buildWindowsSmokeReport,
  collectWindowsBackendEvidence,
  createPcm16WavFixture,
  createWindowsServerLaunch,
  createWindowsSmokeEnvironment,
  normalizeWindowsSmokeOptions,
  parseExactHealthResponse,
  removeWindowsSmokeCaptureFile,
  removeWindowsSmokeWorkRoot,
  runBoundedFileCommand,
  runNative002WindowsSmoke,
  runPrivateServerSmoke,
  terminateWindowsSmokeChild,
  verifyPinnedLaunchModel,
  writeWindowsSmokeReport,
} from "./run-native002-windows-smoke.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function targetPaths(root = path.resolve("native002b-test")) {
  return {
    runtimeRoot: path.join(root, "runtime"),
    acceleratorRuntimeRoot: path.join(root, "cuda"),
    modelPath: path.join(root, "model.bin"),
    workRoot: path.join(root, "work"),
  };
}

function serverResult(backend, overrides = {}) {
  return {
    backend,
    healthStatus: "ok",
    loopbackOnly: true,
    privatePathUsed: true,
    modelLoaded: true,
    modelLoadFirstMs: 1_450,
    exitedBeforeHealth: false,
    diagnosticsBounded: true,
    backendEvidence: backend === "cpu"
      ? "official-server-no-gpu-flag"
      : "exact-pid-windows-gpu-process-memory-counter-with-nvidia-smi-fallback",
    backendVerified: true,
    backendEvidenceDetails: backend === "cpu"
      ? {
          exactProcessIdMatched: true,
          sampleCount: 0,
          peakRamBytes: null,
          peakVramBytes: null,
        }
      : {
          exactProcessIdMatched: true,
          sampleCount: 3,
          peakRamBytes: 512 * 1024 * 1024,
          peakVramBytes: 256 * 1024 * 1024,
        },
    ...overrides,
  };
}

function mediaResult() {
  return {
    ffmpegIdentityMatched: true,
    ffprobeIdentityMatched: true,
    pcm16DecodePassed: true,
    sampleRate: 16_000,
    channels: 1,
  };
}

test("enforces CPU/CUDA accelerator argument mutual exclusion", () => {
  const paths = targetPaths();
  assert.throws(
    () => normalizeWindowsSmokeOptions({
      ...paths,
      backend: "cpu",
      platform: "win32",
      arch: "x64",
    }),
    (error) => error?.code === "invalid_arguments" &&
      /does not accept an accelerator/u.test(error.message),
  );
  const { acceleratorRuntimeRoot: _omitted, ...withoutAccelerator } = paths;
  assert.throws(
    () => normalizeWindowsSmokeOptions({
      ...withoutAccelerator,
      backend: "cuda",
      platform: "win32",
      arch: "x64",
    }),
    (error) => error?.code === "invalid_arguments" &&
      /requires an accelerator/u.test(error.message),
  );
});

test("launches CPU with --no-gpu and CUDA without it", () => {
  const root = path.resolve("native002b-launch");
  const shared = {
    serverPath: path.join(root, "bin", "whisper-server.exe"),
    modelPath: path.join(root, "model.bin"),
    publicDirectory: path.join(root, "public"),
    temporaryDirectory: path.join(root, "tmp"),
    port: 31_337,
    privatePath: `/fusionkit-${"1".repeat(48)}`,
    sourceEnvironment: {
      SystemRoot: "C:\\Windows",
      OPENAI_API_KEY: "must-not-survive",
      CUDA_PATH: "C:\\untrusted-cuda",
    },
  };
  const cpu = createWindowsServerLaunch({ ...shared, backend: "cpu" });
  const cuda = createWindowsServerLaunch({ ...shared, backend: "cuda" });

  assert.ok(cpu.args.includes("--no-gpu"));
  assert.ok(!cuda.args.includes("--no-gpu"));
  assert.equal(cpu.spawnOptions.shell, false);
  assert.equal(cpu.spawnOptions.windowsHide, true);
  assert.equal(cpu.spawnOptions.cwd, path.dirname(shared.serverPath));
  assert.equal(cpu.spawnOptions.env.OPENAI_API_KEY, undefined);
  assert.equal(cpu.spawnOptions.env.CUDA_PATH, undefined);
});

test("accepts only the exact private health response", () => {
  assert.equal(parseExactHealthResponse(Buffer.from('{"status":"ok"}')), true);
  for (const invalid of [
    "{}",
    '{"status":"ready"}',
    '{"status":"ok","extra":true}',
    "not-json",
  ]) {
    assert.throws(
      () => parseExactHealthResponse(Buffer.from(invalid)),
      (error) => error?.code === "health_invalid",
    );
  }
});

test("fails CUDA closed when health has no exact-PID positive VRAM", () => {
  for (const evidence of [
    {
      backendVerified: true,
      exactProcessIdMatched: true,
      sampleCount: 1,
      peakVramBytes: 0,
    },
    {
      backendVerified: true,
      exactProcessIdMatched: false,
      sampleCount: 1,
      peakVramBytes: 1024,
    },
    {
      backendVerified: true,
      exactProcessIdMatched: true,
      sampleCount: 0,
      peakVramBytes: 1024,
    },
  ]) {
    assert.throws(
      () => assertBackendEvidence("cuda", evidence),
      (error) => error?.code === "backend_unverified",
    );
  }
  const verified = assertBackendEvidence("cuda", {
    backendVerified: true,
    exactProcessIdMatched: true,
    sampleCount: 2,
    peakRamBytes: 4096,
    peakVramBytes: 2048,
  });
  assert.equal(verified.backendVerified, true);
  assert.equal(verified.peakVramBytes, 2048);
});

test("samples Windows GPU counters from the tool directory, not the private work root", async () => {
  const privateWorkRoot = path.resolve("native002b-private-work");
  const systemRoot = "C:\\Windows";
  const expectedPowerShellDirectory = path.dirname(
    path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  );
  const calls = [];
  const evidence = await collectWindowsBackendEvidence({
    processId: 2468,
    observeMs: 0,
    intervalMs: 1,
    workRoot: privateWorkRoot,
    environment: {
      SystemRoot: systemRoot,
      PATH: "",
    },
    isProcessAlive: () => true,
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        exitCode: 0,
        stdout: `${1024 * 1024},${2 * 1024 * 1024}`,
        stderr: "",
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, expectedPowerShellDirectory);
  assert.notEqual(calls[0].options.cwd, privateWorkRoot);
  assert.equal(evidence.backendVerified, true);
  assert.equal(evidence.exactProcessIdMatched, true);
  assert.equal(evidence.peakVramBytes, 2 * 1024 * 1024);
});

test("requires explicit --no-gpu evidence for CPU", () => {
  assert.throws(
    () => assertBackendEvidence("cpu", {
      backendVerified: true,
      backendEvidence: "health-only",
    }),
    (error) => error?.code === "backend_unverified",
  );
  assert.equal(
    assertBackendEvidence("cpu", {
      backendVerified: true,
      backendEvidence: "official-server-no-gpu-flag",
      sampleCount: 0,
    }).peakVramBytes,
    null,
  );
});

test("creates a minimal Windows environment without inherited secrets or PATH", () => {
  const root = path.resolve("native002b-environment");
  const executableDirectory = path.join(root, "server");
  const temporaryDirectory = path.join(root, "tmp");
  const environment = createWindowsSmokeEnvironment({
    executableDirectories: [executableDirectory],
    temporaryDirectory,
    tempDirectory: temporaryDirectory,
    sourceEnvironment: {
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      ProgramW6432: "C:\\Program Files",
      PATH: "C:\\untrusted-bin",
      OPENAI_API_KEY: "secret",
      HTTPS_PROXY: "http://secret.invalid",
      CUDA_PATH: "C:\\CUDA",
      COMSPEC: "C:\\untrusted\\cmd.exe",
    },
  });

  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.CUDA_PATH, undefined);
  assert.equal(environment.COMSPEC, undefined);
  assert.ok(environment.PATH.split(path.delimiter).includes(
    path.normalize(executableDirectory),
  ));
  assert.ok(environment.PATH.split(path.delimiter).includes(
    path.join(environment.SystemRoot, "System32"),
  ));
  assert.doesNotMatch(environment.PATH, /untrusted-bin/iu);
  assert.equal(environment.TEMP, path.normalize(temporaryDirectory));
  assert.equal(environment.TMP, path.normalize(temporaryDirectory));
});

test("builds a frozen path-free CPU report", () => {
  const report = buildWindowsSmokeReport({
    backend: "cpu",
    baseVerification: {
      launchResults: [{
        id: "whisper-server-win-x64-cpu",
        kind: "server",
        versionMatched: true,
        exitCode: 0,
        filePath: "C:\\private\\whisper-server.exe",
      }],
    },
    baseManifestSha256: SHA_A,
    acceleratorVerification: null,
    serverArtifactId: "whisper-server-win-x64-cpu",
    server: serverResult("cpu"),
    media: mediaResult(),
    model: {
      id: "large-v3-q5_0",
      byteSize: 1_081_140_203,
      sha256: SHA_C,
    },
  });

  assert.equal(report.status, "target_smoke_passed");
  assert.equal(report.acceleratorRuntime, null);
  assert.equal(report.server.backendEvidenceDetails.peakVramBytes, null);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.server), true);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /C:\\\\private/iu);
  assert.doesNotMatch(serialized, /fusionkit-[a-f0-9]{16,}/iu);
  assert.doesNotMatch(serialized, /raw diagnostic/iu);
});

test("sanitizes CUDA pack verification and excludes server authority", () => {
  const report = buildWindowsSmokeReport({
    backend: "cuda",
    baseVerification: { launchResults: [] },
    baseManifestSha256: SHA_A,
    acceleratorVerification: {
      manifestSha256: SHA_B,
      artifactCount: 9,
      expandedByteSize: 1_209_487_872,
      serverPath: "C:\\private\\cuda\\whisper-server.exe",
    },
    serverArtifactId: "whisper-server-win-x64-cuda-12.4",
    server: serverResult("cuda"),
    media: mediaResult(),
    model: {
      id: "large-v3-q5_0",
      byteSize: 1_081_140_203,
      sha256: SHA_C,
    },
  });

  assert.deepEqual(report.acceleratorRuntime, {
    manifestSha256: SHA_B,
    artifactCount: 9,
    expandedByteSize: 1_209_487_872,
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /C:\\\\private/iu);
  assert.doesNotMatch(serialized, /serverPath/u);
  assert.doesNotMatch(serialized, /"processId"/u);
  assert.doesNotMatch(serialized, /"pid"/iu);
});

test("consumes the independent CUDA pack verifier with its root authority", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-native002b-contract-"),
  );
  const paths = targetPaths(temporaryRoot);
  const calls = [];
  try {
    const report = await runNative002WindowsSmoke({
      ...paths,
      backend: "cuda",
      platform: "win32",
      arch: "x64",
    }, {
      verifyPinnedLaunchModel: async () => ({
        model: {
          id: "large-v3-q5_0",
          byteSize: 1_081_140_203,
          sha256: SHA_C,
        },
        identity: { localOnly: true },
      }),
      verifyRuntimeBundle: async (options) => {
        calls.push(["base", options]);
        return { manifestSha256: SHA_A, launchResults: [] };
      },
      loadRuntimeManifest: async (runtimeRoot) => ({
        root: runtimeRoot,
        manifestSha256: SHA_A,
        manifest: {
          artifacts: [
            {
              id: "whisper-server-win-x64-cpu",
              kind: "server",
              backend: "cpu",
              relativePath: "server/whisper-server.exe",
            },
            {
              id: "ffmpeg-win-x64",
              kind: "ffmpeg",
              backend: "media",
              relativePath: "media/ffmpeg.exe",
            },
            {
              id: "ffprobe-win-x64",
              kind: "ffprobe",
              backend: "media",
              relativePath: "media/ffprobe.exe",
            },
          ],
        },
      }),
      resolveContainedResourcePath: (root, relativePath) =>
        path.resolve(root, relativePath),
      cudaPackContract: {
        WINDOWS_CUDA_PACK_CONTRACT: {
          packId: "local-subtitle-windows-x64-cuda-12.4-v1",
        },
        verifyWindowsCudaPack: async (options) => {
          calls.push(["cuda", options]);
          const verification = {
            manifestSha256: SHA_B,
            artifactCount: 9,
            expandedByteSize: 1_209_487_872,
            serverArtifactId: "whisper-server-win-x64-cuda-12.4",
          };
          return verification;
        },
        resolveWindowsCudaServer: (verification) => {
          calls.push(["resolve-cuda", verification]);
          return path.join(
            paths.acceleratorRuntimeRoot,
            "bin",
            "whisper-server.exe",
          );
        },
      },
      runBundledMediaSmoke: async () => mediaResult(),
      runPrivateServerSmoke: async (options) => {
        calls.push(["server", options.serverPath]);
        return serverResult("cuda");
      },
    });

    assert.equal(calls[1][0], "cuda");
    assert.deepEqual(calls[1][1], {
      runtimeRoot: paths.acceleratorRuntimeRoot,
      launch: true,
    });
    assert.equal(calls[2][0], "resolve-cuda");
    assert.equal(
      calls[3][1],
      path.join(
        paths.acceleratorRuntimeRoot,
        "bin",
        "whisper-server.exe",
      ),
    );
    assert.equal(report.acceleratorRuntime.manifestSha256, SHA_B);
    await assert.rejects(stat(paths.workRoot), { code: "ENOENT" });
    assert.doesNotMatch(JSON.stringify(report), /contract-/iu);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preserves the primary smoke failure when work-root cleanup also fails", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-native002b-cleanup-"),
  );
  const paths = targetPaths(temporaryRoot);
  const primaryError = Object.assign(
    new Error("The pinned model failed verification."),
    { code: "model_invalid" },
  );
  try {
    await assert.rejects(
      runNative002WindowsSmoke({
        runtimeRoot: paths.runtimeRoot,
        modelPath: paths.modelPath,
        workRoot: paths.workRoot,
        backend: "cpu",
        platform: "win32",
        arch: "x64",
      }, {
        verifyPinnedLaunchModel: async () => {
          throw primaryError;
        },
        removeWorkRoot: async () => {
          throw Object.assign(new Error("private cleanup path"), {
            code: "EPERM",
          });
        },
      }),
      (error) => {
        assert.equal(error, primaryError);
        assert.equal(error.code, "model_invalid");
        assert.equal(error.cleanupFailure, "work_root_cleanup_failed");
        assert.doesNotMatch(error.cleanupFailure, /private|path/iu);
        return true;
      },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("uses bounded Windows retries for smoke work-root cleanup", async () => {
  let attempts = 0;
  let delays = 0;
  await removeWindowsSmokeWorkRoot(
    path.resolve("native002b-cleanup-options"),
    async (workRoot, options) => {
      attempts += 1;
      assert.equal(
        workRoot,
        path.resolve("native002b-cleanup-options"),
      );
      assert.equal(options.recursive, true);
      assert.equal(options.force, true);
      assert.equal(options.maxRetries, 0);
      if (attempts < 3) {
        throw Object.assign(new Error("transient lock"), {
          code: "EPERM",
        });
      }
    },
    async (milliseconds) => {
      assert.equal(milliseconds, 250);
      delays += 1;
    },
  );
  assert.equal(attempts, 3);
  assert.equal(delays, 2);
});

test("preserves a command failure when capture cleanup also fails", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-native002b-command-cleanup-"),
  );
  try {
    await assert.rejects(
      runBoundedFileCommand(
        process.execPath,
        ["-e", "process.exit(7)"],
        {
          cwd: temporaryRoot,
          env: process.env,
          timeoutMs: 5_000,
          workRoot: temporaryRoot,
          label: "dual-failure regression",
          removeCaptureFile: async () => {
            throw Object.assign(new Error("private capture path"), {
              code: "EPERM",
            });
          },
        },
      ),
      (error) => {
        assert.equal(error.code, "command_failed");
        assert.equal(
          error.cleanupFailure,
          "command_capture_cleanup_failed",
        );
        assert.doesNotMatch(error.cleanupFailure, /private|path/iu);
        return true;
      },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("uses bounded Windows retries for command capture cleanup", async () => {
  let attempts = 0;
  let delays = 0;
  await removeWindowsSmokeCaptureFile(
    path.resolve("native002b-capture-cleanup.local"),
    async (capturePath) => {
      attempts += 1;
      assert.equal(
        capturePath,
        path.resolve("native002b-capture-cleanup.local"),
      );
      if (attempts < 3) {
        throw Object.assign(new Error("transient lock"), {
          code: "EBUSY",
        });
      }
    },
    async (milliseconds) => {
      assert.equal(milliseconds, 250);
      delays += 1;
    },
  );
  assert.equal(attempts, 3);
  assert.equal(delays, 2);

  let nonTransientAttempts = 0;
  await assert.rejects(
    removeWindowsSmokeCaptureFile(
      path.resolve("native002b-capture-cleanup.local"),
      async () => {
        nonTransientAttempts += 1;
        throw Object.assign(new Error("not a transient lock"), {
          code: "EISDIR",
        });
      },
      async () => {
        throw new Error("non-transient cleanup must not delay");
      },
    ),
    (error) => error?.code === "EISDIR",
  );
  assert.equal(nonTransientAttempts, 1);
});

test("preserves a health failure when server termination also fails", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-native002b-server-cleanup-"),
  );
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 2468;
  const primaryError = Object.assign(
    new Error("The private health response is invalid."),
    { code: "health_invalid" },
  );
  try {
    await assert.rejects(
      runPrivateServerSmoke({
        serverPath: path.join(temporaryRoot, "whisper-server.exe"),
        modelPath: path.join(temporaryRoot, "model.bin"),
        modelIdentity: { localOnly: true },
        workRoot: path.join(temporaryRoot, "work"),
        backend: "cpu",
        timeoutMs: 5_000,
        observeMs: 100,
        metricsIntervalMs: 25,
        sourceEnvironment: {
          SystemRoot: "C:\\Windows",
        },
        spawnImpl: () => child,
        waitForHealth: async () => {
          throw primaryError;
        },
        terminateChild: async () => {
          throw Object.assign(new Error("private server path"), {
            code: "EPERM",
          });
        },
      }),
      (error) => {
        assert.equal(error, primaryError);
        assert.equal(error.code, "health_invalid");
        assert.equal(error.cleanupFailure, "server_termination_failed");
        assert.doesNotMatch(error.cleanupFailure, /private|path/iu);
        return true;
      },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("confirms child close before cleanup succeeds", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  const result = await terminateWindowsSmokeChild(child, closed, {
    gracefulTimeoutMs: 100,
    forcedTimeoutMs: 100,
  });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(result, {
    close: { code: null, signal: "SIGTERM" },
    requestedSignal: "SIGTERM",
  });
});

test("accepts a confirmed natural close without masking the primary result", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    queueMicrotask(() => {
      child.exitCode = 1;
      child.emit("close", 1, null);
    });
    return false;
  };
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  assert.deepEqual(
    await terminateWindowsSmokeChild(child, closed, {
      gracefulTimeoutMs: 100,
      forcedTimeoutMs: 100,
    }),
    {
      close: { code: 1, signal: null },
      requestedSignal: undefined,
    },
  );
});

test("writes reports with no-clobber wx semantics", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-native002b-report-"),
  );
  try {
    const reportPath = path.join(temporaryRoot, "report.json");
    const report = buildWindowsSmokeReport({
      backend: "cpu",
      baseVerification: { launchResults: [] },
      baseManifestSha256: SHA_A,
      acceleratorVerification: null,
      serverArtifactId: "whisper-server-win-x64-cpu",
      server: serverResult("cpu"),
      media: mediaResult(),
      model: {
        id: "large-v3-q5_0",
        byteSize: 1_081_140_203,
        sha256: SHA_C,
      },
    });
    await writeWindowsSmokeReport(reportPath, report);
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).status,
      "target_smoke_passed");
    await assert.rejects(
      writeWindowsSmokeReport(reportPath, report),
      { code: "EEXIST" },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("binds launch bytes, size, hash, and file identity to the model pin", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-native002b-model-"),
  );
  try {
    const modelPath = path.join(temporaryRoot, "model.bin");
    const manifestPath = path.join(temporaryRoot, "manifest.json");
    const bytes = Buffer.from("model-bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(modelPath, bytes, { flag: "wx" });
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      engine: {
        version: "v1.9.1",
        commit: "f049fff95a089aa9969deb009cdd4892b3e74916",
      },
      models: [{
        id: "large-v3-q5_0",
        byteSize: bytes.length,
        sha256,
        defaultRecommended: true,
        bundledInInstaller: false,
      }],
    }), { flag: "wx" });

    const verified = await verifyPinnedLaunchModel(modelPath, manifestPath);
    assert.equal(verified.model.byteSize, bytes.length);
    assert.equal(verified.model.sha256, sha256);
    assert.equal(typeof verified.identity.ino, "bigint");

    await writeFile(modelPath, "changed");
    await assert.rejects(
      verifyPinnedLaunchModel(modelPath, manifestPath),
      (error) => error?.code === "model_invalid",
    );
    assert.equal(await readFile(modelPath, "utf8"), "changed");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("creates a deterministic mono 16 kHz PCM16 fixture", () => {
  const wav = createPcm16WavFixture(160);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 320);
});
