#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseNvidiaComputeApps,
  parseWindowsProcessMetrics,
} from "../whisper-server/process-metrics.mjs";
import {
  buildSanitizedRuntimeEnvironment,
  getWindowsPowerShellPath,
  loadRuntimeManifest,
  resolveContainedResourcePath,
  verifyRuntimeBundle,
} from "./runtime-manifest.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../../..");
const MODEL_MANIFEST_PATH = path.join(
  PROJECT_ROOT,
  "resources/local-subtitle/manifests/local-subtitle-models.v1.json",
);
const MAX_HEALTH_BYTES = 4 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_WORK_ROOT_CHARS = 160;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_OBSERVE_MS = 5_000;
const DEFAULT_METRICS_INTERVAL_MS = 500;
const WINDOWS_CLEANUP_RETRY_LIMIT = 20;
const WINDOWS_CLEANUP_RETRY_DELAY_MS = 250;
const WINDOWS_TRANSIENT_CLEANUP_CODES = new Set([
  "EBUSY",
  "EACCES",
  "EPERM",
]);

let commandSequence = 0;

export class WindowsTargetSmokeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : {
      cause: options.cause,
    });
    this.name = "WindowsTargetSmokeError";
    this.code = code;
  }
}

export function normalizeWindowsSmokeOptions(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "win32" || arch !== "x64") {
    throw smokeError(
      "unsupported_target",
      "NATIVE-002B target smoke requires a native win32/x64 host.",
    );
  }
  const backend = normalizeBackend(options.backend);
  const runtimeRoot = normalizeAbsolutePath(options.runtimeRoot, "runtimeRoot");
  const modelPath = normalizeAbsolutePath(options.modelPath, "modelPath");
  const workRoot = normalizeAbsolutePath(options.workRoot, "workRoot");
  const acceleratorRuntimeRoot = options.acceleratorRuntimeRoot === undefined
    ? undefined
    : normalizeAbsolutePath(
        options.acceleratorRuntimeRoot,
        "acceleratorRuntimeRoot",
      );
  if (backend === "cpu" && acceleratorRuntimeRoot !== undefined) {
    throw smokeError(
      "invalid_arguments",
      "The CPU smoke does not accept an accelerator runtime.",
    );
  }
  if (backend === "cuda" && acceleratorRuntimeRoot === undefined) {
    throw smokeError(
      "invalid_arguments",
      "The CUDA smoke requires an accelerator runtime.",
    );
  }
  if (workRoot.length > MAX_WORK_ROOT_CHARS) {
    throw smokeError(
      "invalid_arguments",
      `workRoot must not exceed ${MAX_WORK_ROOT_CHARS} characters.`,
    );
  }
  return {
    platform,
    arch,
    backend,
    runtimeRoot,
    modelPath,
    workRoot,
    acceleratorRuntimeRoot,
    timeoutMs: normalizeIntegerOption(
      options.timeoutMs,
      "timeoutMs",
      5_000,
      10 * 60_000,
      DEFAULT_TIMEOUT_MS,
    ),
    observeMs: normalizeIntegerOption(
      options.observeMs,
      "observeMs",
      100,
      60_000,
      DEFAULT_OBSERVE_MS,
    ),
    metricsIntervalMs: normalizeIntegerOption(
      options.metricsIntervalMs,
      "metricsIntervalMs",
      25,
      5_000,
      DEFAULT_METRICS_INTERVAL_MS,
    ),
    modelManifestPath: options.modelManifestPath,
  };
}

export async function runNative002WindowsSmoke(options, dependencies = {}) {
  const normalized = normalizeWindowsSmokeOptions(options);
  await assertMissing(
    normalized.workRoot,
    "The NATIVE-002B smoke work directory already exists.",
  );
  await mkdir(normalized.workRoot, { recursive: true });

  const verifyModel =
    dependencies.verifyPinnedLaunchModel ?? verifyPinnedLaunchModel;
  const verifyBaseRuntime =
    dependencies.verifyRuntimeBundle ?? verifyRuntimeBundle;
  const loadBaseRuntime =
    dependencies.loadRuntimeManifest ?? loadRuntimeManifest;
  const resolveBasePath =
    dependencies.resolveContainedResourcePath ?? resolveContainedResourcePath;
  const runMedia =
    dependencies.runBundledMediaSmoke ?? runBundledMediaSmoke;
  const runServer =
    dependencies.runPrivateServerSmoke ?? runPrivateServerSmoke;
  const removeWorkRoot =
    dependencies.removeWorkRoot ?? removeWindowsSmokeWorkRoot;

  let report;
  let operationError;
  let cleanupError;
  try {
    const verifiedModel = await verifyModel(
      normalized.modelPath,
      normalized.modelManifestPath,
    );
    const baseVerification = await verifyBaseRuntime({
      runtimeRoot: normalized.runtimeRoot,
      platform: "win32",
      arch: "x64",
      scope: "all",
      launch: true,
    });
    const loadedBase = await loadBaseRuntime(normalized.runtimeRoot, {
      platform: "win32",
      arch: "x64",
    });
    const cpuServerArtifact = requireArtifact(
      loadedBase.manifest,
      "server",
      "cpu",
    );
    const ffmpegArtifact = requireArtifact(
      loadedBase.manifest,
      "ffmpeg",
      "media",
    );
    const ffprobeArtifact = requireArtifact(
      loadedBase.manifest,
      "ffprobe",
      "media",
    );
    const ffmpegPath = resolveBasePath(
      loadedBase.root,
      ffmpegArtifact.relativePath,
    );
    const ffprobePath = resolveBasePath(
      loadedBase.root,
      ffprobeArtifact.relativePath,
    );

    let acceleratorVerification = null;
    let serverArtifactId = cpuServerArtifact.id;
    let serverPath = resolveBasePath(
      loadedBase.root,
      cpuServerArtifact.relativePath,
    );
    if (normalized.backend === "cuda") {
      const cudaContract = dependencies.cudaPackContract ??
        await loadDefaultCudaPackContract();
      acceleratorVerification = await cudaContract.verifyWindowsCudaPack({
        runtimeRoot: normalized.acceleratorRuntimeRoot,
        launch: true,
      });
      serverPath = cudaContract.resolveWindowsCudaServer(
        acceleratorVerification,
      );
      if (
        typeof serverPath !== "string" ||
        !path.isAbsolute(serverPath)
      ) {
        throw smokeError(
          "accelerator_invalid",
          "The CUDA pack contract returned an invalid server authority.",
        );
      }
      serverArtifactId = acceleratorVerification.serverArtifactId;
    }

    const media = await runMedia({
      ffmpegPath,
      ffprobePath,
      workRoot: path.join(normalized.workRoot, "media"),
      timeoutMs: normalized.timeoutMs,
      sourceEnvironment: dependencies.sourceEnvironment,
      commandRunner: dependencies.commandRunner,
    });
    const server = await runServer({
      serverPath,
      modelPath: normalized.modelPath,
      modelIdentity: verifiedModel.identity,
      workRoot: path.join(normalized.workRoot, "server"),
      backend: normalized.backend,
      timeoutMs: normalized.timeoutMs,
      observeMs: normalized.observeMs,
      metricsIntervalMs: normalized.metricsIntervalMs,
      sourceEnvironment: dependencies.sourceEnvironment,
      spawnImpl: dependencies.spawnImpl,
      metricsCollector: dependencies.metricsCollector,
      commandRunner: dependencies.commandRunner,
    });

    report = buildWindowsSmokeReport({
      backend: normalized.backend,
      baseVerification,
      baseManifestSha256:
        loadedBase.manifestSha256 ?? baseVerification.manifestSha256,
      acceleratorVerification,
      serverArtifactId,
      server,
      media,
      model: verifiedModel.model,
    });
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await removeWorkRoot(normalized.workRoot);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (operationError) {
    attachStableCleanupFailure(
      operationError,
      cleanupError,
      "work_root_cleanup_failed",
    );
    throw operationError;
  }
  if (cleanupError) {
    throw smokeError(
      "cleanup_failed",
      "The NATIVE-002B smoke work directory cleanup could not be confirmed.",
    );
  }
  return report;
}

export async function removeWindowsSmokeWorkRoot(
  workRoot,
  rmImpl = rm,
  delayImpl = delay,
) {
  const normalizedWorkRoot = normalizeAbsolutePath(workRoot, "workRoot");
  await retryWindowsCleanup(
    () => rmImpl(normalizedWorkRoot, {
      recursive: true,
      force: true,
      maxRetries: 0,
    }),
    delayImpl,
  );
}

export function buildWindowsSmokeReport(input) {
  const backend = normalizeBackend(input.backend);
  const server = sanitizeServerEvidence(backend, input.server);
  const report = {
    schemaVersion: 1,
    workPackage: "NATIVE-002B",
    target: { platform: "win32", arch: "x64" },
    profile: {
      backend,
      delivery: backend === "cuda"
        ? "on_demand_accelerator"
        : "base_runtime",
    },
    status: "target_smoke_passed",
    baseRuntime: {
      manifestSha256: requireSha256(
        input.baseManifestSha256,
        "base runtime manifest",
      ),
      artifactLaunchResults: sanitizeLaunchResults(
        input.baseVerification?.launchResults,
      ),
    },
    acceleratorRuntime: backend === "cuda"
      ? sanitizeAcceleratorVerification(input.acceleratorVerification)
      : null,
    server: {
      artifactId: requirePublicId(input.serverArtifactId, "server artifact"),
      ...server,
    },
    media: sanitizeMediaResult(input.media),
    model: {
      id: requirePublicId(input.model?.id, "model"),
      byteSize: requirePositiveSafeInteger(
        input.model?.byteSize,
        "model byteSize",
      ),
      sha256: requireSha256(input.model?.sha256, "model"),
      bundledInInstaller: false,
    },
    noPathFallback: true,
    cudaToolkitPathUsed: false,
    productionPathDirectoryOnly: true,
    controlledWorkingDirectories: true,
    privateLoopbackHealth: true,
    cleanup: {
      serverProcessesClosed: true,
      temporaryFilesRemoved: true,
      commandCaptureFilesRemoved: true,
    },
    privacy: {
      absolutePathsRecorded: false,
      processIdRecorded: false,
      privateRouteRecorded: false,
      rawDiagnosticsRecorded: false,
    },
  };
  assertReportPrivacy(report);
  return deepFreeze(report);
}

export async function verifyPinnedLaunchModel(
  modelPath,
  manifestPath = MODEL_MANIFEST_PATH,
) {
  const absoluteModelPath = normalizeAbsolutePath(modelPath, "modelPath");
  const manifest = JSON.parse(
    await readFile(path.resolve(manifestPath), "utf8"),
  );
  const model = manifest?.models?.find(
    (candidate) => candidate.id === "large-v3-q5_0",
  );
  const before = await lstat(absoluteModelPath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw smokeError(
      "model_invalid",
      "The NATIVE-002B launch model must be a regular file.",
    );
  }
  let handle;
  let opened;
  let completed;
  let sha256;
  try {
    handle = await open(
      absoluteModelPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    opened = await handle.stat({ bigint: true });
    assertSameFileIdentity(before, opened);
    sha256 = await hashOpenFile(handle);
    completed = await handle.stat({ bigint: true });
    assertSameFileIdentity(opened, completed);
  } finally {
    await handle?.close();
  }
  const after = await lstat(absoluteModelPath, { bigint: true });
  assertSameFileIdentity(completed, after);
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.engine?.version !== "v1.9.1" ||
    manifest.engine?.commit !==
      "f049fff95a089aa9969deb009cdd4892b3e74916" ||
    !model ||
    model.defaultRecommended !== true ||
    model.bundledInInstaller !== false ||
    opened.size !== BigInt(model.byteSize) ||
    sha256 !== model.sha256
  ) {
    throw smokeError(
      "model_invalid",
      "The NATIVE-002B launch model does not match its manifest.",
    );
  }
  return { model, identity: completed };
}

export function createPcm16WavFixture(sampleCount = 1_600) {
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
    throw new TypeError("sampleCount must be a positive safe integer.");
  }
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(
      Math.round(Math.sin(index / 12) * 8_000),
      44 + index * 2,
    );
  }
  return buffer;
}

export function parseExactHealthResponse(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_HEALTH_BYTES
  ) {
    throw smokeError(
      "health_invalid",
      "The private health response size is invalid.",
    );
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw smokeError(
      "health_invalid",
      "The private health response is not JSON.",
    );
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    value.status !== "ok"
  ) {
    throw smokeError(
      "health_invalid",
      "The private health response does not match the contract.",
    );
  }
  return true;
}

export function createWindowsSmokeEnvironment(options = {}) {
  const source = options.sourceEnvironment ?? process.env;
  const base = buildSanitizedRuntimeEnvironment("win32", source);
  const systemRoot = base.SystemRoot;
  const executableDirectories = Array.isArray(options.executableDirectories)
    ? options.executableDirectories.map((directory) =>
        normalizeAbsolutePath(directory, "executableDirectory"))
    : [];
  const systemDirectory = path.join(systemRoot, "System32");
  const environment = {
    ...base,
    PATH: uniqueWindowsPaths([
      ...executableDirectories,
      systemDirectory,
    ]).join(path.delimiter),
    TEMP: normalizeAbsolutePath(options.tempDirectory, "tempDirectory"),
    TMP: normalizeAbsolutePath(options.tempDirectory, "tempDirectory"),
  };
  return environment;
}

export async function runBundledMediaSmoke(options) {
  const workRoot = normalizeAbsolutePath(options.workRoot, "workRoot");
  await mkdir(workRoot, { recursive: true });
  const inputPath = path.join(workRoot, "input.wav");
  const outputPath = path.join(workRoot, "normalized.wav");
  await writeFile(inputPath, createPcm16WavFixture(), {
    flag: "wx",
    mode: 0o600,
  });
  const environment = createWindowsSmokeEnvironment({
    executableDirectories: [],
    tempDirectory: workRoot,
    sourceEnvironment: options.sourceEnvironment,
  });
  for (const fileName of ["ffmpeg.exe", "ffprobe.exe"]) {
    if (await findExecutableOnPath(fileName, environment)) {
      throw smokeError(
        "path_fallback",
        "The sanitized smoke environment can resolve a media executable.",
      );
    }
  }
  const runner = options.commandRunner ?? runBoundedFileCommand;
  await runner(
    options.ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      outputPath,
    ],
    {
      cwd: workRoot,
      env: environment,
      timeoutMs: options.timeoutMs,
      workRoot,
      label: "ffmpeg",
    },
  );
  const probe = await runner(
    options.ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,sample_rate,channels",
      "-of",
      "json",
      outputPath,
    ],
    {
      cwd: workRoot,
      env: environment,
      timeoutMs: options.timeoutMs,
      workRoot,
      label: "ffprobe",
    },
  );
  let parsed;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    throw smokeError(
      "media_failed",
      "The bundled ffprobe returned invalid JSON.",
    );
  }
  const stream = parsed?.streams?.[0];
  if (
    stream?.codec_name !== "pcm_s16le" ||
    stream?.sample_rate !== "16000" ||
    stream?.channels !== 1
  ) {
    throw smokeError(
      "media_failed",
      "The bundled media runtime failed its PCM16 decode contract.",
    );
  }
  return {
    ffmpegIdentityMatched: true,
    ffprobeIdentityMatched: true,
    pcm16DecodePassed: true,
    sampleRate: 16_000,
    channels: 1,
  };
}

export async function runPrivateServerSmoke(options) {
  const workRoot = normalizeAbsolutePath(options.workRoot, "workRoot");
  await mkdir(workRoot, { recursive: true });
  const publicDirectory = path.join(workRoot, "public");
  const temporaryDirectory = path.join(workRoot, "tmp");
  await Promise.all([
    mkdir(publicDirectory, { mode: 0o700 }),
    mkdir(temporaryDirectory, { mode: 0o700 }),
  ]);
  const backend = normalizeBackend(options.backend);
  const port = await reserveLoopbackPort();
  const privatePath = `/fusionkit-${randomBytes(24).toString("hex")}`;
  const launch = createWindowsServerLaunch({
    ...options,
    backend,
    port,
    privatePath,
    publicDirectory,
    temporaryDirectory,
  });
  const environment = launch.spawnOptions.env;
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(
    launch.serverPath,
    launch.args,
    launch.spawnOptions,
  );
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  const captures = [child.stdout, child.stderr]
    .filter(Boolean)
    .map((stream) => {
      const capture = createBoundedDiagnosticCapture(
        MAX_DIAGNOSTIC_BYTES / 2,
      );
      stream.on("data", (chunk) => capture.write(chunk));
      stream.once("error", (error) => capture.fail(error));
      return capture;
    });
  const waitForHealth = options.waitForHealth ?? waitForPrivateHealth;
  const terminateChild =
    options.terminateChild ?? terminateWindowsSmokeChild;
  let finalizationStarted = false;
  let result;
  let operationError;
  let cleanupError;
  try {
    const started = performance.now();
    await waitForHealth({
      child,
      getSpawnError: () => spawnError,
      port,
      requestPath: `${privatePath}/health`,
      timeoutMs: options.timeoutMs,
    });
    const modelLoadFirstMs = Math.round(performance.now() - started);
    await assertCurrentModelIdentity(options.modelPath, options.modelIdentity);
    const collectMetrics = options.metricsCollector ??
      collectWindowsBackendEvidence;
    const rawEvidence = backend === "cuda"
      ? await collectMetrics({
          processId: child.pid,
          workRoot,
          environment,
          observeMs: options.observeMs,
          intervalMs: options.metricsIntervalMs,
          commandRunner: options.commandRunner,
          isProcessAlive: () =>
            child.exitCode === null && child.signalCode === null,
        })
      : {
          backend: "cpu",
          exactProcessIdMatched: true,
          sampleCount: 0,
          peakRamBytes: undefined,
          peakVramBytes: null,
          backendEvidence: "official-server-no-gpu-flag",
          backendVerified: true,
        };
    const evidence = assertBackendEvidence(backend, rawEvidence);
    finalizationStarted = true;
    result = await finalizeHealthyServerSmoke({
      child,
      closed,
      backend,
      evidence,
      captures,
      modelLoadFirstMs,
    });
  } catch (error) {
    operationError = error;
  } finally {
    if (!finalizationStarted) {
      try {
        await terminateChild(child, closed);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (operationError) {
    attachStableCleanupFailure(
      operationError,
      cleanupError,
      "server_termination_failed",
    );
    throw operationError;
  }
  if (cleanupError) {
    throw smokeError(
      "cleanup_failed",
      "The whisper-server termination could not be confirmed.",
    );
  }
  return result;
}

export function createWindowsServerLaunch(options) {
  const backend = normalizeBackend(options.backend);
  const serverPath = normalizeAbsolutePath(options.serverPath, "serverPath");
  const modelPath = normalizeAbsolutePath(options.modelPath, "modelPath");
  const publicDirectory = normalizeAbsolutePath(
    options.publicDirectory,
    "publicDirectory",
  );
  const temporaryDirectory = normalizeAbsolutePath(
    options.temporaryDirectory,
    "temporaryDirectory",
  );
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65_535
  ) {
    throw smokeError(
      "invalid_arguments",
      "The private server port is invalid.",
    );
  }
  if (
    typeof options.privatePath !== "string" ||
    !/^\/fusionkit-[a-f0-9]{48}$/u.test(options.privatePath)
  ) {
    throw smokeError(
      "invalid_arguments",
      "The private server request path is invalid.",
    );
  }
  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    String(options.port),
    "--request-path",
    options.privatePath,
    "--inference-path",
    "/inference",
    "--public",
    publicDirectory,
    "--tmp-dir",
    temporaryDirectory,
    "--model",
    modelPath,
    "--threads",
    "4",
    "--processors",
    "1",
    ...(backend === "cpu" ? ["--no-gpu"] : []),
  ];
  return {
    serverPath,
    args,
    spawnOptions: {
      cwd: path.dirname(serverPath),
      env: createWindowsSmokeEnvironment({
        executableDirectories: [path.dirname(serverPath)],
        tempDirectory: temporaryDirectory,
        sourceEnvironment: options.sourceEnvironment,
      }),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}

export async function finalizeHealthyServerSmoke(options) {
  const aliveBeforeTermination =
    options.child.exitCode === null && options.child.signalCode === null;
  const termination = await terminateWindowsSmokeChild(
    options.child,
    options.closed,
  );
  if (!aliveBeforeTermination || termination.requestedSignal === undefined) {
    throw smokeError(
      "server_exit",
      "The whisper-server exited unexpectedly after private health.",
    );
  }
  const summaries = options.captures.map((capture) => capture.summary());
  if (
    summaries.some(
      (summary) =>
        summary.streamFailed || summary.diagnosticsBounded !== true,
    )
  ) {
    throw smokeError(
      "diagnostics_failed",
      "The whisper-server diagnostic stream did not settle safely.",
    );
  }
  return {
    backend: options.backend,
    healthStatus: "ok",
    loopbackOnly: true,
    privatePathUsed: true,
    modelLoaded: true,
    modelLoadFirstMs: options.modelLoadFirstMs,
    exitedBeforeHealth: false,
    diagnosticsBounded: true,
    backendEvidence: options.evidence.backendEvidence,
    backendVerified: true,
    backendEvidenceDetails: {
      exactProcessIdMatched: options.evidence.exactProcessIdMatched,
      sampleCount: options.evidence.sampleCount,
      peakRamBytes: options.evidence.peakRamBytes,
      peakVramBytes: options.evidence.peakVramBytes,
    },
  };
}

export async function waitForPrivateHealth(options) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (options.getSpawnError()) {
      throw smokeError(
        "launch_failed",
        "The whisper-server could not be spawned.",
      );
    }
    if (
      options.child.exitCode !== null ||
      options.child.signalCode !== null
    ) {
      throw smokeError(
        "server_exit",
        "The whisper-server exited before private health was ready.",
      );
    }
    try {
      const response = await requestHealth(
        options.port,
        options.requestPath,
        deadline,
      );
      if (response.statusCode === 200) {
        if (!/^application\/json(?:;|$)/iu.test(response.contentType ?? "")) {
          throw smokeError(
            "health_invalid",
            "The private health content type is invalid.",
          );
        }
        parseExactHealthResponse(response.body);
        return;
      }
      if (response.statusCode !== 503) {
        throw smokeError(
          "health_invalid",
          "The private health endpoint returned an invalid status.",
        );
      }
    } catch (error) {
      if (!isRetryableHealthError(error)) throw error;
    }
    await delay(200);
  }
  throw smokeError(
    "health_timeout",
    "The private health endpoint did not become ready in time.",
  );
}

export function assertBackendEvidence(backend, evidence) {
  const normalized = normalizeBackend(backend);
  if (normalized === "cpu") {
    if (
      evidence?.backendVerified !== true ||
      evidence?.backendEvidence !== "official-server-no-gpu-flag"
    ) {
      throw smokeError(
        "backend_unverified",
        "The CPU backend evidence is invalid.",
      );
    }
    return {
      ...evidence,
      exactProcessIdMatched: true,
      peakVramBytes: null,
    };
  }
  if (
    evidence?.backendVerified !== true ||
    evidence?.exactProcessIdMatched !== true ||
    !Number.isSafeInteger(evidence?.sampleCount) ||
    evidence.sampleCount <= 0 ||
    !Number.isFinite(evidence?.peakVramBytes) ||
    evidence.peakVramBytes <= 0
  ) {
    throw smokeError(
      "backend_unverified",
      "CUDA health succeeded without positive exact-PID VRAM evidence.",
    );
  }
  return {
    ...evidence,
    backendEvidence:
      "exact-pid-windows-gpu-process-memory-counter-with-nvidia-smi-fallback",
    backendVerified: true,
  };
}

export async function collectWindowsBackendEvidence(options) {
  if (
    !Number.isInteger(options.processId) ||
    options.processId <= 0
  ) {
    throw smokeError(
      "backend_unverified",
      "The CUDA server process ID is unavailable.",
    );
  }
  const runner = options.commandRunner ?? runBoundedFileCommand;
  const powershellPath = getWindowsPowerShellPath(options.environment);
  const nvidiaSmiPath = await resolveNvidiaSmiPath(options.environment);
  const deadline = Date.now() + options.observeMs;
  let sampleCount = 0;
  let peakRamBytes = 0;
  let peakVramBytes = 0;
  do {
    if (options.isProcessAlive?.() === false) {
      throw smokeError(
        "server_exit",
        "The CUDA server exited during backend attestation.",
      );
    }
    const processMetrics = await sampleWindowsProcessMetrics({
      processId: options.processId,
      powershellPath,
      workRoot: options.workRoot,
      environment: options.environment,
      commandRunner: runner,
    });
    let observed = false;
    if (Number.isFinite(processMetrics?.ramBytes)) {
      peakRamBytes = Math.max(peakRamBytes, processMetrics.ramBytes);
      observed = true;
    }
    if (Number.isFinite(processMetrics?.vramBytes)) {
      peakVramBytes = Math.max(peakVramBytes, processMetrics.vramBytes);
      observed = true;
    }
    if (peakVramBytes <= 0 && nvidiaSmiPath) {
      const fallback = await sampleNvidiaProcessMemory({
        processId: options.processId,
        nvidiaSmiPath,
        workRoot: options.workRoot,
        environment: options.environment,
        commandRunner: runner,
      });
      if (Number.isFinite(fallback)) {
        peakVramBytes = Math.max(peakVramBytes, fallback);
        observed = true;
      }
    }
    if (observed) sampleCount += 1;
    if (Date.now() >= deadline) break;
    await delay(
      Math.min(options.intervalMs, Math.max(1, deadline - Date.now())),
    );
  } while (true);

  return {
    backend: "cuda",
    exactProcessIdMatched: peakVramBytes > 0,
    sampleCount,
    peakRamBytes: peakRamBytes || undefined,
    peakVramBytes,
    backendEvidence:
      "exact-pid-windows-gpu-process-memory-counter-with-nvidia-smi-fallback",
    backendVerified: peakVramBytes > 0,
  };
}

export async function runBoundedFileCommand(command, args, options) {
  const workRoot = normalizeAbsolutePath(options.workRoot, "workRoot");
  commandSequence += 1;
  const stem = path.join(
    workRoot,
    `.fusionkit-native002b-${process.pid}-${commandSequence}`,
  );
  const stdoutPath = `${stem}.stdout.local`;
  const stderrPath = `${stem}.stderr.local`;
  const closeDescriptor = options.closeDescriptor ?? closeSync;
  const removeCaptureFile =
    options.removeCaptureFile ?? removeWindowsSmokeCaptureFile;
  let stdoutDescriptor;
  let stderrDescriptor;
  let output;
  let operationError;
  let cleanupError;
  try {
    stdoutDescriptor = openSync(stdoutPath, "wx");
    stderrDescriptor = openSync(stderrPath, "wx");
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", stdoutDescriptor, stderrDescriptor],
    });
    closeDescriptor(stdoutDescriptor);
    stdoutDescriptor = undefined;
    closeDescriptor(stderrDescriptor);
    stderrDescriptor = undefined;
    if (
      statSync(stdoutPath).size > MAX_COMMAND_OUTPUT_BYTES ||
      statSync(stderrPath).size > MAX_COMMAND_OUTPUT_BYTES
    ) {
      throw smokeError(
        "output_exceeded",
        "A NATIVE-002B command exceeded its output limit.",
      );
    }
    const normalized = {
      exitCode: Number.isInteger(result.status) ? result.status : null,
      signal: result.signal ?? null,
      stdout: readFileSync(stdoutPath, "utf8"),
      stderr: readFileSync(stderrPath, "utf8"),
    };
    if (
      result.error ||
      (
        normalized.exitCode !== 0 &&
        options.allowFailure !== true
      )
    ) {
      throw smokeError(
        result.error?.code === "ETIMEDOUT"
          ? "command_timeout"
          : "command_failed",
        `The ${options.label ?? "native"} smoke command failed.`,
      );
    }
    output = normalized;
  } catch (error) {
    operationError = error;
  } finally {
    for (const descriptor of [stdoutDescriptor, stderrDescriptor]) {
      if (descriptor === undefined) continue;
      try {
        closeDescriptor(descriptor);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    for (const capturePath of [stdoutPath, stderrPath]) {
      try {
        await removeCaptureFile(capturePath);
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }
  if (operationError) {
    attachStableCleanupFailure(
      operationError,
      cleanupError,
      "command_capture_cleanup_failed",
    );
    throw operationError;
  }
  if (cleanupError) {
    throw smokeError(
      "cleanup_failed",
      "A NATIVE-002B command capture cleanup could not be confirmed.",
    );
  }
  return output;
}

export async function removeWindowsSmokeCaptureFile(
  capturePath,
  unlinkImpl = unlink,
  delayImpl = delay,
) {
  const normalizedCapturePath = normalizeAbsolutePath(
    capturePath,
    "capturePath",
  );
  await retryWindowsCleanup(
    () => unlinkImpl(normalizedCapturePath),
    delayImpl,
  );
}

export async function terminateWindowsSmokeChild(
  child,
  closed,
  options = {},
) {
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5_000;
  const forcedTimeoutMs = options.forcedTimeoutMs ?? 5_000;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!await waitForCloseWithin(closed, gracefulTimeoutMs)) {
      throw smokeError(
        "cleanup_failed",
        "The whisper-server close event was not confirmed.",
      );
    }
    return { close: await closed, requestedSignal: undefined };
  }
  let requestedSignal;
  if (child.kill("SIGTERM")) requestedSignal = "SIGTERM";
  if (!await waitForCloseWithin(closed, gracefulTimeoutMs)) {
    if (child.kill("SIGKILL")) requestedSignal = "SIGKILL";
    if (!await waitForCloseWithin(closed, forcedTimeoutMs)) {
      throw smokeError(
        "cleanup_failed",
        "The whisper-server could not confirm close after forced termination.",
      );
    }
  }
  return { close: await closed, requestedSignal };
}

function createBoundedDiagnosticCapture(maxRetainedBytes) {
  let retained = Buffer.alloc(0);
  let observedBytes = 0;
  let streamFailed = false;
  return {
    write(value) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      observedBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        observedBytes + bytes.length,
      );
      retained = Buffer.from(
        Buffer.concat([retained, bytes]).subarray(-maxRetainedBytes),
      );
    },
    fail() {
      streamFailed = true;
    },
    summary() {
      return {
        diagnosticsBounded: retained.length <= maxRetainedBytes,
        diagnosticBytesObserved: observedBytes,
        diagnosticBytesRetained: retained.length,
        diagnosticsTruncated: observedBytes > retained.length,
        streamFailed,
      };
    },
  };
}

async function sampleWindowsProcessMetrics(options) {
  const command =
    `$p = Get-Process -Id ${options.processId} -ErrorAction SilentlyContinue; ` +
    "if ($null -ne $p) { " +
    `$prefix = 'pid_${options.processId}_'; ` +
    "$gpuSamples = @((Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples | " +
    "Where-Object { $_.InstanceName.StartsWith($prefix) }); " +
    "$gpu = $gpuSamples | Measure-Object CookedValue -Sum; " +
    "$gpuBytes = if ($gpuSamples.Count -eq 0) { -1 } else { [long]$gpu.Sum }; " +
    "[Console]::Out.Write(('{0},{1}' -f [long]$p.WorkingSet64, $gpuBytes)) }";
  try {
    const result = await options.commandRunner(
      options.powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        command,
      ],
      {
        cwd: path.dirname(options.powershellPath),
        env: options.environment,
        timeoutMs: 5_000,
        workRoot: options.workRoot,
        label: "process metrics",
        allowFailure: true,
      },
    );
    if (result.exitCode !== 0) return undefined;
    return parseWindowsProcessMetrics(result.stdout, true);
  } catch {
    return undefined;
  }
}

async function sampleNvidiaProcessMemory(options) {
  try {
    const result = await options.commandRunner(
      options.nvidiaSmiPath,
      [
        "--query-compute-apps=pid,used_gpu_memory",
        "--format=csv,noheader,nounits",
      ],
      {
        cwd: path.dirname(options.nvidiaSmiPath),
        env: options.environment,
        timeoutMs: 5_000,
        workRoot: options.workRoot,
        label: "NVIDIA process metrics",
        allowFailure: true,
      },
    );
    if (result.exitCode !== 0) return undefined;
    return parseNvidiaComputeApps(result.stdout, options.processId);
  } catch {
    return undefined;
  }
}

async function resolveNvidiaSmiPath(environment) {
  const candidates = [
    path.join(environment.SystemRoot, "System32", "nvidia-smi.exe"),
    environment.ProgramFiles
      ? path.join(
          environment.ProgramFiles,
          "NVIDIA Corporation",
          "NVSMI",
          "nvidia-smi.exe",
        )
      : undefined,
    environment.ProgramW6432
      ? path.join(
          environment.ProgramW6432,
          "NVIDIA Corporation",
          "NVSMI",
          "nvidia-smi.exe",
        )
      : undefined,
  ].filter(Boolean);
  for (const candidate of uniqueWindowsPaths(candidates)) {
    try {
      const proof = await stat(candidate);
      if (proof.isFile()) return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
  }
  return undefined;
}

async function findExecutableOnPath(fileName, environment) {
  const searchPath = environment.PATH;
  if (typeof searchPath !== "string" || searchPath === "") return null;
  const extensions = path.extname(fileName) === ""
    ? String(environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
    : [""];
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${fileName}${extension}`);
      try {
        const proof = await stat(candidate);
        if (proof.isFile()) return candidate;
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      }
    }
  }
  return null;
}

function requestHealth(port, requestPath, deadline) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
        headers: { Accept: "application/json" },
      },
      (response) => {
        const chunks = [];
        let total = 0;
        response.once("error", settleReject);
        response.once("aborted", () =>
          settleReject(new Error("health_aborted")));
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > MAX_HEALTH_BYTES) {
            response.destroy(
              smokeError(
                "health_invalid",
                "The private health response is too large.",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            statusCode: response.statusCode,
            contentType: response.headers["content-type"],
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("health_timeout")),
      Math.max(1, Math.min(2_000, deadline - Date.now())),
    );
    req.once("close", () => clearTimeout(timer));
    req.once("error", settleReject);
    req.end();
  });
}

async function loadDefaultCudaPackContract() {
  let contract;
  try {
    contract = await import("./windows-cuda-pack-contract.mjs");
  } catch (error) {
    throw smokeError(
      "accelerator_invalid",
      "The Windows CUDA pack contract is unavailable.",
      error,
    );
  }
  if (
    typeof contract.verifyWindowsCudaPack !== "function" ||
    typeof contract.resolveWindowsCudaServer !== "function" ||
    contract.WINDOWS_CUDA_PACK_CONTRACT === null ||
    typeof contract.WINDOWS_CUDA_PACK_CONTRACT !== "object"
  ) {
    throw smokeError(
      "accelerator_invalid",
      "The Windows CUDA pack contract exports are invalid.",
    );
  }
  return contract;
}

function sanitizeServerEvidence(backend, value) {
  if (
    value?.backend !== backend ||
    value.healthStatus !== "ok" ||
    value.loopbackOnly !== true ||
    value.privatePathUsed !== true ||
    value.modelLoaded !== true ||
    value.exitedBeforeHealth !== false ||
    value.diagnosticsBounded !== true ||
    value.backendVerified !== true
  ) {
    throw smokeError(
      "invalid_result",
      "The server smoke result is invalid.",
    );
  }
  const evidence = assertBackendEvidence(
    backend,
    {
      ...value.backendEvidenceDetails,
      backendEvidence: value.backendEvidence,
      backendVerified: value.backendVerified,
    },
  );
  return {
    backend,
    healthStatus: "ok",
    loopbackOnly: true,
    privatePathUsed: true,
    modelLoaded: true,
    modelLoadFirstMs: requireNonNegativeSafeInteger(
      value.modelLoadFirstMs,
      "modelLoadFirstMs",
    ),
    exitedBeforeHealth: false,
    diagnosticsBounded: true,
    backendEvidence: evidence.backendEvidence,
    backendVerified: true,
    backendEvidenceDetails: {
      exactProcessIdMatched: true,
      sampleCount: requireNonNegativeSafeInteger(
        evidence.sampleCount,
        "backend sampleCount",
      ),
      peakRamBytes: evidence.peakRamBytes === undefined ||
          evidence.peakRamBytes === null
        ? null
        : requireNonNegativeSafeInteger(
            evidence.peakRamBytes,
            "backend peakRamBytes",
          ),
      peakVramBytes: evidence.peakVramBytes === null
        ? null
        : requirePositiveSafeInteger(
            evidence.peakVramBytes,
            "backend peakVramBytes",
          ),
    },
  };
}

function sanitizeMediaResult(value) {
  if (
    value?.ffmpegIdentityMatched !== true ||
    value.ffprobeIdentityMatched !== true ||
    value.pcm16DecodePassed !== true ||
    value.sampleRate !== 16_000 ||
    value.channels !== 1
  ) {
    throw smokeError(
      "invalid_result",
      "The media smoke result is invalid.",
    );
  }
  return {
    ffmpegIdentityMatched: true,
    ffprobeIdentityMatched: true,
    pcm16DecodePassed: true,
    sampleRate: 16_000,
    channels: 1,
  };
}

function sanitizeAcceleratorVerification(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw smokeError(
      "accelerator_invalid",
      "The CUDA pack verification result is invalid.",
    );
  }
  return {
    manifestSha256: requireSha256(
      value.manifestSha256,
      "accelerator manifest",
    ),
    artifactCount: requirePositiveSafeInteger(
      value.artifactCount,
      "accelerator artifactCount",
    ),
    expandedByteSize: requirePositiveSafeInteger(
      value.expandedByteSize,
      "accelerator expandedByteSize",
    ),
  };
}

function sanitizeLaunchResults(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.kind !== "string" ||
      entry.versionMatched !== true ||
      entry.exitCode !== 0
    ) {
      throw smokeError(
        "invalid_result",
        "A runtime launch result is invalid.",
      );
    }
    return {
      id: requirePublicId(entry.id, "artifact"),
      kind: requirePublicId(entry.kind, "artifact kind"),
      versionMatched: true,
      exitCode: 0,
    };
  });
}

function assertReportPrivacy(report) {
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    /[A-Za-z]:[\\/]/u,
    /\/fusionkit-[a-f0-9]{16,}/iu,
    /"processId"/u,
    /"pid"/iu,
    /OPENAI_API_KEY|HTTPS?_PROXY|CUDA_PATH/iu,
  ]) {
    if (forbidden.test(serialized)) {
      throw smokeError(
        "privacy_failed",
        "The NATIVE-002B report contains private runtime data.",
      );
    }
  }
}

function requireArtifact(manifest, kind, backend) {
  const artifact = manifest?.artifacts?.find(
    (candidate) =>
      candidate.kind === kind &&
      (backend === undefined || candidate.backend === backend),
  );
  if (!artifact) {
    throw smokeError(
      "runtime_invalid",
      `The runtime manifest is missing the ${kind} artifact.`,
    );
  }
  return artifact;
}

async function hashOpenFile(handle) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      position,
    );
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function assertSameFileIdentity(expected, actual) {
  if (
    !expected ||
    !actual ||
    !actual.isFile() ||
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.size !== actual.size ||
    expected.mtimeNs !== actual.mtimeNs ||
    expected.ctimeNs !== actual.ctimeNs
  ) {
    throw smokeError(
      "model_changed",
      "The NATIVE-002B launch model changed during verification.",
    );
  }
}

async function assertCurrentModelIdentity(modelPath, expected) {
  const current = await lstat(modelPath, { bigint: true });
  if (current.isSymbolicLink()) {
    throw smokeError(
      "model_changed",
      "The NATIVE-002B launch model changed during private health.",
    );
  }
  assertSameFileIdentity(expected, current);
}

async function assertMissing(filePath, message) {
  try {
    await stat(filePath);
    throw smokeError("work_exists", message);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function normalizeBackend(value) {
  if (value === undefined) return "cpu";
  if (value !== "cpu" && value !== "cuda") {
    throw smokeError(
      "invalid_arguments",
      "backend must be cpu or cuda.",
    );
  }
  return value;
}

function normalizeIntegerOption(value, label, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw smokeError(
      "invalid_arguments",
      `${label} must be between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function normalizeAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw smokeError(
      "invalid_arguments",
      `${label} must be an absolute path.`,
    );
  }
  return path.normalize(value);
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw smokeError(
      "invalid_result",
      `${label} SHA-256 is invalid.`,
    );
  }
  return value;
}

function requirePublicId(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._+-]+$/u.test(value)
  ) {
    throw smokeError(
      "invalid_result",
      `${label} identifier is invalid.`,
    );
  }
  return value;
}

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw smokeError("invalid_result", `${label} is invalid.`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw smokeError("invalid_result", `${label} is invalid.`);
  }
  return value;
}

function uniqueWindowsPaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = path.normalize(value);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function isRetryableHealthError(error) {
  return new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE"]).has(error?.code) ||
    error?.message === "health_timeout";
}

function waitForCloseWithin(closed, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    closed.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

function reserveLoopbackPort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(
          smokeError(
            "launch_failed",
            "A private loopback port could not be reserved.",
          ),
        );
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function smokeError(code, message, cause) {
  return new WindowsTargetSmokeError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function attachStableCleanupFailure(
  operationError,
  cleanupError,
  failureCode,
) {
  if (
    !cleanupError ||
    typeof operationError !== "object" ||
    operationError === null ||
    !Object.isExtensible(operationError)
  ) {
    return;
  }
  Object.defineProperty(operationError, "cleanupFailure", {
    configurable: true,
    enumerable: true,
    value: failureCode,
  });
}

async function retryWindowsCleanup(action, delayImpl) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (
        !WINDOWS_TRANSIENT_CLEANUP_CODES.has(error?.code) ||
        attempt >= WINDOWS_CLEANUP_RETRY_LIMIT
      ) {
        throw error;
      }
      await delayImpl(WINDOWS_CLEANUP_RETRY_DELAY_MS);
    }
  }
}

function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function parseWindowsSmokeArguments(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      runtime: { type: "string" },
      "accelerator-runtime": { type: "string" },
      model: { type: "string" },
      backend: { type: "string", default: "cpu" },
      work: { type: "string" },
      "timeout-ms": { type: "string" },
      "observe-ms": { type: "string" },
      "metrics-interval-ms": { type: "string" },
      report: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (positionals.length > 0) {
    throw smokeError(
      "invalid_arguments",
      "Positional arguments are not supported.",
    );
  }
  if (values.help) return { help: true };
  return {
    runtimeRoot: values.runtime,
    acceleratorRuntimeRoot: values["accelerator-runtime"],
    modelPath: values.model,
    backend: values.backend,
    workRoot: values.work,
    reportPath: values.report,
    ...(values["timeout-ms"] === undefined
      ? {}
      : { timeoutMs: Number(values["timeout-ms"]) }),
    ...(values["observe-ms"] === undefined
      ? {}
      : { observeMs: Number(values["observe-ms"]) }),
    ...(values["metrics-interval-ms"] === undefined
      ? {}
      : { metricsIntervalMs: Number(values["metrics-interval-ms"]) }),
  };
}

export async function writeWindowsSmokeReport(reportPath, report) {
  if (
    report === null ||
    typeof report !== "object" ||
    Array.isArray(report)
  ) {
    throw smokeError(
      "invalid_result",
      "The NATIVE-002B report is invalid.",
    );
  }
  assertReportPrivacy(report);
  await writeFile(
    path.resolve(reportPath),
    `${JSON.stringify(report, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseWindowsSmokeArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node run-native002-windows-smoke.mjs " +
        "--runtime <canonical-base-root> --model <large-v3-q5_0.bin> " +
        "--backend cpu|cuda --work <short-empty-ignored-dir> " +
        "[--accelerator-runtime <canonical-cuda-pack-root>] " +
        "[--timeout-ms <milliseconds>] [--observe-ms <milliseconds>] " +
        "[--metrics-interval-ms <milliseconds>] [--report <new-json>]\n",
    );
    return;
  }
  const report = await runNative002WindowsSmoke(options);
  if (options.reportPath !== undefined) {
    await writeWindowsSmokeReport(options.reportPath, report);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(
      `native002_windows_smoke_failed:${error?.code ?? "unknown"}: ` +
        `${String(error?.message ?? "").replaceAll("\r", " ").replaceAll("\n", " ")}\n`,
    );
    process.exitCode = error?.code === "backend_unverified" ? 2 : 1;
  });
}
