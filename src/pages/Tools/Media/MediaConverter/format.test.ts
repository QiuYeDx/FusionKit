import { describe, expect, it } from "vitest";
import {
  UNKNOWN_VALUE,
  formatBitRate,
  formatBytes,
  formatDurationMs,
  formatDurationUs,
  formatFrameRate,
  formatPercent,
  formatResolution,
  formatSampleRate,
  formatSizeChange,
  formatSpeed,
} from "./format";

const KIB = 1024;
const MIB = KIB ** 2;
const GIB = KIB ** 3;
const TIB = KIB ** 4;

describe("media converter number formats", () => {
  it("shows sizes in 1024-based units labelled KB, MB, GB and TB", () => {
    expect(formatBytes(0, "en")).toBe("0 B");
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(1023, "en")).toBe("1,023 B");
    expect(formatBytes(KIB, "en")).toBe("1 KB");
    expect(formatBytes(1.5 * KIB, "en")).toBe("1.5 KB");
    // 1024-based: a million bytes is not 1 MB but 976.6 KB.
    expect(formatBytes(1_000_000, "en")).toBe("977 KB");
    expect(formatBytes(24.3 * MIB, "en")).toBe("24.3 MB");
    expect(formatBytes(512 * MIB, "en")).toBe("512 MB");
    expect(formatBytes(188.4 * MIB, "en")).toBe("188 MB");
    expect(formatBytes(1.25 * GIB, "en")).toBe("1.3 GB");
    expect(formatBytes(3 * GIB, "en")).toBe("3 GB");
    expect(formatBytes(3.5 * TIB, "en")).toBe("3.5 TB");
    expect(formatBytes(2048 * TIB, "en")).toBe("2,048 TB");
  });

  it("never shows a size that rounds up to 1024 of its unit", () => {
    expect(formatBytes(GIB - 1, "en")).toBe("1 GB");
    expect(formatBytes(MIB - 1, "en")).toBe("1 MB");
    expect(formatBytes(1023.96 * MIB, "en")).toBe("1 GB");
    expect(formatBytes(1023.4 * MIB, "en")).toBe("1,023 MB");
  });

  it("writes numbers the way the current language does", () => {
    for (const language of ["zh", "zh-Hant", "ja", "en"]) {
      expect(formatBytes(1.5 * GIB, language)).toBe("1.5 GB");
      expect(formatBitRate(4_500_000, language)).toBe("4.5 Mbps");
      expect(formatPercent(0.62, language)).toBe("62%");
    }
    // A language with a decimal comma and a space before the percent sign.
    expect(formatBytes(1.5 * GIB, "de")).toBe("1,5 GB");
    expect(formatSampleRate(44_100, "de")).toBe("44,1 kHz");
    expect(formatPercent(0.62, "de")).toBe("62 %");
    // An unknown tag still formats, in English.
    expect(formatBytes(1.5 * GIB, "not a language")).toBe("1.5 GB");
  });

  it("shows durations as a clock, never 0:00 for something that lasts", () => {
    expect(formatDurationUs(0, "zh")).toBe("0:00");
    expect(formatDurationUs(400_000, "zh")).toBe("0:01");
    expect(formatDurationUs(2_000_000, "zh")).toBe("0:02");
    expect(formatDurationUs(42_400_000, "zh")).toBe("0:42");
    expect(formatDurationUs(61_500_000, "zh")).toBe("1:02");
    expect(formatDurationUs(725_000_000, "en")).toBe("12:05");
    expect(formatDurationUs(3_723_000_000, "en")).toBe("1:02:03");
    expect(formatDurationUs(100 * 3_600_000_000, "en")).toBe("100:00:00");
    expect(formatDurationMs(72_000, "en")).toBe("1:12");
    expect(formatDurationMs(3_600_000, "ja")).toBe("1:00:00");
  });

  it("shows bit rates in 1000-based units", () => {
    expect(formatBitRate(96_000, "en")).toBe("96 kbps");
    expect(formatBitRate(127_800, "en")).toBe("128 kbps");
    expect(formatBitRate(999_400, "en")).toBe("999 kbps");
    // Rounds up to 1000 kbps: that is 1 Mbps.
    expect(formatBitRate(999_600, "en")).toBe("1 Mbps");
    expect(formatBitRate(4_510_000, "en")).toBe("4.5 Mbps");
    expect(formatBitRate(120_000_000, "en")).toBe("120 Mbps");
  });

  it("shows frame rates, sample rates and speeds", () => {
    expect(formatFrameRate(25, "en")).toBe("25");
    expect(formatFrameRate(30000 / 1001, "en")).toBe("29.97");
    expect(formatFrameRate(24000 / 1001, "en")).toBe("23.976");
    expect(formatFrameRate(60000 / 1001, "en")).toBe("59.94");
    // The average of a variable rate, shown as "about": one decimal at most.
    expect(formatFrameRate(14.985, "en", true)).toBe("15");
    expect(formatFrameRate(29.874, "en", true)).toBe("29.9");
    expect(formatFrameRate(29.874, "de", true)).toBe("29,9");
    expect(formatSampleRate(48_000, "en")).toBe("48 kHz");
    expect(formatSampleRate(44_100, "en")).toBe("44.1 kHz");
    expect(formatSampleRate(22_050, "en")).toBe("22.05 kHz");
    expect(formatSpeed(0.456, "en")).toBe("0.46×");
    expect(formatSpeed(3.14, "en")).toBe("3.1×");
    expect(formatSpeed(12.4, "en")).toBe("12×");
  });

  it("shows percentages and how an output compares with its source, with a real minus sign", () => {
    expect(formatPercent(0, "en")).toBe("0%");
    expect(formatPercent(0.999, "en")).toBe("100%");
    expect(formatSizeChange(512 * MIB, 188 * MIB, "zh")).toBe("−63%");
    expect(formatSizeChange(100, 112, "en")).toBe("+12%");
    expect(formatSizeChange(100, 100, "en")).toBe("0%");
    expect(formatSizeChange(1000, 999, "en")).toBe("0%");
    expect(formatSizeChange(0, 100, "en")).toBe(UNKNOWN_VALUE);
  });

  it("shows the picture as a player turns it", () => {
    expect(formatResolution(1920, 1080)).toBe("1920×1080");
    expect(formatResolution(1920, 1080, 90)).toBe("1080×1920");
    expect(formatResolution(1920, 1080, 180)).toBe("1920×1080");
    expect(formatResolution(1920, 1080, 270)).toBe("1080×1920");
  });

  it("reads anything that cannot be a size, rate or duration as unknown", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(formatBytes(value, "en")).toBe(UNKNOWN_VALUE);
      expect(formatDurationUs(value, "en")).toBe(UNKNOWN_VALUE);
      expect(formatDurationMs(value, "en")).toBe(UNKNOWN_VALUE);
      expect(formatBitRate(value, "en")).toBe(UNKNOWN_VALUE);
      expect(formatFrameRate(value, "en")).toBe(UNKNOWN_VALUE);
      expect(formatSampleRate(value, "en")).toBe(UNKNOWN_VALUE);
      expect(formatSpeed(value, "en")).toBe(UNKNOWN_VALUE);
    }
    expect(formatPercent(Number.NaN, "en")).toBe(UNKNOWN_VALUE);
  });
});
