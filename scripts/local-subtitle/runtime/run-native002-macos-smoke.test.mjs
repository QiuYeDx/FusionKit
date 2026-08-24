import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildServerSmokeReport,
  createBoundedBackendEvidenceCapture,
  createPcm16WavFixture,
  finalizeHealthyServerSmoke,
  parseExactHealthResponse,
  terminateChild,
  verifyPinnedLaunchModel,
  waitForPrivateHealth,
} from "./run-native002-macos-smoke.mjs";

test("creates a deterministic mono 16 kHz PCM16 WAV", () => {
  const wav = createPcm16WavFixture(160);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 320);
});

test("accepts only the exact private health response", () => {
  assert.equal(parseExactHealthResponse(Buffer.from('{"status":"ok"}')), true);
  for (const invalid of [
    "{}",
    '{"status":"ready"}',
    '{"status":"ok","extra":true}',
    "not-json",
  ]) {
    assert.throws(() => parseExactHealthResponse(Buffer.from(invalid)));
  }
});

test("requires positive Metal initialization and device evidence after health", () => {
  const noMetal = createBoundedBackendEvidenceCapture({ backend: "metal" });
  assert.throws(
    () => buildServerSmokeReport("metal", [noMetal.summary()]),
    /initialization evidence/u,
  );

  const noDevice = createBoundedBackendEvidenceCapture({ backend: "metal" });
  noDevice.write("ggml_metal_init: loading kernels\n");
  assert.throws(
    () => buildServerSmokeReport("metal", [noDevice.summary()]),
    /device evidence/u,
  );

  const verified = createBoundedBackendEvidenceCapture({ backend: "metal" });
  verified.write("ggml_metal_init: loading kernels\n");
  verified.write("found device: Apple M-series GPU\n");
  const report = buildServerSmokeReport("metal", [verified.summary()]);
  assert.equal(report.healthStatus, "ok");
  assert.equal(report.backendVerified, true);
  assert.deepEqual(report.backendEvidenceDetails, {
    initializationObserved: true,
    deviceObserved: true,
    failureObserved: false,
    backendVerified: true,
  });
});

test("rejects Metal allocation failures even after positive evidence", () => {
  const capture = createBoundedBackendEvidenceCapture({ backend: "metal" });
  capture.write(
    "ggml_metal_init: loading kernels\n" +
      "Metal device: Apple M-series GPU\n" +
      "ggml_metal_buffer_init: error: failed to allocate buffer\n",
  );
  assert.throws(
    () => buildServerSmokeReport("metal", [capture.summary()]),
    /initialization failure/u,
  );
});

test("rejects fail-closed Metal initialization diagnostics", () => {
  for (const diagnostic of [
    "ggml_metal_init: error: could not create command queue",
    "ggml_backend_metal_device_init: unsupported GPU family",
    "ggml_metal_init: device = nil",
    "ggml_metal_init: fatal initialization fault",
  ]) {
    const capture = createBoundedBackendEvidenceCapture({ backend: "metal" });
    capture.write(
      "ggml_metal_init: loading kernels\n" +
        "Metal device: Apple M-series GPU\n" +
        `${diagnostic}\n`,
    );
    assert.throws(
      () => buildServerSmokeReport("metal", [capture.summary()]),
      /initialization failure/u,
      diagnostic,
    );
  }
});

test("keeps diagnostics bounded while detecting split evidence without reporting raw data", () => {
  const capture = createBoundedBackendEvidenceCapture({
    backend: "metal",
    maxRetainedBytes: 256,
  });
  const secretModelPath = "/Users/private/models/large-v3.bin";
  const secretRoute = "/fusionkit-secret-health-route";
  capture.write(
    `${"x".repeat(2_048)}\n${secretModelPath}\n${secretRoute}\nggml_met`,
  );
  capture.write("al_init: loading kernels\nfound device: Apple M-series GPU\n");
  const summary = capture.summary();
  assert.equal(summary.diagnosticsBounded, true);
  assert.equal(summary.diagnosticsTruncated, true);
  assert.ok(summary.diagnosticBytesRetained <= 256);
  assert.equal(summary.backendEvidenceDetails.backendVerified, true);

  const serialized = JSON.stringify(buildServerSmokeReport("metal", [summary]));
  assert.doesNotMatch(serialized, /Users\/private/u);
  assert.doesNotMatch(serialized, /fusionkit-secret/u);
  assert.doesNotMatch(serialized, /loading kernels/u);
});

test("rejects a server that exits before private health is ready", async () => {
  await assert.rejects(
    waitForPrivateHealth({
      child: { exitCode: 1, signalCode: null },
      getSpawnError: () => undefined,
      port: 1,
      path: "/private/health",
      timeoutMs: 1_000,
    }),
    /exited before private health/u,
  );
});

test("confirms child close during smoke cleanup", async () => {
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
  const result = await terminateChild(child, closed);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(result, {
    close: { code: null, signal: "SIGTERM" },
    requestedSignal: "SIGTERM",
  });
});

test("builds backend evidence only after expected close drains diagnostics", async () => {
  const capture = createBoundedBackendEvidenceCapture({ backend: "metal" });
  capture.write("ggml_metal_init: loading kernels\n");
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    capture.write("found device: Apple M-series GPU\n");
    queueMicrotask(() => child.emit("close", 0, null));
    return true;
  };
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const report = await finalizeHealthyServerSmoke({
    child,
    closed,
    backend: "metal",
    diagnosticCaptures: [capture],
  });
  assert.equal(report.backendVerified, true);
  assert.equal(report.backendEvidenceDetails.deviceObserved, true);
});

test("rejects late Metal failures emitted during expected shutdown", async () => {
  const capture = createBoundedBackendEvidenceCapture({ backend: "metal" });
  capture.write(
    "ggml_metal_init: loading kernels\nMetal device: Apple M-series GPU\n",
  );
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    capture.write("ggml_metal_init: error: late command queue failure\n");
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await assert.rejects(
    finalizeHealthyServerSmoke({
      child,
      closed,
      backend: "metal",
      diagnosticCaptures: [capture],
    }),
    /initialization failure/u,
  );
});

test("rejects natural server exit after health instead of treating it as cleanup", async () => {
  const child = {
    exitCode: 0,
    signalCode: null,
  };
  await assert.rejects(
    finalizeHealthyServerSmoke({
      child,
      closed: Promise.resolve({ code: 0, signal: null }),
      backend: "cpu",
      diagnosticCaptures: [
        createBoundedBackendEvidenceCapture({ backend: "cpu" }),
      ],
    }),
    /exited unexpectedly after private health/u,
  );
});

test("binds the smoke model bytes to the pinned model manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-native002-model-"));
  try {
    const modelPath = path.join(root, "model.bin");
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(modelPath, "model-bytes");
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update("model-bytes").digest("hex");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      engine: {
        version: "v1.9.1",
        commit: "f049fff95a089aa9969deb009cdd4892b3e74916",
      },
      models: [{
        id: "large-v3-q5_0",
        byteSize: 11,
        sha256,
        defaultRecommended: true,
        bundledInInstaller: false,
      }],
    }));
    const verified = await verifyPinnedLaunchModel(modelPath, manifestPath);
    assert.equal(verified.model.sha256, sha256);
    await writeFile(modelPath, "changed");
    await assert.rejects(
      verifyPinnedLaunchModel(modelPath, manifestPath),
      /does not match/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
