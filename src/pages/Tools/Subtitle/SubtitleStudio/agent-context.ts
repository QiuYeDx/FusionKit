import { z } from 'zod';
import { LIMITS, type ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentPage, StudioResult, SubtitleStudioApi } from '@/subtitle-studio/ipc-contract';
import type { AgentPageContext, PageSuggestion, PageToolSet } from '@/agent/page-context';
import type { CueRevisionOutcome, CueRevisionPreset } from './StudioCueRevision';
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

function outcomeResult(outcome: CueRevisionOutcome): Result {
  switch (outcome.status) {
    case 'ready': return ok({ status: 'awaiting_user_review', checkedCues: outcome.checked, proposedRevisions: outcome.proposals, notes: outcome.notes, ...(outcome.plan ? { plan: outcome.plan } : {}),
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
        const outcome = await new Promise<CueRevisionOutcome | 'aborted'>(resolve => {
          const signal = options?.abortSignal;
          const abort = () => resolve('aborted');
          if (signal?.aborted) { abort(); return; }
          signal?.addEventListener('abort', abort, { once: true });
          deps.openRevision(selection, { instructions: args.instructions, scope: args.scope, ...(args.fields ? { fields: args.fields } : {}), ...(search ? { search } : {}) }, value => {
            signal?.removeEventListener('abort', abort);
            resolve(value);
          });
        });
        // A stopped turn leaves the preview with the user.
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
