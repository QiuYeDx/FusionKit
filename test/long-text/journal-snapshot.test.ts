import { describe, expect, it } from 'vitest';
import {
  buildSnapshot, emptyUsage, formatLines, readSnapshot, replayJournal, replayJournalAsync, segmentLine, snapshotLines, usageLine,
  type JournalState,
} from '../../src/long-text/journal';
import type { TranslationRecord, TranslationState } from '../../src/long-text/model';

/** The snapshot file, line by line (design §6.10), as the repository writes and reads it. */

const RUN = '0f8fad5b-d9cb-469f-a165-70867728950e';
const AT = 1_761_100_000_000;
const PENDING: TranslationState = { status: 'pending', target: null, origin: null, locked: false, flags: [], failure: null };

const done = (index: number, rev: number, target: string): TranslationRecord => ({
  index, rev, status: 'done', target, origin: 'model', locked: false,
  flags: [{ code: 'length_short', dismissed: false, detail: { ratio: 0.31 } }], failure: null, previous: PENDING, runId: RUN, at: AT,
});

async function* source(lines: Iterable<string>): AsyncGenerator<string> {
  // As readline hands them over: without the newline.
  for (const line of lines) yield line.endsWith('\n') ? line.slice(0, -1) : line;
}

function state(count: number): JournalState {
  const usage = { ...emptyUsage(), inputTokens: 10, requests: 2 };
  return { seq: count + 5, records: Array.from({ length: count }, (_, index) => (index % 3 === 1 ? undefined : done(index, 1, `译${index}`))), usage, runUsage: new Map([[RUN, usage]]) };
}

describe('snapshot lines', () => {
  it('writes a header and one line per record, and reads back what buildSnapshot builds', async () => {
    const written = [...snapshotLines(state(7))];
    expect(written).toHaveLength(1 + 5);
    expect(written.every(line => line.endsWith('\n') && !line.slice(0, -1).includes('\n'))).toBe(true);
    expect(await readSnapshot(source(written))).toEqual({ snapshot: buildSnapshot(state(7)), skipped: 0 });
  });

  it('is null without a usable header, and leaves out unreadable or repeated records', async () => {
    expect(await readSnapshot(source([]))).toEqual({ snapshot: null, skipped: 0 });
    expect(await readSnapshot(source(['{"version":2}', ...[...snapshotLines(state(3))].slice(1)]))).toEqual({ snapshot: null, skipped: 0 });
    const [header, first, second] = snapshotLines(state(3));
    const read = await readSnapshot(source([header, first, '', '{"i":', second.replace('"s":"d"', '"s":"x"'), first]));
    expect(Object.keys(read.snapshot!.records)).toEqual(['0']);
    expect(read.skipped).toBe(3);
  });

  it('replays a large snapshot asynchronously with the same result as replayJournal', async () => {
    const snapshot = (await readSnapshot(source(snapshotLines(state(6_000))))).snapshot!;
    const journal = formatLines([
      segmentLine(3, done(0, 9, 'older than the snapshot')),
      segmentLine(6_010, done(3, 2, 'newer')),
      segmentLine(6_011, done(4, 1, 'a segment the snapshot does not hold')),
      usageLine(6_012, { runId: RUN, usage: { ...emptyUsage(), outputTokens: 7, requests: 1 } }),
    ]).split('\n').filter(Boolean);
    const expected = replayJournal(snapshot, journal);
    const replay = await replayJournalAsync(snapshot, journal);
    expect(replay).toEqual(expected);
    expect(replay.records.get(0)?.target).toBe('译0');
    expect(replay.records.get(3)?.target).toBe('newer');
    expect(await replayJournalAsync(null, journal)).toEqual(replayJournal(null, journal));
  });
});
