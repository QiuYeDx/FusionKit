import { describe, expect, it, vi } from 'vitest';
import type { DocumentDetail, PageInfo, RunView } from '../../src/long-text/contract';

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

const { LONG_TEXT_AGENT_INSTRUCTIONS, LONG_TEXT_ROUTE, longTextAgentContext, longTextSnapshot } = await import('../../src/pages/Tools/Text/LongTextTranslator/agent-context');
const { buildPageContextSection } = await import('../../src/agent/page-context');
const { useLongTextStore } = await import('../../src/store/tools/text/useLongTextStore');

const SNAPSHOT_LIMIT = 1_000;
const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, failedRequests: 0, unknownRequests: 0 };

function page(index: number, title: string | null = null): PageInfo {
  return { index, start: index * 60, end: index * 60 + 59, title, translatable: 60, done: 0, attention: 0, inFlight: false };
}

function run(patch: Partial<RunView> = {}): RunView {
  return {
    id: 'run-1', kind: 'full', status: 'running', total: 1284, done: 204, failed: 0, deferred: 0, inFlight: 2,
    frontier: 204, frontierPage: 3, pace: 2, effectiveLanes: 2, etaSeconds: 600, startedAt: 1, endedAt: null,
    model: { profileId: 'p', modelKey: 'deepseek-chat', label: 'DeepSeek' }, usage, ...patch,
  };
}

function detail(patch: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    id: '00000000-0000-4000-8000-000000000001', revision: 1, name: 'novel.txt', format: 'txt', createdAt: 1, updatedAt: 1,
    source: { kind: 'file', fileName: 'novel.txt', directory: 'C:\\private\\books' }, encoding: { name: 'gb18030', confidence: 'high', confirmed: true },
    languages: { source: 'ja', target: 'zh-Hans', sourceIsAuto: true }, style: 'literary',
    stats: { characters: 382_000, translatable: 1284, pages: 3 },
    counts: { translatable: 1284, done: 204, pending: 1078, failed: 2, attention: 5, edited: 1, locked: 0 },
    usage, fullRunStarted: true, run: run(), lastExport: null, journalIssues: 0,
    settings: {
      sourceLanguage: 'auto', targetLanguage: 'zh-Hans', style: 'literary', instructions: 'Keep the narrator formal.', knowledge: null,
      profileId: null, pace: 2, batchSourceTokens: 1500, maxOutputTokens: null,
    },
    detected: { sourceLanguage: 'ja', style: 'literary' }, structure: { txtSplit: 'auto', resolved: 'line' },
    pages: [page(0, '序章'), page(1), page(2, '第二章 雨の夜')], ledger: { total: 12, confirmed: 3 }, sample: null, exportFolder: null,
    ...patch,
  };
}

describe('long text agent page context', () => {
  it('registers a read-only page without tools or suggestions', () => {
    const context = longTextAgentContext(detail());
    expect(context).toMatchObject({ route: '/tools/text/translator', titleKey: 'tools:fields.text_translator', subject: 'novel.txt', instructions: LONG_TEXT_AGENT_INSTRUCTIONS });
    expect(context.route).toBe(LONG_TEXT_ROUTE);
    expect(context.tools).toBeUndefined();
    expect(context.suggestions).toBeUndefined();
    const empty = longTextAgentContext(null);
    expect('subject' in empty).toBe(false);
    expect(empty.describe?.()).toEqual({ document: null });
  });

  it('describes the open document and the page the reader remembers', () => {
    const doc = detail();
    useLongTextStore.getState().rememberPage(doc.id, 2);
    expect(longTextAgentContext(doc).describe?.()).toEqual({
      document: {
        name: 'novel.txt', format: 'txt', languages: { source: 'ja', target: 'zh-Hans', sourceIsAuto: true },
        counts: { translatable: 1284, done: 204, pending: 1078, failed: 2, attention: 5, edited: 1, locked: 0 },
        run: { kind: 'full', status: 'running', done: 204, total: 1284 },
        page: { number: 3, of: 3, title: '第二章 雨の夜' },
      },
    });
    expect(longTextSnapshot(doc, 1).document?.page).toEqual({ number: 2, of: 3 });
    // A page the document no longer has falls back to the first, as the reader does.
    expect(longTextSnapshot(doc, 9).document?.page).toEqual({ number: 1, of: 3, title: '序章' });
    expect(longTextSnapshot(detail({ run: null, pages: [] }), undefined).document).toMatchObject({ run: null, page: null });
  });

  it('stays within 1,000 characters and carries no document text, settings or paths', () => {
    const json = JSON.stringify(longTextSnapshot(detail(), 0));
    for (const hidden of ['Keep the narrator', 'private', 'DeepSeek', 'deepseek-chat']) expect(json).not.toContain(hidden);
    const big = 200_000;
    const worst = detail({
      name: '"\\'.repeat(60), format: 'markdown',
      languages: { source: 'zh-Hant', target: 'zh-Hant', sourceIsAuto: false },
      counts: { translatable: big, done: big, pending: big, failed: big, attention: big, edited: big, locked: big },
      run: run({ kind: 'sample', status: 'interrupted', done: big, total: big }),
      pages: [page(0, '\u0001\ud800'.repeat(30))],
    });
    const snapshot = longTextSnapshot(worst, 0);
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(SNAPSHOT_LIMIT);
    expect(snapshot.document?.name).toBe('"\\'.repeat(30));
    const section = buildPageContextSection(LONG_TEXT_ROUTE, { id: 'p', route: LONG_TEXT_ROUTE, titleKey: 'tools:fields.text_translator', read: () => longTextAgentContext(worst) }, key => key);
    expect(section.snapshotTruncated).toBeUndefined();
    expect(section.title).toBe('tools:fields.text_translator');
  });
});
