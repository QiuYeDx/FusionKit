import { describe, expect, it, vi } from 'vitest';
import type { DocumentPage, SubtitleStudioApi } from '@/subtitle-studio/ipc-contract';
import type { CueRevisionOutcome, CueRevisionPreset } from './StudioCueRevision';
import { createStudioAgentTools, studioPageContext, studioSnapshot, type StudioAgentDeps } from './agent-context';

const text = (plain: string) => ({ plain, spans: [{ text: plain, marks: [] }] });
function documentPage(offset: number, lines: string[], cueCount = 250): DocumentPage {
  const cues = lines.map((line, index) => ({ id: `cue-${offset + index + 1}`, source: text(line), sourceRevision: 1, timing: { startMs: (offset + index) * 1000, endMs: (offset + index) * 1000 + 800 } }));
  return {
    summary: { id: 'doc-1', revision: 7, origin: { format: 'srt', displayName: 'episode.srt' }, cueCount, translationStatus: 'partial', capabilities: { translate: true } },
    offset, cues, tasks: [],
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
    opened[0].preset.onApplied!(2, hints, { merges: 0, deletes: 0, timings: 0, splits: 0, inserts: 0 });
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

describe('structural edits the assistant prepares', () => {
  it('prepares merges, deletions and time changes by cue number without a model, and reports them applied', async () => {
    reported.length = 0;
    const { setPageEventSink } = await import('@/agent/page-context');
    setPageEventSink(event => { reported.push(event); });
    const { value, opened, api } = deps();
    const tools = createStudioAgentTools(value);
    const pending = call(tools, 'studio_prepare_cue_edits', { edits: [
      { kind: 'merge', from: 101, to: 102 }, { kind: 'delete', numbers: [5] }, { kind: 'timing', number: 150, start: '00:02:29.500', end: '150.2' },
    ] });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const { preset } = opened[0];
    expect(preset).toMatchObject({ mode: 'prepared', scope: 'document' });
    expect(preset.structure).toEqual([
      expect.objectContaining({ kind: 'merge', cueIds: ['cue-101', 'cue-102'], indexes: [100, 101], source: 'line 101 line 102', timing: { startMs: 100000, endMs: 101800 } }),
      expect.objectContaining({ kind: 'delete', cueId: 'cue-5', index: 4 }),
      expect.objectContaining({ kind: 'timing', cueId: 'cue-150', before: { startMs: 149000, endMs: 149800 }, timing: { startMs: 149500, endMs: 150200 } }),
    ]);
    // Only the pages holding the named cues are read, the visible one not again.
    expect(api.readDocumentPage).toHaveBeenCalledTimes(1);
    opened[0].onSettled({ status: 'ready', checked: 3, proposals: 3, notes: [], structure: { merges: 1, deletes: 1, timings: 1, splits: 0, inserts: 0 } });
    expect((await pending).data).toMatchObject({ status: 'awaiting_user_review', proposedRevisions: 3, structure: { merges: 1, deletes: 1, timings: 1, splits: 0, inserts: 0 } });
    preset.onApplied!(4, [], { merges: 1, deletes: 1, timings: 1, splits: 0, inserts: 0 });
    await vi.waitFor(() => expect(reported).toHaveLength(1));
    expect(reported[0]).toMatchObject({ kind: 'revision_applied', values: { count: 4, merged: 1, deleted: 1, retimed: 1 } });
  });

  it('refuses edits it cannot prepare, with stable codes and no preview', async () => {
    const { value, opened } = deps();
    const tools = createStudioAgentTools(value);
    expect(await call(tools, 'studio_prepare_cue_edits', { edits: [{ kind: 'merge', from: 101, to: 101 }] })).toMatchObject({ success: false, error: 'not_adjacent' });
    expect(await call(tools, 'studio_prepare_cue_edits', { edits: [{ kind: 'delete', numbers: [251] }] })).toMatchObject({ success: false, error: 'invalid_cue_number' });
    expect(await call(tools, 'studio_prepare_cue_edits', { edits: [{ kind: 'merge', from: 101, to: 102 }, { kind: 'delete', numbers: [102] }] })).toMatchObject({ success: false, error: 'overlapping_edits' });
    expect(await call(tools, 'studio_prepare_cue_edits', { edits: [{ kind: 'timing', number: 101, end: '00:00:01.000' }] })).toMatchObject({ success: false, error: 'invalid_time' });
    expect(await call(tools, 'studio_prepare_cue_edits', { edits: [{ kind: 'timing', number: 101, start: 'soon' }] })).toMatchObject({ success: false, error: 'invalid_time' });
    expect(opened).toHaveLength(0);
  });

  it('opens the duplicate check for the selection or the document', async () => {
    const { value, opened } = deps();
    const tools = createStudioAgentTools(value);
    const pending = call(tools, 'studio_find_duplicates', { scope: 'selection' });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toMatchObject({ cueIds: ['cue-102', 'cue-101', 'missing'], preset: { mode: 'duplicates', scope: 'selection' } });
    opened[0].onSettled({ status: 'ready', checked: 2, proposals: 0, notes: [], structure: { merges: 0, deletes: 0, timings: 0, splits: 0, inserts: 0 } });
    expect((await pending).data).toMatchObject({ status: 'awaiting_user_review', proposedRevisions: 0 });
    expect(await call(createStudioAgentTools({ ...value, selection: () => [] }), 'studio_find_duplicates', { scope: 'selection' })).toMatchObject({ success: false, error: 'empty_selection' });
  });
});

describe('splits and inserts the assistant prepares', () => {
  it('splits where the second part starts, at the suggested time, with or without the translation', async () => {
    const { value, opened, api } = deps();
    const suggestCueSplit = vi.fn(async () => ({ ok: true, value: { splitMs: 100_400, basis: 'proportional' } }));
    Object.assign(api, { suggestCueSplit });
    const current = value.page()!;
    current.cues[0] = { ...current.cues[0], source: text('甲。乙。') };
    const tools = createStudioAgentTools(value);
    const pending = call(tools, 'studio_prepare_cue_edits', { edits: [
      { kind: 'split', number: 101, before: '乙', translation: { first: '甲。', second: '乙。' } },
      { kind: 'split', number: 120, before: '120', time: '00:01:59.300' },
    ] });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(suggestCueSplit).toHaveBeenCalledWith({ documentId: 'doc-1', revision: 7, cueId: 'cue-101', offset: 2 });
    expect(opened[0].preset.structure).toEqual([
      expect.objectContaining({ kind: 'split', cueId: 'cue-101', index: 100, sources: ['甲。', '乙。'], splitMs: 100_400, basis: 'proportional', targets: ['甲。', '乙。'] }),
      expect.objectContaining({ kind: 'split', cueId: 'cue-120', sources: ['line', '120'], splitMs: 119_300, basis: 'given' }),
    ]);
    opened[0].onSettled({ status: 'ready', checked: 2, proposals: 2, notes: [], structure: { merges: 0, deletes: 0, timings: 0, splits: 2, inserts: 0 } });
    expect((await pending).data).toMatchObject({ structure: { splits: 2, inserts: 0 } });
  });

  it('inserts with the gap next to a cue by default, or the given times', async () => {
    const { value, opened } = deps();
    const tools = createStudioAgentTools(value);
    const pending = call(tools, 'studio_prepare_cue_edits', { edits: [
      { kind: 'insert', number: 102, position: 'after', text: '补上的一句', translation: 'The missing line' },
      { kind: 'insert', number: 150, position: 'before', text: '另一句', start: '00:02:28.900', end: '00:02:29.000' },
    ] });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    // Line 102 ends at 101.8 s and line 103 starts at 102 s: the gap is 0.2 s.
    expect(opened[0].preset.structure).toEqual([
      { kind: 'insert', cueId: 'cue-102', index: 101, position: 'after', timing: { startMs: 101_800, endMs: 102_000 }, source: '补上的一句', target: 'The missing line' },
      { kind: 'insert', cueId: 'cue-150', index: 149, position: 'before', timing: { startMs: 148_900, endMs: 149_000 }, source: '另一句' },
    ]);
  });

  it('refuses splits and inserts it cannot prepare, with stable codes and no preview', async () => {
    const { value, opened } = deps();
    const tools = createStudioAgentTools(value);
    const refused = async (edits: unknown[], error: string) => expect(await call(tools, 'studio_prepare_cue_edits', { edits })).toMatchObject({ success: false, error });
    await refused([{ kind: 'split', number: 101, before: '没有' }], 'invalid_split');
    // "1" appears twice in "line 101": ambiguous without an occurrence.
    await refused([{ kind: 'split', number: 101, before: '1' }], 'invalid_split');
    // At the very start the first part would be empty.
    await refused([{ kind: 'split', number: 101, before: 'line' }], 'invalid_split');
    await refused([{ kind: 'split', number: 101, before: '101', time: '00:01:42.000' }], 'invalid_time');
    await refused([{ kind: 'split', number: 101, before: '101' }, { kind: 'delete', numbers: [101] }], 'overlapping_edits');
    // After 101 and before 102 is the same gap.
    await refused([{ kind: 'insert', number: 101, position: 'after', text: 'a' }, { kind: 'insert', number: 102, position: 'before', text: 'b' }], 'overlapping_edits');
    await refused([{ kind: 'insert', number: 101, position: 'after', text: 'a', start: '00:01:50.000' }], 'invalid_time');
    await refused([{ kind: 'insert', number: 101, position: 'after', text: 'a', end: 'unknown' }], 'invalid_time');
    await refused([{ kind: 'insert', number: 101, position: 'after', text: '<i>a</i>' }], 'invalid_text');
    expect(opened).toHaveLength(0);
    expect(await call(createStudioAgentTools({ ...value, track: () => undefined }), 'studio_prepare_cue_edits', { edits: [{ kind: 'insert', number: 101, position: 'after', text: 'a', translation: 'b' }] }))
      .toMatchObject({ success: false, error: 'no_translation_track' });
  });

  it('reports applied splits and inserts with the other changes', async () => {
    reported.length = 0;
    const { setPageEventSink } = await import('@/agent/page-context');
    setPageEventSink(event => { reported.push(event); });
    const { value, opened } = deps();
    const pending = call(createStudioAgentTools(value), 'studio_prepare_cue_edits', { edits: [{ kind: 'insert', number: 101, position: 'after', text: 'a' }] });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    opened[0].onSettled({ status: 'ready', checked: 1, proposals: 1, notes: [], structure: { merges: 0, deletes: 0, timings: 1, splits: 1, inserts: 1 } });
    await pending;
    opened[0].preset.onApplied!(3, [], { merges: 0, deletes: 0, timings: 1, splits: 1, inserts: 1 });
    await vi.waitFor(() => expect(reported).toHaveLength(1));
    expect(reported[0]).toMatchObject({ kind: 'revision_applied', values: { count: 3, retimed: 1, split: 1, inserted: 1 } });
  });
});
