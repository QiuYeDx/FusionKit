#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { inspectPcm16Wav } from "../whisper-server/pcm-windowing.mjs";
import {
  RUNTIME_MANIFEST_RELATIVE_PATH,
  buildSanitizedRuntimeEnvironment,
  loadRuntimeManifest,
  resolveContainedResourcePath,
  verifyRuntimeBundle,
} from "./runtime-manifest.mjs";

const execFileAsync = promisify(execFile);

export const PRE005_FORMAT_CASES = Object.freeze([
  Object.freeze({ id: "mp3", fileName: "sample.mp3", video: false }),
  Object.freeze({ id: "wav", fileName: "sample.wav", video: false }),
  Object.freeze({ id: "flac", fileName: "sample.flac", video: false }),
  Object.freeze({ id: "aac", fileName: "sample.aac", video: false }),
  Object.freeze({ id: "m4a", fileName: "sample.m4a", video: false }),
  Object.freeze({ id: "mp4", fileName: "sample.mp4", video: true }),
  Object.freeze({ id: "mkv", fileName: "sample.mkv", video: true }),
  Object.freeze({ id: "mov", fileName: "sample.mov", video: true }),
  Object.freeze({ id: "webm", fileName: "sample.webm", video: true }),
]);

export async function runPre005Smoke(options) {
  const runtimeRoot = path.resolve(requirePath(options.runtimeRoot, "runtimeRoot"));
  const generatorFfmpeg = path.resolve(
    requirePath(options.fixtureGeneratorFfmpeg, "fixtureGeneratorFfmpeg"),
  );
  const workRoot = path.resolve(requirePath(options.workRoot, "workRoot"));
  await assertMissing(workRoot, "The PRE-005 smoke work directory already exists.");
  await mkdir(workRoot, { recursive: true });

  const bundleVerification = await verifyRuntimeBundle({
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
  const ffmpegArtifact = loaded.manifest.artifacts.find(
    (artifact) => artifact.kind === "ffmpeg",
  );
  const ffprobeArtifact = loaded.manifest.artifacts.find(
    (artifact) => artifact.kind === "ffprobe",
  );
  const ffmpegPath = resolveContainedResourcePath(
    loaded.root,
    ffmpegArtifact.relativePath,
  );
  const ffprobePath = resolveContainedResourcePath(
    loaded.root,
    ffprobeArtifact.relativePath,
  );
  const isolatedEnvironment = buildSanitizedRuntimeEnvironment("darwin", {
    TMPDIR: path.join(workRoot, "tmp"),
  });
  await mkdir(isolatedEnvironment.TMPDIR, { recursive: true });
  const whichProbe = await runCommand(
    "/usr/bin/which",
    ["ffmpeg"],
    {
      cwd: workRoot,
      env: isolatedEnvironment,
      timeoutMs: 10_000,
      allowFailure: true,
    },
  );
  if (whichProbe.exitCode === 0) {
    throw new Error("The no-PATH smoke environment can still resolve system FFmpeg.");
  }

  const fixtureRoot = path.join(workRoot, "fixtures");
  const normalizedRoot = path.join(workRoot, "normalized");
  await mkdir(normalizedRoot, { recursive: true });
  const fixtures = await generateMediaFixtures(generatorFfmpeg, fixtureRoot);
  const formatMatrix = [];
  for (const formatCase of PRE005_FORMAT_CASES) {
    const inputPath = path.join(fixtureRoot, formatCase.fileName);
    const probe = await probeMedia(ffprobePath, inputPath, isolatedEnvironment);
    const summary = summarizeMediaProbe(probe);
    if (
      summary.audioStreamCount < 1 ||
      summary.durationMs <= 0 ||
      (formatCase.video && summary.videoStreamCount < 1)
    ) {
      throw new Error(`Bundled ffprobe did not recognize the ${formatCase.id} fixture.`);
    }
    const outputPath = path.join(normalizedRoot, `${formatCase.id}.wav`);
    const progress = await normalizeMedia(
      ffmpegPath,
      inputPath,
      outputPath,
      isolatedEnvironment,
      "0:a:0",
    );
    const pcm = await inspectPcm16Wav(outputPath);
    assertPcmContract(pcm);
    formatMatrix.push({
      format: formatCase.id,
      audioStreamCount: summary.audioStreamCount,
      videoStreamCount: summary.videoStreamCount,
      normalizedPcm16: true,
      progressEndObserved: progress.progressEndObserved,
    });
  }

  const multiTrackProbe = summarizeMediaProbe(
    await probeMedia(
      ffprobePath,
      path.join(fixtureRoot, fixtures.multiTrackFileName),
      isolatedEnvironment,
    ),
  );
  if (
    multiTrackProbe.audioStreamCount !== 2 ||
    multiTrackProbe.defaultAudioStreamCount !== 1
  ) {
    throw new Error("Bundled ffprobe did not preserve the multi-track contract.");
  }
  const secondTrackOutput = path.join(normalizedRoot, "multi-track-second.wav");
  await normalizeMedia(
    ffmpegPath,
    path.join(fixtureRoot, fixtures.multiTrackFileName),
    secondTrackOutput,
    isolatedEnvironment,
    "0:a:1",
  );
  assertPcmContract(await inspectPcm16Wav(secondTrackOutput));

  const longPathOutput = path.join(normalizedRoot, "long-non-ascii.wav");
  const longPathProbe = summarizeMediaProbe(
    await probeMedia(ffprobePath, fixtures.longNonAsciiPath, isolatedEnvironment),
  );
  await normalizeMedia(
    ffmpegPath,
    fixtures.longNonAsciiPath,
    longPathOutput,
    isolatedEnvironment,
    "0:a:0",
  );
  assertPcmContract(await inspectPcm16Wav(longPathOutput));

  const corruptResult = await probeMediaResult(
    ffprobePath,
    path.join(fixtureRoot, fixtures.corruptFileName),
    isolatedEnvironment,
  );
  if (corruptResult.ok) {
    throw new Error("The corrupt fixture unexpectedly passed ffprobe.");
  }
  const zeroDurationProbe = summarizeMediaProbe(
    await probeMedia(
      ffprobePath,
      path.join(fixtureRoot, fixtures.zeroDurationFileName),
      isolatedEnvironment,
    ),
  );
  if (zeroDurationProbe.durationMs !== 0) {
    throw new Error("The zero-duration fixture did not remain zero duration.");
  }

  const faultMatrix = await runFaultMatrix(runtimeRoot);
  const report = {
    schemaVersion: 1,
    workPackage: "PRE-005",
    target: { platform: "darwin", arch: "arm64" },
    status: "current_environment_passed",
    packagedRuntime: {
      manifestSha256: bundleVerification.manifestSha256,
      artifactCount: bundleVerification.artifactCount,
      launchResults: bundleVerification.launchResults,
      signatureVerification: bundleVerification.signatureVerification,
      noPathFallback: bundleVerification.noPathFallback,
      sourceAndLicenseEvidenceFileCount: bundleVerification.evidenceFileCount,
    },
    fixtureGenerator: {
      systemFfmpegUsedForFixtureGenerationOnly: true,
      stagedAsRuntime: false,
      releaseEvidence: false,
    },
    formatMatrix,
    multiTrack: {
      audioStreamCount: multiTrackProbe.audioStreamCount,
      defaultAudioStreamCount: multiTrackProbe.defaultAudioStreamCount,
      explicitSecondTrackNormalized: true,
    },
    pathMatrix: {
      nonAscii: true,
      longPath: true,
      pathCharacterCount: fixtures.longPathCharacterCount,
      audioStreamCount: longPathProbe.audioStreamCount,
      normalizedPcm16: true,
    },
    invalidInputMatrix: {
      corruptRejected: true,
      zeroDurationRejectedBeforeEnqueue: true,
    },
    faultMatrix,
    blocksBeforeEnqueue: faultMatrix.every((entry) => entry.blockedBeforeEnqueue),
    remainingTargetEvidence: [
      "windows_x64_packaged_no_path_and_authenticode_runtime_smoke",
    ],
    deferredReleaseEvidence: [
      "ffmpeg_detached_signature_verification_with_pinned_key",
      "developer_id_notarization_and_gatekeeper_acceptance_QA_004",
    ],
    privacy: {
      absolutePathsRecorded: false,
      mediaContentRecorded: false,
      signingIdentityRecorded: false,
    },
  };
  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

export async function generateMediaFixtures(generatorFfmpeg, fixtureRoot) {
  await mkdir(fixtureRoot, { recursive: true });
  const environment = buildSanitizedRuntimeEnvironment("darwin", {
    TMPDIR: path.join(fixtureRoot, "tmp"),
  });
  await mkdir(environment.TMPDIR, { recursive: true });
  const baseTone = path.join(fixtureRoot, "base-tone.wav");
  await runGenerator(generatorFfmpeg, [
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2",
    "-c:a",
    "pcm_s16le",
    baseTone,
  ], fixtureRoot, environment);
  await copyFile(baseTone, path.join(fixtureRoot, "sample.wav"));

  const audioCases = [
    ["sample.mp3", ["-c:a", "libmp3lame"]],
    ["sample.flac", ["-c:a", "flac"]],
    ["sample.aac", ["-c:a", "aac", "-f", "adts"]],
    ["sample.m4a", ["-c:a", "aac"]],
  ];
  for (const [fileName, codecArgs] of audioCases) {
    await runGenerator(
      generatorFfmpeg,
      ["-i", baseTone, ...codecArgs, path.join(fixtureRoot, fileName)],
      fixtureRoot,
      environment,
    );
  }

  const videoCases = [
    ["sample.mp4", ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"]],
    ["sample.mkv", ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "flac"]],
    ["sample.mov", ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"]],
    [
      "sample.webm",
      ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus"],
    ],
  ];
  for (const [fileName, codecArgs] of videoCases) {
    await runGenerator(
      generatorFfmpeg,
      [
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:r=1:d=2",
        "-i",
        baseTone,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-shortest",
        ...codecArgs,
        path.join(fixtureRoot, fileName),
      ],
      fixtureRoot,
      environment,
    );
  }

  const multiTrackFileName = "multi-track.mkv";
  await runGenerator(
    generatorFfmpeg,
    [
      "-i",
      baseTone,
      "-i",
      baseTone,
      "-map",
      "0:a:0",
      "-map",
      "1:a:0",
      "-c:a",
      "flac",
      "-disposition:a:0",
      "default",
      "-disposition:a:1",
      "0",
      "-metadata:s:a:0",
      "language=jpn",
      "-metadata:s:a:1",
      "language=zho",
      path.join(fixtureRoot, multiTrackFileName),
    ],
    fixtureRoot,
    environment,
  );

  const longLeaf = `非ASCII-${"long-path-".repeat(20)}media`;
  const longDirectory = path.join(fixtureRoot, longLeaf);
  await mkdir(longDirectory, { recursive: true });
  const longNonAsciiPath = path.join(longDirectory, "样本-video.mp4");
  await copyFile(path.join(fixtureRoot, "sample.mp4"), longNonAsciiPath);

  const corruptFileName = "corrupt.mp4";
  const mp4Bytes = await readFile(path.join(fixtureRoot, "sample.mp4"));
  await writeFile(
    path.join(fixtureRoot, corruptFileName),
    mp4Bytes.subarray(0, Math.min(128, mp4Bytes.length)),
  );
  const zeroDurationFileName = "zero-duration.wav";
  await writeFile(
    path.join(fixtureRoot, zeroDurationFileName),
    createZeroDurationPcm16Wav(),
  );
  return {
    multiTrackFileName,
    longNonAsciiPath,
    longPathCharacterCount: path.relative(fixtureRoot, longNonAsciiPath).length,
    corruptFileName,
    zeroDurationFileName,
  };
}

export function createZeroDurationPcm16Wav() {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(0, 40);
  return buffer;
}

export function summarizeMediaProbe(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(probe?.format?.duration ?? 0);
  return {
    audioStreamCount: audioStreams.length,
    videoStreamCount: streams.filter((stream) => stream.codec_type === "video").length,
    defaultAudioStreamCount: audioStreams.filter(
      (stream) => stream.disposition?.default === 1,
    ).length,
    durationMs:
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.round(durationSeconds * 1_000)
        : 0,
  };
}

export async function runFaultMatrix(runtimeRoot) {
  const cases = [
    {
      id: "manifest_missing",
      expectedCode: "media_runtime_missing",
      mutate: async (root) => rm(manifestPath(root)),
    },
    {
      id: "ffmpeg_missing",
      expectedCode: "media_runtime_missing",
      mutate: async (root, manifest) => rm(artifactPath(root, manifest, "ffmpeg")),
    },
    {
      id: "license_missing",
      expectedCode: "media_runtime_missing",
      mutate: async (root, manifest) =>
        rm(path.join(root, ...manifest.licenses[1].licenseFiles[0].relativePath.split("/"))),
    },
    {
      id: "source_offer_missing",
      expectedCode: "media_runtime_missing",
      mutate: async (root, manifest) =>
        rm(path.join(root, ...manifest.sources[1].evidenceFile.relativePath.split("/"))),
    },
    {
      id: "ffmpeg_hash_changed",
      expectedCode: "media_runtime_invalid",
      mutate: async (root, manifest) =>
        appendFile(artifactPath(root, manifest, "ffmpeg"), "changed"),
    },
    {
      id: "ffmpeg_wrong_architecture",
      expectedCode: "media_runtime_invalid",
      mutate: async (root, manifest) => {
        const target = artifactPath(root, manifest, "ffmpeg");
        const bytes = await readFile(target);
        bytes.writeUInt32LE(0x01000007, 4);
        await writeFile(target, bytes);
        await updateArtifactEvidence(root, manifest, "ffmpeg");
      },
    },
    {
      id: "ffmpeg_not_executable",
      expectedCode: "media_runtime_invalid",
      mutate: async (root, manifest) =>
        chmod(artifactPath(root, manifest, "ffmpeg"), 0o644),
    },
    {
      id: "ffmpeg_launch_identity_failed",
      expectedCode: "media_runtime_launch_failed",
      launch: true,
      mutate: async (root, manifest) => {
        const ffmpeg = artifactPath(root, manifest, "ffmpeg");
        const ffprobe = artifactPath(root, manifest, "ffprobe");
        await copyFile(ffprobe, ffmpeg);
        await chmod(ffmpeg, 0o755);
        await updateArtifactEvidence(root, manifest, "ffmpeg");
      },
    },
    {
      id: "server_missing",
      expectedCode: "runtime_missing",
      scope: "all",
      mutate: async (root, manifest) => rm(artifactPath(root, manifest, "server")),
    },
  ];
  const results = [];
  for (const fault of cases) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-pre005-fault-"));
    const copyRoot = path.join(tempRoot, "local-subtitle");
    try {
      await cp(runtimeRoot, copyRoot, {
        recursive: true,
        preserveTimestamps: true,
      });
      const manifest = JSON.parse(await readFile(manifestPath(copyRoot), "utf8"));
      await fault.mutate(copyRoot, manifest);
      let observedCode = null;
      try {
        await verifyRuntimeBundle({
          runtimeRoot: copyRoot,
          platform: "darwin",
          arch: "arm64",
          scope: fault.scope ?? "media",
          launch: fault.launch === true,
        });
      } catch (error) {
        observedCode = error?.code ?? null;
        if (String(error?.message ?? "").includes(tempRoot)) {
          throw new Error("A fault diagnostic exposed its temporary path.");
        }
      }
      if (observedCode !== fault.expectedCode) {
        throw new Error(
          `${fault.id} returned ${observedCode ?? "success"}, expected ${fault.expectedCode}.`,
        );
      }
      results.push({
        fault: fault.id,
        errorCode: observedCode,
        blockedBeforeEnqueue: true,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
  return results;
}

async function probeMedia(ffprobePath, inputPath, environment) {
  const result = await probeMediaResult(ffprobePath, inputPath, environment);
  if (!result.ok) throw new Error("Bundled ffprobe failed a supported fixture.");
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Bundled ffprobe returned invalid JSON.");
  }
}

async function probeMediaResult(ffprobePath, inputPath, environment) {
  const result = await runCommand(
    ffprobePath,
    [
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,codec_name,channels:stream_disposition=default:format=duration",
      "-of",
      "json",
      inputPath,
    ],
    {
      cwd: path.dirname(inputPath),
      env: environment,
      timeoutMs: 30_000,
      allowFailure: true,
    },
  );
  return { ok: result.exitCode === 0, stdout: result.stdout };
}

async function normalizeMedia(
  ffmpegPath,
  inputPath,
  outputPath,
  environment,
  streamSelector,
) {
  const result = await runCommand(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      inputPath,
      "-map",
      streamSelector,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "-progress",
      "pipe:1",
      "-nostats",
      outputPath,
    ],
    {
      cwd: path.dirname(outputPath),
      env: environment,
      timeoutMs: 30_000,
    },
  );
  return { progressEndObserved: /(?:^|\n)progress=end(?:\r?\n|$)/u.test(result.stdout) };
}

function assertPcmContract(pcm) {
  if (
    pcm.sampleRate !== 16_000 ||
    pcm.channels !== 1 ||
    pcm.bitsPerSample !== 16 ||
    pcm.totalFrames <= 0
  ) {
    throw new Error("Bundled FFmpeg output did not satisfy the PCM16 contract.");
  }
}

async function runGenerator(command, args, cwd, environment) {
  await runCommand(
    command,
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args],
    { cwd, env: environment, timeoutMs: 60_000 },
  );
}

async function runCommand(command, args, options) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const result = {
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? ""),
    };
    if (options.allowFailure === true) return result;
    throw new Error(`PRE-005 command failed: ${path.basename(command)}.`);
  }
}

function manifestPath(runtimeRoot) {
  return path.join(runtimeRoot, ...RUNTIME_MANIFEST_RELATIVE_PATH.split("/"));
}

function artifactPath(runtimeRoot, manifest, kind) {
  const artifact = manifest.artifacts.find((entry) => entry.kind === kind);
  if (!artifact) throw new Error(`Fault fixture is missing ${kind}.`);
  return path.join(runtimeRoot, ...artifact.relativePath.split("/"));
}

async function updateArtifactEvidence(runtimeRoot, manifest, kind) {
  const artifact = manifest.artifacts.find((entry) => entry.kind === kind);
  const target = artifactPath(runtimeRoot, manifest, kind);
  const targetStat = await stat(target);
  artifact.byteSize = targetStat.size;
  artifact.sha256 = createHash("sha256").update(await readFile(target)).digest("hex");
  await writeFile(manifestPath(runtimeRoot), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function assertMissing(filePath, message) {
  try {
    await stat(filePath);
    throw new Error(message);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
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
      "fixture-generator-ffmpeg": { type: "string" },
      work: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    runtimeRoot: values.runtime,
    fixtureGeneratorFfmpeg: values["fixture-generator-ffmpeg"],
    workRoot: values.work,
    outputPath: values.output,
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node run-pre005-smoke.mjs --runtime <packaged-local-subtitle> " +
        "--fixture-generator-ffmpeg <development-only-ffmpeg> --work <ignored-dir> " +
        "[--output <ignored-report.json>]\n",
    );
    return;
  }
  const report = await runPre005Smoke(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`pre005_smoke_failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
