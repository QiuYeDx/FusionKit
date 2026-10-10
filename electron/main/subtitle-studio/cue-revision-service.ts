import { StudioError, type SubtitleDocument } from '../../../src/subtitle-studio/domain';
import { normalizeTranslationModel, type TranslationModel, type TranslationUsage } from '../../../src/subtitle-studio/translation-contract';
import {
  buildCueLocateMessages, buildCueRevisionMessages, containsWording, CUE_REVISION_CHUNK, CUE_REVISION_DOCUMENT_LIMIT, CUE_REVISION_HINTS_LIMIT, cueRevisionRequestSchemas, mentionsTerm,
  parseCueLocateResponse, parseCueRevisionResponse, revisesTarget, type CueRevisionHint,
  type CueFindRequest, type CueFindResult, type CueLocateRequest, type CueRevisionContext, type CueRevisionItem, type CueRevisionLocation, type CueRevisionPlan, type CueRevisionProposal, type CueRevisionRequest, type CueRevisionResult,
} from '../../../src/subtitle-studio/cue-revision-contract';
import { sendModelRuntimeText, type ModelRuntimeMessage, type ModelRuntimeTextRequest, type ModelRuntimeTextResult } from '../ai/model-runtime-client';
import { ModelRuntimeClientError } from '../ai/model-runtime-errors';
import type { DocumentRepository } from './document-repository';
import { normalizeUsage } from './translation-service';
import { providerError } from './knowledge-trial';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import type { KnowledgeEnvironment, KnowledgeSelection } from '../../../src/translation-knowledge/execution-contract';
import { compileKnowledge, resolveEnvironment, selectBatchKnowledge } from '../../../src/translation-knowledge/execution';
import { mergeProposal, type CueStructureProposal } from '../../../src/subtitle-studio/cue-structure';

/** Requests of one call run side by side. */
const CONCURRENCY = 3;
/** Lines shown to the planner so that it knows the document's language and style. */
const SAMPLE_LINES = 20;
const SAMPLE_CHARS = 2000;
type Active = { owner: number; controller: AbortController };
type Track = SubtitleDocument['translationTracks'][number];
type Run = { document: SubtitleDocument; track?: Track; usage: TranslationUsage; send: (messages: ModelRuntimeMessage[], signal?: AbortSignal) => Promise<string>; alive: () => void };

function addUsage(total: TranslationUsage, usage: TranslationUsage) {
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const sum = total[key] === null || usage[key] === null ? null : total[key]! + usage[key]!;
    total[key] = sum !== null && Number.isSafeInteger(sum) ? sum : null;
  }
}
const yieldToEvents = () => new Promise<void>(resolve => setImmediate(resolve));

/** Only a current translation counts; a stale one describes an older source. */
function currentTarget(track: Track | undefined, cue: SubtitleDocument['cues'][number]) {
  const entry = track?.entries[cue.id];
  return entry && entry.sourceRevision === cue.sourceRevision && entry.text.plain.trim() ? entry.text : undefined;
}

/** Cue IDs a plan finds, in document order; searching yields to the event loop so long documents do not hold the main process. */
async function searchCues(document: SubtitleDocument, track: Track | undefined, plan: CueRevisionPlan, alive: () => void): Promise<string[]> {
  let cueIds: string[];
  if (plan.strategy === 'lines') cueIds = plan.lines.filter(line => line <= document.cues.length).map(line => document.cues[line - 1].id);
  else if (plan.strategy === 'all') cueIds = document.cues.filter(cue => cue.source.plain.trim()).map(cue => cue.id);
  else {
    cueIds = [];
    for (let index = 0; index < document.cues.length; index++) {
      if (index % 1000 === 999) { await yieldToEvents(); alive(); }
      const cue = document.cues[index];
      const target = track?.entries[cue.id]?.text.plain;
      if (mentionsTerm(cue.source.plain, plan.terms) || (target !== undefined && mentionsTerm(target, plan.terms))) cueIds.push(cue.id);
    }
  }
  if (cueIds.length > CUE_REVISION_DOCUMENT_LIMIT) throw new StudioError('limit_exceeded');
  return cueIds;
}

/**
 * Revises cues from a natural-language request, using the translation model.
 * `locate` turns a document-wide request into the cues it concerns (by
 * wording, line numbers or every line); `revise` proposes revisions of given
 * cues. Nothing is written: the renderer previews the proposals and applies
 * the accepted ones as one undoable cue edit, checked against the revision the
 * proposals were made for. Each step is one owner-bound, cancellable call.
 */
export class CueRevisionService {
  private active = new Map<string, Active>();
  private closed = false;

  constructor(private repository: DocumentRepository, private sendText: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult> = sendModelRuntimeText,
    private readKnowledge?: () => Promise<LibrarySnapshot>) {}

  /**
   * The document's translation materials resolved for the cues, or nothing: materials only guide a
   * revision, so an unreadable library or selection revises without them instead of failing.
   */
  private async materials(selection: KnowledgeSelection | undefined, document: SubtitleDocument, cueIds: string[]): Promise<KnowledgeEnvironment | undefined> {
    if (!selection || !this.readKnowledge || !selection.languagePair.source || (!selection.recipeId && !selection.collectionIds.length)) return undefined;
    try {
      const library = await this.readKnowledge();
      const cues = new Map(document.cues.map(cue => [cue.id, cue]));
      const environment = resolveEnvironment(library, selection, cueIds.map(id => ({ id, text: cues.get(id)!.source.plain, sourceLanguage: selection.languagePair.source })));
      return environment.items.length || environment.instructions || environment.context ? environment : undefined;
    } catch { return undefined; }
  }

  async locate(owner: number, input: CueLocateRequest, guard: () => void = () => {}): Promise<CueRevisionLocation> {
    const parsed = cueRevisionRequestSchemas.locateCueRevision.safeParse(input);
    if (!parsed.success) throw new StudioError('invalid_input');
    const request = parsed.data;
    return this.run(owner, request, guard, async ({ document, track, usage, send, alive }) => {
      const sample: string[] = [];
      let chars = 0;
      for (const cue of document.cues) {
        if (sample.length >= SAMPLE_LINES || chars >= SAMPLE_CHARS) break;
        if (!cue.source.plain.trim()) continue;
        sample.push(cue.source.plain); chars += cue.source.plain.length;
      }
      const plan = parseCueLocateResponse(await send(buildCueLocateMessages({ instructions: request.instructions, fields: request.fields, cueCount: document.cues.length, sample })), document.cues.length);
      const cueIds = await searchCues(document, track, plan, alive);
      return { documentId: document.id, revision: document.revision, plan, cueIds, total: document.cues.length, usage };
    });
  }

  async revise(owner: number, input: CueRevisionRequest, guard: () => void = () => {}): Promise<CueRevisionResult> {
    const parsed = cueRevisionRequestSchemas.reviseCues.safeParse(input);
    if (!parsed.success) throw new StudioError('invalid_input');
    const request = parsed.data;
    return this.run(owner, request, guard, async ({ document, track, usage, send, alive }) => {
      const positions = new Map(document.cues.map((cue, index) => [cue.id, index]));
      if (request.cueIds.some(id => !positions.has(id))) throw new StudioError('invalid_input');
      const translating = !!track && revisesTarget(request.fields);
      const environment = translating ? await this.materials(request.knowledge, document, request.cueIds) : undefined;
      alive();
      let knowledgeItems = 0;
      const context = (index: number): CueRevisionContext | undefined => {
        const cue = document.cues[index];
        if (!cue) return undefined;
        const text = currentTarget(track, cue)?.plain;
        return { source: cue.source.plain, ...(text !== undefined ? { target: text } : {}) };
      };
      const order = request.cueIds.map(id => positions.get(id)!).sort((a, b) => a - b);
      const chunks: (CueRevisionItem & { index: number })[][] = [];
      for (let offset = 0; offset < order.length; offset += CUE_REVISION_CHUNK) {
        const indices = order.slice(offset, offset + CUE_REVISION_CHUNK);
        const inChunk = new Set(indices);
        // Neighbours that are not items themselves give each line its context, also for lines found across a long document.
        chunks.push(indices.map((index, position) => {
          const cue = document.cues[index];
          const text = currentTarget(track, cue)?.plain;
          const before = inChunk.has(index - 1) ? undefined : context(index - 1);
          const after = inChunk.has(index + 1) ? undefined : context(index + 1);
          return { id: `c${position + 1}`, cueId: cue.id, index, source: cue.source.plain, ...(text !== undefined ? { target: text } : {}), ...(before ? { before } : {}), ...(after ? { after } : {}) };
        }));
      }
      // A failed request stops its siblings without counting as a cancellation by the user.
      const requests = new AbortController();
      const results: ReturnType<typeof parseCueRevisionResponse>[] = new Array(chunks.length);
      // Each chunk carries only the materials that apply to its lines, projected as for translation.
      const chunkMaterials = (chunk: (typeof chunks)[number]) => {
        if (!environment) return {};
        const compiled = compileKnowledge(selectBatchKnowledge(environment, chunk.map(item => item.cueId)));
        const ids = new Map(chunk.map(item => [item.cueId, item.id]));
        const items = compiled.items.map(item => ({ kind: item.kind, required: item.required, payload: item.payload,
          applicableItemIds: item.applicableCueIds.map(id => ids.get(id)).filter((id): id is string => id !== undefined),
          ...(item.condition ? { condition: item.condition } : {}) }));
        knowledgeItems += items.length;
        return items.length || compiled.context || compiled.instructions
          ? { translationKnowledge: { background: compiled.context, items }, ...(compiled.instructions ? { translationRequirements: compiled.instructions } : {}) } : {};
      };
      const runChunk = async (chunk: (typeof chunks)[number]) => parseCueRevisionResponse(await send(buildCueRevisionMessages({
        instructions: request.instructions, fields: request.fields,
        ...(translating ? { targetLanguage: track!.language, suggestKnowledge: true, ...chunkMaterials(chunk) } : {}),
        items: chunk,
      }), requests.signal), chunk, request.fields);
      let next = 0;
      const worker = async () => {
        while (next < chunks.length) {
          const position = next++;
          results[position] = await runChunk(chunks[position]);
        }
      };
      try { await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker)); }
      catch (error) { requests.abort(); throw error; }
      alive();
      const proposed = new Map(results.flatMap(result => [...result.proposals]));
      const proposals: CueRevisionProposal[] = [];
      for (const index of order) {
        const cue = document.cues[index];
        const proposal = proposed.get(cue.id);
        if (!proposal) continue;
        const target = currentTarget(track, cue);
        const value: CueRevisionProposal = { cueId: cue.id, index, current: { source: structuredClone(cue.source), ...(target ? { target: structuredClone(target) } : {}) }, ...proposal };
        // A changed source whose current translation was not revised keeps that translation current.
        if (value.source !== undefined && value.target === undefined && target && revisesTarget(request.fields)) {
          value.target = target.plain;
          value.keptTarget = true;
        }
        proposals.push(value);
      }
      // A suggested wording counts only where the texts bear it out: its source in a line's source and
      // its translation in that line's revised (or kept) translation.
      const hints = new Map<string, CueRevisionHint>();
      results.forEach((result, position) => {
        for (const hint of result.hints) {
          const cueIds = chunks[position].filter(item => {
            const revised = proposed.get(item.cueId);
            return containsWording(revised?.source ?? item.source, hint.source) && containsWording(revised?.target ?? item.target, hint.target);
          }).map(item => item.cueId);
          if (!cueIds.length) continue;
          const key = JSON.stringify([hint.source, hint.target].map(text => text.normalize('NFKC').toLowerCase()));
          const existing = hints.get(key);
          if (existing) existing.cueIds = [...new Set([...existing.cueIds, ...cueIds])];
          else if (hints.size < CUE_REVISION_HINTS_LIMIT) hints.set(key, { ...hint, cueIds });
        }
      });
      // Merges and deletions take their times and current texts from the document, never from the model.
      const structure: CueStructureProposal[] = [];
      let structureRejected = 0;
      const located = (cueId: string) => ({ ...document.cues[positions.get(cueId)!], index: positions.get(cueId)! });
      for (const result of results) {
        for (const merge of result.merges) {
          const proposal = mergeProposal(merge.cueIds.map(located), track, 'ai');
          proposal.source = merge.source;
          if (merge.target !== undefined && track) { proposal.target = merge.target; delete proposal.targetStale; }
          structure.push(proposal);
        }
        for (const cueId of result.deletes) {
          const cue = located(cueId);
          const target = currentTarget(track, cue);
          structure.push({ kind: 'delete', cueId, index: cue.index, current: { source: structuredClone(cue.source), ...(target ? { target: structuredClone(target) } : {}) }, timing: { ...cue.timing } });
        }
      }
      // A document keeps at least one cue: deletions that would remove every cue are dropped.
      const removing = structure.reduce((sum, item) => sum + (item.kind === 'merge' ? item.cueIds.length - 1 : 1), 0);
      if (removing >= document.cues.length) {
        structureRejected = structure.filter(item => item.kind === 'delete').length;
        structure.splice(0, structure.length, ...structure.filter(item => item.kind !== 'delete'));
      }
      structure.sort((a, b) => (a.kind === 'merge' ? a.indexes[0] : a.index) - (b.kind === 'merge' ? b.indexes[0] : b.index));
      return {
        documentId: document.id, revision: document.revision, ...(track ? { trackId: track.id } : {}), proposals,
        notes: results.flatMap(result => result.note ? [result.note] : []),
        rejected: results.reduce((sum, result) => sum + result.rejected, 0) + structureRejected, usage, ...(structure.length ? { structure } : {}),
        ...(translating ? { knowledgeHints: [...hints.values()] } : {}), ...(knowledgeItems ? { knowledgeItems } : {}),
      };
    });
  }

  /** Finds cues by wording or number without a model; nothing is written. */
  async find(input: CueFindRequest, guard: () => void = () => {}): Promise<CueFindResult> {
    const parsed = cueRevisionRequestSchemas.findCues.safeParse(input);
    if (!parsed.success) throw new StudioError('invalid_input');
    const request = parsed.data;
    if (this.closed) throw new StudioError('access_denied');
    const document = await this.repository.read(request.documentId); guard();
    if (document.revision !== request.revision) throw new StudioError('revision_conflict');
    const track = request.trackId ? document.translationTracks.find(item => item.id === request.trackId) : undefined;
    if (request.trackId && !track) throw new StudioError('invalid_input');
    const plan: CueRevisionPlan = request.terms ? { strategy: 'terms', terms: request.terms } : { strategy: 'lines', lines: [...new Set(request.lines!)].sort((a, b) => a - b) };
    const cueIds = await searchCues(document, track, plan, guard);
    const positions = new Map(document.cues.map((cue, index) => [cue.id, index]));
    const matches = cueIds.slice(0, request.limit).map(cueId => {
      const index = positions.get(cueId)!;
      const cue = document.cues[index];
      const target = currentTarget(track, cue)?.plain;
      return { cueId, index, source: cue.source.plain, ...(target !== undefined ? { target } : {}) };
    });
    return { documentId: document.id, revision: document.revision, total: cueIds.length, cueIds, matches };
  }

  /** Shared admission, document checks, model access and cancellation of one call. */
  private async run<T>(owner: number, request: CueLocateRequest, guard: () => void, body: (run: Run) => Promise<T>): Promise<T> {
    if (this.closed) throw new StudioError('access_denied');
    if (!request.apiKey.trim()) throw new StudioError('needs_configuration');
    if (this.active.has(request.requestId)) throw new StudioError('resource_busy');
    const model: TranslationModel = normalizeTranslationModel(request.model);
    const controller = new AbortController();
    this.active.set(request.requestId, { owner, controller });
    const unregister = this.repository.registerActivity(request.documentId, controller);
    const alive = () => {
      if (controller.signal.aborted || this.closed) throw new StudioError('interrupted');
      guard();
    };
    const usage: TranslationUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const send = async (messages: ModelRuntimeMessage[], signal?: AbortSignal) => {
      const linked = new AbortController();
      const abort = () => linked.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      let response: ModelRuntimeTextResult;
      try {
        response = await this.sendText({
          model: { ...model, apiKey: request.apiKey }, messages, maxOutputTokens: request.maxOutputTokens,
          responseFormat: 'json_object', maxResponseBytes: request.maxOutputTokens * 32 + 65536,
          timeoutMs: 120000, retry: { maxRetries: 1 }, signal: linked.signal,
        });
      } catch (error) {
        if (error instanceof ModelRuntimeClientError) addUsage(usage, normalizeUsage(error.details.usage));
        throw error;
      } finally {
        controller.signal.removeEventListener('abort', abort);
        signal?.removeEventListener('abort', abort);
      }
      addUsage(usage, normalizeUsage(response.usage));
      alive();
      if (response.apiFormat === 'chat_completions' && response.finishReason === 'length') throw new StudioError('translation_output_limit');
      return response.content;
    };
    try {
      const document = await this.repository.read(request.documentId); alive();
      if (document.revision !== request.revision) throw new StudioError('revision_conflict');
      const track = request.trackId ? document.translationTracks.find(item => item.id === request.trackId) : undefined;
      if (request.trackId && !track) throw new StudioError('invalid_input');
      return await body({ document, track, usage, send, alive });
    } catch (error) {
      throw controller.signal.aborted && !(error instanceof StudioError && error.code === 'revision_conflict') ? new StudioError('interrupted') : providerError(error);
    } finally {
      unregister();
      this.active.delete(request.requestId);
    }
  }

  cancel(owner: number, requestId: string) {
    const active = this.active.get(requestId);
    if (active?.owner === owner) active.controller.abort();
  }

  forgetOwner(owner: number) {
    for (const active of this.active.values()) if (active.owner === owner) active.controller.abort();
  }

  dispose() {
    this.closed = true;
    for (const active of this.active.values()) active.controller.abort();
  }
}
