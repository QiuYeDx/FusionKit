import { StudioError, type SubtitleDocument } from '../../../src/subtitle-studio/domain';
import { normalizeTranslationModel, type TranslationUsage } from '../../../src/subtitle-studio/translation-contract';
import {
  buildConsistencyGroups, buildConsistencyMessages, CONSISTENCY_CHUNK, CONSISTENCY_CUE_LIMIT, consistencyRequestSchemas, parseConsistencyResponse,
  type ConsistencyDocument, type ConsistencyKnowledgeTerm, type ConsistencyLine, type ConsistencyRequest, type ConsistencyResult, type ConsistencyTerm,
} from '../../../src/subtitle-studio/consistency-contract';
import type { KnowledgeSelection } from '../../../src/translation-knowledge/execution-contract';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import { sendModelRuntimeText, type ModelRuntimeMessage, type ModelRuntimeTextRequest, type ModelRuntimeTextResult } from '../ai/model-runtime-client';
import { ModelRuntimeClientError } from '../ai/model-runtime-errors';
import type { DocumentRepository } from './document-repository';
import { normalizeUsage } from './translation-service';
import { providerError } from './knowledge-trial';

const CONCURRENCY = 3;
type Active = { owner: number; controller: AbortController };

function addUsage(total: TranslationUsage, usage: TranslationUsage) {
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const sum = total[key] === null || usage[key] === null ? null : total[key]! + usage[key]!;
    total[key] = sum !== null && Number.isSafeInteger(sum) ? sum : null;
  }
}

/** The current translation of a cue on a track, if it still describes the cue's source. */
function currentTarget(document: SubtitleDocument, trackId: string | undefined, cue: SubtitleDocument['cues'][number]) {
  const track = trackId ? document.translationTracks.find(item => item.id === trackId) : document.translationTracks.at(-1);
  const entry = track?.entries[cue.id];
  return entry && entry.sourceRevision === cue.sourceRevision && entry.text.plain.trim() ? entry.text.plain : undefined;
}

/**
 * Checks documents for names and terms written more than one way. The model only lists candidates
 * per chunk; the counting over every line is the app's own, so nothing reported without evidence in
 * the texts becomes a finding. Read-only and cancellable; the user applies fixes in the renderer.
 */
export class ConsistencyService {
  private active = new Map<string, Active>();
  private closed = false;

  constructor(private repository: DocumentRepository, private sendText: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult> = sendModelRuntimeText,
    private readKnowledge?: () => Promise<LibrarySnapshot>) {}

  /** Enabled terms of the chosen materials in the documents' language pair; none when unreadable. */
  private async knowledgeTerms(selection: KnowledgeSelection | undefined): Promise<ConsistencyKnowledgeTerm[]> {
    if (!selection || !this.readKnowledge || (!selection.recipeId && !selection.collectionIds.length)) return [];
    try {
      const library = await this.readKnowledge();
      const recipe = selection.recipeId ? library.data.recipes.find(item => item.id === selection.recipeId) : undefined;
      const collections = new Set([...selection.collectionIds, ...(recipe?.readCollectionIds ?? [])]);
      const archived = new Set(library.data.collections.filter(item => item.archived).map(item => item.id));
      return library.data.entries.flatMap(entry => entry.kind === 'term' && entry.state === 'ready' && library.approvals[entry.id]?.revision === entry.revision
        && collections.has(entry.collectionId) && !archived.has(entry.collectionId) && !selection.disabledEntryIds.includes(entry.id)
        && entry.scope.languagePair.target === selection.languagePair.target && (!selection.languagePair.source || entry.scope.languagePair.source === selection.languagePair.source)
        ? [{ source: entry.payload.source, aliases: entry.payload.aliases, target: entry.payload.target }] : []);
    } catch { return []; }
  }

  async check(owner: number, input: ConsistencyRequest, guard: () => void = () => {}): Promise<ConsistencyResult> {
    const parsed = consistencyRequestSchemas.checkConsistency.safeParse(input);
    if (!parsed.success) throw new StudioError('invalid_input');
    const request = parsed.data;
    if (this.closed) throw new StudioError('access_denied');
    if (!request.apiKey.trim()) throw new StudioError('needs_configuration');
    if (this.active.has(request.requestId)) throw new StudioError('resource_busy');
    const model = normalizeTranslationModel(request.model);
    const controller = new AbortController();
    this.active.set(request.requestId, { owner, controller });
    const alive = () => {
      if (controller.signal.aborted || this.closed) throw new StudioError('interrupted');
      guard();
    };
    const usage: TranslationUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const send = async (messages: ModelRuntimeMessage[], signal: AbortSignal) => {
      const linked = new AbortController();
      const abort = () => linked.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      signal.addEventListener('abort', abort, { once: true });
      let response: ModelRuntimeTextResult;
      try {
        response = await this.sendText({ model: { ...model, apiKey: request.apiKey }, messages, maxOutputTokens: request.maxOutputTokens,
          responseFormat: 'json_object', maxResponseBytes: request.maxOutputTokens * 32 + 65536, timeoutMs: 120000, retry: { maxRetries: 1 }, signal: linked.signal });
      } catch (error) {
        if (error instanceof ModelRuntimeClientError) addUsage(usage, normalizeUsage(error.details.usage));
        throw error;
      } finally {
        controller.signal.removeEventListener('abort', abort);
        signal.removeEventListener('abort', abort);
      }
      addUsage(usage, normalizeUsage(response.usage));
      alive();
      if (response.apiFormat === 'chat_completions' && response.finishReason === 'length') throw new StudioError('translation_output_limit');
      return response.content;
    };
    const unregister = request.documents.map(item => this.repository.registerActivity(item.documentId, controller));
    try {
      const lines: ConsistencyLine[] = [];
      const documents: ConsistencyDocument[] = [];
      let targetLanguage: string | undefined;
      for (const item of request.documents) {
        const document = await this.repository.read(item.documentId); alive();
        if (document.revision !== item.revision) throw new StudioError('revision_conflict');
        const track = item.trackId ? document.translationTracks.find(value => value.id === item.trackId) : document.translationTracks.at(-1);
        if (item.trackId && !track) throw new StudioError('invalid_input');
        targetLanguage ??= track?.language;
        documents.push({ documentId: document.id, revision: document.revision, name: document.origin.displayName, ...(track ? { trackId: track.id } : {}) });
        document.cues.forEach((cue, index) => {
          if (!cue.source.plain.trim()) return;
          const target = currentTarget(document, track?.id, cue);
          lines.push({ documentId: document.id, cueId: cue.id, index, source: cue.source.plain, ...(target !== undefined ? { target } : {}) });
        });
        if (lines.length > CONSISTENCY_CUE_LIMIT) throw new StudioError('limit_exceeded');
      }
      const knowledge = await this.knowledgeTerms(request.knowledge); alive();
      const chunks: ConsistencyLine[][] = [];
      for (let offset = 0; offset < lines.length; offset += CONSISTENCY_CHUNK) chunks.push(lines.slice(offset, offset + CONSISTENCY_CHUNK));
      // A failed request stops its siblings without counting as a cancellation by the user.
      const requests = new AbortController();
      const terms: ConsistencyTerm[][] = new Array(chunks.length);
      let next = 0;
      const worker = async () => {
        while (next < chunks.length) {
          const position = next++;
          const chunk = chunks[position];
          terms[position] = parseConsistencyResponse(await send(buildConsistencyMessages({ ...(request.focus ? { focus: request.focus } : {}), ...(targetLanguage ? { targetLanguage } : {}),
            lines: chunk.map((line, index) => ({ id: `l${index + 1}`, source: line.source, ...(line.target !== undefined ? { target: line.target } : {}) })) }), requests.signal));
        }
      };
      try { await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker)); }
      catch (error) { requests.abort(); throw error; }
      alive();
      return { groups: buildConsistencyGroups(lines, terms.flat(), knowledge), checkedLines: lines.length, documents, usage };
    } catch (error) {
      throw controller.signal.aborted && !(error instanceof StudioError && error.code === 'revision_conflict') ? new StudioError('interrupted') : providerError(error);
    } finally {
      for (const release of unregister) release();
      this.active.delete(request.requestId);
    }
  }

  cancel(owner: number, requestId: string) {
    const active = this.active.get(requestId);
    if (active && active.owner === owner) active.controller.abort();
  }

  forgetOwner(owner: number) {
    for (const active of this.active.values()) if (active.owner === owner) active.controller.abort();
  }

  dispose() {
    this.closed = true;
    for (const active of this.active.values()) active.controller.abort();
    this.active.clear();
  }
}
