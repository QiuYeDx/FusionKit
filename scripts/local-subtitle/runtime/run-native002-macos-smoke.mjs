#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createServer, request } from "node:http";
import {
  mkdir,
  mkdtemp,
  lstat,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildSanitizedRuntimeEnvironment,
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

export async function runNative002MacosSmoke(options) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("NATIVE-002A smoke requires a native darwin/arm64 host.");
  }
  const runtimeRoot = path.resolve(requirePath(options.runtimeRoot, "runtimeRoot"));
  const modelPath = path.resolve(requirePath(options.modelPath, "modelPath"));
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const backend = normalizeBackend(options.backend);
  const verifiedModel = await verifyPinnedLaunchModel(
    modelPath,
    options.modelManifestPath,
  );
  const model = verifiedModel.model;
  const identityVerification = await verifyRuntimeBundle({
    runtimeRoot,
    platform: "darwin",
    arch: "arm64",
    scope: "all",
    launch: true,
  });
  const loaded = await loadRuntimeManifest(runtimeRoot, {
    platform: "darwin",
    arch: "arm64",
  });
  const serverArtifact = requireArtifact(loaded.manifest, "server");
  const ffmpegArtifact = requireArtifact(loaded.manifest, "ffmpeg");
  const ffprobeArtifact = requireArtifact(loaded.manifest, "ffprobe");
  const serverPath = resolveContainedResourcePath(
    loaded.root,
    serverArtifact.relativePath,
  );
  const ffmpegPath = resolveContainedResourcePath(
    loaded.root,
    ffmpegArtifact.relativePath,
  );
  const ffprobePath = resolveContainedResourcePath(
    loaded.root,
    ffprobeArtifact.relativePath,
  );
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-native002a-smoke-"));
  try {
    const media = await runMediaDecodeSmoke({
      ffmpegPath,
      ffprobePath,
      workRoot,
      timeoutMs,
    });
    const server = await runPrivateHealthSmoke({
      serverPath,
      modelPath,
      modelIdentity: verifiedModel.identity,
      workRoot: path.join(workRoot, backend),
      backend,
      timeoutMs,
    });
    return {
      schemaVersion: 1,
      workPackage: "NATIVE-002A",
      target: { platform: "darwin", arch: "arm64" },
      status: "target_smoke_passed",
      runtimeManifestSha256: loaded.manifestSha256,
      artifactLaunchResults: identityVerification.launchResults,
      server,
      media,
      model: {
        id: model.id,
        byteSize: model.byteSize,
        sha256: model.sha256,
        bundledInInstaller: false,
      },
      noPathFallback: true,
      productionPathDirectoryOnly: true,
      controlledWorkingDirectories: true,
      privateLoopbackHealth: true,
      cleanup: { serverProcessesClosed: true, temporaryFilesRemoved: true },
      privacy: { absolutePathsRecorded: false, privateRouteRecorded: false },
    };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

export async function verifyPinnedLaunchModel(modelPath, manifestPath) {
  const manifest = JSON.parse(
    await readFile(path.resolve(manifestPath ?? MODEL_MANIFEST_PATH), "utf8"),
  );
  const model = manifest?.models?.find(
    (candidate) => candidate.id === "large-v3-q5_0",
  );
  const before = await lstat(modelPath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("The NATIVE-002A launch model must be a regular file.");
  }
  let handle;
  let opened;
  let completed;
  let sha256;
  try {
    handle = await open(
      modelPath,
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
  const after = await lstat(modelPath, { bigint: true });
  assertSameFileIdentity(completed, after);
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.engine?.version !== "v1.9.1" ||
    manifest.engine?.commit !== "f049fff95a089aa9969deb009cdd4892b3e74916" ||
    !model ||
    model.defaultRecommended !== true ||
    model.bundledInInstaller !== false ||
    opened.size !== BigInt(model.byteSize) ||
    sha256 !== model.sha256
  ) {
    throw new Error("The NATIVE-002A launch model does not match its manifest.");
  }
  return { model, identity: completed };
}

export function createPcm16WavFixture(sampleCount = 1600) {
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
    buffer.writeInt16LE(Math.round(Math.sin(index / 12) * 8_000), 44 + index * 2);
  }
  return buffer;
}

export function parseExactHealthResponse(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_HEALTH_BYTES) {
    throw new Error("The private health response size is invalid.");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("The private health response is not JSON.");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    value.status !== "ok"
  ) {
    throw new Error("The private health response does not match the contract.");
  }
  return true;
}

async function runMediaDecodeSmoke(options) {
  const inputPath = path.join(options.workRoot, "input.wav");
  const outputPath = path.join(options.workRoot, "normalized.wav");
  await writeFile(inputPath, createPcm16WavFixture(), { flag: "wx", mode: 0o600 });
  const environment = buildSanitizedRuntimeEnvironment("darwin", {
    TMPDIR: options.workRoot,
  });
  environment.PATH = path.dirname(options.ffmpegPath);
  environment.TEMP = options.workRoot;
  environment.TMP = options.workRoot;
  await runCommand(
    options.ffmpegPath,
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    { cwd: options.workRoot, env: environment, timeoutMs: options.timeoutMs },
  );
  const probe = await runCommand(
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
    { cwd: options.workRoot, env: environment, timeoutMs: options.timeoutMs },
  );
  const parsed = JSON.parse(probe.stdout);
  const stream = parsed?.streams?.[0];
  if (
    stream?.codec_name !== "pcm_s16le" ||
    stream?.sample_rate !== "16000" ||
    stream?.channels !== 1
  ) {
    throw new Error("The bundled media runtime failed its decode contract.");
  }
  return {
    ffmpegIdentityMatched: true,
    ffprobeIdentityMatched: true,
    pcm16DecodePassed: true,
    sampleRate: 16_000,
    channels: 1,
  };
}

async function runPrivateHealthSmoke(options) {
  await mkdir(options.workRoot, { recursive: true, mode: 0o700 });
  const publicDirectory = path.join(options.workRoot, "public");
  const temporaryDirectory = path.join(options.workRoot, "tmp");
  await Promise.all([
    mkdir(publicDirectory, { mode: 0o700 }),
    mkdir(temporaryDirectory, { mode: 0o700 }),
  ]);
  const port = await reserveLoopbackPort();
  const privatePath = `/fusionkit-${randomBytes(24).toString("hex")}`;
  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--request-path",
    privatePath,
    "--inference-path",
    "/inference",
    "--public",
    publicDirectory,
    "--tmp-dir",
    temporaryDirectory,
    "--model",
    options.modelPath,
    "--threads",
    "4",
    "--processors",
    "1",
    ...(options.backend === "cpu" ? ["--no-gpu"] : []),
  ];
  const child = spawn(options.serverPath, args, {
    cwd: options.workRoot,
    env: buildProductionRuntimeEnvironment(
      path.dirname(options.serverPath),
      temporaryDirectory,
    ),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  let diagnosticBytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      diagnosticBytes = Math.min(64 * 1024, diagnosticBytes + chunk.length);
    });
  }
  try {
    await waitForPrivateHealth({
      child,
      getSpawnError: () => spawnError,
      port,
      path: `${privatePath}/health`,
      timeoutMs: options.timeoutMs,
    });
    await assertCurrentModelIdentity(options.modelPath, options.modelIdentity);
    return {
      backend: options.backend,
      healthStatus: "ok",
      loopbackOnly: true,
      privatePathUsed: true,
      modelLoaded: true,
      exitedBeforeHealth: false,
      diagnosticsBounded: diagnosticBytes <= 64 * 1024,
    };
  } finally {
    await terminateChild(child, closed);
  }
}

async function waitForPrivateHealth(options) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (options.getSpawnError()) {
      throw new Error("The whisper-server could not be spawned.");
    }
    if (options.child.exitCode !== null || options.child.signalCode !== null) {
      throw new Error("The whisper-server exited before private health was ready.");
    }
    try {
      const response = await requestHealth(options.port, options.path, deadline);
      if (response.statusCode === 200) {
        if (!/^application\/json(?:;|$)/iu.test(response.contentType ?? "")) {
          throw new Error("The private health response content type is invalid.");
        }
        parseExactHealthResponse(response.body);
        return;
      }
      if (response.statusCode !== 503) {
        throw new Error("The private health endpoint returned an invalid status.");
      }
    } catch (error) {
      if (!isRetryableHealthError(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The private health endpoint did not become ready in time.");
}

function requestHealth(port, requestPath, deadline) {
  return new Promise((resolve, reject) => {
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
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        response.once("error", fail);
        response.once("aborted", () => fail(new Error("health_aborted")));
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > MAX_HEALTH_BYTES) {
            response.destroy(new Error("The private health response is too large."));
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
    const deadlineTimer = setTimeout(
      () => req.destroy(new Error("health_timeout")),
      Math.max(1, Math.min(2_000, deadline - Date.now())),
    );
    req.once("close", () => clearTimeout(deadlineTimer));
    req.once("error", reject);
    req.end();
  });
}

function isRetryableHealthError(error) {
  return new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE"]).has(error?.code) ||
    error?.message === "health_timeout";
}

async function terminateChild(child, closed) {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!await waitForCloseWithin(closed, 5_000)) {
      throw new Error("The whisper-server close event was not confirmed.");
    }
    return;
  }
  child.kill("SIGTERM");
  const graceful = await waitForCloseWithin(closed, 5_000);
  if (!graceful) {
    child.kill("SIGKILL");
    if (!await waitForCloseWithin(closed, 5_000)) {
      throw new Error("The whisper-server could not confirm close after SIGKILL.");
    }
  }
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("A loopback port could not be reserved.");
  }
  return address.port;
}

async function runCommand(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let total = 0;
  let outputExceeded = false;
  const result = await new Promise((resolve, reject) => {
    let failureMessage;
    let spawnError;
    let closeConfirmationTimer;
    const requestForcedStop = (message) => {
      if (failureMessage) return;
      failureMessage = message;
      child.kill("SIGKILL");
      closeConfirmationTimer = setTimeout(
        () => reject(new Error("A target smoke command could not confirm close.")),
        5_000,
      );
    };
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on("data", (chunk) => {
        total += chunk.length;
        if (total > 4 * 1024 * 1024) {
          outputExceeded = true;
          requestForcedStop("A target smoke command exceeded output limits.");
        } else {
          chunks.push(chunk);
        }
      });
    }
    const timeout = setTimeout(() => {
      requestForcedStop("A target smoke command timed out.");
    }, options.timeoutMs);
    child.once("error", (error) => {
      spawnError = error;
      requestForcedStop("A target smoke command could not spawn.");
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(closeConfirmationTimer);
      if (spawnError) reject(new Error("A target smoke command could not spawn."));
      else if (failureMessage) reject(new Error(failureMessage));
      else if (outputExceeded) reject(new Error("A target smoke command exceeded output limits."));
      else resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
  if (result.code !== 0) throw new Error("A target smoke command failed.");
  return result;
}

function buildProductionRuntimeEnvironment(executableDirectory, temporaryDirectory) {
  return {
    PATH: executableDirectory,
    LANG: "C",
    LC_ALL: "C",
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
  };
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

async function hashOpenFile(handle) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
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
    throw new Error("The NATIVE-002A launch model changed during verification.");
  }
}

async function assertCurrentModelIdentity(modelPath, expected) {
  const current = await lstat(modelPath, { bigint: true });
  if (current.isSymbolicLink()) {
    throw new Error("The NATIVE-002A launch model changed during health smoke.");
  }
  assertSameFileIdentity(expected, current);
}

function requireArtifact(manifest, kind) {
  const artifact = manifest.artifacts.find((candidate) => candidate.kind === kind);
  if (!artifact) throw new Error(`The runtime manifest is missing ${kind}.`);
  return artifact;
}

function normalizeTimeout(value) {
  if (value === undefined) return 120_000;
  if (!Number.isSafeInteger(value) || value < 5_000 || value > 10 * 60_000) {
    throw new Error("timeoutMs must be between 5000 and 600000.");
  }
  return value;
}

function normalizeBackend(value) {
  if (value === undefined) return "cpu";
  if (value !== "cpu" && value !== "metal") {
    throw new Error("backend must be cpu or metal.");
  }
  return value;
}

function requirePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function parseCliArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      runtime: { type: "string" },
      model: { type: "string" },
      "timeout-ms": { type: "string" },
      backend: { type: "string", default: "cpu" },
      report: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    runtimeRoot: values.runtime,
    modelPath: values.model,
    backend: values.backend,
    reportPath: values.report,
    ...(values["timeout-ms"] === undefined
      ? {}
      : { timeoutMs: Number(values["timeout-ms"]) }),
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node run-native002-macos-smoke.mjs --runtime <canonical-root> " +
        "--model <pinned-large-v3-q5_0.bin> [--backend cpu|metal] " +
        "[--timeout-ms <milliseconds>] [--report <ignored-json>]\n",
    );
    return;
  }
  const report = await runNative002MacosSmoke(options);
  if (options.reportPath !== undefined) {
    await writeFile(
      path.resolve(options.reportPath),
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`native002_macos_smoke_failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
