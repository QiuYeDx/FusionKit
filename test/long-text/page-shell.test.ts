import { describe, expect, it, vi } from 'vitest';
import type { DocumentDetail, DocumentSummary, RunView } from '../../src/long-text/contract';

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

const { importOutcome, isTranslating, nextActiveAfter, resolveActive, sortDocuments, upsertSummary } = await import('../../src/pages/Tools/Text/LongTextTranslator/hooks/useDocuments');
const { estimateKey, mergeDetail, toSummary } = await import('../../src/pages/Tools/Text/LongTextTranslator/hooks/useDocumentDetail');
const { hasOpenLayer, isEditableTarget, isFindShortcut } = await import('../../src/pages/Tools/Text/LongTextTranslator/hooks/usePageShortcuts');
const { looksLikeMarkdown, pasteTime } = await import('../../src/pages/Tools/Text/LongTextTranslator/PasteDialog');
const { collectNotices, skippedList } = await import('../../src/pages/Tools/Text/LongTextTranslator/Notices');
const { formatBytes, matchesName, percentDone } = await import('../../src/pages/Tools/Text/LongTextTranslator/DocumentLibrary');
const { groupedCount } = await import('../../src/pages/Tools/Text/LongTextTranslator/page-context');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, failedRequests: 0, unknownRequests: 0 };

function summary(n: number, patch: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id: id(n), revision: 1, name: `doc-${n}.txt`, format: 'txt', createdAt: 1, updatedAt: n,
    source: { kind: 'file', fileName: `doc-${n}.txt`, directory: 'C:\\docs' },
    encoding: { name: 'utf-8', confidence: 'high', confirmed: true },
    languages: { source: 'ja', target: 'zh-Hans', sourceIsAuto: true }, style: 'general',
    stats: { characters: 100, translatable: 10, pages: 1 },
    counts: { translatable: 10, done: 0, pending: 10, failed: 0, attention: 0, edited: 0, locked: 0 },
    usage, fullRunStarted: false, run: null, lastExport: null, journalIssues: 0,
    ...patch,
  };
}

function run(patch: Partial<RunView> = {}): RunView {
  return {
    id: 'run-1', kind: 'full', status: 'running', total: 10, done: 0, failed: 0, deferred: 0, inFlight: 1,
    frontier: 0, frontierPage: 0, pace: 2, effectiveLanes: 2, etaSeconds: null, startedAt: 1, endedAt: null,
    model: { profileId: 'profile', modelKey: 'deepseek-chat', label: 'DeepSeek' }, usage, ...patch,
  };
}

function detail(n: number, patch: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    ...summary(n),
    settings: {
      sourceLanguage: 'auto', targetLanguage: 'zh-Hans', style: 'general', instructions: '', knowledge: null,
      profileId: null, pace: 2, batchSourceTokens: 1500, maxOutputTokens: null,
    },
    detected: { sourceLanguage: 'ja', style: 'general' }, structure: { txtSplit: 'auto', resolved: 'line' },
    pages: [{ index: 0, start: 0, end: 9, title: null, translatable: 10, done: 0, attention: 0, inFlight: false }],
    ledger: { total: 0, confirmed: 0 }, sample: null, exportFolder: null,
    ...patch,
  };
}

const model = { problem: 'no_profile' as const };
const ready = {
  model: {
    profileId: 'p', label: 'DeepSeek', modelKey: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1',
    apiFormat: 'chat_completions' as const, contextWindow: 65_536, maxOutputTokens: 8192,
  },
  apiKey: 'key', profile: {} as never, fellBack: false,
};

describe('document list helpers', () => {
  it('orders by the latest update and never replaces a newer copy', () => {
    const list = sortDocuments([summary(1), summary(3), summary(2)]);
    expect(list.map(item => item.updatedAt)).toEqual([3, 2, 1]);
    const touched = upsertSummary(list, summary(1, { updatedAt: 9 }));
    expect(touched[0].id).toBe(id(1));
    const stale = upsertSummary(touched, summary(1, { updatedAt: 4 }));
    expect(stale).toBe(touched);
    expect(upsertSummary(touched, summary(1, { revision: 2, updatedAt: 4 }))[0].revision).toBe(2);
    expect(upsertSummary(list, summary(7)).map(item => item.id)).toEqual([id(7), id(3), id(2), id(1)]);
  });

  it('moves to the next document after a deletion, then the previous one', () => {
    const list = [summary(3), summary(2), summary(1)];
    expect(nextActiveAfter(list, id(3))).toBe(id(2));
    expect(nextActiveAfter(list, id(1))).toBe(id(2));
    expect(nextActiveAfter([summary(1)], id(1))).toBeNull();
    expect(nextActiveAfter(list, id(9))).toBe(id(3));
  });

  it('restores the remembered document and falls back to the newest one', () => {
    const list = [summary(3), summary(2)];
    expect(resolveActive(list, id(2))).toBe(id(2));
    expect(resolveActive(list, id(9))).toBe(id(3));
    expect(resolveActive(list, null)).toBe(id(3));
    expect(resolveActive([], id(2))).toBeNull();
  });

  it('opens the first new document of an import, else the first duplicate', () => {
    expect(importOutcome({ documents: [summary(1), summary(2)], duplicates: [], skipped: [] }))
      .toEqual({ activate: id(1), imported: 2, skipped: [], duplicates: [] });
    expect(importOutcome({ documents: [], duplicates: [{ name: 'a.txt', documentId: id(5) }], skipped: [{ name: 'x.srt', reason: 'subtitle_file' }] }))
      .toEqual({ activate: id(5), imported: 0, skipped: [{ name: 'x.srt', reason: 'subtitle_file' }], duplicates: ['a.txt'] });
    expect(importOutcome({ documents: [], duplicates: [], skipped: [] }).activate).toBeNull();
  });

  it('treats running and pausing runs as translating', () => {
    expect(isTranslating(summary(1, { run: run() }))).toBe(true);
    expect(isTranslating(summary(1, { run: run({ status: 'pausing' }) }))).toBe(true);
    expect(isTranslating(summary(1, { run: run({ status: 'paused' }) }))).toBe(false);
    expect(isTranslating(null)).toBe(false);
  });
});

describe('document detail helpers', () => {
  it('lays a summary of the same or a newer revision over the detail', () => {
    const base = detail(1);
    const counts = { ...base.counts, done: 4, pending: 6 };
    const merged = mergeDetail(base, summary(1, { counts }));
    expect(merged?.counts.done).toBe(4);
    expect(merged?.pages).toBe(base.pages);
    expect(mergeDetail({ ...base, revision: 3 }, summary(1, { counts }))?.counts.done).toBe(0);
    expect(mergeDetail(base, summary(2, { counts }))).toBe(base);
    expect(mergeDetail(null, summary(1))).toBeNull();
  });

  it('keeps detail-only fields out of the list entry', () => {
    const entry = toSummary(detail(1, { unavailable: undefined }));
    expect(Object.keys(entry).sort()).toEqual(Object.keys(summary(1)).sort());
    expect(toSummary(detail(1, { unavailable: 'damaged' })).unavailable).toBe('damaged');
  });

  it('estimates again when the work left or the model limits change', () => {
    const doc = detail(1);
    const key = estimateKey(doc, ready);
    expect(key).not.toBeNull();
    expect(estimateKey({ ...doc, counts: { ...doc.counts, pending: 9 } }, ready)).not.toBe(key);
    expect(estimateKey(doc, { ...ready, model: { ...ready.model, maxOutputTokens: 4096 } })).not.toBe(key);
    expect(estimateKey({ ...doc, counts: { ...doc.counts, done: 3 } }, ready)).toBe(key);
    expect(estimateKey(null, ready)).toBeNull();
    expect(estimateKey(doc, null)).toBeNull();
  });
});

describe('page shortcuts', () => {
  it('recognises Ctrl/Cmd+F only without other modifiers', () => {
    const key = { key: 'f', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(isFindShortcut({ ...key, ctrlKey: true })).toBe(true);
    expect(isFindShortcut({ ...key, metaKey: true, key: 'F' })).toBe(true);
    expect(isFindShortcut({ ...key, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isFindShortcut(key)).toBe(false);
  });

  it('leaves fields and editable content alone', () => {
    const element = (field: boolean, editable = false) => ({ isContentEditable: editable, closest: () => field ? {} : null }) as unknown as EventTarget;
    expect(isEditableTarget(element(true))).toBe(true);
    expect(isEditableTarget(element(false, true))).toBe(true);
    expect(isEditableTarget(element(false))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
  });

  it('lets a non-modal panel (the pinned assistant) own the keyboard only while it holds focus', () => {
    const inside = {};
    const outside = {};
    const layer = (attributes: Record<string, string>, visible = true, hiddenByAncestor = false) => ({
      getClientRects: () => ({ length: visible ? 1 : 0 }),
      getAttribute: (name: string) => attributes[name] ?? null,
      contains: (node: unknown) => node === inside,
      closest: () => hiddenByAncestor ? {} : null,
    });
    const root = (...elements: unknown[]) => ({ querySelectorAll: () => elements }) as unknown as ParentNode;
    try {
      vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
      vi.stubGlobal('document', { activeElement: outside });
      expect(hasOpenLayer(root(layer({ 'aria-modal': 'false' })))).toBe(false);
      expect(hasOpenLayer(root(layer({})))).toBe(true);
      expect(hasOpenLayer(root(layer({ 'aria-modal': 'true' })))).toBe(true);
      expect(hasOpenLayer(root(layer({}, false)))).toBe(false);
      // A panel kept mounted while closed hides behind aria-hidden/inert and is not open.
      expect(hasOpenLayer(root(layer({}, true, true)))).toBe(false);
      expect(hasOpenLayer(root(layer({ 'aria-modal': 'false' }), layer({})))).toBe(true);
      vi.stubGlobal('document', { activeElement: inside });
      expect(hasOpenLayer(root(layer({ 'aria-modal': 'false' })))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('paste dialog', () => {
  it('detects Markdown from two features', () => {
    expect(looksLikeMarkdown('# Title\n\n```js\ncode\n```\n')).toBe(true);
    expect(looksLikeMarkdown('# Title\n\nJust prose.')).toBe(false);
    expect(looksLikeMarkdown('- a\n- b\n- c\n\nSee [docs](https://example.com).')).toBe(true);
    expect(looksLikeMarkdown('- a\n- b\n\nSee [docs](https://example.com).')).toBe(false);
    expect(looksLikeMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n## Table')).toBe(true);
    expect(looksLikeMarkdown('~~~\nfenced\n~~~\n1. one\n2. two\n3. three')).toBe(true);
    expect(looksLikeMarkdown('#hashtag only\n第一章　夜の森\n「どこへ行くの？」')).toBe(false);
  });

  it('dates the default name as MM-DD HH:mm', () => {
    expect(pasteTime(new Date(2026, 9, 2, 4, 5))).toBe('10-02 04:05');
    expect(pasteTime(new Date(2026, 11, 31, 23, 59))).toBe('12-31 23:59');
  });
});

describe('notices', () => {
  const none = new Set<string>();

  it('puts a stopped run first and shows at most three notices', () => {
    const doc = detail(1, {
      run: run({ status: 'failed', error: { code: 'model_failed', category: 'auth' } }),
      encoding: { name: 'gb18030', confidence: 'low', confirmed: false },
      journalIssues: 2,
    });
    const items = collectNotices({ detail: doc, runModel: model, transient: [], dismissed: none });
    expect(items.map(item => item.kind)).toEqual(['failed', 'encoding', 'model']);
    expect(collectNotices({ detail: doc, runModel: ready, transient: [], dismissed: none }).map(item => item.kind)).toEqual(['failed', 'encoding', 'journal']);
  });

  it('turns storage and materials failures into their own notices', () => {
    const storage = detail(1, { run: run({ status: 'failed', error: { code: 'storage_failed' } }) });
    expect(collectNotices({ detail: storage, runModel: ready, transient: [], dismissed: none })[0].kind).toBe('storage');
    const knowledge = detail(1, { run: run({ status: 'failed', error: { code: 'knowledge_invalid' } }) });
    const items = collectNotices({ detail: knowledge, runModel: ready, transient: [{ kind: 'knowledge', id: 4, documentId: id(1) }], dismissed: none });
    expect(items.map(item => item.kind)).toEqual(['knowledge']);
  });

  it('keeps a dismissed notice away until what it says changes', () => {
    const sampled = (stale: boolean) => detail(1, { run: run({ kind: 'sample', status: 'completed' }), sample: { indices: [0], stale } });
    const [done] = collectNotices({ detail: sampled(false), runModel: ready, transient: [], dismissed: none });
    expect(done.kind).toBe('sample');
    const dismissed = new Set([done.key]);
    expect(collectNotices({ detail: sampled(false), runModel: ready, transient: [], dismissed })).toEqual([]);
    expect(collectNotices({ detail: sampled(true), runModel: ready, transient: [], dismissed })).toMatchObject([{ kind: 'sample', stale: true }]);
    expect(collectNotices({ detail: { ...sampled(false), fullRunStarted: true }, runModel: ready, transient: [], dismissed: none })).toEqual([]);
  });

  it('reports run endings with deferred or failed segments, interruptions and journal issues', () => {
    const ended = detail(1, { run: run({ status: 'completed', deferred: 6 }) });
    expect(collectNotices({ detail: ended, runModel: ready, transient: [], dismissed: none }).map(item => item.kind)).toEqual(['run_end']);
    const clean = detail(1, { run: run({ status: 'completed' }) });
    expect(collectNotices({ detail: clean, runModel: ready, transient: [], dismissed: none })).toEqual([]);
    const interrupted = detail(1, { run: run({ status: 'interrupted' }), counts: { ...detail(1).counts, done: 1204 } });
    expect(collectNotices({ detail: interrupted, runModel: ready, transient: [], dismissed: none })).toMatchObject([{ kind: 'interrupted', done: 1204 }]);
  });

  it('shows import notices on any document and export notices only on their own', () => {
    const transient = [
      { kind: 'exported' as const, id: 2, documentId: id(2), name: 'b.zh-Hans.txt' },
      { kind: 'import' as const, id: 1, skipped: [{ name: 'a.docx', reason: 'unsupported_format' as const }], duplicates: [] },
    ];
    expect(collectNotices({ detail: detail(1), runModel: ready, transient, dismissed: none }).map(item => item.kind)).toEqual(['import']);
    expect(collectNotices({ detail: detail(2), runModel: ready, transient, dismissed: none }).map(item => item.kind)).toEqual(['import', 'exported']);
    expect(collectNotices({ detail: null, runModel: model, transient, dismissed: none }).map(item => item.kind)).toEqual(['import']);
  });

  it('lists skipped files in the interface language', () => {
    const items = [{ name: 'a.docx', reason: '暂不支持此格式' }, { name: 'ep01.srt', reason: '字幕文件请在字幕工作台中翻译' }];
    expect(skippedList(items, null, 'zh')).toBe('a.docx（暂不支持此格式）和ep01.srt（字幕文件请在字幕工作台中翻译）');
    expect(skippedList(items, '等 2 个', 'zh')).toBe('a.docx（暂不支持此格式）、ep01.srt（字幕文件请在字幕工作台中翻译）等 2 个');
    expect(skippedList([{ name: 'a.docx', reason: 'not supported' }], null, 'en')).toBe('a.docx (not supported)');
    expect(skippedList([{ name: 'a', reason: 'x' }, { name: 'b', reason: 'y' }], 'and 1 more', 'en')).toBe('a (x), b (y), and 1 more');
  });
});

describe('library helpers', () => {
  it('formats storage, progress, name search and grouped counts', () => {
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(18.6 * 1024 * 1024, 'en')).toBe('18.6 MB');
    expect(percentDone(summary(1, { counts: { ...summary(1).counts, done: 4, translatable: 9 } }))).toBe(44);
    expect(percentDone(summary(1, { counts: { ...summary(1).counts, translatable: 0 } }))).toBe(0);
    expect(matchesName({ name: 'Ｎｏｖｅｌ.txt' }, 'novel')).toBe(true);
    expect(matchesName({ name: 'guide.md' }, '  ')).toBe(true);
    expect(matchesName({ name: 'guide.md' }, 'novel')).toBe(false);
    expect(String(groupedCount(2_000_001, 'en'))).toBe('2,000,001');
  });
});
