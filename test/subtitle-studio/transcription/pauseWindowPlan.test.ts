import { describe, expect, it } from "vitest";
import { LocalSubtitleQuietScanner, planLocalSubtitlePauseRanges as plan } from "../../../electron/main/subtitle-studio/transcription/native/pause-window-plan";

describe("bounded pause geometry", () => {
  it("keeps analysis frames independent of I/O chunk boundaries", () => {
    const bytes = Buffer.alloc(64002);
    for (let i = 16000; i < 17000; i++) bytes.writeInt16LE(300, i * 2);
    for (const chunkBytes of [2, 318, 320, 642, 65536]) {
      const scanner = new LocalSubtitleQuietScanner();
      for (let at = 0; at < bytes.length; at += chunkBytes) scanner.push(bytes.subarray(at, at + chunkBytes));
      expect(scanner.finish()).toEqual([{ startFrame: 0, endFrame: 16000 }, { startFrame: 17120, endFrame: 32001 }]);
      expect(() => scanner.push(bytes)).toThrow();
    }
  });
  it("requires both RMS and peak gates and excludes sub-600ms gaps", () => {
    const bytes = Buffer.alloc(32000);
    for (let i = 0; i < 16000; i += 160) bytes.writeInt16LE(220, i * 2);
    const scanner = new LocalSubtitleQuietScanner(); scanner.push(bytes);
    expect(scanner.finish()).toEqual([]);
    const short = new LocalSubtitleQuietScanner(); short.push(Buffer.alloc(19198));
    expect(short.finish()).toEqual([]);
    expect(() => new LocalSubtitleQuietScanner().push(Buffer.alloc(3))).toThrow();
  });
  it("keeps the guard and chooses the earlier equidistant cut", () => {
    const p = plan(960000, [{ startFrame: 379200, endFrame: 388800 }, { startFrame: 411200, endFrame: 420800 }]);
    expect(p[0].endFrame).toBe(384000);
    expect(p[1].startFrame).toBe(384000);
  });
  it("retains whole silence and falls back for a pause beyond the search limit", () => {
    const duration = 1120001;
    const p = plan(duration, [{ startFrame: 0, endFrame: duration }]);
    expect(p.at(-1)!.endFrame).toBe(duration);
    expect(p.every((w, i) => !i || p[i - 1].endFrame === w.startFrame)).toBe(true);
    expect(plan(duration, [{ startFrame: 460800, endFrame: 480000 }])[0].endFrame).toBe(480000);
  });
  it("rejects invalid candidate claims instead of skipping coverage", () => {
    for (const c of [[{ startFrame: -1, endFrame: 20000 }], [{ startFrame: 0, endFrame: 9000 }],
      [{ startFrame: 20000, endFrame: 40000 }, { startFrame: 10000, endFrame: 20000 }],
      [{ startFrame: 0, endFrame: 960001 }], [{ startFrame: 0.5, endFrame: 20000 }]]) {
      expect(() => plan(960000, c)).toThrow();
    }
    expect(() => plan(0, [])).toThrow();
    expect(() => plan(16000 * 86400 + 1, [])).toThrow();
  });
});
