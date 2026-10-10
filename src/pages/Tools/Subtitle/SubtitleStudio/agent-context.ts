import { z } from 'zod';
import { LIMITS, type ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentPage, StudioResult, SubtitleStudioApi } from '@/subtitle-studio/ipc-contract';
import { reportPageEvent, type AgentPageContext, type PageSuggestion, type PageToolSet } from '@/agent/page-context';
import type { CueRevisionOutcome, CueRevisionPreset, StructureCounts } from './StudioCueRevision';
import { MERGE_LIMIT, mergeProposal, parseStudioTime, type CueStructureProposal } from '@/subtitle-studio/cue-structure';
import type { ConsistencyOutcome } from './StudioConsistencyCheck';
import type { CueRevisionHint } from '@/subtitle-studio/cue-revision-contract';
import type { CueTrack } from './StudioCueMenu';

export const STUDIO_ROUTE = '/tools/subtitle/studio';
const TEXT_LIMIT = 300;
const SELECTION_NUMBERS = 50;

/** What the Studio page lends to the assistant; read at call time, so tools see the current page. */
export interface StudioAgentDeps {
  page: () => DocumentPage | null;
  track: () => CueTrack | undefined;
  selection: () => readonly string[];
  /** Why cue edits are unavailable now (a translation is running, the page is busy). */
  editBlocked: () => string | undefined;
  revisionOpen: () => boolean;
  /** Opens the AI revision preview with a preset; the outcome is reported once. */
  openRevision: (cueIds: string[], preset: CueRevisionPreset, onSettled: (outcome: CueRevisionOutcome) => void) => void;
  consistencyOpen?: () => boolean;
  /** Opens the consistency check for the open document and starts it; false when there is nothing to check. */
  openConsistency?: (focus: string | undefined, onSettled: (outcome: ConsistencyOutcome) => void) => boolean;
  api: () => SubtitleStudioApi;
}

type Result = { success: true; data: unknown } | { success: false; error: string; data?: unknown };
class PageFailure extends Error {}
const ok = (data: unknown): Result => ({ success: true, data });
const clip = (text: string) => text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
function unwrap<T>(result: StudioResult<T>): T {
  if (!result.ok) throw new PageFailure(result.error);
  return result.value;
}

/** The current document's identity at call start; later awaits must still see it. */
function currentDocument(deps: StudioAgentDeps) {
  const page = deps.page();
  if (!page) throw new PageFailure('no_document');
  const documentId = page.summary.id;
  return { page, check: () => { if (deps.page()?.summary.id !== documentId) throw new PageFailure('page_changed'); } };
}

async function guard(execute: () => Promise<Result>): Promise<Result> {
  try { return await execute(); }
  catch (error) {
    if (error instanceof PageFailure) return { success: false, error: error.message };
    return { success: false, error: 'tool_request_failed', data: { reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) } };
  }
}

/** Bounded description of what the user sees: the open document, the visible range and the selection. */
export function studioSnapshot(deps: StudioAgentDeps) {
  const page = deps.page();
  if (!page) return { document: null, note: 'No subtitle document is open. The user picks one from the library on the left.' };
  const track = deps.track();
  const numbers = new Map(page.cues.map((cue, index) => [cue.id, page.offset + index + 1]));
  const selected = deps.selection().flatMap(id => numbers.has(id) ? [numbers.get(id)!] : []);
  const blocked = deps.editBlocked();
  return {
    document: {
      documentId: page.summary.id, name: page.summary.origin.displayName, format: page.summary.origin.format, revision: page.summary.revision,
      cueCount: page.summary.cueCount, translationStatus: page.summary.translationStatus,
      tracks: page.translationTracks.map(item => ({ trackId: item.id, language: item.language, ...(item.name ? { name: item.name } : {}), shown: item.id === track?.id })),
    },
    view: page.cues.length ? { firstCue: page.offset + 1, lastCue: page.offset + page.cues.length } : null,
    selection: { count: selected.length, cueNumbers: selected.slice(0, SELECTION_NUMBERS), ...(selected.length > SELECTION_NUMBERS ? { truncated: true } : {}) },
    editing: blocked ? { available: false, reason: blocked } : { available: true },
    revisionPreviewOpen: deps.revisionOpen(),
  };
}

const readSchema = z.object({
  from: z.number().int().min(1).max(LIMITS.cues).describe('First cue number, counted from 1 as in the list.'),
  count: z.number().int().min(1).max(50).default(20),
}).strict();
const findSchema = z.object({
  terms: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional().describe('Words to find; near misses of longer words also match.'),
  lines: z.array(z.number().int().min(1).max(LIMITS.cues)).min(1).max(200).optional().describe('Cue numbers, counted from 1.'),
  limit: z.number().int().min(1).max(50).default(20),
}).strict().refine(value => !!value.terms !== !!value.lines, 'Give either terms or lines.');
const reviseSchema = z.object({
  instructions: z.string().trim().min(1).max(2000).describe("What to change, in the user's words and language, with the correct spelling."),
  scope: z.enum(['selection', 'document']).describe('selection: the cues the user selected; document: the whole document.'),
  fields: z.enum(['source', 'target', 'both']).optional().describe('Texts that may change; defaults to the source, or both when a translation is shown.'),
  terms: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional().describe('For scope=document: wrong spellings to search for, including likely mis-transcriptions.'),
  lines: z.array(z.number().int().min(1).max(LIMITS.cues)).min(1).max(200).optional().describe('For scope=document: cue numbers to revise.'),
}).strict().refine(value => !(value.terms && value.lines), 'Give terms or lines, not both.');

/** Tells the assistant that the user applied the revision it prepared, with the wordings it settled and the cues merged, deleted or retimed. */
function reportApplied(count: number, hints: CueRevisionHint[], changes?: StructureCounts) {
  reportPageEvent({ kind: 'revision_applied',
    values: { count, hints: hints.slice(0, 5).map(hint => `${clip(hint.source)} → ${clip(hint.target)}`).join('; '), hintCount: hints.length,
      ...(changes?.merges ? { merged: changes.merges } : {}), ...(changes?.deletes ? { deleted: changes.deletes } : {}), ...(changes?.timings ? { retimed: changes.timings } : {}) } });
}

const EDIT_LIMIT = 200;
const cueNumber = z.number().int().min(1).max(LIMITS.cues);
const time = z.string().trim().min(1).max(20).describe('A time such as 00:01:02.300, 01:02.3 or 62.3 (seconds).');
const editSchema = z.object({
  edits: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('merge'), from: cueNumber, to: cueNumber }).strict().describe('Merge cues from..to (consecutive, at most 50) into one: texts joined without repeating, from the first start to the last end.'),
    z.object({ kind: z.literal('delete'), numbers: z.array(cueNumber).min(1).max(EDIT_LIMIT) }).strict(),
    z.object({ kind: z.literal('timing'), number: cueNumber, start: time.optional(), end: z.union([time, z.literal('unknown')]).optional() }).strict()
      .describe('New start and/or end of one cue; end "unknown" only for LRC documents.'),
  ])).min(1).max(EDIT_LIMIT),
}).strict();
const duplicatesSchema = z.object({
  scope: z.enum(['selection', 'document']).describe('selection: among the cues the user selected; document: the whole document.'),
}).strict();

/** Reads the cues the edits name, by number, at the page's revision. */
async function cuesByNumber(deps: StudioAgentDeps, page: DocumentPage, numbers: readonly number[], check: () => void) {
  const track = deps.track();
  const cues = new Map<number, DocumentPage['cues'][number] & { index: number }>();
  const entries: NonNullable<CueTrack>['entries'] = {};
  for (const offset of new Set(numbers.map(number => Math.floor((number - 1) / LIMITS.pageSize) * LIMITS.pageSize))) {
    const chunk = offset === page.offset ? page : unwrap(await deps.api().readDocumentPage({ documentId: page.summary.id, revision: page.summary.revision, offset }));
    check();
    chunk.cues.forEach((cue, position) => cues.set(chunk.offset + position + 1, { ...cue, index: chunk.offset + position }));
    Object.assign(entries, chunk.translationTracks.find(item => item.id === track?.id)?.entries ?? {});
  }
  return { cues, track: track ? { id: track.id, entries } : undefined };
}

/** The structure proposals for the edits the user asked for, or why they cannot be made. */
async function prepareEdits(deps: StudioAgentDeps, page: DocumentPage, edits: z.infer<typeof editSchema>['edits'], check: () => void): Promise<CueStructureProposal[]> {
  const total = page.summary.cueCount;
  const numbers = edits.flatMap(edit => edit.kind === 'merge' ? Array.from({ length: Math.max(0, edit.to - edit.from + 1) }, (_, offset) => edit.from + offset) : edit.kind === 'delete' ? edit.numbers : [edit.number]);
  if (numbers.some(number => number > total)) throw new PageFailure('invalid_cue_number');
  if (numbers.length > EDIT_LIMIT * 2 || new Set(numbers).size !== numbers.length) throw new PageFailure(new Set(numbers).size !== numbers.length ? 'overlapping_edits' : 'too_many_edits');
  const { cues, track } = await cuesByNumber(deps, page, numbers, check);
  const proposals: CueStructureProposal[] = [];
  for (const edit of edits) {
    if (edit.kind === 'merge') {
      if (edit.to <= edit.from || edit.to - edit.from + 1 > MERGE_LIMIT) throw new PageFailure('not_adjacent');
      proposals.push(mergeProposal(Array.from({ length: edit.to - edit.from + 1 }, (_, offset) => cues.get(edit.from + offset)!), track));
    } else if (edit.kind === 'delete') {
      for (const number of edit.numbers) {
        const cue = cues.get(number)!;
        const entry = track?.entries[cue.id];
        proposals.push({ kind: 'delete', cueId: cue.id, index: cue.index, current: { source: cue.source, ...(entry && entry.sourceRevision === cue.sourceRevision ? { target: entry.text } : {}) }, timing: { ...cue.timing } });
      }
    } else {
      const cue = cues.get(edit.number)!;
      const startMs = edit.start === undefined ? cue.timing.startMs : parseStudioTime(edit.start);
      const endMs = edit.end === undefined ? cue.timing.endMs : edit.end === 'unknown' ? null : parseStudioTime(edit.end);
      if (startMs === null || (edit.end !== undefined && edit.end !== 'unknown' && endMs === null) || (endMs !== null && endMs < startMs)
        || (endMs === null && page.summary.origin.format !== 'lrc' && cue.timing.endMs !== null)) throw new PageFailure('invalid_time');
      proposals.push({ kind: 'timing', cueId: cue.id, index: cue.index, current: { source: cue.source }, before: { ...cue.timing }, timing: { startMs, endMs } });
    }
  }
  if (proposals.reduce((sum, item) => sum + (item.kind === 'merge' ? item.cueIds.length - 1 : item.kind === 'delete' ? 1 : 0), 0) >= total) throw new PageFailure('invalid_cue_number');
  return proposals;
}

/** Opens the revision preview with a preset and waits for its outcome; a stopped turn leaves the preview with the user. */
function openPreview(deps: StudioAgentDeps, cueIds: string[], preset: CueRevisionPreset, signal?: AbortSignal) {
  return new Promise<CueRevisionOutcome | 'aborted'>(resolve => {
    const abort = () => resolve('aborted');
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    deps.openRevision(cueIds, preset, value => { signal?.removeEventListener('abort', abort); resolve(value); });
  });
}

const consistencySchema = z.object({
  focus: z.string().trim().max(500).optional().describe('What to concentrate on, in the user\u2019s words, such as names of people and places.'),
}).strict();

function consistencyResult(outcome: ConsistencyOutcome): Result {
  if (outcome.status === 'cancelled') return { success: false, error: 'consistency_cancelled' };
  if (outcome.status === 'failed') return { success: false, error: outcome.error satisfies ErrorCode };
  const { result } = outcome;
  return ok({ status: 'awaiting_user_review', groups: result.groups.length, checkedLines: result.checkedLines,
    summary: result.groups.slice(0, 10).map(group => ({ source: clip(group.source), kind: group.kind,
      variants: group.variants.filter(variant => variant.text).map(variant => ({ text: clip(variant.text), count: variant.count })),
      ...(group.spellings.length > 1 ? { sourceSpellings: group.spellings.map(spelling => ({ text: clip(spelling.text), count: spelling.count })) } : {}),
      ...(group.recommended ? { recommended: clip(group.recommended) } : {}), ...(group.knowledgeTarget ? { fromMaterials: true } : {}) })),
    nextAction: result.groups.length ? 'The consistency check is open in Subtitle Studio. The user chooses the standard wordings and unifies them there; nothing has been changed yet.'
      : 'No inconsistent names or terms were found.' });
}

function outcomeResult(outcome: CueRevisionOutcome): Result {
  switch (outcome.status) {
    case 'ready': return ok({ status: 'awaiting_user_review', checkedCues: outcome.checked, proposedRevisions: outcome.proposals, notes: outcome.notes, ...(outcome.plan ? { plan: outcome.plan } : {}),
      ...(outcome.structure ? { structure: { merges: outcome.structure.merges, deletes: outcome.structure.deletes, timings: outcome.structure.timings } } : {}),
      ...(outcome.knowledgeHints?.length ? { knowledgeHints: outcome.knowledgeHints.slice(0, 5).map(hint => ({ source: clip(hint.source), target: clip(hint.target) })) } : {}),
      nextAction: outcome.proposals ? 'The revision preview is open in Subtitle Studio. The user reviews the changes and applies them there; nothing has been written yet.' : 'No change was proposed; the preview is open for the user to adjust the request.' });
    case 'needs_confirmation': return ok({ status: 'awaiting_scan_confirmation', cueCount: outcome.count, plan: outcome.plan,
      nextAction: 'Checking this many cues needs many model requests. The user confirms the scan in the open preview.' });
    case 'failed': return { success: false, error: outcome.error satisfies ErrorCode };
    case 'cancelled': return { success: false, error: 'revision_cancelled' };
  }
}

export function createStudioAgentTools(deps: StudioAgentDeps): PageToolSet {
  return {
    studio_read_cues: {
      description: 'Read cues of the subtitle document open in Subtitle Studio by number: time, source text and the shown translation (with whether it is outdated). Read-only.',
      inputSchema: readSchema,
      execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => guard(async () => {
        const args = readSchema.parse(input);
        const { page, check } = currentDocument(deps);
        const track = deps.track();
        const total = page.summary.cueCount;
        const start = args.from - 1, end = Math.min(total, start + args.count);
        const items: unknown[] = [];
        for (let offset = Math.floor(start / LIMITS.pageSize) * LIMITS.pageSize; offset < end; offset += LIMITS.pageSize) {
          if (options?.abortSignal?.aborted) throw new PageFailure('agent_cancelled');
          const chunk = offset === page.offset ? page : unwrap(await deps.api().readDocumentPage({ documentId: page.summary.id, revision: page.summary.revision, offset }));
          check();
          const entries = chunk.translationTracks.find(item => item.id === track?.id)?.entries ?? {};
          chunk.cues.forEach((cue, index) => {
            const number = chunk.offset + index + 1;
            if (number <= start || number > end) return;
            const entry = entries[cue.id];
            items.push({ number, startMs: cue.timing.startMs, endMs: cue.timing.endMs, source: clip(cue.source.plain),
              ...(entry ? { target: clip(entry.text.plain), ...(entry.sourceRevision !== cue.sourceRevision ? { targetOutdated: true } : {}) } : {}) });
          });
        }
        return ok({ total, items });
      }),
    },
    studio_find_cues: {
      description: 'Find cues in the open Subtitle Studio document by wording (near misses of longer words also match) or by number, without a model call. Searches the source and the shown translation. Read-only.',
      inputSchema: findSchema,
      execute: (input: unknown) => guard(async () => {
        const args = findSchema.parse(input);
        const { page, check } = currentDocument(deps);
        const track = deps.track();
        const found = unwrap(await deps.api().findCues({ documentId: page.summary.id, revision: page.summary.revision, ...(track ? { trackId: track.id } : {}),
          ...(args.terms ? { terms: args.terms } : { lines: args.lines! }), limit: args.limit }));
        check();
        return ok({ total: found.total, matches: found.matches.map(match => ({ number: match.index + 1, source: clip(match.source), ...(match.target !== undefined ? { target: clip(match.target) } : {}) })) });
      }),
    },
    studio_check_consistency: {
      description: 'Open the terminology consistency check for the document open in Subtitle Studio and run it: it finds names and terms translated or spelled more than one way (and lines not following the chosen translation materials). ' +
        'Returns the groups found; the user chooses standard wordings and unifies them in the check window. This tool never writes. Uses the AI translation model configured for Studio.',
      inputSchema: consistencySchema,
      execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => guard(async () => {
        const args = consistencySchema.parse(input);
        const { check } = currentDocument(deps);
        if (!deps.openConsistency) throw new PageFailure('unsupported_feature');
        if (deps.consistencyOpen?.() || deps.revisionOpen()) throw new PageFailure('consistency_already_open');
        const outcome = await new Promise<ConsistencyOutcome | 'aborted' | 'empty'>(resolve => {
          const signal = options?.abortSignal;
          const abort = () => resolve('aborted');
          if (signal?.aborted) { abort(); return; }
          signal?.addEventListener('abort', abort, { once: true });
          const opened = deps.openConsistency!(args.focus, value => { signal?.removeEventListener('abort', abort); resolve(value); });
          if (!opened) { signal?.removeEventListener('abort', abort); resolve('empty'); }
        });
        if (outcome === 'aborted') throw new PageFailure('agent_cancelled');
        if (outcome === 'empty') throw new PageFailure('empty_document');
        check();
        return consistencyResult(outcome);
      }),
    },
    studio_prepare_revision: {
      description: 'Open the AI revision preview in Subtitle Studio for the selected cues or the whole document, prefilled with the request, and wait until the proposals are ready. ' +
        'The user reviews and applies the changes in the preview; this tool never writes. Uses the AI translation model configured for Studio.',
      inputSchema: reviseSchema,
      execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => guard(async () => {
        const args = reviseSchema.parse(input);
        const { check } = currentDocument(deps);
        const blocked = deps.editBlocked();
        if (blocked) return { success: false, error: 'edit_blocked', data: { reason: blocked } };
        if (deps.revisionOpen()) throw new PageFailure('revision_already_open');
        const selection = args.scope === 'selection' ? [...deps.selection()] : [];
        if (args.scope === 'selection' && !selection.length) throw new PageFailure('empty_selection');
        const track = deps.track();
        if (args.fields && args.fields !== 'source' && !track) throw new PageFailure('no_translation_track');
        const search = args.scope === 'document' ? args.terms ? { terms: args.terms } : args.lines ? { lines: args.lines } : undefined : undefined;
        const outcome = await openPreview(deps, selection, { instructions: args.instructions, scope: args.scope, ...(args.fields ? { fields: args.fields } : {}), ...(search ? { search } : {}), onApplied: reportApplied }, options?.abortSignal);
        if (outcome === 'aborted') throw new PageFailure('agent_cancelled');
        check();
        return outcomeResult(outcome);
      }),
    },
    studio_prepare_cue_edits: {
      description: 'Prepare structural edits the user asked for in the open Subtitle Studio document, by cue number: merge consecutive cues into one (texts joined without repeating; from the first start to the last end), delete cues, or change a cue\u2019s start or end time. ' +
        'No model is used. The edits open in the revision preview, where the user reviews and applies them as one undoable edit; this tool never writes.',
      inputSchema: editSchema,
      execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => guard(async () => {
        const args = editSchema.parse(input);
        const { page, check } = currentDocument(deps);
        const blocked = deps.editBlocked();
        if (blocked) return { success: false, error: 'edit_blocked', data: { reason: blocked } };
        if (deps.revisionOpen()) throw new PageFailure('revision_already_open');
        const structure = await prepareEdits(deps, page, args.edits, check);
        const outcome = await openPreview(deps, [], { instructions: '', scope: 'document', mode: 'prepared', structure, onApplied: reportApplied }, options?.abortSignal);
        if (outcome === 'aborted') throw new PageFailure('agent_cancelled');
        check();
        return outcomeResult(outcome);
      }),
    },
    studio_find_duplicates: {
      description: 'Check the open Subtitle Studio document (or the selected cues) for neighbouring cues that repeat each other, as speech recognition sometimes outputs one line twice. No model is used. ' +
        'Each repetition is proposed as a merge in the revision preview, where the user reviews and applies them; this tool never writes.',
      inputSchema: duplicatesSchema,
      execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => guard(async () => {
        const args = duplicatesSchema.parse(input);
        const { check } = currentDocument(deps);
        const blocked = deps.editBlocked();
        if (blocked) return { success: false, error: 'edit_blocked', data: { reason: blocked } };
        if (deps.revisionOpen()) throw new PageFailure('revision_already_open');
        const selection = args.scope === 'selection' ? [...deps.selection()] : [];
        if (args.scope === 'selection' && selection.length < 2) throw new PageFailure('empty_selection');
        const outcome = await openPreview(deps, selection, { instructions: '', scope: args.scope, mode: 'duplicates', onApplied: reportApplied }, options?.abortSignal);
        if (outcome === 'aborted') throw new PageFailure('agent_cancelled');
        check();
        return outcomeResult(outcome);
      }),
    },
  };
}

export const STUDIO_AGENT_INSTRUCTIONS = [
  'Subtitle Studio is open. Cue numbers count from 1 as in the list; refer to cues by number.',
  'To change subtitle text (misheard names or terms, what a line should say, punctuation, translations), call studio_prepare_revision. It opens the AI revision preview; the user reviews and applies the changes there. Never claim the text has been changed.',
  'When the user names wrong spellings, use scope=document and pass terms with the wrong forms and likely mis-transcriptions (homophones, near misses), so no extra planning request is needed; for numbered lines pass lines. Use scope=selection when the user refers to the selected cues.',
  'Use studio_read_cues or studio_find_cues to look at the text before answering questions about it. Translating, exporting and library work keep using the fixed Subtitle Studio tools.',
  'To merge, delete or retime cues the user names ("merge 19 and 20", "start line 5 at 00:01:02.300"), call studio_prepare_cue_edits. To find lines speech recognition repeated, call studio_find_duplicates; for repeats only the model can judge, studio_prepare_revision may also propose merges and deletions. The user applies them in the preview.',
  'When the user asks whether names or terms are consistent or wants them unified across the document, call studio_check_consistency (optionally with a focus); the user unifies them in the check window.',
  'When the user wants a wording kept in translation materials (after a revision or not), take the exact source form from the cues the revision touched, use the source and translation languages of the document as the language pair, and prepare it with prepare_knowledge_changes.',
].join(' ');

export const STUDIO_AGENT_SUGGESTIONS: readonly PageSuggestion[] = [
  { labelKey: 'studio:agent.suggest_fix', promptKey: 'studio:agent.suggest_fix_prompt' },
  { labelKey: 'studio:agent.suggest_terms', promptKey: 'studio:agent.suggest_terms_prompt' },
  { labelKey: 'studio:agent.suggest_summary', promptKey: 'studio:agent.suggest_summary_prompt' },
];

/** The page context the Studio page registers with the assistant. */
export function studioPageContext(deps: StudioAgentDeps, tools: PageToolSet): AgentPageContext {
  const page = deps.page();
  return {
    route: STUDIO_ROUTE, titleKey: 'studio:title', ...(page ? { subject: page.summary.origin.displayName } : {}),
    suggestions: STUDIO_AGENT_SUGGESTIONS, instructions: STUDIO_AGENT_INSTRUCTIONS,
    describe: () => studioSnapshot(deps), tools,
  };
}
