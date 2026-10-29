import { describe, expect, it } from 'vitest';
import {
  EtaEstimator, jobFraction, mergeProgress, phaseFraction, PROGRESS_LIMITS, ProgressParser, ProgressTracker, redactedLogTail, redactFfmpegLog,
  createLogRedactor, utf8Tail, type ProgressBlock, type ProgressState,
} from '../../electron/main/media-converter/engine/progress';

/**
 * The pure half of the encoding process (design §4): the `-progress` parser, the job share across
 * weighted phases, the smoothed time left, and the redaction of ffmpeg's log.
 */

/**
 * What the bundled ffmpeg n8.1.2 wrote to `-progress pipe:1` for a 2 s mpeg4 encode at half speed
 * (`-readrate 0.5 -stats_period 0.5`), copied verbatim from a run on 2026-10-26.
 */
const REAL_STREAM =
  'frame=5\nfps=0.00\nstream_0_0_q=2.1\nbitrate=  23.8kbits/s\ntotal_size=596\nout_time_us=200000\nout_time_ms=200000\nout_time=00:00:00.200000\n' +
  'dup_frames=0\ndrop_frames=0\nspeed=0.385x\nprogress=continue\n' +
  'frame=12\nfps=11.62\nstream_0_0_q=8.5\nbitrate=   9.9kbits/s\ntotal_size=596\nout_time_us=480000\nout_time_ms=480000\nout_time=00:00:00.480000\n' +
  'dup_frames=0\ndrop_frames=0\nspeed=0.465x\nprogress=continue\n' +
  'frame=18\nfps=11.64\nstream_0_0_q=9.9\nbitrate= 558.1kbits/s\ntotal_size=50225\nout_time_us=720000\nout_time_ms=720000\nout_time=00:00:00.720000\n' +
  'dup_frames=0\ndrop_frames=0\nspeed=0.466x\nprogress=continue\n' +
  'frame=25\nfps=12.14\nstream_0_0_q=8.9\nbitrate= 401.8kbits/s\ntotal_size=50225\nout_time_us=1000000\nout_time_ms=1000000\nout_time=00:00:01.000000\n' +
  'dup_frames=0\ndrop_frames=0\nspeed=0.486x\nprogress=continue\n' +
  'frame=31\nfps=12.05\nstream_0_0_q=12.0\nbitrate= 470.3kbits/s\ntotal_size=72890\nout_time_us=1240000\nout_time_ms=1240000\nout_time=00:00:01.240000\n' +
  'dup_frames=0\ndrop_frames=0\nspeed=0.482x\nprogress=continue\n' +
  'frame=50\nfps=17.50\nstream_0_0_q=14.4\nbitrate= 460.7kbits/s\ntotal_size=115169\nout_time_us=2000000\nout_time_ms=2000000\nout_time=00:00:02.000000\n' +
  'dup_frames=0\ndrop_frames=0\nspeed= 0.7x\nprogress=end\n';

const parseAll = (...chunks: (string | Uint8Array)[]) => {
  const parser = new ProgressParser();
  return [...chunks.flatMap(chunk => parser.push(chunk)), ...parser.finish()];
};
const block = (fields: Partial<ProgressBlock>): ProgressBlock => ({ outTimeUs: null, totalSize: null, speed: null, fps: null, frame: null, ended: false, ...fields });

describe('the progress parser', () => {
  it('reads the blocks of a real ffmpeg 8 stream', () => {
    expect(parseAll(REAL_STREAM)).toEqual([
      { outTimeUs: 200_000, totalSize: 596, speed: 0.385, fps: 0, frame: 5, ended: false },
      { outTimeUs: 480_000, totalSize: 596, speed: 0.465, fps: 11.62, frame: 12, ended: false },
      { outTimeUs: 720_000, totalSize: 50_225, speed: 0.466, fps: 11.64, frame: 18, ended: false },
      { outTimeUs: 1_000_000, totalSize: 50_225, speed: 0.486, fps: 12.14, frame: 25, ended: false },
      { outTimeUs: 1_240_000, totalSize: 72_890, speed: 0.482, fps: 12.05, frame: 31, ended: false },
      { outTimeUs: 2_000_000, totalSize: 115_169, speed: 0.7, fps: 17.5, frame: 50, ended: true },
    ]);
  });

  it('gives the same blocks whatever the chunk boundaries, bytes or text, LF or CRLF', () => {
    const whole = parseAll(REAL_STREAM);
    const bytes = Buffer.from(REAL_STREAM, 'latin1');
    expect(parseAll(...[...bytes].map(byte => Uint8Array.of(byte)))).toEqual(whole);
    for (const size of [2, 3, 7, 13, 64]) {
      const chunks: Uint8Array[] = [];
      for (let start = 0; start < bytes.length; start += size) chunks.push(bytes.subarray(start, start + size));
      expect(parseAll(...chunks)).toEqual(whole);
    }
    expect(parseAll(REAL_STREAM.replace(/\n/g, '\r\n'))).toEqual(whole);
    // A chunk boundary right between \r and \n.
    const crlf = REAL_STREAM.replace(/\n/g, '\r\n');
    const cut = crlf.indexOf('\r\n') + 1;
    expect(parseAll(crlf.slice(0, cut), crlf.slice(cut))).toEqual(whole);
  });

  it('ignores N/A and negative values', () => {
    const [first, second] = parseAll(
      'frame=0\nfps=N/A\nbitrate=N/A\ntotal_size=N/A\nout_time_us=-9223372036854775807\nout_time_ms=-9223372036854775807\nout_time=-00:00:00.000000\nspeed=N/A\nprogress=continue\n',
      'frame=-3\nfps=-1.5\ntotal_size=-1\nout_time_us=N/A\nout_time_ms=N/A\nout_time=N/A\nspeed=-2x\nprogress=continue\n');
    expect(first).toEqual(block({ frame: 0 }));
    expect(second).toEqual(block({}));
  });

  it('reads values with leading spaces and units', () => {
    expect(parseAll('frame=  7\nfps= 25.0\ntotal_size= 1024\nout_time_us= 280000\nspeed= 138x\nbitrate= 924.2kbits/s\nprogress= continue\n'))
      .toEqual([{ outTimeUs: 280_000, totalSize: 1024, speed: 138, fps: 25, frame: 7, ended: false }]);
    expect(parseAll('speed=1.5e+01x\nprogress=continue\n')[0].speed).toBe(15);
  });

  it('takes out_time_ms as microseconds, below out_time_us and above out_time', () => {
    expect(parseAll('out_time_ms=1500000\nprogress=continue\n')[0].outTimeUs).toBe(1_500_000);
    expect(parseAll('out_time_ms=1500000\nout_time_us=1600000\nout_time=00:00:01.700000\nprogress=continue\n')[0].outTimeUs).toBe(1_600_000);
    expect(parseAll('out_time=01:02:03.250000\nprogress=continue\n')[0].outTimeUs).toBe(3_723_250_000);
    expect(parseAll('out_time=00:00:01.700000\nout_time_ms=N/A\nprogress=continue\n')[0].outTimeUs).toBe(1_700_000);
  });

  it('rejects garbage, fractions where integers belong, and numbers beyond 2^53', () => {
    expect(parseAll('frame=12abc\ntotal_size=1.5\nout_time_us=99999999999999999999\nfps=fast\nprogress=continue\n')[0]).toEqual(block({}));
    expect(parseAll('=5\nframe\nnoise\nprogress=continue\n')).toEqual([block({})]);
  });

  it('drops a line over 16 KB, split across chunks or not, and goes on with the next one', () => {
    const huge = `frame=${'9'.repeat(PROGRESS_LIMITS.maxLineBytes + 10)}`;
    expect(parseAll(`${huge}\nframe=4\nprogress=continue\n`)).toEqual([block({ frame: 4 })]);
    const pieces: string[] = [];
    for (let start = 0; start < huge.length; start += 1000) pieces.push(huge.slice(start, start + 1000));
    expect(parseAll(...pieces, '\nframe=4\nprogress=continue\n')).toEqual([block({ frame: 4 })]);
    // A line of exactly the limit is still read, one byte more is not.
    expect(parseAll(`frame=${' '.repeat(PROGRESS_LIMITS.maxLineBytes - 7)}5\nprogress=continue\n`)[0].frame).toBe(5);
    expect(parseAll(`frame=${' '.repeat(PROGRESS_LIMITS.maxLineBytes - 6)}5\nprogress=continue\n`)[0].frame).toBe(null);
  });

  it('ends a run on progress=end, keeps a last line without newline, and drops a block cut short', () => {
    expect(parseAll('frame=50\nout_time_us=2000000\nprogress=end').at(-1)).toEqual(block({ frame: 50, outTimeUs: 2_000_000, ended: true }));
    expect(parseAll('frame=50\nout_time_us=2000000\n')).toEqual([]);
    const parser = new ProgressParser();
    expect(parser.push('frame=1\nprogress=continue\nframe=2\n')).toHaveLength(1);
    expect(parser.finish()).toEqual([]);
  });
});

describe('the progress state', () => {
  it('keeps the last known values through N/A and never lets processed time or size go back', () => {
    let state: ProgressState | null = null;
    state = mergeProgress(state, block({ outTimeUs: 400_000, totalSize: 900, speed: 1.2, fps: 24, frame: 10 }));
    state = mergeProgress(state, block({}));
    expect(state).toMatchObject({ outTimeUs: 400_000, totalSize: 900, speed: 1.2, fps: 24, frame: 10, ended: false, blocks: 2 });
    state = mergeProgress(state, block({ outTimeUs: 300_000, totalSize: 800, speed: 1.1 }));
    expect(state).toMatchObject({ outTimeUs: 400_000, totalSize: 900, speed: 1.1 });
    state = mergeProgress(state, block({ ended: true }));
    expect(state.ended).toBe(true);
    expect(mergeProgress(state, block({})).ended).toBe(true);
  });
});

describe('the job share', () => {
  it('is processed ÷ expected, held at 99 % until the end, and unknown without a duration', () => {
    expect(phaseFraction(500_000, 2_000_000, false)).toBe(0.25);
    expect(phaseFraction(null, 2_000_000, false)).toBe(0);
    expect(phaseFraction(2_500_000, 2_000_000, false)).toBe(PROGRESS_LIMITS.maxRunningFraction);
    expect(phaseFraction(1_000, 2_000_000, true)).toBe(1);
    expect(phaseFraction(500_000, null, false)).toBe(null);
    expect(phaseFraction(500_000, 0, false)).toBe(null);
    expect(phaseFraction(500_000, null, true)).toBe(1);
  });

  it('weights phases: earlier phases count whole, the current one by its share', () => {
    const twoPass = [{ weight: 1, expectedDurationUs: 10_000_000 }, { weight: 3, expectedDurationUs: 10_000_000 }];
    expect(jobFraction(twoPass, 0, 5_000_000, false)).toBeCloseTo(0.125);
    expect(jobFraction(twoPass, 0, 10_000_000, true)).toBeCloseTo(0.25);
    expect(jobFraction(twoPass, 1, 0, false)).toBeCloseTo(0.25);
    expect(jobFraction(twoPass, 1, 5_000_000, false)).toBeCloseTo(0.625);
    expect(jobFraction(twoPass, 1, 10_000_000, true)).toBe(1);
    // An analysis phase over a 20 s sample, then the encode of a 60 s file.
    const sampled = [{ weight: 2, expectedDurationUs: 20_000_000 }, { weight: 8, expectedDurationUs: 60_000_000 }];
    expect(jobFraction(sampled, 1, 30_000_000, false)).toBeCloseTo(0.6);
    expect(jobFraction([{ weight: 1, expectedDurationUs: null }], 0, 30_000_000, false)).toBe(null);
    expect(() => jobFraction(twoPass, 2, 0, false)).toThrow(RangeError);
    expect(() => jobFraction([{ weight: 0, expectedDurationUs: 1 }], 0, 0, false)).toThrow(RangeError);
    expect(() => jobFraction([{ weight: Number.NaN, expectedDurationUs: 1 }], 0, 0, false)).toThrow(RangeError);
  });
});

describe('the time left', () => {
  it('waits for the warm-up, then matches a steady pace exactly', () => {
    const eta = new EtaEstimator({ halfLifeMs: 5_000, warmupMs: 2_000 });
    // 1 % per second: 100 s for the whole job.
    expect(eta.observe(0, 0)).toBe(null);
    expect(eta.observe(1_000, 0.01)).toBe(null);
    expect(eta.observe(2_000, 0.02)).toBe(98_000);
    expect(eta.observe(30_000, 0.30)).toBe(70_000);
    expect(eta.observe(30_500, 1)).toBe(0);
  });

  it('moves only part of the way after a burst or a pause, and recovers', () => {
    const eta = new EtaEstimator({ halfLifeMs: 5_000, warmupMs: 0 });
    for (let second = 0; second <= 20; second++) eta.observe(second * 1000, second / 100);
    const steady = eta.observe(21_000, 0.21)!;
    expect(steady).toBe(79_000);
    // One second at ten times the pace.
    const burst = eta.observe(22_000, 0.31)!;
    // Below what the steady pace says (69 s left), far above what the burst pace alone says (6.9 s).
    expect(burst).toBeLessThan(69_000);
    expect(burst).toBeGreaterThan(6_900 * 3);
    // Back to the steady pace: the estimate returns towards it.
    let later = burst;
    for (let second = 23; second <= 60; second++) later = eta.observe(second * 1000, 0.31 + (second - 22) / 100)!;
    expect(later).toBeGreaterThan(31_000 * 0.95);
    expect(later).toBeLessThan(31_000 * 1.05);
    // A pause of three seconds raises the estimate gradually, not to infinity.
    const paused = [61_000, 62_000, 63_000].map(at => eta.observe(at, 0.69)!);
    expect(paused[0]).toBeGreaterThan(later);
    expect(paused[2]).toBeGreaterThan(paused[0]);
    expect(Number.isFinite(paused[2])).toBe(true);
  });

  it('ignores time going backwards and a share going down, and starts over without a share', () => {
    const eta = new EtaEstimator({ halfLifeMs: 5_000, warmupMs: 0 });
    eta.observe(0, 0);
    expect(eta.observe(1_000, 0.1)).toBe(9_000);
    expect(eta.observe(500, 0.2)).toBe(8_000);
    expect(eta.observe(2_000, 0.05)).toBe(9_500);
    expect(eta.observe(3_000, null)).toBe(null);
    expect(eta.observe(4_000, 0.5)).toBe(null);
    expect(() => new EtaEstimator({ halfLifeMs: 0 })).toThrow(RangeError);
  });

  it('tracks a two-phase job through the tracker', () => {
    const tracker = new ProgressTracker([{ weight: 1, expectedDurationUs: 10_000_000 }, { weight: 1, expectedDurationUs: 10_000_000 }], { warmupMs: 0 });
    const state = (outTimeUs: number, ended = false): ProgressState => ({ outTimeUs, totalSize: 10, speed: 1, fps: 25, frame: 1, ended, blocks: 1 });
    expect(tracker.update(state(0), 0)).toMatchObject({ phase: 0, fraction: 0, etaMs: null });
    expect(tracker.update(state(5_000_000), 5_000)).toMatchObject({ phase: 0, fraction: 0.25, processedUs: 5_000_000, etaMs: 15_000 });
    tracker.beginPhase(1);
    expect(tracker.update(state(0), 10_000)).toMatchObject({ phase: 1, fraction: 0.5 });
    expect(tracker.update(state(10_000_000, true), 20_000)).toMatchObject({ fraction: 1, etaMs: 0 });
    expect(() => tracker.beginPhase(2)).toThrow(RangeError);
  });
});

describe('the log redaction', () => {
  const input = 'D:\\Videos\\Holiday 2025\\clip one.mkv';
  const output = 'D:\\Videos\\Holiday 2025\\clip one (compressed).mp4';
  const work = 'C:\\Users\\Ann\\AppData\\Roaming\\FusionKit\\media-converter\\work\\k3x9';
  const temporary = `${work}\\clip one (compressed).mp4.partial`;
  const paths = { inputs: [input], outputs: [output], temporaries: [temporary], work: [work] };

  it('replaces the input, temporary, output and working paths, with or without file:, in either slash and any case', () => {
    const log = [
      `[in#0/matroska @ 000001] [warning] Input #0, matroska,webm, from 'file:${input}':`,
      `[out#0/mp4 @ 000002] [fatal] Error opening output file:${temporary}: Permission denied`,
      `[error] Error opening output file file:${temporary}.`,
      `[fatal] File '${output.replace(/\\/g, '/')}' already exists. Exiting.`,
      `[warning] reading ${input.toUpperCase()}`,
      `[info] filter file ${work}\\filter-v0.txt and \\\\?\\${input}`,
      `[info] plain ${work}`,
    ].join('\n');
    expect(redactFfmpegLog(log, paths).split('\n')).toEqual([
      "[in#0/matroska @ 000001] [warning] Input #0, matroska,webm, from '<input>':",
      '[out#0/mp4 @ 000002] [fatal] Error opening output <output>: Permission denied',
      '[error] Error opening output file <output>.',
      "[fatal] File '<output>' already exists. Exiting.",
      '[warning] reading <input>',
      '[info] filter file <work>\\filter-v0.txt and <input>',
      '[info] plain <work>',
    ]);
  });

  it('hides other absolute paths as [path], and leaves ordinary ffmpeg text alone', () => {
    const log = [
      "[fatal] File 'E:\\Other Folder\\secret name.mkv' already exists. Exiting.",
      '[error] Error opening output file:F:/Private/x.mkv: No such file or directory',
      '[warning] font C:\\Windows\\Fonts\\arial.ttf missing',
      '[warning] share \\\\nas\\media\\film.mkv offline',
      '[warning] cache file:///C:/Users/Ann/cache.bin',
      '[warning] posix /home/ann/movie.mkv',
      'Svt[info]: SVT [config]: width / height / fps numerator / fps denominator : 320 / 184 / 25 / 1',
      'bitrate= 924.2kbits/s speed=1.2x time_base 1/25 Stream #0:0',
    ].join('\n');
    expect(redactFfmpegLog(log, paths).split('\n')).toEqual([
      "[fatal] File '[path]' already exists. Exiting.",
      '[error] Error opening output [path]: No such file or directory',
      '[warning] font [path] missing',
      '[warning] share [path] offline',
      '[warning] cache [path]',
      '[warning] posix [path]',
      'Svt[info]: SVT [config]: width / height / fps numerator / fps denominator : 320 / 184 / 25 / 1',
      'bitrate= 924.2kbits/s speed=1.2x time_base 1/25 Stream #0:0',
    ]);
  });

  it('removes terminal escapes and control characters and keeps line breaks', () => {
    expect(redactFfmpegLog('\u001b[31mred\u001b[0m\r\nbell\u0007\ttab\rnext\u200e', {})).toBe('red\nbell tab\nnext');
  });

  it('cuts the tail on whole lines, never showing part of a path cut at the boundary', () => {
    const redact = createLogRedactor(paths);
    const lines = Array.from({ length: 400 }, (_, index) => `[error] frame ${index} of 'file:${input}' failed in ${work}\\x`);
    const raw = Buffer.from(lines.join('\n') + '\n', 'utf8');
    for (const maxBytes of [100, 1000, 4096, 9000]) {
      const tail = redactedLogTail(raw, maxBytes, redact);
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(maxBytes);
      expect(tail).not.toMatch(/Holiday|Ann|Videos|clip one/);
      expect(tail.endsWith("failed in <work>\\x\n")).toBe(true);
      expect(tail.startsWith('[error] frame ')).toBe(true);
    }
    // The raw window begins in the middle of the input path: that line is dropped, not shown in part.
    const cut = raw.subarray(raw.indexOf('Holiday 2025', raw.length - 3000));
    const tail = redactedLogTail(cut, 1_000_000, redact, true);
    expect(tail.startsWith('[error] frame ')).toBe(true);
    expect(tail).not.toMatch(/Holiday|clip one/);
  });

  it('measures the tail in UTF-8 bytes without splitting a character', () => {
    expect(utf8Tail('aé\nbé', 3)).toBe('bé');
    expect(utf8Tail('ééé', 4)).toBe('éé');
    expect(utf8Tail('short', 100)).toBe('short');
    expect(utf8Tail('line one\nline two\n', 9)).toBe('line two\n');
  });
});
