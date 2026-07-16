import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  WhisperServerError,
  WhisperServerSupervisor,
} from "./supervisor.mjs";

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
  const cancelAfterMs = parsePositiveInteger(
    values["cancel-after-ms"],
    "--cancel-after-ms",
  );
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const samples = selectRealSamples(inventory);
  if (samples.length < 2) {
    throw new Error("PRE-002 requires at least two real subtitle samples.");
  }
  await mkdir(outputDirectory, { recursive: true });

  const modelStat = await stat(modelPath);
  const supervisor = new WhisperServerSupervisor({
    serverPath,
    modelPath,
    ffmpegPath,
    convertWithFfmpeg: Boolean(ffmpegPath),
    useGpu: false,
    threads,
    startupTimeoutMs: 180_000,
  });
  const summary = {
    schemaVersion: 1,
    engine: "whisper.cpp",
    engineVersion: "v1.9.1",
    transport: "node-owned-loopback-http",
    modelFileName: path.basename(modelPath),
    modelSizeBytes: modelStat.size,
    modelLoadCount: 1,
    startedAt: new Date().toISOString(),
    cancellation: undefined,
    samples: [],
  };

  try {
    await supervisor.start();
    const processId = supervisor.processId;
    process.stdout.write(`whisper-server ready (pid ${processId})\n`);

    for (const sample of samples) {
      if (sample.sampleId === values["cancel-sample"]) {
        summary.cancellation = await runCancellationProbe({
          supervisor,
          sample,
          cancelAfterMs,
          expectedProcessId: processId,
        });
      }

      const started = performance.now();
      const result = await supervisor.transcribe(sample.mediaPath, {
        language: languageForSample(sample.sampleId),
      });
      const elapsedMs = Math.round(performance.now() - started);
      const record = {
        sampleId: sample.sampleId,
        language: languageForSample(sample.sampleId),
        elapsedMs,
        audioDurationMs: result.durationMs,
        realtimeFactor: result.durationMs
          ? Number((elapsedMs / result.durationMs).toFixed(4))
          : undefined,
        segmentCount: result.segments.length,
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
    summary.completedAt = new Date().toISOString();
    summary.serverProcessId = processId;
    summary.processReused = summary.samples.every(
      (sample) => sample.processId === processId,
    );
    summary.completedRequestCount = supervisor.requestCount;
    summary.healthyBeforeShutdown = await supervisor.health();
    await writeFile(
      path.join(outputDirectory, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
    return summary;
  } finally {
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
  return {
    sampleId: options.sample.sampleId,
    cancelAfterMs: options.cancelAfterMs,
    observedAfterMs,
    cancelLatencyMs: Math.max(0, observedAfterMs - options.cancelAfterMs),
    errorCode,
    processId: options.supervisor.processId,
    processReused: options.supervisor.processId === options.expectedProcessId,
    healthyAfterAbort: await options.supervisor.health(),
  };
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPoc().catch((error) => {
    const code = error instanceof WhisperServerError ? error.code : "poc_failed";
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
