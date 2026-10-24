import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { DocumentDetail, PageInfo, RunView, SegmentRow } from '../../src/long-text/contract';

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size; },
    },
  });
});

// The helpers under test never render; Radix primitives stay out of the node environment.
vi.mock('radix-ui', () => ({}));

const { emptyRows, eventTouchesPage, initialPage, mergeRefresh, needsAttention, queryFilter, replaceRow, viewKey } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/useReaderPage');
const { inlineRuns, markRuns, searchRanges } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/InlineText');
const { cellLabel, cellRatio, cellTarget, stripCells, STRIP_CELL_MIN_PX } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/PageStrip');
const { filterPages, pageLabel, pageNumber, PICKER_LIMIT } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/PagePicker');
const { offersSample, primaryAction } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/RunControls');
const { estimateText, formatEta, statusLine, usageLines } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/ReaderFooter');
const { readerKeyAction } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/useReaderKeyboard');
const { editorKey } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/RowEditor');
const { appendRequirement } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/RetranslatePopover');
const { flagText, isKeyboardContextMenu, rowDot, rowLabel } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/ReaderRow');
const { filterCounts, settingsSummary } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/ReaderToolbar');
const { draftToKeep, locateFrom, segmentationKey, stepRow } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/ReaderPanel');
const { followPage, followRow } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/useFollowProgress');
const { focusWentWithOverlay, hasTranslation, rowErrorText } = await import('../../src/pages/Tools/Text/LongTextTranslator/reader/RowMenu');
const { LongTextClientError } = await import('../../src/services/long-text/client');

/** Renders a key with its values, so assertions see what was asked for. */
const t = ((key: string, values?: Record<string, unknown>) => values ? `${key}${JSON.stringify(values)}` : key) as unknown as TFunction<'text'>;

const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, failedRequests: 0, unknownRequests: 0 };

function row(index: number, patch: Partial<SegmentRow> = {}): SegmentRow {
  return {
    index, ordinal: index + 1, page: 0, rev: 1, kind: 'paragraph', level: 0, marker: '', translatable: true,
    source: `source ${index}`, target: null, status: 'pending', origin: null, locked: false, flags: [], failure: null, canUndo: false,
    ...patch,
  };
}

function page(index: number, patch: Partial<PageInfo> = {}): PageInfo {
  return { index, start: index * 10, end: index * 10 + 9, title: null, translatable: 10, done: 0, attention: 0, inFlight: false, ...patch };
}

function run(patch: Partial<RunView> = {}): RunView {
  return {
    id: 'run-1', kind: 'full', status: 'running', total: 10, done: 0, failed: 0, deferred: 0, inFlight: 2,
    frontier: 0, frontierPage: 0, pace: 2, effectiveLanes: 2, etaSeconds: null, startedAt: 1, endedAt: null,
    model: { profileId: 'p', modelKey: 'deepseek-chat', label: 'DeepSeek' }, usage, ...patch,
  };
}

function detail(patch: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    id: '00000000-0000-4000-8000-000000000001', revision: 1, name: 'novel.txt', format: 'txt', createdAt: 1, updatedAt: 1,
    source: { kind: 'file', fileName: 'novel.txt', directory: 'C:\\docs' }, encoding: { name: 'gb18030', confidence: 'high', confirmed: true },
    languages: { source: 'ja', target: 'zh-Hans', sourceIsAuto: true }, style: 'literary',
    stats: { characters: 382_000, translatable: 1284, pages: 2 },
    counts: { translatable: 1284, done: 0, pending: 1284, failed: 0, attention: 0, edited: 0, locked: 0 },
    usage, fullRunStarted: false, run: null, lastExport: null, journalIssues: 0,
    settings: {
      sourceLanguage: 'auto', targetLanguage: 'zh-Hans', style: 'literary', instructions: '', knowledge: null,
      profileId: null, pace: 2, batchSourceTokens: 1500, maxOutputTokens: null,
    },
    detected: { sourceLanguage: 'ja', style: 'literary' }, structure: { txtSplit: 'auto', resolved: 'line' },
    pages: [page(0), page(1)], ledger: { total: 0, confirmed: 0 }, sample: null, exportFolder: null,
    ...patch,
  };
}

const estimate = {
  documentId: '00000000-0000-4000-8000-000000000001',
  value: { segments: 1280, sourceTokens: 40_000, requests: 30, inputTokens: [40_000, 60_000] as [number, number], outputTokens: [12_100, 24_600] as [number, number], basis: 'model' as const },
  cost: [0.031, 0.05] as [number, number],
};

describe('reader rows', () => {
  it('names views and reads filters from them', () => {
    expect(viewKey({ kind: 'page', page: 3 })).toBe('page:3');
    expect(viewKey({ kind: 'filter', filter: 'attention', offset: 60 })).toBe('filter:attention:60');
    expect(viewKey({ kind: 'search', text: 'a:b', offset: 0 })).toBe('search:0:a:b');
    expect(queryFilter({ kind: 'search', text: 'アリス', offset: 0 })).toEqual({ kind: 'search', text: 'アリス' });
    expect(queryFilter({ kind: 'filter', filter: 'edited', offset: 0 })).toEqual({ kind: 'edited' });
  });

  it('counts attention as the main process does', () => {
    expect(needsAttention(row(0, { status: 'failed' }))).toBe(true);
    expect(needsAttention(row(0, { status: 'done', flags: [{ code: 'length_short', detail: { ratio: 0.3 } }] }))).toBe(true);
    expect(needsAttention(row(0, { status: 'done', locked: true, flags: [{ code: 'length_short' }] }))).toBe(false);
    expect(needsAttention(row(0, { status: 'done', locked: true, flags: [{ code: 'markup_missing', detail: { items: ['](x)'] } }] }))).toBe(true);
    expect(needsAttention(row(0, { status: 'done' }))).toBe(false);
  });

  it('reads a page again only when a change touches it', () => {
    const info = page(2);
    expect(eventTouchesPage({ range: { start: 0, end: 19 } }, info)).toBe(false);
    expect(eventTouchesPage({ range: { start: 0, end: 20 } }, info)).toBe(true);
    expect(eventTouchesPage({ range: { start: 29, end: 40 } }, info)).toBe(true);
    expect(eventTouchesPage({ range: { start: 30, end: 40 } }, info)).toBe(false);
    expect(eventTouchesPage({ pages: [2] }, info)).toBe(true);
    expect(eventTouchesPage({}, info)).toBe(true);
  });

  it('marks rows that became done and keeps handled rows in the attention view', () => {
    const view = { kind: 'filter' as const, filter: 'attention' as const, offset: 0 };
    const before = { ...emptyRows(view), rows: [row(1, { status: 'failed' }), row(4, { status: 'translating' }), row(7, { status: 'failed' })], total: 3 };
    const after = mergeRefresh(before, view, { rows: [row(4, { status: 'done', target: 'x', flags: [{ code: 'untranslated' }] }), row(7, { status: 'failed' })], total: 2, truncated: false });
    expect(after.rows.map(item => item.index)).toEqual([1, 4, 7]);
    expect([...after.dropped]).toEqual([1]);
    expect([...after.filled]).toEqual([4]);
    expect(after.total).toBe(2);
    // Another view starts fresh.
    const page0 = { kind: 'page' as const, page: 0 };
    const fresh = mergeRefresh(after, page0, { rows: [row(0)], total: 1, truncated: false });
    expect(fresh.dropped.size).toBe(0);
    expect(fresh.filled.size).toBe(0);
    expect(fresh.view).toBe(page0);
  });

  it('lets other views drop rows that no longer match', () => {
    const view = { kind: 'filter' as const, filter: 'untranslated' as const, offset: 0 };
    const before = { ...emptyRows(view), rows: [row(1), row(2)] };
    expect(mergeRefresh(before, view, { rows: [row(2)], total: 1, truncated: false }).rows.map(item => item.index)).toEqual([2]);
  });

  it('replaces one row and opens on the remembered page', () => {
    const rows = [row(0), row(1)];
    expect(replaceRow(rows, row(1, { status: 'done', target: 'y' }))[1].target).toBe('y');
    expect(replaceRow(rows, row(5))).toEqual(rows);
    expect(initialPage(3, 5)).toBe(3);
    expect(initialPage(5, 5)).toBe(0);
    expect(initialPage(undefined, 5)).toBe(0);
  });
});

describe('inline text', () => {
  const join = (runs: Array<{ text: string }>) => runs.map(run => run.text).join('');

  it('adds up to the display text and styles markup', () => {
    const samples: Array<[string, SegmentRow['kind'], 'txt' | 'markdown']> = [
      ['The **daemon** restarts and `ttl` see [the guide](https://x.y/z) <b>x</b> $a+b$ [^1] &amp; \\* ok', 'paragraph', 'markdown'],
      ['![alt *text*](img.png "t") and *em* ~~del~~ __strong__ ***both***', 'paragraph', 'markdown'],
      ['line one  \nline two\\\nthree', 'paragraph', 'markdown'],
      ['visit https://example.com now <x1/>, mail a@b.co', 'line', 'txt'],
      ['', 'paragraph', 'markdown'],
    ];
    for (const [display, kind, format] of samples) expect(join(inlineRuns(display, kind, format))).toBe(display);
    const runs = inlineRuns('The **daemon** and `ttl` [guide](https://x)', 'paragraph', 'markdown');
    expect(runs.find(run => run.text === 'daemon')?.styles).toEqual(['lt-strong']);
    expect(runs.find(run => run.text === '**')?.styles).toEqual(['lt-markup']);
    expect(runs.find(run => run.text === '`ttl`')?.styles).toEqual(['lt-code']);
    expect(runs.find(run => run.text === 'guide')?.styles).toEqual(['lt-link']);
    expect(runs.find(run => run.text === '](https://x)')?.styles).toEqual(['lt-markup']);
    expect(inlineRuns('a ***b*** ~~c~~', 'paragraph', 'markdown').filter(run => /^[bc]$/.test(run.text)).map(run => run.styles))
      .toEqual([['lt-strong', 'lt-em'], ['lt-strike']]);
  });

  it('shows table cells with a bar between them and hides the outer pipes', () => {
    const runs = inlineRuns('| a | **b** | c |', 'table_row', 'markdown');
    expect(join(runs)).toBe('| a | **b** | c |');
    expect(runs.filter(run => run.shown !== undefined).map(run => run.shown)).toEqual(['', '│', '│', '']);
  });

  it('finds search text ignoring case and width', () => {
    expect(searchRanges('Alice met ALICE', 'alice')).toEqual([[0, 5], [10, 15]]);
    expect(searchRanges('ＡＢＣ と abc', 'abc')).toEqual([[0, 3], [6, 9]]);
    expect(searchRanges('アリス', 'ｱﾘｽ')).toEqual([[0, 3]]);
    expect(searchRanges('text', '  ')).toEqual([]);
    expect(searchRanges('aaa', 'aa')).toEqual([[0, 2]]);
    expect(searchRanges('😀x😀', 'x')).toEqual([[2, 3]]);
  });

  it('marks what the main process matches when the text is decomposed', () => {
    // NFD accents (macOS and PDF exports) and half-width voiced kana compose as in a whole-text NFKC.
    expect(searchRanges('Un e\u0301te\u0301 chaud', 'été')).toEqual([[3, 8]]);
    expect(searchRanges('été', 'e\u0301te\u0301')).toEqual([[0, 3]]);
    expect(searchRanges('ｶﾞｲﾄﾞ', 'ガイド')).toEqual([[0, 5]]);
    expect(searchRanges('\u1112\u1161\u11AB국', '한')).toEqual([[0, 3]]);
    // Accents still count.
    expect(searchRanges('café', 'cafe')).toEqual([]);
  });

  it('cuts runs at matches without losing text', () => {
    const runs = inlineRuns('The **daemon** runs', 'paragraph', 'markdown');
    const marked = markRuns(runs, searchRanges('The **daemon** runs', 'mon** r'));
    expect(marked.map(piece => piece.text).join('')).toBe('The **daemon** runs');
    expect(marked.filter(piece => piece.marked).map(piece => piece.text)).toEqual(['mon', '**', ' r']);
    const table = inlineRuns('| a | b |', 'table_row', 'markdown');
    expect(markRuns(table, [[3, 4]]).filter(piece => piece.marked).map(piece => piece.shown)).toEqual(['│']);
  });
});

describe('page strip', () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => page(index, { done: index % 2 ? 10 : 0, attention: index === 7 ? 2 : 0, inFlight: index === 3 }));

  it('gives every cell at least 4px and buckets the pages beyond that', () => {
    for (const width of [560, 856, 1240]) {
      const cells = stripCells(many(600), width);
      expect(cells.length).toBeLessThanOrEqual(Math.floor(width / STRIP_CELL_MIN_PX));
      expect(width / cells.length).toBeGreaterThanOrEqual(STRIP_CELL_MIN_PX);
      expect(cells[0].from).toBe(0);
      expect(cells[cells.length - 1].to).toBe(599);
      for (let k = 1; k < cells.length; k++) expect(cells[k].from).toBe(cells[k - 1].to + 1);
    }
    const cells = stripCells(many(600), 856);
    expect(cells[0]).toMatchObject({ from: 0, to: 2, translatable: 30, done: 10, attention: 0, inFlight: false });
    expect(cells[1]).toMatchObject({ from: 3, to: 5, inFlight: true });
    expect(cells[2]).toMatchObject({ from: 6, to: 8, attention: 2, firstAttention: 7 });
    expect(cellTarget(cells[2])).toBe(7);
    expect(cellTarget(cells[0])).toBe(0);
  });

  it('shows one page per cell when they fit and nothing when it cannot help', () => {
    expect(stripCells(many(40), 856)).toHaveLength(40);
    expect(stripCells(many(1), 856)).toEqual([]);
    expect(stripCells(many(40), 559)).toEqual([]);
  });

  it('describes cells', () => {
    expect(cellRatio({ translatable: 0, done: 0 })).toBe(1);
    expect(cellRatio({ translatable: 4, done: 1 })).toBe(0.25);
    const pages = [page(0, { title: '第一章', done: 4, attention: 1 }), page(1)];
    const [first] = stripCells(pages, 856);
    expect(cellLabel(t, 'zh', first, pages)).toBe('reader.page{"page":1} · 第一章 · 4/10 · status.attention{"count":"1"}');
    const bucket = stripCells(many(600), 856)[2];
    expect(cellLabel(t, 'en', bucket, many(600))).toBe('reader.strip_bucket{"from":7,"to":9,"percent":33,"attention":"2"}');
  });
});

describe('page picker', () => {
  it('filters by number or chapter title and caps the list', () => {
    const pages = Array.from({ length: 700 }, (_, index) => page(index, { title: index === 41 ? 'Chapter Forty-Two' : null }));
    expect(filterPages(pages, '').items).toHaveLength(PICKER_LIMIT);
    expect(filterPages(pages, '').more).toBe(true);
    expect(filterPages(pages, '42').items.map(item => item.index)).toEqual([41, 141, 241, 341, 419, 420, 421, 422, 423, 424, 425, 426, 427, 428, 441, 541, 641]);
    expect(filterPages(pages, 'forty').items.map(item => item.index)).toEqual([41]);
    expect(filterPages(pages, 'ＦＯＲＴＹ').items.map(item => item.index)).toEqual([41]);
  });

  it('jumps on a page number only', () => {
    expect(pageNumber('12', 40)).toBe(11);
    expect(pageNumber(' １２ ', 40)).toBe(11);
    expect(pageNumber('41', 40)).toBeNull();
    expect(pageNumber('0', 40)).toBeNull();
    expect(pageNumber('1a', 40)).toBeNull();
    expect(pageLabel(t, page(2, { title: '第三章' }), 40)).toBe('reader.page_title{"page":3,"title":"第三章"}');
    expect(pageLabel(t, page(2), 40)).toBe('3 / 40');
  });
});

describe('run controls', () => {
  const counts = (patch: Partial<DocumentDetail['counts']>) => ({ ...detail().counts, ...patch });

  it('follows the state table of design §5.2.3', () => {
    expect(primaryAction(detail())).toEqual({ kind: 'translate_all' });
    expect(primaryAction(detail({ fullRunStarted: true }))).toEqual({ kind: 'continue' });
    expect(primaryAction(detail({ counts: counts({ pending: 0, failed: 3 }) }))).toEqual({ kind: 'retry_failed', count: 3 });
    expect(primaryAction(detail({ counts: counts({ pending: 0, done: 1284 }) }))).toEqual({ kind: 'export' });
    expect(primaryAction(detail({ run: run() }))).toEqual({ kind: 'pause' });
    expect(primaryAction(detail({ run: run({ status: 'pausing' }) }))).toEqual({ kind: 'pausing' });
    expect(primaryAction(detail({ run: run({ status: 'paused' }), fullRunStarted: true }))).toEqual({ kind: 'continue' });
  });

  it('offers a sample only before the first full run', () => {
    expect(offersSample(detail())).toBe(true);
    expect(offersSample(detail({ fullRunStarted: true }))).toBe(false);
    expect(offersSample(detail({ run: run({ kind: 'sample' }) }))).toBe(false);
    expect(offersSample(detail({ counts: counts({ pending: 0, failed: 2 }) }))).toBe(false);
  });
});

describe('footer status', () => {
  it('formats ranges, the estimate and the remaining time', () => {
    expect(estimateText(t, 'en', estimate, 'DeepSeek V4'))
      .toBe('status.idle{"count":"1,280","tokens":"52.1K–84.6K"}status.idle_cost{"cost":"$0.031–0.050"}status.idle_model{"name":"DeepSeek V4"}');
    expect(estimateText(t, 'en', { ...estimate, cost: null }, null)).toBe('status.idle{"count":"1,280","tokens":"52.1K–84.6K"}');
    expect(formatEta(30, 'en')).toBe('1 min');
    expect(formatEta(4320, 'en')).toBe('1 hr 12 min');
    expect(formatEta(7200, 'en')).toBe('2 hr');
  });

  it('says what the document is doing', () => {
    const running = statusLine(t, 'en', detail({ run: run({ etaSeconds: 600, usage: { ...usage, inputTokens: 30_000, outputTokens: 11_200 }, effectiveLanes: 1 }), counts: { ...detail().counts, done: 1204 } }), null, null);
    expect(running.icon).toBe('spinner');
    expect(running.full).toBe('status.running{"done":"1,204","total":"1,284"} · status.eta{"time":"10 min"} · status.used{"tokens":"41.2K"}');
    expect(running.short).toBe('meta.segments{"count":"1,204 / 1,284"}');
    expect(running.throttled).toBe(1);
    expect(statusLine(t, 'en', detail({ run: run({ etaSeconds: null }) }), null, null).full).not.toContain('status.eta');
    expect(statusLine(t, 'en', detail({ run: run({ status: 'pausing', inFlight: 2 }) }), null, null).full).toBe('status.waiting{"count":2}');

    const done = statusLine(t, 'en', detail({ counts: { ...detail().counts, pending: 0, done: 1284, attention: 3 }, usage: { ...usage, inputTokens: 90_000, outputTokens: 6_400 } }), estimate, 'DeepSeek');
    expect(done).toMatchObject({ icon: 'done', full: 'status.completed{"count":"1,284"} · status.attention{"count":"3"} · status.usage_total{"tokens":"96.4K"}' });

    const idle = statusLine(t, 'en', detail(), estimate, 'DeepSeek');
    expect(idle.full).toBe(estimateText(t, 'en', estimate, 'DeepSeek'));
    expect(idle.icon).toBeNull();
    expect(idle.short).toBe('status.idle{"count":"1,280","tokens":"52.1K–84.6K"}');
    expect(idle.tooltip).toEqual([idle.full]);
    expect(statusLine(t, 'en', detail({ run: run({ status: 'paused' }), counts: { ...detail().counts, done: 10 } }), null, null).full)
      .toBe('status.paused{"done":"10","total":"1,284"}');
  });

  it('keeps a run that stopped short in the line and what is left in the tooltip', () => {
    const spent = { ...usage, inputTokens: 1500, outputTokens: 20 };
    for (const status of ['paused', 'interrupted', 'failed'] as const) {
      const line = statusLine(t, 'en', detail({ run: run({ status }), counts: { ...detail().counts, done: 10 }, usage: spent }), estimate, 'DeepSeek');
      expect(line.full).toBe(`status.${status}{"done":"10","total":"1,284"}`);
      expect(line.short).toBe(line.full);
      expect(line.tooltip).toEqual([line.full, estimateText(t, 'en', estimate, 'DeepSeek'), 'status.usage_detail{"input":"1.5K","output":"20"}']);
    }
    // A finished sample leaves the estimate of the full run.
    expect(statusLine(t, 'en', detail({ run: run({ kind: 'sample', status: 'completed' }) }), estimate, null).full).toBe(estimateText(t, 'en', estimate, null));
    const running = statusLine(t, 'en', detail({ run: run({ usage: { ...usage, unknownRequests: 1 } }) }), estimate, null);
    expect(running.tooltip).toEqual([running.full, 'status.usage_detail{"input":"0","output":"0"}', 'status.usage_unknown{"count":1}']);
    expect(statusLine(t, 'en', detail(), null, null).full).toBe('reader.pending · meta.segments{"count":"1,284"}');
  });

  it('lists usage with the requests whose result is unknown', () => {
    expect(usageLines(t, { ...usage, inputTokens: 1500, outputTokens: 20 })).toEqual(['status.usage_detail{"input":"1.5K","output":"20"}']);
    expect(usageLines(t, { ...usage, unknownRequests: 2 })).toHaveLength(2);
  });
});

describe('keys', () => {
  const key = (name: string, modifiers: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) =>
    ({ key: name, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers });

  it('maps only the reader keys of design §4.1', () => {
    expect(readerKeyAction(key('ArrowDown'))).toEqual({ kind: 'move', step: 1 });
    expect(readerKeyAction(key('ArrowUp'))).toEqual({ kind: 'move', step: -1 });
    expect(readerKeyAction(key('Enter'))).toEqual({ kind: 'edit' });
    expect(readerKeyAction(key('F2'))).toEqual({ kind: 'edit' });
    expect(readerKeyAction(key('r'))).toEqual({ kind: 'retranslate' });
    expect(readerKeyAction(key('L'))).toEqual({ kind: 'lock' });
    expect(readerKeyAction(key('n'))).toEqual({ kind: 'attention', direction: 'next' });
    expect(readerKeyAction(key('N', { shiftKey: true }))).toEqual({ kind: 'attention', direction: 'previous' });
    expect(readerKeyAction(key('F8'))).toEqual({ kind: 'attention', direction: 'next' });
    expect(readerKeyAction(key('F8', { shiftKey: true }))).toEqual({ kind: 'attention', direction: 'previous' });
    expect(readerKeyAction(key('F10', { shiftKey: true }))).toEqual({ kind: 'menu' });
    expect(readerKeyAction(key('ContextMenu'))).toEqual({ kind: 'menu' });
    expect(readerKeyAction(key('PageDown'))).toEqual({ kind: 'scroll' });
    for (const ignored of [key('z', { ctrlKey: true }), key('j'), key('k'), key('c'), key('['), key('r', { ctrlKey: true }), key('R', { shiftKey: true }), key('Enter', { shiftKey: true }), key('F10')]) {
      expect(readerKeyAction(ignored)).toBeNull();
    }
  });

  it('gives the editor its own keys and leaves Enter a new line', () => {
    expect(editorKey(key('Enter', { ctrlKey: true }))).toBe('save');
    expect(editorKey(key('Enter', { metaKey: true }))).toBe('save');
    expect(editorKey(key('Enter'))).toBeNull();
    expect(editorKey(key('Escape'))).toBe('cancel');
    expect(editorKey(key('ArrowDown', { altKey: true }))).toEqual({ kind: 'move', step: 1 });
    expect(editorKey(key('ArrowUp', { altKey: true }))).toEqual({ kind: 'move', step: -1 });
    expect(editorKey(key('ArrowDown'))).toBeNull();
    expect(editorKey(key('F8', { shiftKey: true }))).toEqual({ kind: 'attention', direction: 'previous' });
    expect(editorKey(key('z', { ctrlKey: true }))).toBeNull();
  });
});

describe('row details', () => {
  it('adds quick requirements once, within the limit', () => {
    expect(appendRequirement('', '语气更口语化。')).toBe('语气更口语化。');
    expect(appendRequirement('人名保留。', '表达更简洁。')).toBe('人名保留。表达更简洁。');
    expect(appendRequirement('Keep names', 'Be concise.')).toBe('Keep names Be concise.');
    expect(appendRequirement('Be concise.', 'Be concise.')).toBe('Be concise.');
    expect(appendRequirement('x'.repeat(498), 'Be concise.')).toHaveLength(500);
  });

  it('words flags, labels and dots', () => {
    expect(flagText(t, 'en', { code: 'length_short', detail: { ratio: 0.3149 } })).toBe('flags.length_short{"ratio":"0.31"}');
    expect(flagText(t, 'en', { code: 'term_missing', detail: { source: 'Alice', target: '爱丽丝', more: 2 } }))
      .toBe('flags.term_missing_more{"source":"Alice","target":"爱丽丝","count":2}');
    expect(flagText(t, 'en', { code: 'term_missing', detail: { source: 'Alice', target: '爱丽丝', more: 0 } })).toBe('flags.term_missing{"source":"Alice","target":"爱丽丝"}');
    expect(flagText(t, 'en', { code: 'placeholder_repaired', detail: { kinds: ['url', 'link', 'code'] } }))
      .toBe('flags.placeholder_repaired{"kinds":"flags.kinds.url, flags.kinds.link, and flags.kinds.code"}');
    expect(flagText(t, 'en', { code: 'markup_missing', detail: { items: ['](a)', '`b`'] } })).toBe('flags.markup_missing{"items":"](a)  `b`"}');
    expect(flagText(t, 'en', { code: 'untranslated' })).toBe('flags.untranslated');

    // `ordinal` would switch i18next to ordinal plurals, so the values go through `replace`.
    expect(rowLabel(t, 'en', row(1203, { status: 'done', target: 'x' }))).toBe('reader.row_label{"replace":{"ordinal":"1,204","status":"reader.row_status.done"}}');
    expect(rowLabel(t, 'en', row(26, { status: 'failed', failure: { code: 'transport' } })))
      .toBe('reader.row_label{"replace":{"ordinal":"27","status":"reader.row_status.failed"}}reader.row_attention{"reason":"failure.transport"}');
    expect(rowLabel(t, 'en', row(26, { status: 'done', target: 'x', locked: true, flags: [{ code: 'length_short', detail: { ratio: 0.3 } }] })))
      .toBe('reader.row_label{"replace":{"ordinal":"27","status":"reader.row_status.done"}}');
    expect(rowDot(row(0))).toBe('pending');
    expect(rowDot(row(0, { status: 'translating' }))).toBe('translating');
    expect(rowDot(row(0, { status: 'failed' }))).toBe('failed');
    expect(rowDot(row(0, { status: 'done', target: 'x', flags: [{ code: 'untranslated' }] }))).toBe('attention');
    expect(rowDot(row(0, { status: 'done', target: 'x' }))).toBeNull();
    expect(hasTranslation(row(0, { status: 'done', target: 'x' }))).toBe(true);
    expect(hasTranslation(row(0, { status: 'failed' }))).toBe(false);
  });

  it('tells keyboard context menus from pointer ones', () => {
    expect(isKeyboardContextMenu({ pointerType: '' } as unknown as MouseEvent)).toBe(true);
    expect(isKeyboardContextMenu({ pointerType: 'mouse' } as unknown as MouseEvent)).toBe(false);
    expect(isKeyboardContextMenu({ clientX: 4 } as unknown as MouseEvent)).toBe(false);
  });

  it('words command failures', () => {
    expect(rowErrorText(t, new LongTextClientError('busy'))).toBe('row.busy');
    expect(rowErrorText(t, new LongTextClientError('revision_conflict'))).toBe('row.conflict');
    expect(rowErrorText(t, new LongTextClientError('storage_failed'))).toBe('errors.storage_failed');
    expect(rowErrorText(t, new Error('x'))).toBe('errors.internal');
  });

  it('names the model error of a failed retranslation', () => {
    expect(rowErrorText(t, new LongTextClientError('model_failed', 'balance'))).toBe('common:model_error.balance.cause');
    expect(rowErrorText(t, new LongTextClientError('model_failed', 'auth'))).toBe('common:model_error.auth.cause');
    expect(rowErrorText(t, new LongTextClientError('model_failed'))).toBe('errors.model_failed');
  });

  it('puts focus back on the row only when it went away with the overlay', () => {
    const body = {};
    try {
      vi.stubGlobal('document', { body, activeElement: body });
      expect(focusWentWithOverlay()).toBe(true);
      vi.stubGlobal('document', { body, activeElement: null });
      expect(focusWentWithOverlay()).toBe(true);
      // The user clicked into the search box, or another row's overlay took focus.
      vi.stubGlobal('document', { body, activeElement: {} });
      expect(focusWentWithOverlay()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('toolbar and navigation', () => {
  it('counts the filters and sums up the settings', () => {
    expect(filterCounts({ ...detail().counts, pending: 10, failed: 2, attention: 3, edited: 1 })).toEqual({ all: 1284, attention: 3, untranslated: 12, edited: 1 });
    const ready = { model: { label: 'DeepSeek V4' } } as never;
    expect(settingsSummary(t, detail(), ready)).toEqual({
      text: 'settings_summary.value{"direction":"meta.direction{\\"source\\":\\"knowledge:languages.ja\\",\\"target\\":\\"knowledge:languages.zh-Hans\\"}","style":"styles.literary"}',
      tooltip: 'settings_summary.tooltip{"direction":"meta.direction{\\"source\\":\\"knowledge:languages.ja\\",\\"target\\":\\"knowledge:languages.zh-Hans\\"}","style":"styles.literary","model":"DeepSeek V4","pace":"settings.pace_options.2"}',
    });
    expect(settingsSummary(t, detail(), { problem: 'no_key' }).tooltip).toContain('"model":"settings.model_missing_key"');
  });

  it('steps between translatable rows and starts locating next to the rows on screen', () => {
    const rows = [row(0), row(1, { translatable: false, kind: 'verbatim' }), row(2), row(3)];
    expect(stepRow(rows, 0, 1)?.index).toBe(2);
    expect(stepRow(rows, 2, -1)?.index).toBe(0);
    expect(stepRow(rows, 3, 1)).toBeNull();
    expect(stepRow(rows, null, 1)?.index).toBe(0);
    expect(stepRow(rows, null, -1)?.index).toBe(3);
    expect(stepRow([], null, 1)).toBeNull();
    expect(locateFrom('next', { start: 10, end: 19 }, 100)).toEqual({ from: 9, wrapsAround: false });
    expect(locateFrom('next', { start: 0, end: 9 }, 100)).toEqual({ from: 99, wrapsAround: true });
    expect(locateFrom('previous', { start: 10, end: 19 }, 100)).toEqual({ from: 20, wrapsAround: false });
    expect(locateFrom('previous', { start: 90, end: 99 }, 100)).toEqual({ from: 0, wrapsAround: true });
  });

  it('closes an open editor only when the document is cut into segments anew', () => {
    const shown = segmentationKey(detail());
    // Settings that keep the segments (style, languages, a confirmed encoding) keep the editor.
    expect(segmentationKey(detail({ style: 'technical', encoding: { name: 'gb18030', confidence: 'high', confirmed: false } }))).toBe(shown);
    expect(segmentationKey(detail({ structure: { txtSplit: 'line', resolved: 'line' } }))).not.toBe(shown);
    expect(segmentationKey(detail({ encoding: { name: 'shift_jis', confidence: 'high', confirmed: true } }))).not.toBe(shown);
  });

  it('keeps a changed draft when the reader goes away', () => {
    expect(draftToKeep(row(0, { target: 'old' }), 'new')).toBe(true);
    expect(draftToKeep(row(0, { target: null }), 'first')).toBe(true);
    expect(draftToKeep(row(0, { target: 'same' }), 'same')).toBe(false);
    expect(draftToKeep(row(0, { target: null }), '')).toBe(false);
    expect(draftToKeep(row(0, { target: 'old' }), 'x'.repeat(20_001))).toBe(false);
  });

  it('follows the frontier page and the row in flight', () => {
    const view = { kind: 'page' as const, page: 1 };
    expect(followPage({ following: true, view, editing: false, frontierPage: 3 })).toBe(3);
    expect(followPage({ following: true, view, editing: false, frontierPage: 1 })).toBeNull();
    expect(followPage({ following: false, view, editing: false, frontierPage: 3 })).toBeNull();
    expect(followPage({ following: true, view, editing: true, frontierPage: 3 })).toBeNull();
    expect(followPage({ following: true, view: { kind: 'filter', filter: 'attention', offset: 0 }, editing: false, frontierPage: 3 })).toBeNull();
    const rows = [row(0, { status: 'done', target: 'a' }), row(1, { status: 'done', target: 'b' }), row(2, { status: 'translating' })];
    expect(followRow(rows, new Set([1]))).toBe(2);
    expect(followRow(rows.slice(0, 2), new Set([1]))).toBe(1);
    expect(followRow(rows.slice(0, 2), new Set())).toBeNull();
  });
});
