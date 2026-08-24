import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  WhisperServerError,
  buildWhisperServerEnvironment,
  createWhisperInferenceFields,
  createWhisperServerLaunch,
  parseWhisperVerboseJson,
  postMultipartFile,
} from "./supervisor.mjs";
import {
  languageForSample,
  languageMatches,
  parseBackend,
  selectRequestedSamples,
  selectRealSamples,
} from "./run-poc.mjs";

test("builds a minimal child environment without application secrets", () => {
  const root = path.parse(process.cwd()).root;
  const runtimeDirectory = path.join(root, "runtime");
  const mediaDirectory = path.join(runtimeDirectory, "media");
  const systemRoot = path.join(root, "system-root");
  const environment = buildWhisperServerEnvironment({
    serverPath: path.join(runtimeDirectory, "whisper-server"),
    ffmpegPath: path.join(mediaDirectory, "ffmpeg"),
    tempDirectory: path.join(root, "temp", "fusionkit-whisper"),
    sourceEnvironment: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      COMSPEC: path.join(systemRoot, "System32", "cmd.exe"),
      PATHEXT: ".EXE;.CMD",
      PATH: "C:\\untrusted",
      OPENAI_API_KEY: "must-not-leak",
      HTTPS_PROXY: "http://secret-proxy",
      ProgramFiles: path.join(root, "Program Files"),
      ProgramW6432: path.join(root, "Program Files"),
    },
  });

  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.PATH.includes("untrusted"), false);
  assert.equal(environment.PATH.includes(runtimeDirectory), true);
  assert.equal(environment.TEMP, path.join(root, "temp", "fusionkit-whisper"));
  assert.equal(environment.ProgramFiles, path.join(root, "Program Files"));
});

test("launches the official server on loopback with a private request path", () => {
  const root = path.parse(process.cwd()).root;
  const runtimeDirectory = path.join(root, "runtime");
  const launch = createWhisperServerLaunch({
    serverPath: path.join(runtimeDirectory, "whisper-server"),
    modelPath: path.join(root, "models", "ggml-base.bin"),
    vadModelPath: path.join(root, "models", "ggml-silero-v6.2.0.bin"),
    ffmpegPath: path.join(runtimeDirectory, "ffmpeg"),
    port: 43123,
    requestPath: "/fusionkit-private-token",
    publicDirectory: path.join(root, "temp", "empty-public"),
    mediaTempDirectory: path.join(root, "temp", "media"),
    threads: 6,
    useGpu: false,
    convertWithFfmpeg: true,
    sourceEnvironment: {},
  });

  assert.deepEqual(launch.args.slice(0, 4), [
    "--host",
    "127.0.0.1",
    "--port",
    "43123",
  ]);
  assert.ok(launch.args.includes("/fusionkit-private-token"));
  assert.ok(launch.args.includes("--no-gpu"));
  assert.ok(launch.args.includes("--convert"));
  assert.deepEqual(launch.args.slice(-2), [
    "--vad-model",
    path.join(root, "models", "ggml-silero-v6.2.0.bin"),
  ]);
  assert.equal(launch.spawnOptions.shell, false);
  assert.equal(launch.spawnOptions.windowsHide, true);
  assert.equal(launch.spawnOptions.cwd, runtimeDirectory);

  const cudaLaunch = createWhisperServerLaunch({
    serverPath: path.join(runtimeDirectory, "whisper-server"),
    modelPath: path.join(root, "models", "ggml-large-v3-q5_0.bin"),
    port: 43124,
    requestPath: "/fusionkit-private-cuda",
    publicDirectory: path.join(root, "temp", "empty-public"),
    mediaTempDirectory: path.join(root, "temp", "media"),
    threads: 6,
    useGpu: true,
    convertWithFfmpeg: false,
    sourceEnvironment: {},
  });
  assert.equal(cudaLaunch.args.includes("--no-gpu"), false);
});

test("normalizes official verbose JSON into millisecond segments", () => {
  const result = parseWhisperVerboseJson({
    language: "Chinese",
    duration: 2.5,
    text: " 你好世界 ",
    segments: [
      {
        id: 4,
        start: 0.12,
        end: 2.34,
        text: " 你好世界 ",
        words: [
          { word: "你好", start: 0.12, end: 0.8, probability: 0.91 },
        ],
      },
    ],
  });

  assert.deepEqual(result, {
    text: "你好世界",
    language: "Chinese",
    durationMs: 2_500,
    segments: [
      {
        id: 4,
        startMs: 120,
        endMs: 2_340,
        text: "你好世界",
        words: [
          { text: "你好", startMs: 120, endMs: 800, probability: 0.91 },
        ],
      },
    ],
  });
});

test("VAD forces token timestamps off and ignores compressed word timestamps", () => {
  const fields = createWhisperInferenceFields({
    language: "ja",
    vad: true,
    tokenTimestamps: true,
  });
  assert.equal(fields.vad, "true");
  assert.equal(fields.token_timestamps, "false");
  assert.throws(
    () => createWhisperInferenceFields({ vad: "false" }),
    (error) =>
      error instanceof WhisperServerError && error.code === "invalid_request",
  );

  const result = parseWhisperVerboseJson({
    language: "Japanese",
    duration: 30,
    text: "そういえばさ、お風呂どうする?",
    segments: [{
      id: 0,
      start: 13.7,
      end: 17.28,
      text: "そういえばさ、お風呂どうする?",
      words: [{
        word: "そう",
        start: 0,
        end: 0.44,
        probability: 0.67,
      }],
    }],
  }, { includeWords: false });

  assert.equal(result.segments[0].startMs, 13_700);
  assert.equal(result.segments[0].endMs, 17_280);
  assert.equal(result.segments[0].words, undefined);
});

test("rejects malformed verbose JSON instead of parsing human logs", () => {
  assert.throws(
    () => parseWhisperVerboseJson({ text: "not enough" }),
    (error) =>
      error instanceof WhisperServerError && error.code === "invalid_response",
  );
  assert.throws(
    () => parseWhisperVerboseJson({
      segments: [{ start: 3, end: 2, text: "backwards" }],
    }),
    (error) =>
      error instanceof WhisperServerError && error.code === "invalid_response",
  );
});

test("streams multipart inference without the fetch response-header timeout", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fusionkit-multipart-test-"));
  const filePath = path.join(directory, "sample.bin");
  await writeFile(filePath, Buffer.from([0, 1, 2, 3, 255]));
  let requestBody = Buffer.alloc(0);
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requestBody = Buffer.concat(chunks);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"segments":[]}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    const response = await postMultipartFile({
      url: `http://127.0.0.1:${address.port}/inference`,
      filePath,
      fileName: 'sample"\r\n.bin',
      fields: { response_format: "verbose_json", language: "ja" },
      timeoutMs: 5_000,
    });
    assert.equal(response.ok, true);
    assert.equal(response.bodyText, '{"segments":[]}');
    const bodyText = requestBody.toString("latin1");
    assert.match(bodyText, /name="response_format"/u);
    assert.match(bodyText, /verbose_json/u);
    assert.match(bodyText, /filename="sample___\.bin"/u);
    assert.equal(requestBody.includes(Buffer.from([0, 1, 2, 3, 255])), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("selects only the three real Chinese and Japanese inventory samples", () => {
  const samples = selectRealSamples({
    files: [
      { sampleId: "zh-one", mediaPath: "zh.mp4", subtitlePath: "zh.srt" },
      { sampleId: "ja-one", mediaPath: "ja.wav", subtitlePath: "ja.lrc" },
      {
        sampleId: "zh-../../escape",
        mediaPath: path.resolve("escape.mp4"),
        subtitlePath: path.resolve("escape.srt"),
      },
      { sampleId: "synthetic-silence-short", mediaPath: "silence.wav" },
    ],
  });
  assert.deepEqual(samples.map((sample) => sample.sampleId), []);

  const absoluteSamples = selectRealSamples({
    files: [
      {
        sampleId: "zh-one",
        mediaPath: path.resolve("samples/zh.mp4"),
        subtitlePath: path.resolve("samples/zh.srt"),
      },
      {
        sampleId: "ja-one",
        mediaPath: path.resolve("samples/ja.wav"),
        subtitlePath: path.resolve("samples/ja.lrc"),
      },
    ],
  });
  assert.deepEqual(
    absoluteSamples.map((sample) => sample.sampleId),
    ["zh-one", "ja-one"],
  );
  assert.equal(languageForSample("zh-one"), "zh");
  assert.equal(languageForSample("ja-one"), "ja");
  assert.equal(languageForSample("other"), "auto");
  assert.equal(languageMatches("zh", "chinese"), true);
  assert.equal(languageMatches("ja", "Japanese"), true);
  assert.equal(languageMatches("zh", "japanese"), false);
  assert.equal(parseBackend("metal"), "metal");
  assert.throws(() => parseBackend("vulkan"), /cpu, cuda, or metal/u);
  assert.deepEqual(
    selectRequestedSamples(absoluteSamples, ["ja-one", "ja-one"])
      .map((sample) => sample.sampleId),
    ["ja-one"],
  );
  assert.throws(
    () => selectRequestedSamples(absoluteSamples, ["missing"]),
    /Unknown --sample value/u,
  );
});
