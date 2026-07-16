import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  WhisperServerError,
  buildWhisperServerEnvironment,
  createWhisperServerLaunch,
  parseWhisperVerboseJson,
} from "./supervisor.mjs";
import { languageForSample, selectRealSamples } from "./run-poc.mjs";

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
    },
  });

  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.PATH.includes("untrusted"), false);
  assert.equal(environment.PATH.includes("C:\\runtime"), true);
  assert.equal(environment.TEMP, "C:\\temp\\fusionkit-whisper");
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
});
