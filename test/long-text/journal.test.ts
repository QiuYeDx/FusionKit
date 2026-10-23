import { describe, expect, it } from 'vitest';
import type { Usage } from '../../src/long-text/contract';
import {
  buildSnapshot, decodeRecord, emptyUsage, encodeRecord, formatLines, parseSnapshot, replayJournal, segmentLine,
  splitJournal, sumUsage, usageLine, type JournalReplay,
} from '../../src/long-text/journal';
import type { Flag, JournalLine, JournalSnapshot, TranslationRecord, TranslationState } from '../../src/long-text/model';

const RUN_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const RUN_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const AT = 1_761_100_000_000;
const PENDING: TranslationState = { status: 'pending', target: null, origin: null, locked: false, flags: [], failure: null };

function usageOf(inputTokens: number, outputTokens: number, extra: Partial<Usage> = {}): Usage {
  return { ...emptyUsage(), inputTokens, outputTokens, requests: 1, ...extra };
}

function done(index: number, rev: number, target: string, extra: Partial<TranslationRecord> = {}): TranslationRecord {
  return { index, rev, status: 'done', target, origin: 'model', locked: false, flags: [], failure: null, previous: PENDING, runId: RUN_A, at: AT, ...extra };
}

function lines(...journal: JournalLine[]): string[] {
  return formatLines(journal).split('\n').filter(Boolean);
}

function snapshotOf(replay: JournalReplay): JournalSnapshot {
  const snapshot = buildSnapshot({ seq: replay.lastSeq, records: replay.records.values(), usage: replay.usage, runUsage: replay.runUsage });
  const parsed = parseSnapshot(JSON.stringify(snapshot));
  expect(parsed).not.toBeNull();
  return parsed!;
}

describe('journal lines', () => {
  const segmentExample = `{"q":1043,"t":"s","i":812,"v":5,"s":"d","x":"……","o":"m","l":0,"f":[["length_short",0,{"ratio":0.31}]],"e":null,"p":{"s":"p","x":null,"o":null,"l":0,"f":[],"e":null},"r":"${RUN_A}","a":1761100000000}`;
  const usageExample = `{"q":1044,"t":"u","r":"${RUN_A}","in":1834,"out":2210,"c":0,"n":1,"fail":0,"unk":0}`;

  it('reads and writes the lines of the design example byte for byte', () => {
    const replay = replayJournal(null, [segmentExample, usageExample]);
    const record = replay.records.get(812)!;
    expect(record).toEqual(done(812, 5, '……', { flags: [{ code: 'length_short', dismissed: false, detail: { ratio: 0.31 } }] }));
    expect(replay.usage).toEqual(usageOf(1834, 2210));
    expect(replay.runUsage).toEqual(new Map([[RUN_A, usageOf(1834, 2210)]]));
    expect(replay.lastSeq).toBe(1044);
    expect(formatLines([segmentLine(1043, record), usageLine(1044, { runId: RUN_A, usage: replay.usage })]))
      .toBe(`${segmentExample}\n${usageExample}\n`);
  });

  it('round-trips every kind of flag, failure and previous version', () => {
    const records: TranslationRecord[] = [
      done(0, 3, '译文', {
        origin: 'user', locked: true, runId: null,
        flags: [
          { code: 'markup_missing', dismissed: false, detail: { items: ['`code`', '**'] } },
          { code: 'placeholder_repaired', dismissed: true, detail: { kinds: ['link', 'table'] } },
          { code: 'term_missing', dismissed: false, detail: { source: 'Alice', target: '爱丽丝', more: 2 } },
          { code: 'untranslated', dismissed: false },
          { code: 'untranslated', dismissed: true, detail: {} },
          { code: 'length_long', dismissed: false, detail: { ratio: 2.5 } },
        ],
        previous: { status: 'failed', target: null, origin: null, locked: false, flags: [], failure: { code: 'transport', category: 'rate_limited' } },
      }),
      { ...done(1, 2, ''), status: 'failed', target: null, origin: null, failure: { code: 'protocol_invalid' }, previous: null },
      { ...done(2, 7, ''), ...PENDING, previous: { ...PENDING, status: 'done', target: 'old', origin: 'model', locked: true } },
    ];
    for (const record of records) expect(decodeRecord(encodeRecord(record))).toEqual(record);
    const replay = replayJournal(null, lines(...records.map((record, k) => segmentLine(k + 1, record))));
    expect([...replay.records.values()]).toEqual(records);
  });

  it('refuses to format a line that replay would drop', () => {
    const doneWithoutTarget: TranslationRecord = { ...done(0, 1, 'x'), target: null };
    const lockedPending: TranslationRecord = { ...done(0, 1, 'x'), ...PENDING, locked: true };
    const failedWithoutFailure: TranslationRecord = { ...done(0, 1, 'x'), ...PENDING, status: 'failed' };
    const inconsistentPrevious: TranslationRecord = { ...done(0, 1, 'x'), previous: { ...PENDING, target: 'stale' } };
    for (const record of [doneWithoutTarget, lockedPending, failedWithoutFailure, inconsistentPrevious, done(0, 0, 'x'), done(200_000, 1, 'x')]) {
      expect(() => formatLines([segmentLine(1, done(1, 1, 'fine')), segmentLine(2, record)])).toThrow();
    }
    expect(() => formatLines([usageLine(0, { runId: null, usage: usageOf(1, 1) })])).toThrow();
    expect(() => formatLines([usageLine(1, { runId: '', usage: usageOf(1, 1) })])).toThrow();
    expect(() => formatLines([usageLine(1, { runId: null, usage: usageOf(-1, 1) })])).toThrow();
    expect(formatLines([])).toBe('');
  });
});

describe('replayJournal', () => {
  it('keeps the line with the largest q per segment, whatever the order', () => {
    const journal = lines(
      segmentLine(3, done(4, 3, 'third')),
      segmentLine(1, done(4, 1, 'first')),
      segmentLine(5, done(9, 1, 'other')),
      segmentLine(2, done(4, 2, 'second')),
    );
    const replay = replayJournal(null, journal);
    expect(replay.records.get(4)?.target).toBe('third');
    expect(replay.records.get(9)?.target).toBe('other');
    expect(replay.records.size).toBe(2);
    expect(replay.lastSeq).toBe(5);
    expect(replayJournal(null, [...journal].reverse())).toEqual(replay);
    expect(replayJournal(null, [...journal, ...journal])).toEqual(replay);
  });

  it('sums usage lines per document and per run, counting a duplicated line once', () => {
    const journal = lines(
      usageLine(1, { runId: RUN_A, usage: usageOf(100, 200, { cachedInputTokens: 40 }) }),
      usageLine(2, { runId: RUN_B, usage: usageOf(10, 20) }),
      usageLine(3, { runId: RUN_A, usage: usageOf(1, 2, { requests: 2, failedRequests: 1, unknownRequests: 1 }) }),
      usageLine(4, { runId: null, usage: usageOf(1000, 0, { failedRequests: 1 }) }),
    );
    const replay = replayJournal(null, [...journal, journal[0]]);
    expect(replay.usage).toEqual({ inputTokens: 1111, outputTokens: 222, cachedInputTokens: 40, requests: 5, failedRequests: 2, unknownRequests: 1 });
    expect(replay.runUsage).toEqual(new Map([
      [RUN_A, { inputTokens: 101, outputTokens: 202, cachedInputTokens: 40, requests: 3, failedRequests: 1, unknownRequests: 1 }],
      [RUN_B, usageOf(10, 20)],
    ]));
    expect(replay.records.size).toBe(0);
  });

  it('applies only lines newer than the snapshot on top of it', () => {
    const snapshot = snapshotOf(replayJournal(null, lines(
      segmentLine(9, done(1, 2, 'snapshot')),
      usageLine(10, { runId: RUN_A, usage: usageOf(5, 5) }),
    )));
    expect(snapshot.seq).toBe(10);
    const replay = replayJournal(snapshot, lines(
      segmentLine(8, done(1, 1, 'older')),
      usageLine(10, { runId: RUN_A, usage: usageOf(5, 5) }),
      segmentLine(11, done(2, 1, 'newer')),
      usageLine(12, { runId: RUN_A, usage: usageOf(1, 1) }),
    ));
    expect(replay.records.get(1)?.target).toBe('snapshot');
    expect(replay.records.get(2)?.target).toBe('newer');
    expect(replay.usage).toEqual(usageOf(6, 6, { requests: 2 }));
    expect(replay.runUsage.get(RUN_A)).toEqual(usageOf(6, 6, { requests: 2 }));
    expect(replay.lastSeq).toBe(12);
    expect(replayJournal(snapshot, []).lastSeq).toBe(10);
  });

  it('skips and counts lines it cannot read, and ignores blank ones', () => {
    const good = lines(segmentLine(1, done(0, 1, 'kept')), usageLine(2, { runId: null, usage: usageOf(3, 4) }));
    const segment = JSON.parse(good[0]) as Record<string, unknown>;
    const usage = JSON.parse(good[1]) as Record<string, unknown>;
    const bad = [
      '{"q":3,"t":"s","i":1', 'null', '[]', '42', 'not json',
      JSON.stringify({ ...segment, q: 3, t: 'x' }),
      JSON.stringify({ ...segment, q: 3, i: undefined }),
      JSON.stringify({ ...segment, q: 3, x: null }),
      JSON.stringify({ ...segment, q: 3, s: 'p', x: null, o: null, l: 1 }),
      JSON.stringify({ ...segment, q: 3, s: 'f', x: null, o: null }),
      JSON.stringify({ ...segment, q: 3, p: { s: 'd', x: null, o: 'm', l: 0, f: [], e: null } }),
      JSON.stringify({ ...segment, q: 3, f: [['too_short', 0]] }),
      JSON.stringify({ ...segment, q: 3, f: [['length_short', 0, { ratio: '0.3' }]] }),
      JSON.stringify({ ...segment, q: 3, e: ['transport', 'teapot'] }),
      JSON.stringify({ ...segment, q: 3, i: 200_000 }),
      JSON.stringify({ ...segment, q: 0 }),
      JSON.stringify({ ...segment, q: 3, v: 1.5 }),
      JSON.stringify({ ...usage, q: 3, in: -1 }),
      JSON.stringify({ ...usage, q: 3, n: 0.5 }),
    ];
    const replay = replayJournal(null, [good[0], ...bad, '', '   ', good[1]]);
    expect(replay.skipped).toBe(bad.length);
    expect(replay.records.get(0)?.target).toBe('kept');
    expect(replay.records.size).toBe(1);
    expect(replay.usage).toEqual(usageOf(3, 4));
    expect(replay.lastSeq).toBe(2);
  });

  it('accepts lines with keys it does not know', () => {
    const [line] = lines(segmentLine(1, done(0, 1, 'kept')));
    const replay = replayJournal(null, [JSON.stringify({ ...JSON.parse(line), z: 1 })]);
    expect(replay.skipped).toBe(0);
    expect(replay.records.get(0)).toEqual(done(0, 1, 'kept'));
  });
});

describe('splitJournal', () => {
  const encoder = new TextEncoder();

  it('drops a torn last line and reports where to truncate', () => {
    const complete = formatLines([segmentLine(1, done(0, 1, '第一段')), usageLine(2, { runId: null, usage: usageOf(1, 1) })]);
    const torn = encoder.encode(`${complete}{"q":3,"t":"s","i":1,"v":1,"s":"d","x":"半`);
    const { lines: read, end } = splitJournal(torn.subarray(0, torn.length - 1));
    expect(end).toBe(encoder.encode(complete).length);
    expect(read).toEqual(complete.split('\n').slice(0, 2));
    expect(replayJournal(null, read).records.get(0)?.target).toBe('第一段');
  });

  it('returns every line of a complete file and nothing of a file without a newline', () => {
    const complete = encoder.encode(formatLines([usageLine(1, { runId: null, usage: usageOf(1, 1) })]));
    expect(splitJournal(complete)).toEqual({ lines: [new TextDecoder().decode(complete).trimEnd()], end: complete.length });
    expect(splitJournal(encoder.encode('{"q":1,'))).toEqual({ lines: [], end: 0 });
    expect(splitJournal(new Uint8Array())).toEqual({ lines: [], end: 0 });
  });
});

describe('parseSnapshot', () => {
  const replay = replayJournal(null, lines(
    segmentLine(1, done(3, 1, 'a')),
    segmentLine(2, done(5, 1, 'b', { locked: true, origin: 'user', runId: null })),
    usageLine(3, { runId: RUN_B, usage: usageOf(7, 8) }),
  ));
  const snapshot = buildSnapshot({ seq: replay.lastSeq, records: replay.records.values(), usage: replay.usage, runUsage: replay.runUsage });
  const valid = JSON.parse(JSON.stringify(snapshot)) as JournalSnapshot;

  it('round-trips a built snapshot', () => {
    expect(Object.keys(snapshot.records)).toEqual(['3', '5']);
    expect(parseSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(replayJournal(parseSnapshot(JSON.stringify(snapshot)), [])).toEqual(replay);
  });

  it('copies usage, so later changes to the state leave a built snapshot alone', () => {
    const runUsage = new Map([[RUN_A, usageOf(1, 1)]]);
    const usage = usageOf(2, 2);
    const built = buildSnapshot({ seq: 1, records: [], usage, runUsage });
    runUsage.get(RUN_A)!.inputTokens = 100;
    usage.inputTokens = 100;
    expect(built.runUsage[RUN_A]).toEqual(usageOf(1, 1));
    expect(built.usage).toEqual(usageOf(2, 2));
  });

  it('skips records left undefined by a sparse table', () => {
    const table: Array<TranslationRecord | undefined> = [];
    table[2] = done(2, 1, 'only');
    const sparse = buildSnapshot({ seq: 1, records: table, usage: emptyUsage(), runUsage: new Map() });
    expect(Object.keys(sparse.records)).toEqual(['2']);
  });

  it('rejects a damaged snapshot as a whole', () => {
    const damaged = [
      '{"version":1,', '',
      { ...valid, version: 2 },
      { ...valid, seq: -1 },
      { ...valid, records: { 4: valid.records[3] } },
      { ...valid, records: { ...valid.records, 3: { ...valid.records[3], x: null } } },
      { ...valid, usage: { ...valid.usage, requests: -1 } },
      { ...valid, runUsage: { [RUN_B]: { inputTokens: 1 } } },
    ];
    for (const value of damaged) expect(parseSnapshot(typeof value === 'string' ? value : JSON.stringify(value))).toBeNull();
  });
});

/** Deterministic PRNG so a failing seed can be replayed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const OPERATIONS = ['translate', 'translate', 'fail', 'edit', 'lock', 'undo', 'clear', 'dismiss', 'usage'] as const;

/**
 * Applies `count` random segment operations that follow the state machine of design §5.2.2 and returns
 * the journal they write together with the state they leave in memory.
 */
function simulate(seed: number, count: number) {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const int = (max: number) => Math.floor(random() * (max + 1));
  const records = new Map<number, TranslationRecord>();
  let usage = emptyUsage();
  const runUsage = new Map<string, Usage>();
  const journal: JournalLine[] = [];
  let q = 0;

  const stateOf = (index: number): TranslationState => {
    const record = records.get(index);
    if (!record) return PENDING;
    const { status, target, origin, locked, flags, failure } = record;
    return { status, target, origin, locked, flags, failure };
  };
  const write = (index: number, state: TranslationState, previous: TranslationState | null, runId: string | null) => {
    const record: TranslationRecord = { index, rev: (records.get(index)?.rev ?? 0) + 1, ...state, previous, runId, at: AT + q };
    records.set(index, record);
    journal.push(segmentLine(++q, record));
  };
  const spend = (runId: string | null) => {
    const delta: Usage = {
      inputTokens: int(4000), outputTokens: int(4000), cachedInputTokens: int(500),
      requests: 1, failedRequests: int(1), unknownRequests: int(1),
    };
    usage = sumUsage(usage, delta);
    if (runId !== null) runUsage.set(runId, sumUsage(runUsage.get(runId) ?? emptyUsage(), delta));
    journal.push(usageLine(++q, { runId, usage: delta }));
  };
  const modelFlags = (): Flag[] => {
    const all: Flag[] = [
      { code: 'placeholder_repaired', dismissed: false, detail: { kinds: ['code', 'link'] } },
      { code: 'term_missing', dismissed: false, detail: { source: 'Alice', target: '爱丽丝', more: int(3) } },
      { code: 'untranslated', dismissed: false },
      { code: 'length_short', dismissed: false, detail: { ratio: Math.round(random() * 50) / 100 } },
    ];
    return all.filter(() => random() < 0.3);
  };

  for (let step = 0; step < count; step++) {
    const index = int(23);
    const current = stateOf(index);
    const runId = pick([RUN_A, RUN_B, null]);
    switch (pick(OPERATIONS)) {
      case 'translate':
        if (current.status === 'done' && current.locked) break;
        write(index, { status: 'done', target: `译文 ${seed}-${step}`, origin: 'model', locked: false, flags: modelFlags(), failure: null }, current, runId);
        spend(runId);
        break;
      case 'fail':
        if (current.status === 'done') break;
        write(index, { ...PENDING, status: 'failed', failure: random() < 0.5 ? { code: 'transport', category: 'network' } : { code: 'empty_output' } }, current, runId);
        if (random() < 0.5) spend(runId);
        break;
      case 'edit':
        if (random() < 0.2) write(index, PENDING, current, null);
        else write(index, {
          status: 'done', target: `修改 ${step}\n第二行`, origin: 'user', locked: true, failure: null,
          flags: random() < 0.5 ? [{ code: 'markup_missing', dismissed: false, detail: { items: ['`x`'] } }] : [],
        }, current, null);
        break;
      case 'lock':
        if (current.status === 'done') write(index, { ...current, locked: !current.locked }, records.get(index)!.previous, null);
        break;
      case 'undo': {
        const previous = records.get(index)?.previous;
        if (previous) write(index, previous, null, null);
        break;
      }
      case 'clear':
        if (current.status !== 'pending' && !current.locked) write(index, PENDING, current, runId);
        break;
      case 'dismiss':
        if (current.flags.some(flag => !flag.dismissed)) {
          const flags = current.flags.map((flag, k) => (k === current.flags.findIndex(f => !f.dismissed) ? { ...flag, dismissed: true } : flag));
          write(index, { ...current, flags }, records.get(index)!.previous, null);
        }
        break;
      case 'usage':
        spend(runId);
        break;
    }
  }
  return { lines: formatLines(journal).split('\n').filter(Boolean), records, usage, runUsage, lastSeq: q, random };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

describe('replay property', () => {
  const SEEDS = Array.from({ length: 64 }, (_, k) => k * 7919 + 1);

  it.each(SEEDS)('snapshot + replay equals full replay (seed %i)', seed => {
    const simulation = simulate(seed, 200);
    const full = replayJournal(null, simulation.lines);
    expect(full).toEqual({
      records: simulation.records, usage: simulation.usage, runUsage: simulation.runUsage, lastSeq: simulation.lastSeq, skipped: 0,
    });
    expect(replayJournal(null, shuffle(simulation.lines, simulation.random))).toEqual(full);

    for (let attempt = 0; attempt < 3; attempt++) {
      const cut = Math.floor(simulation.random() * (simulation.lines.length + 1));
      const snapshot = snapshotOf(replayJournal(null, simulation.lines.slice(0, cut)));
      const rest = simulation.lines.slice(cut);
      expect(replayJournal(snapshot, rest)).toEqual(full);
      // Crash between renaming the snapshot and emptying the journal: the old lines are still there.
      expect(replayJournal(snapshot, simulation.lines)).toEqual(full);
      expect(replayJournal(snapshot, shuffle(rest, simulation.random))).toEqual(full);
      // A snapshot taken on top of an earlier snapshot.
      expect(replayJournal(snapshotOf(replayJournal(snapshot, rest.slice(0, rest.length >> 1))), rest.slice(rest.length >> 1))).toEqual(full);
    }
  });
});
