import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  WhisperServerError,
  buildWhisperServerEnvironment,
  createWhisperServerLaunch,
  parseWhisperVerboseJson,
  postMultipartFile,
} from "./supervisor.mjs";
import {
  languageForSample,
  languageMatches,
  selectRequestedSamples,
  selectRealSamples,
} from "./run-poc.mjs";

test("builds a minimal child environment without application secrets", () => {
  const environment = buildWhisperServerEnvironment({
    serverPath: "C:\\runtime\\whisper-server.exe",
    ffmpegPath: "C:\\runtime\\media\\ffmpeg.exe",
    tempDirectory: "C:\\temp\\fusionkit-whisper",
    sourceEnvironment: {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".EXE;.CMD",
      PATH: "C:\\untrusted",
      OPENAI_API_KEY: "must-not-leak",
      HTTPS_PROXY: "http://secret-proxy",
      ProgramFiles: "C:\\Program Files",
      ProgramW6432: "C:\\Program Files",
    },
  });

  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.PATH.includes("untrusted"), false);
  assert.equal(environment.PATH.includes("C:\\runtime"), true);
  assert.equal(environment.TEMP, "C:\\temp\\fusionkit-whisper");
  assert.equal(environment.ProgramFiles, "C:\\Program Files");
});

test("launches the official server on loopback with a private request path", () => {
  const launch = createWhisperServerLaunch({
    serverPath: "C:\\runtime\\whisper-server.exe",
    modelPath: "C:\\models\\ggml-base.bin",
    ffmpegPath: "C:\\runtime\\ffmpeg.exe",
    port: 43123,
    requestPath: "/fusionkit-private-token",
    publicDirectory: "C:\\temp\\empty-public",
    mediaTempDirectory: "C:\\temp\\media",
    threads: 6,
    useGpu: false,
    convertWithFfmpeg: true,
    sourceEnvironment: { SystemRoot: "C:\\Windows" },
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
  assert.equal(launch.spawnOptions.shell, false);
  assert.equal(launch.spawnOptions.windowsHide, true);
  assert.equal(launch.spawnOptions.cwd, "C:\\runtime");

  const cudaLaunch = createWhisperServerLaunch({
    serverPath: "C:\\runtime\\whisper-server.exe",
    modelPath: "C:\\models\\ggml-large-v3-q5_0.bin",
    port: 43124,
    requestPath: "/fusionkit-private-cuda",
    publicDirectory: "C:\\temp\\empty-public",
    mediaTempDirectory: "C:\\temp\\media",
    threads: 6,
    useGpu: true,
    convertWithFfmpeg: false,
    sourceEnvironment: { SystemRoot: "C:\\Windows" },
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
