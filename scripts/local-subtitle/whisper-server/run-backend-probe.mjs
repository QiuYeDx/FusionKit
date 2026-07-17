import { stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ProcessMetricsMonitor } from "./process-metrics.mjs";
import {
  WhisperServerError,
  WhisperServerSupervisor,
} from "./supervisor.mjs";

export async function runBackendProbe(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      model: { type: "string" },
      backend: { type: "string", default: "cuda" },
      "observe-ms": { type: "string", default: "5000" },
      "metrics-interval-ms": { type: "string", default: "500" },
    },
    strict: true,
  });
  if (!values.server || !values.model) {
    throw new Error("Missing --server or --model.");
  }
  if (!["cpu", "cuda", "metal"].includes(values.backend)) {
    throw new Error("--backend must be cpu, cuda, or metal.");
  }
  const observeMs = parsePositiveInteger(values["observe-ms"], "--observe-ms");
  const metricsIntervalMs = parsePositiveInteger(
    values["metrics-interval-ms"],
    "--metrics-interval-ms",
  );
  const serverPath = path.resolve(values.server);
  const modelPath = path.resolve(values.model);
  const [serverStat, modelStat] = await Promise.all([
    stat(serverPath),
    stat(modelPath),
  ]);
  const supervisor = new WhisperServerSupervisor({
    serverPath,
    modelPath,
    useGpu: values.backend !== "cpu",
    startupTimeoutMs: 180_000,
  });
  const monitor = new ProcessMetricsMonitor({
    processIdProvider: () => supervisor.processId,
    diagnosticsProvider: () => supervisor.safeDiagnostics(),
    backend: values.backend,
    intervalMs: metricsIntervalMs,
  });

  try {
    monitor.start();
    const started = performance.now();
    await supervisor.start();
    const modelLoadFirstMs = Math.round(performance.now() - started);
    await delay(observeMs);
    const healthy = await supervisor.health().catch(() => false);
    await monitor.stop();
    const resources = monitor.summary();
    return {
      schemaVersion: 1,
      probeType: "official-server-backend-startup",
      backend: values.backend,
      serverFileName: path.basename(serverPath),
      serverSizeBytes: serverStat.size,
      modelFileName: path.basename(modelPath),
      modelSizeBytes: modelStat.size,
      modelLoadFirstMs,
      healthy,
      ...resources,
    };
  } finally {
    await monitor.stop();
    await supervisor.stop();
  }
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBackendProbe()
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (!summary.backendVerified) process.exitCode = 2;
    })
    .catch((error) => {
      const code = error instanceof WhisperServerError
        ? error.code
        : "backend_probe_failed";
      process.stderr.write(`${code}: ${error.message}\n`);
      process.exitCode = 1;
    });
}
