import { describe, expect, it, vi } from 'vitest';
import type { DocumentPage, SubtitleStudioApi } from '@/subtitle-studio/ipc-contract';
import type { CueRevisionOutcome, CueRevisionPreset } from './StudioCueRevision';
import { createStudioAgentTools, studioPageContext, studioSnapshot, type StudioAgentDeps } from './agent-context';

const text = (plain: string) => ({ plain, spans: [{ text: plain, marks: [] }] });
function documentPage(offset: number, lines: string[], cueCount = 250): DocumentPage {
  const cues = lines.map((line, index) => ({ id: `cue-${offset + index + 1}`, source: text(line), sourceRevision: 1, timing: { startMs: (offset + index) * 1000, endMs: (offset + index) * 1000 + 800 } }));
  return {
    summary: { id: 'doc-1', revision: 7, origin: { format: 'srt', displayName: 'episode.srt' }, cueCount, translationStatus: 'partial', capabilities: { translate: true } },
    offset, cues, nodeOffset: 0, nodeCount: 0, rawNodes: [], tasks: [],
    translationTracks: [{ id: 'track-1', language: 'zh', entries: Object.fromEntries(cues.slice(0, 2).map((cue, index) => [cue.id, { text: text(`译${cue.source.plain}`), sourceRevision: index ? 0 : 1 }])) }],
  } as unknown as DocumentPage;
}
type Opened = { cueIds: string[]; preset: CueRevisionPreset; onSettled: (outcome: CueRevisionOutcome) => void };
function deps(overrides: Partial<StudioAgentDeps> = {}) {
  const current = documentPage(100, Array.from({ length: 100 }, (_, index) => `line ${101 + index}`));
  const opened: Opened[] = [];
  const api = {
    readDocumentPage: vi.fn(async ({ offset }: { offset: number }) => ({ ok: true, value: documentPage(offset, Array.from({ length: 100 }, (_, index) => `line ${offset + index + 1}`)) })),
    findCues: vi.fn(async () => ({ ok: true, value: { documentId: 'doc-1', revision: 7, total: 2, cueIds: ['cue-5', 'cue-120'], matches: [{ cueId: 'cue-5', index: 4, source: '法尔童', target: '译' }] } })),
  };
  const value: StudioAgentDeps = {
    page: () => current, track: () => current.translationTracks[0], selection: () => ['cue-102', 'cue-101', 'missing'],
    editBlocked: () => undefined, revisionOpen: () => false,
    openRevision: (cueIds, preset, onSettled) => opened.push({ cueIds, preset, onSettled }),
    api: () => api as unknown as SubtitleStudioApi, ...overrides,
  };
  return { value, api, opened, current };
}
const call = (tools: ReturnType<typeof createStudioAgentTools>, name: string, input: unknown, signal?: AbortSignal) =>
  tools[name].execute!(input, { toolCallId: name, ...(signal ? { abortSignal: signal } : {}) }) as Promise<{ success: boolean; data?: any; error?: string }>;

describe('Studio page snapshot', () => {
  it('describes the open document, the visible range and the selection by cue number', () => {
    const { value } = deps();
    expect(studioSnapshot(value)).toEqual({
      document: { documentId: 'doc-1', name: 'episode.srt', format: 'srt', revision: 7, cueCount: 250, translationStatus: 'partial', tracks: [{ trackId: 'track-1', language: 'zh', shown: true }] },
      view: { firstCue: 101, lastCue: 200 }, selection: { count: 2, cueNumbers: [102, 101] }, editing: { available: true }, revisionPreviewOpen: false,
    });
    expect(studioSnapshot({ ...value, page: () => null })).toMatchObject({ document: null });
    expect(studioSnapshot({ ...value, editBlocked: () => 'busy' }).editing).toEqual({ available: false, reason: 'busy' });
    const context = studioPageContext(value, {});
    expect(context).toMatchObject({ route: '/tools/subtitle/studio', titleKey: 'studio:title', subject: 'episode.srt' });
    expect(context.instructions).toContain('studio_prepare_revision');
  });
});

describe('Studio page tools', () => {
  it('reads cues across pages with the shown translation and whether it is outdated', async () => {
    const { value, api } = deps();
    const tools = createStudioAgentTools(value);
    const result = await call(tools, 'studio_read_cues', { from: 99, count: 4 });
    expect(result.success).toBe(true);
    expect(result.data.items.map((item: { number: number }) => item.number)).toEqual([99, 100, 101, 102]);
    // The visible page is not read again.
    expect(api.readDocumentPage).toHaveBeenCalledTimes(1);
    expect(result.data.items[2]).toMatchObject({ number: 101, source: 'line 101', target: '译line 101' });
    expect(result.data.items[3]).toMatchObject({ number: 102, targetOutdated: true });
    expect((await call(tools, 'studio_read_cues', { from: 300 })).data).toEqual({ total: 250, items: [] });
    expect(await call(createStudioAgentTools({ ...value, page: () => null }), 'studio_read_cues', { from: 1 })).toEqual({ success: false, error: 'no_document' });
  });

  it('finds cues by wording or number in the open document', async () => {
    const { value, api } = deps();
    const result = await call(createStudioAgentTools(value), 'studio_find_cues', { terms: ['法尔童'] });
    expect(api.findCues).toHaveBeenCalledWith({ documentId: 'doc-1', revision: 7, trackId: 'track-1', terms: ['法尔童'], limit: 20 });
    expect(result.data).toEqual({ total: 2, matches: [{ number: 5, source: '法尔童', target: '译' }] });
    expect((await call(createStudioAgentTools(value), 'studio_find_cues', { terms: ['x'], lines: [1] })).error).toBe('tool_request_failed');
  });

  it('opens a prefilled revision preview and reports its outcome without applying anything', async () => {
    const { value, opened } = deps();
    const tools = createStudioAgentTools(value);
    const pending = call(tools, 'studio_prepare_revision', { instructions: '“法尔童”应为“法厄同”', scope: 'document', fields: 'both', terms: ['法尔童', '法而童'] });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toMatchObject({ cueIds: [], preset: { instructions: '“法尔童”应为“法厄同”', scope: 'document', fields: 'both', search: { terms: ['法尔童', '法而童'] } } });
    opened[0].onSettled({ status: 'ready', checked: 3, proposals: 3, notes: ['已更正'], plan: { strategy: 'terms', terms: ['法尔童', '法而童'] } });
    await expect(pending).resolves.toMatchObject({ success: true, data: { status: 'awaiting_user_review', checkedCues: 3, proposedRevisions: 3 } });

    const selection = call(tools, 'studio_prepare_revision', { instructions: 'fix', scope: 'selection', lines: [3] });
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    // Search hints only apply to the whole document.
    expect(opened[1]).toMatchObject({ cueIds: ['cue-102', 'cue-101', 'missing'], preset: { scope: 'selection' } });
    expect(opened[1].preset.search).toBeUndefined();
    opened[1].onSettled({ status: 'needs_confirmation', count: 400, plan: { strategy: 'all' } });
    await expect(selection).resolves.toMatchObject({ data: { status: 'awaiting_scan_confirmation', cueCount: 400 } });

    const failed = call(tools, 'studio_prepare_revision', { instructions: 'fix', scope: 'document' });
    await vi.waitFor(() => expect(opened).toHaveLength(3));
    opened[2].onSettled({ status: 'failed', error: 'needs_configuration' });
    await expect(failed).resolves.toEqual({ success: false, error: 'needs_configuration' });
  });

  it('refuses when editing is blocked, a preview is open, nothing is selected or there is no translation', async () => {
    const { value } = deps();
    const input = { instructions: 'fix', scope: 'document' };
    expect(await call(createStudioAgentTools({ ...value, editBlocked: () => 'translating' }), 'studio_prepare_revision', input)).toEqual({ success: false, error: 'edit_blocked', data: { reason: 'translating' } });
    expect((await call(createStudioAgentTools({ ...value, revisionOpen: () => true }), 'studio_prepare_revision', input)).error).toBe('revision_already_open');
    expect((await call(createStudioAgentTools({ ...value, selection: () => [] }), 'studio_prepare_revision', { ...input, scope: 'selection' })).error).toBe('empty_selection');
    expect((await call(createStudioAgentTools({ ...value, track: () => undefined }), 'studio_prepare_revision', { ...input, fields: 'target' })).error).toBe('no_translation_track');
  });

  it('leaves the preview with the user when the turn stops, and notices a document switch', async () => {
    const { value, opened, current } = deps();
    const controller = new AbortController();
    const stopped = call(createStudioAgentTools(value), 'studio_prepare_revision', { instructions: 'fix', scope: 'document' }, controller.signal);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    controller.abort();
    await expect(stopped).resolves.toEqual({ success: false, error: 'agent_cancelled' });

    let page: DocumentPage = current;
    const switching = call(createStudioAgentTools({ ...value, page: () => page }), 'studio_prepare_revision', { instructions: 'fix', scope: 'document' });
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    page = { ...current, summary: { ...current.summary, id: 'doc-2' } };
    opened[1].onSettled({ status: 'cancelled' });
    await expect(switching).resolves.toEqual({ success: false, error: 'page_changed' });
  });
});

const reported: unknown[] = [];

describe('revisions the assistant prepared and the user applied', () => {
  it('returns the wordings a revision settled and reports the applied revision back', async () => {
    reported.length = 0;
    const { setPageEventSink } = await import('@/agent/page-context');
    setPageEventSink(event => { reported.push(event); });
    const { value, opened } = deps();
    const tools = createStudioAgentTools(value);
    const pending = call(tools, 'studio_prepare_revision', { instructions: '应该是泰姆菲尔德家的大小姐', scope: 'document', fields: 'target', terms: ['テイムフィールド'] });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const hints = [{ source: 'テイムフィールド家のお嬢様', target: '泰姆菲尔德家的大小姐', cueIds: ['cue-5'] }];
    opened[0].onSettled({ status: 'ready', checked: 2, proposals: 2, notes: [], knowledgeHints: hints });
    expect((await pending).data).toMatchObject({ status: 'awaiting_user_review', knowledgeHints: [{ source: 'テイムフィールド家のお嬢様', target: '泰姆菲尔德家的大小姐' }] });
    opened[0].preset.onApplied!(2, hints);
    await vi.waitFor(() => expect(reported).toHaveLength(1));
    expect(reported[0]).toEqual({ kind: 'revision_applied', values: { count: 2, hintCount: 1, hints: 'テイムフィールド家のお嬢様 → 泰姆菲尔德家的大小姐' } });
  });
});

describe('consistency checks the assistant starts', () => {
  const result = { checkedLines: 4, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, documents: [{ documentId: 'doc-1', revision: 7, name: 'episode.srt' }],
    groups: [{ id: 'g1', kind: 'translation' as const, source: 'テイムフィールド家のお嬢様', recommended: '泰姆菲尔德家的大小姐', spellings: [{ text: 'テイムフィールド家のお嬢様', count: 4, occurrences: [] }],
      variants: [{ text: '泰姆菲尔德家的大小姐', count: 3, occurrences: [] }, { text: '时间菲尔德家的大小姐', count: 1, occurrences: [] }] }] };
  it('opens and runs the check, then returns the groups for the user to unify', async () => {
    const started: { focus?: string; onSettled: (outcome: import('./StudioConsistencyCheck').ConsistencyOutcome) => void }[] = [];
    const { value } = deps({ openConsistency: (focus, onSettled) => { started.push({ focus, onSettled }); return true; }, consistencyOpen: () => false });
    const tools = createStudioAgentTools(value);
    const pending = call(tools, 'studio_check_consistency', { focus: '人名' });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0].focus).toBe('人名');
    started[0].onSettled({ status: 'ready', result });
    expect((await pending).data).toMatchObject({ status: 'awaiting_user_review', groups: 1, checkedLines: 4,
      summary: [{ source: 'テイムフィールド家のお嬢様', kind: 'translation', recommended: '泰姆菲尔德家的大小姐', variants: [{ text: '泰姆菲尔德家的大小姐', count: 3 }, { text: '时间菲尔德家的大小姐', count: 1 }] }] });
  });
  it('refuses without a document, while a check is open, or when there is nothing to check', async () => {
    const open = deps({ openConsistency: () => true, consistencyOpen: () => true });
    expect(await call(createStudioAgentTools(open.value), 'studio_check_consistency', {})).toMatchObject({ success: false, error: 'consistency_already_open' });
    const empty = deps({ openConsistency: () => false, consistencyOpen: () => false });
    expect(await call(createStudioAgentTools(empty.value), 'studio_check_consistency', {})).toMatchObject({ success: false, error: 'empty_document' });
    const none = deps({ page: () => null, openConsistency: () => true });
    expect((await call(createStudioAgentTools(none.value), 'studio_check_consistency', {})).success).toBe(false);
    const cancelled = deps({ openConsistency: (_focus, onSettled) => { onSettled({ status: 'cancelled' }); return true; }, consistencyOpen: () => false });
    expect(await call(createStudioAgentTools(cancelled.value), 'studio_check_consistency', {})).toMatchObject({ success: false, error: 'consistency_cancelled' });
  });
});
