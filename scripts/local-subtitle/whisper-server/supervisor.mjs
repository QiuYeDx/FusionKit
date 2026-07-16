import { spawn } from "node:child_process";
import { constants as fsConstants, openAsBlob } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  stat,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const MAX_DIAGNOSTIC_CHARS = 64 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;

export class WhisperServerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "WhisperServerError";
    this.code = code;
    this.details = options.details;
  }
}

/**
 * Node-owned lifecycle wrapper for the official prebuilt whisper-server.
 * stdout/stderr are diagnostics only; readiness and inference use HTTP JSON.
 */
export class WhisperServerSupervisor {
  constructor(options) {
    this.options = {
      startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      threads: Math.max(1, Math.min(8, os.cpus().length || 4)),
      useGpu: false,
      convertWithFfmpeg: Boolean(options.ffmpegPath),
      tempBaseDirectory: os.tmpdir(),
      fetchImpl: globalThis.fetch,
      spawnImpl: spawn,
      ...options,
    };
    this.state = "stopped";
    this.child = undefined;
    this.exitPromise = undefined;
    this.sessionDirectory = undefined;
    this.baseUrl = undefined;
    this.requestPath = undefined;
    this.activeRequest = undefined;
    this.diagnostics = { stdout: "", stderr: "" };
    this.completedRequests = 0;
  }

  get processId() {
    return this.child?.pid;
  }

  get requestCount() {
    return this.completedRequests;
  }

  async start() {
    if (this.state === "ready") return;
    if (this.state !== "stopped") {
      throw new WhisperServerError(
        "invalid_state",
        `Cannot start whisper-server while state is ${this.state}.`,
      );
    }

    this.state = "starting";
    try {
      await validateRuntimePaths(this.options);
      this.sessionDirectory = await mkdtemp(
        path.join(this.options.tempBaseDirectory, "fusionkit-whisper-server-"),
      );
      const publicDirectory = path.join(this.sessionDirectory, "public");
      const mediaTempDirectory = path.join(this.sessionDirectory, "media");
      await Promise.all([
        mkdir(publicDirectory, { recursive: true }),
        mkdir(mediaTempDirectory, { recursive: true }),
      ]);

      const port = await reserveLoopbackPort();
      this.baseUrl = `http://127.0.0.1:${port}`;
      this.requestPath = `/fusionkit-${randomBytes(24).toString("hex")}`;
      const launch = createWhisperServerLaunch({
        ...this.options,
        port,
        requestPath: this.requestPath,
        publicDirectory,
        mediaTempDirectory,
      });

      this.child = this.options.spawnImpl(
        this.options.serverPath,
        launch.args,
        launch.spawnOptions,
      );
      this.captureDiagnostics(this.child);
      this.exitPromise = observeChildExit(this.child);
      await this.waitUntilReady();
      this.state = "ready";
    } catch (error) {
      await this.stop();
      if (error instanceof WhisperServerError) throw error;
      throw new WhisperServerError(
        "launch_failed",
        "The official whisper-server process could not be started.",
        { cause: error, details: this.safeDiagnostics() },
      );
    }
  }

  async health() {
    this.assertReady();
    const response = await fetchWithTimeout(
      this.options.fetchImpl,
      `${this.baseUrl}${this.requestPath}/health`,
      { method: "GET" },
      2_000,
    );
    if (!response.ok) return false;
    const body = await response.json().catch(() => undefined);
    return body?.status === "ok";
  }

  async transcribe(filePath, options = {}) {
    this.assertReady();
    if (this.activeRequest) {
      throw new WhisperServerError(
        "busy",
        "This whisper-server session already has an active transcription.",
      );
    }

    await assertRegularFile(filePath, "media_missing");
    const controller = new AbortController();
    const detachExternalAbort = forwardAbort(options.signal, controller);
    this.activeRequest = controller;

    try {
      const form = new FormData();
      const fileBlob = await openAsBlob(filePath);
      form.append("file", fileBlob, options.fileName ?? path.basename(filePath));
      form.append("response_format", "verbose_json");
      form.append("language", options.language ?? "auto");
      form.append("translate", String(Boolean(options.translate)));
      form.append("no_language_probabilities", "true");
      form.append("token_timestamps", "true");
      if (options.prompt) form.append("prompt", options.prompt);
      if (options.maxLength !== undefined) {
        form.append("max_len", String(options.maxLength));
      }

      const response = await this.options.fetchImpl(
        `${this.baseUrl}${this.requestPath}/inference`,
        {
          method: "POST",
          body: form,
          signal: controller.signal,
        },
      );
      const bodyText = await response.text();
      if (!response.ok) {
        throw new WhisperServerError(
          "inference_failed",
          `whisper-server returned HTTP ${response.status}.`,
          { details: { status: response.status, body: bodyText.slice(0, 1_000) } },
        );
      }

      let body;
      try {
        body = JSON.parse(bodyText);
      } catch (error) {
        throw new WhisperServerError(
          "invalid_response",
          "whisper-server returned invalid JSON.",
          { cause: error },
        );
      }
      const result = parseWhisperVerboseJson(body);
      this.completedRequests += 1;
      return result;
    } catch (error) {
      if (controller.signal.aborted || options.signal?.aborted) {
        throw new WhisperServerError(
          "aborted",
          "Local transcription was cancelled.",
          { cause: error },
        );
      }
      if (error instanceof WhisperServerError) throw error;
      throw new WhisperServerError(
        "request_failed",
        "The Node client could not complete the whisper-server request.",
        { cause: error },
      );
    } finally {
      detachExternalAbort();
      if (this.activeRequest === controller) this.activeRequest = undefined;
    }
  }

  async stop() {
    if (this.state === "stopped" && !this.child && !this.sessionDirectory) {
      return;
    }
    this.state = "stopping";
    this.activeRequest?.abort();
    this.activeRequest = undefined;

    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      const exited = await waitForPromise(this.exitPromise, 5_000);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForPromise(this.exitPromise, 2_000);
      }
    }

    const sessionDirectory = this.sessionDirectory;
    this.child = undefined;
    this.exitPromise = undefined;
    this.sessionDirectory = undefined;
    this.baseUrl = undefined;
    this.requestPath = undefined;
    this.state = "stopped";
    if (sessionDirectory) {
      await rm(sessionDirectory, { recursive: true, force: true });
    }
  }

  assertReady() {
    if (this.state !== "ready" || !this.child || !this.baseUrl || !this.requestPath) {
      throw new WhisperServerError(
        "not_ready",
        "whisper-server is not ready.",
      );
    }
  }

  captureDiagnostics(child) {
    child.stdout?.on("data", (chunk) => {
      this.diagnostics.stdout = appendBounded(
        this.diagnostics.stdout,
        chunk.toString("utf8"),
      );
    });
    child.stderr?.on("data", (chunk) => {
      this.diagnostics.stderr = appendBounded(
        this.diagnostics.stderr,
        chunk.toString("utf8"),
      );
    });
  }

  safeDiagnostics() {
    return {
      stdout: redactDiagnostics(this.diagnostics.stdout, this.options.modelPath),
      stderr: redactDiagnostics(this.diagnostics.stderr, this.options.modelPath),
    };
  }

  async waitUntilReady() {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    while (Date.now() < deadline) {
      const exit = await readSettledPromise(this.exitPromise);
      if (exit) {
        throw new WhisperServerError(
          "early_exit",
          "whisper-server exited before becoming ready.",
          { details: { exit, ...this.safeDiagnostics() } },
        );
      }
      try {
        const response = await fetchWithTimeout(
          this.options.fetchImpl,
          `${this.baseUrl}${this.requestPath}/health`,
          { method: "GET" },
          1_000,
        );
        if (response.ok) {
          const body = await response.json().catch(() => undefined);
          if (body?.status === "ok") return;
        }
      } catch {
        // Binding and model loading happen before the health endpoint is ready.
      }
      await delay(100);
    }
    throw new WhisperServerError(
      "startup_timeout",
      "whisper-server did not become ready before the startup timeout.",
      { details: this.safeDiagnostics() },
    );
  }
}

export function createWhisperServerLaunch(options) {
  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    String(options.port),
    "--request-path",
    options.requestPath,
    "--public",
    options.publicDirectory,
    "--tmp-dir",
    options.mediaTempDirectory,
    "--model",
    options.modelPath,
    "--threads",
    String(options.threads),
  ];
  if (!options.useGpu) args.push("--no-gpu");
  if (options.convertWithFfmpeg) args.push("--convert");

  return {
    args,
    spawnOptions: {
      cwd: path.dirname(options.serverPath),
      env: buildWhisperServerEnvironment({
        serverPath: options.serverPath,
        ffmpegPath: options.ffmpegPath,
        tempDirectory: options.mediaTempDirectory,
        sourceEnvironment: options.sourceEnvironment,
      }),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}

export function buildWhisperServerEnvironment(options) {
  const source = options.sourceEnvironment ?? process.env;
  const systemRoot = source.SystemRoot ?? source.WINDIR;
  const executableDirectories = [
    path.dirname(options.serverPath),
    options.ffmpegPath ? path.dirname(options.ffmpegPath) : undefined,
    systemRoot ? path.join(systemRoot, "System32") : undefined,
  ].filter(Boolean);
  const environment = {
    PATH: [...new Set(executableDirectories)].join(path.delimiter),
    TEMP: options.tempDirectory,
    TMP: options.tempDirectory,
  };
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (source[key]) environment[key] = source[key];
  }
  return environment;
}

export function parseWhisperVerboseJson(body) {
  if (!isRecord(body) || !Array.isArray(body.segments)) {
    throw new WhisperServerError(
      "invalid_response",
      "whisper-server verbose JSON is missing segments.",
    );
  }
  const segments = body.segments.map((segment, index) => {
    if (
      !isRecord(segment) ||
      typeof segment.text !== "string" ||
      typeof segment.start !== "number" ||
      typeof segment.end !== "number" ||
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end < segment.start
    ) {
      throw new WhisperServerError(
        "invalid_response",
        `whisper-server returned an invalid segment at index ${index}.`,
      );
    }
    return {
      id: Number.isInteger(segment.id) ? segment.id : index,
      startMs: Math.round(segment.start * 1_000),
      endMs: Math.round(segment.end * 1_000),
      text: segment.text.trim(),
      words: normalizeWords(segment.words),
    };
  });

  return {
    text: typeof body.text === "string"
      ? body.text.trim()
      : segments.map((segment) => segment.text).join(" ").trim(),
    language: typeof body.language === "string" ? body.language : undefined,
    durationMs: typeof body.duration === "number" && Number.isFinite(body.duration)
      ? Math.round(body.duration * 1_000)
      : undefined,
    segments,
  };
}

async function validateRuntimePaths(options) {
  if (!path.isAbsolute(options.serverPath) || !path.isAbsolute(options.modelPath)) {
    throw new WhisperServerError(
      "invalid_path",
      "whisper-server and model paths must be absolute.",
    );
  }
  await assertRegularFile(options.serverPath, "runtime_missing");
  await assertRegularFile(options.modelPath, "model_missing");
  if (options.convertWithFfmpeg) {
    if (!options.ffmpegPath || !path.isAbsolute(options.ffmpegPath)) {
      throw new WhisperServerError(
        "ffmpeg_missing",
        "An absolute FFmpeg path is required for media conversion.",
      );
    }
    await assertRegularFile(options.ffmpegPath, "ffmpeg_missing");
  }
  await mkdir(options.tempBaseDirectory, { recursive: true });
}

async function assertRegularFile(filePath, code) {
  try {
    await access(filePath, fsConstants.F_OK);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a regular file");
  } catch (error) {
    throw new WhisperServerError(code, "A required local file is unavailable.", {
      cause: error,
    });
  }
}

function normalizeWords(words) {
  if (!Array.isArray(words)) return undefined;
  const normalized = words.flatMap((word) => {
    if (!isRecord(word) || typeof word.word !== "string") return [];
    return [{
      text: word.word,
      startMs: typeof word.start === "number" ? Math.round(word.start * 1_000) : undefined,
      endMs: typeof word.end === "number" ? Math.round(word.end * 1_000) : undefined,
      probability: typeof word.probability === "number" ? word.probability : undefined,
    }];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendBounded(existing, next) {
  return `${existing}${next}`.slice(-MAX_DIAGNOSTIC_CHARS);
}

function redactDiagnostics(value, modelPath) {
  return value.split(modelPath).join("[model]").slice(-4_000);
}

function observeChildExit(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ error: error.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function readSettledPromise(promise) {
  if (!promise) return undefined;
  const marker = Symbol("pending");
  const value = await Promise.race([promise, Promise.resolve(marker)]);
  return value === marker ? undefined : value;
}

async function waitForPromise(promise, timeoutMs) {
  if (!promise) return true;
  const marker = Symbol("timeout");
  const value = await Promise.race([
    promise,
    delay(timeoutMs).then(() => marker),
  ]);
  return value !== marker;
}

function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(url, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

function forwardAbort(signal, controller) {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a loopback TCP port."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}
