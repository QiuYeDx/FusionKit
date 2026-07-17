import assert from "node:assert/strict";
import test from "node:test";
import {
  parseNvidiaComputeApps,
  parseWindowsProcessMetrics,
} from "./process-metrics.mjs";
import {
  createSmokeCues,
  formatSmokeLrc,
  formatSmokeSrt,
  parseSmokeLrc,
  parseSmokeSrt,
  verifySmokeLrcRoundTrip,
  verifySmokeSrtRoundTrip,
} from "./subtitle-smoke.mjs";

test("parses only the target whisper-server VRAM entry", () => {
  assert.equal(
    parseNvidiaComputeApps("123, 512\n456, 1024 MiB\n", 456),
    1024 * 1024 * 1024,
  );
  assert.equal(parseNvidiaComputeApps("[Not Supported]", 456), 0);
  assert.deepEqual(parseWindowsProcessMetrics("1127084032,4294967296", true), {
    ramBytes: 1_127_084_032,
    vramBytes: 4_294_967_296,
  });
  assert.deepEqual(parseWindowsProcessMetrics("1024,0", false), {
    ramBytes: 1_024,
    vramBytes: undefined,
  });
  assert.deepEqual(parseWindowsProcessMetrics("1024,-1", true), {
    ramBytes: 1_024,
    vramBytes: undefined,
  });
});

test("formats and independently parses SRT and standard LRC smoke output", () => {
  const cues = createSmokeCues([
    { startMs: 9, endMs: 1_234, text: " 你好\r\n世界 " },
    { startMs: 60_011, endMs: 61_500, text: "次の行" },
    { startMs: 1_000, endMs: 1_000, text: "invalid" },
  ]);
  const srt = formatSmokeSrt(cues);
  const lrc = formatSmokeLrc(cues);

  assert.deepEqual(parseSmokeSrt(srt), [
    { startMs: 9, endMs: 1_234, text: "你好 世界" },
    { startMs: 60_011, endMs: 61_500, text: "次の行" },
  ]);
  assert.deepEqual(parseSmokeLrc(lrc), [
    { startCentiseconds: 0, text: "你好 世界" },
    { startCentiseconds: 6_001, text: "次の行" },
  ]);
  assert.equal(verifySmokeSrtRoundTrip(cues, srt), true);
  assert.equal(verifySmokeLrcRoundTrip(cues, lrc), true);
});
