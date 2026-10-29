/**
 * Numbers of the media converter as the interface shows them (module-workbench tasks T-WORKBENCH-03):
 * sizes in 1024-based units labelled KB/MB/GB/TB (R-WORKBENCH-06), clock durations, bit and sample
 * rates, frame rates, speeds and percentages, each in the language given (`i18n.language`).
 * Units and the clock layout are the same in every language; the digits, separators and grouping are not.
 */

const KIB = 1024;
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
/** U+2212: a real minus for "−62%", as the requirements write it. */
const MINUS = "−";
/** What a value that cannot be a size, rate or duration reads as. */
export const UNKNOWN_VALUE = "—";

const formats = new Map<string, Intl.NumberFormat>();
/** One `Intl.NumberFormat` per language and options; an unknown language tag falls back to English. */
function numberFormat(language: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${language}\u0000${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) {
    try { format = new Intl.NumberFormat(language || "en", options); }
    catch { format = new Intl.NumberFormat("en", options); }
    formats.set(key, format);
  }
  return format;
}

const usable = (value: number) => Number.isFinite(value) && value >= 0;
/** Digits after the point: one below 100, none from 100 (24.3 MB, 512 MB). */
const fractionDigits = (value: number) => (value >= 100 ? 0 : 1);
const roundTo = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Bytes in 1024-based units: "512 B", "1.5 KB", "24.3 MB", "512 MB", "1.2 GB", "3.5 TB". */
export function formatBytes(bytes: number, language: string): string {
  if (!usable(bytes)) return UNKNOWN_VALUE;
  let unit = 0;
  let value = bytes;
  while (value >= KIB && unit < SIZE_UNITS.length - 1) {
    value /= KIB;
    unit++;
  }
  // 1023.96 MB would round to "1,024 MB": that is 1 GB.
  if (unit > 0 && unit < SIZE_UNITS.length - 1 && roundTo(value, fractionDigits(value)) >= KIB) {
    value /= KIB;
    unit++;
  }
  const digits = unit === 0 ? 0 : fractionDigits(value);
  return `${numberFormat(language, { maximumFractionDigits: digits }).format(value)} ${SIZE_UNITS[unit]}`;
}

/**
 * Whole seconds as a clock: "0:42", "12:05", "1:02:03". A duration under a second but above none reads
 * "0:01", never a misleading "0:00".
 */
function formatClock(totalSeconds: number, language: string): string {
  const rounded = Math.round(totalSeconds);
  const seconds = totalSeconds > 0 && rounded === 0 ? 1 : rounded;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const plain = numberFormat(language, { useGrouping: false, maximumFractionDigits: 0 });
  const padded = numberFormat(language, { useGrouping: false, minimumIntegerDigits: 2, maximumFractionDigits: 0 });
  return hours > 0
    ? `${plain.format(hours)}:${padded.format(minutes)}:${padded.format(rest)}`
    : `${plain.format(minutes)}:${padded.format(rest)}`;
}

/** A media duration in microseconds (`durationUs`) as a clock. */
export function formatDurationUs(us: number, language: string): string {
  return usable(us) ? formatClock(us / 1_000_000, language) : UNKNOWN_VALUE;
}

/** A duration in milliseconds (an ETA, an elapsed time) as a clock. */
export function formatDurationMs(ms: number, language: string): string {
  return usable(ms) ? formatClock(ms / 1000, language) : UNKNOWN_VALUE;
}

/** Bits per second in the 1000-based units of bit rates: "96 kbps", "4.5 Mbps", "120 Mbps". */
export function formatBitRate(bitsPerSecond: number, language: string): string {
  if (!usable(bitsPerSecond)) return UNKNOWN_VALUE;
  const kbps = bitsPerSecond / 1000;
  if (Math.round(kbps) < 1000) return `${numberFormat(language, { maximumFractionDigits: 0 }).format(kbps)} kbps`;
  const mbps = kbps / 1000;
  return `${numberFormat(language, { maximumFractionDigits: fractionDigits(mbps) }).format(mbps)} Mbps`;
}

/**
 * Frames per second without a unit, to three decimals at most: "25", "29.97", "23.976". The average of
 * a variable rate is `approximate`: one decimal at most ("~15", "~29.9"), as three would claim a precision
 * an average of varying frame times does not have.
 */
export function formatFrameRate(fps: number, language: string, approximate = false): string {
  return usable(fps) ? numberFormat(language, { maximumFractionDigits: approximate ? 1 : 3 }).format(fps) : UNKNOWN_VALUE;
}

/** Hertz as kilohertz: "48 kHz", "44.1 kHz", "22.05 kHz". */
export function formatSampleRate(hertz: number, language: string): string {
  return usable(hertz) ? `${numberFormat(language, { maximumFractionDigits: 2 }).format(hertz / 1000)} kHz` : UNKNOWN_VALUE;
}

/** Media seconds per second: "0.45×", "3.1×", "12×". */
export function formatSpeed(speed: number, language: string): string {
  if (!usable(speed)) return UNKNOWN_VALUE;
  const digits = speed < 1 ? 2 : speed < 10 ? 1 : 0;
  return `${numberFormat(language, { maximumFractionDigits: digits }).format(speed)}×`;
}

/** A share (0–1) as a whole percentage: "62%". */
export function formatPercent(fraction: number, language: string): string {
  return Number.isFinite(fraction) ? numberFormat(language, { style: "percent", maximumFractionDigits: 0 }).format(fraction) : UNKNOWN_VALUE;
}

/** How an output's size compares with its source: "−62%" smaller, "+12%" larger, "0%" the same (AC-WORKBENCH-04-3). */
export function formatSizeChange(sourceBytes: number, outputBytes: number, language: string): string {
  if (!usable(outputBytes) || !usable(sourceBytes) || sourceBytes === 0) return UNKNOWN_VALUE;
  const change = outputBytes / sourceBytes - 1;
  const whole = Math.round(Math.abs(change) * 100);
  if (whole === 0) return formatPercent(0, language);
  return `${change < 0 ? MINUS : "+"}${formatPercent(whole / 100, language)}`;
}

/** The picture as shown, width × height: a phone's 90° turn shows 1080×1920 for a 1920×1080 stream. */
export function formatResolution(width: number, height: number, rotation = 0): string {
  const turned = rotation === 90 || rotation === 270;
  return `${turned ? height : width}×${turned ? width : height}`;
}
