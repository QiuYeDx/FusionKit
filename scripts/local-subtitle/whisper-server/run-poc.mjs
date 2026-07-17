import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  WhisperServerError,
  WhisperServerSupervisor,
} from "./supervisor.mjs";
import { ProcessMetricsMonitor } from "./process-metrics.mjs";
import {
  createSmokeCues,
  formatSmokeLrc,
  formatSmokeSrt,
  verifySmokeLrcRoundTrip,
  verifySmokeSrtRoundTrip,
} from "./subtitle-smoke.mjs";

export async function runPoc(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      model: { type: "string" },
      ffmpeg: { type: "string" },
      inventory: { type: "string" },
      output: { type: "string" },
      threads: { type: "string", default: "6" },
      backend: { type: "string", default: "cpu" },
      "nvidia-smi": { type: "string" },
      "metrics-interval-ms": { type: "string", default: "1000" },
      sample: { type: "string", multiple: true },
      "cancel-sample": { type: "string" },
      "cancel-after-ms": { type: "string", default: "5000" },
    },
    strict: true,
  });
  for (const required of ["server", "model", "inventory", "output"]) {
    if (!values[required]) throw new Error(`Missing --${required}.`);
  }

  const serverPath = path.resolve(values.server);
  const modelPath = path.resolve(values.model);
  const inventoryPath = path.resolve(values.inventory);
  const outputDirectory = path.resolve(values.output);
  const ffmpegPath = values.ffmpeg ? path.resolve(values.ffmpeg) : undefined;
  const threads = parsePositiveInteger(values.threads, "--threads");
  const backend = parseBackend(values.backend);
  const metricsIntervalMs = parsePositiveInteger(
    values["metrics-interval-ms"],
    "--metrics-interval-ms",
  );
  const cancelAfterMs = parsePositiveInteger(
    values["cancel-after-ms"],
    "--cancel-after-ms",
  );
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const samples = selectRequestedSamples(
    selectRealSamples(inventory),
    values.sample ?? [],
  );
  await mkdir(outputDirectory, { recursive: true });

  const [modelStat, serverStat, modelSha256, serverSha256] = await Promise.all([
    stat(modelPath),
    stat(serverPath),
    sha256File(modelPath),
    sha256File(serverPath),
  ]);
  const supervisor = new WhisperServerSupervisor({
    serverPath,
    modelPath,
    ffmpegPath,
    convertWithFfmpeg: Boolean(ffmpegPath),
    useGpu: backend === "cuda",
    threads,
    startupTimeoutMs: 180_000,
  });
  const monitor = new ProcessMetricsMonitor({
    processIdProvider: () => supervisor.processId,
    backend,
    intervalMs: metricsIntervalMs,
    ...(values["nvidia-smi"]
      ? { nvidiaSmiPath: path.resolve(values["nvidia-smi"]) }
      : {}),
  });
  const summary = {
    schemaVersion: 2,
    engine: "whisper.cpp",
    engineVersion: "v1.9.1",
    transport: "node-owned-loopback-http",
    platform: process.platform,
    architecture: process.arch,
    requestedBackend: backend,
    runtimeFileName: path.basename(serverPath),
    runtimeSizeBytes: serverStat.size,
    runtimeSha256: serverSha256,
    modelFileName: path.basename(modelPath),
    modelSizeBytes: modelStat.size,
    modelSha256,
    modelLoadCount: 1,
    modelLoadReuseMs: 0,
    modelLoadReuseEvidence: "same-pid-no-restart-between-normal-requests",
    startedAt: new Date().toISOString(),
    cancellation: undefined,
    samples: [],
  };

  try {
    monitor.start();
    const startupStarted = performance.now();
    await supervisor.start();
    summary.modelLoadFirstMs = Math.round(performance.now() - startupStarted);
    const processId = supervisor.processId;
    process.stdout.write(`whisper-server ready (pid ${processId})\n`);

    for (const sample of samples) {
      const started = performance.now();
      const result = await supervisor.transcribe(sample.mediaPath, {
        language: languageForSample(sample.sampleId),
      });
      const elapsedMs = Math.round(performance.now() - started);
      const cues = createSmokeCues(result.segments);
      const srt = formatSmokeSrt(cues);
      const lrc = formatSmokeLrc(cues);
      const srtFile = `${sample.sampleId}.smoke.srt`;
      const lrcFile = `${sample.sampleId}.smoke.lrc`;
      const srtParseBack = verifySmokeSrtRoundTrip(cues, srt);
      const lrcParseBack = verifySmokeLrcRoundTrip(cues, lrc);
      await Promise.all([
        writeFile(path.join(outputDirectory, srtFile), srt, "utf8"),
        writeFile(path.join(outputDirectory, lrcFile), lrc, "utf8"),
      ]);
      const record = {
        sampleId: sample.sampleId,
        language: languageForSample(sample.sampleId),
        detectedLanguage: result.language,
        languageDetectionMatch: languageMatches(
          languageForSample(sample.sampleId),
          result.language,
        ),
        elapsedMs,
        audioDurationMs: result.durationMs,
        realtimeFactor: result.durationMs
          ? Number((elapsedMs / result.durationMs).toFixed(4))
          : undefined,
        segmentCount: result.segments.length,
        cueCount: cues.length,
        srtFile,
        lrcFile,
        srtParseBack,
        lrcParseBack,
        processId: supervisor.processId,
        resultFile: `${sample.sampleId}.result.json`,
      };
      await writeFile(
        path.join(outputDirectory, record.resultFile),
        `${JSON.stringify({ sampleId: sample.sampleId, ...result }, null, 2)}\n`,
        "utf8",
      );
      summary.samples.push(record);
      process.stdout.write(
        `${sample.sampleId}: ${record.segmentCount} segments, ` +
        `${elapsedMs} ms, RTF ${record.realtimeFactor ?? "n/a"}\n`,
      );
    }
    const cancellationSample = samples.find(
      (sample) => sample.sampleId === values["cancel-sample"],
    );
    if (cancellationSample) {
      summary.cancellation = await runCancellationProbe({
        supervisor,
        sample: cancellationSample,
        cancelAfterMs,
        expectedProcessId: processId,
      });
    }
    summary.completedAt = new Date().toISOString();
    summary.serverProcessId = processId;
    summary.processReused = summary.samples.every(
      (sample) => sample.processId === processId,
    );
    summary.completedRequestCount = supervisor.requestCount;
    summary.healthyBeforeShutdown = await supervisor.health().catch(() => false);
    await monitor.stop();
    summary.resources = monitor.summary();
    summary.allSubtitleParseBackPassed = summary.samples.every(
      (sample) => sample.srtParseBack && sample.lrcParseBack,
    );
    summary.allLanguageDetectionMatched = summary.samples.every(
      (sample) => sample.languageDetectionMatch,
    );
    await writeFile(
      path.join(outputDirectory, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
    if (backend === "cuda" && !summary.resources.backendVerified) {
      throw new WhisperServerError(
        "backend_unverified",
        "CUDA was requested, but no VRAM use was observed for whisper-server.",
      );
    }
    if (!summary.allSubtitleParseBackPassed) {
      throw new WhisperServerError(
        "subtitle_parse_back_failed",
        "At least one generated SRT or LRC artifact failed parse-back.",
      );
    }
    return summary;
  } finally {
    await monitor.stop();
    await supervisor.stop();
  }
}

export function selectRealSamples(inventory) {
  if (!inventory || !Array.isArray(inventory.files)) return [];
  return inventory.files.filter(
    (sample) =>
      typeof sample?.sampleId === "string" &&
      /^(?:zh|ja)-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sample.sampleId) &&
      typeof sample?.mediaPath === "string" &&
      typeof sample?.subtitlePath === "string" &&
      path.isAbsolute(sample.mediaPath) &&
      path.isAbsolute(sample.subtitlePath),
  );
}

export function languageForSample(sampleId) {
  if (sampleId.startsWith("zh-")) return "zh";
  if (sampleId.startsWith("ja-")) return "ja";
  return "auto";
}

export function selectRequestedSamples(samples, requestedSampleIds) {
  if (requestedSampleIds.length === 0) return samples;
  const uniqueIds = [...new Set(requestedSampleIds)];
  const byId = new Map(samples.map((sample) => [sample.sampleId, sample]));
  const missing = uniqueIds.filter((sampleId) => !byId.has(sampleId));
  if (missing.length > 0) {
    throw new Error(`Unknown --sample value: ${missing.join(", ")}.`);
  }
  return uniqueIds.map((sampleId) => byId.get(sampleId));
}

export function languageMatches(expected, detected) {
  const normalized = String(detected ?? "").trim().toLowerCase();
  if (expected === "zh") return normalized === "zh" || normalized === "chinese";
  if (expected === "ja") return normalized === "ja" || normalized === "japanese";
  return Boolean(normalized);
}

async function runCancellationProbe(options) {
  const controller = new AbortController();
  const started = performance.now();
  const timeout = setTimeout(() => controller.abort(), options.cancelAfterMs);
  let errorCode;
  try {
    await options.supervisor.transcribe(options.sample.mediaPath, {
      language: languageForSample(options.sample.sampleId),
      signal: controller.signal,
    });
    throw new Error("Cancellation probe completed before it was cancelled.");
  } catch (error) {
    if (!(error instanceof WhisperServerError) || error.code !== "aborted") {
      throw error;
    }
    errorCode = error.code;
  } finally {
    clearTimeout(timeout);
  }
  const observedAfterMs = Math.round(performance.now() - started);
  const healthyAfterAbort = await options.supervisor.health().catch(() => false);
  return {
    sampleId: options.sample.sampleId,
    cancelAfterMs: options.cancelAfterMs,
    observedAfterMs,
    cancelLatencyMs: Math.max(0, observedAfterMs - options.cancelAfterMs),
    errorCode,
    processId: options.supervisor.processId,
    processReused: options.supervisor.processId === options.expectedProcessId,
    healthyAfterAbort,
    nextTaskPolicy: "restart_server",
  };
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function parseBackend(value) {
  if (value !== "cpu" && value !== "cuda") {
    throw new Error("--backend must be cpu or cuda.");
  }
  return value;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPoc().catch((error) => {
    const code = error instanceof WhisperServerError ? error.code : "poc_failed";
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
