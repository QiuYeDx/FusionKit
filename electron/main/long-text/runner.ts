import { randomUUID } from 'node:crypto';
import type { ModelErrorCategory } from '../../../src/lib/model-error-category';
import {
  LONG_TEXT_LIMITS, modelSchema, SEGMENT_KINDS,
  type LanguageTag, type LedgerEntry, type LongTextError, type LongTextModel, type Pace, type RepairKind, type RunKind, type RunStatus,
  type RunView, type SegmentFailureCode, type Usage,
} from '../../../src/long-text/contract';
import { decode, project, type Projection } from '../../../src/long-text/inline';
import { emptyUsage, sumUsage } from '../../../src/long-text/journal';
import {
  isTranslatable, stateOf,
  type CandidateFilter, type DocumentPort, type Flag, type RunRecord, type RunScope, type SegmentFailure, type TranslationRecord,
} from '../../../src/long-text/model';
import { parseBatchResponse, type TermPair } from '../../../src/long-text/protocol';
import { checkModelOutput, isOmission, ledgerHits, measureLength, RatioReference, type LengthMeasure } from '../../../src/long-text/quality';
import type { CompiledKnowledge, KnowledgeEnvironment } from '../../../src/translation-knowledge/execution-contract';
import { compileKnowledge } from '../../../src/translation-knowledge/execution';
import type { ModelRuntimeConfig, ModelRuntimeTextRequest, ModelRuntimeTextResult, ModelRuntimeUsage } from '../ai/model-runtime-client';
import { ModelRuntimeClientError, modelErrorCategory } from '../ai/model-runtime-errors';
import {
  batchKnowledge, KNOWLEDGE_CUE_BYTES, knowledgeItems, knowledgeTermKeys, materialHits, prepareKnowledge, requiredTermIssues, resolveKnowledge,
  type ReadKnowledge, type RunKnowledge,
} from './knowledge';
import type { DocumentLedger } from './ledger';
import {
  batchContext, boostedOutputTokens, contextAt, familyBudget, firstUnit, fitRequest, maxResponseBytes, selectUnit, unitLimits,
  type DraftOptions, type ObservedTotals, type UnitLimits,
} from './planner';
import { buildPayload, systemPrompt } from './prompt';
import { LongTextOperationError } from './repository';
import type { RequestPool, RequestPriority } from './request-pool';

/**
 * Runs and single-segment retranslations (design §6.8, §6.9.6). A run translates a document page by
 * page in up to `pace` lanes, each lane one page at a time and in order; every model request goes
 * through the global request pool. Results are checked item by item and committed only when the
 * segment's rev is still the one dispatched. Splitting a failed batch never costs a segment an
 * attempt; only single-segment requests do, and each original batch has a bounded number of extra
 * requests, after which its remaining segments are deferred to a later run.
 */

export type SendText = (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult>;

export interface RunnerServices {
  send: SendText;
  pool: RequestPool;
  readKnowledge: ReadKnowledge;
  now?: () => number;
  /** Retry jitter, in [0, 1). */
  random?: () => number;
}

/** What runs and retranslations of one loaded document share; the service keeps one per document. */
export interface RunnerTarget {
  document: DocumentPort;
  ledger: DocumentLedger;
  /** Measured usage of committed batches, for the observed estimate (`planner.estimate`). */
  observed: ObservedTotals;
}

export interface RunStart {
  kind: RunKind;
  /** `from` runs: translations from this index on, unless locked, are cleared first. */
  fromIndex?: number;
  /** Sample runs started with `resample`: the previous sample's segments, cleared unless locked and translated again. */
  resample?: readonly number[] | null;
  model: LongTextModel;
  apiKey: string;
  /** `settingsDigest` of the document's settings, kept in the run record. */
  settingsDigest: string;
}

export interface RunHooks {
  /**
   * Writes the run record to the manifest at once. At the start it also carries what the run sets on
   * the document: `fullRunStarted` for full and from runs, the sample's segments for sample runs.
   */
  save(record: RunRecord, start?: { fullRunStarted: boolean; sample: number[] | null }): Promise<void>;
  /** The run's status or lane count changed. */
  changed?(view: RunView): void;
}

/** A failure that carries more than an error code: `model_failed` with its category and the provider's words. */
export class LongTextRunError extends LongTextOperationError {
  constructor(readonly error: LongTextError, options?: ErrorOptions) {
    super(error.code, options);
    this.name = 'LongTextRunError';
  }
}

// ---------------------------------------------------------------------------------------------
// Shared helpers

const FATAL_CATEGORIES: ReadonlySet<ModelErrorCategory> = new Set(['auth', 'balance', 'model_not_found', 'bad_url']);
// `empty_response` is not here: it is a batch-level invalid answer (see `classify`).
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['network_error', 'request_timeout', 'http_retryable', 'provider_retryable', 'http_rate_limited']);
const NORMAL_FINISH: ReadonlySet<string> = new Set(['stop', 'end_turn', 'eos', '']);
const PROVIDER_MESSAGE_CHARS = 300;
const SIBLING_MIN_CHARS = 20;
const RATE_LIMIT_RECOVERY = 20;
const ETA_SMOOTHING = 0.3;
const ETA_MIN_UNITS = 3;
const RETRY_BASE_MS = 1_000;
const RETRY_JITTER = 0.2;

const kindOf = (document: DocumentPort, index: number) => SEGMENT_KINDS[document.table.kind[index]];
const nonSpaceLength = (text: string) => Array.from(text.replace(/\s+/gu, '')).length;

function rangeOf(indices: Iterable<number>): { start: number; end: number } | null {
  let start = Infinity;
  let end = -Infinity;
  for (const index of indices) {
    start = Math.min(start, index);
    end = Math.max(end, index);
  }
  return Number.isFinite(start) ? { start, end } : null;
}

function emitIndices(document: DocumentPort, indices: Iterable<number>): void {
  const range = rangeOf(indices);
  if (range) document.emit(range);
}

/** `model_invalid` / `model_context_too_small` unless the model passes `modelSchema`. */
function checkModel(model: LongTextModel): void {
  if (model.contextWindow < LONG_TEXT_LIMITS.minContextWindow) throw new LongTextOperationError('model_context_too_small');
  if (!modelSchema.safeParse(model).success) throw new LongTextOperationError('model_invalid');
}

function checkLanguages(document: DocumentPort): { source: LanguageTag; target: LanguageTag } {
  const languages = document.languages();
  if (languages.source === languages.target) throw new LongTextOperationError('same_language');
  return languages;
}

/** Resolves after `ms`, or with false as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function acquireSlot(pool: RequestPool, signal: AbortSignal, priority: RequestPriority): Promise<(() => void) | null> {
  try {
    const release = await pool.acquire(signal, priority);
    if (!signal.aborted) return release;
    release();
  } catch {
    // Aborted while waiting.
  }
  return null;
}

function usageDelta(usage: ModelRuntimeUsage | undefined, outcome: { failed?: boolean; unknown?: boolean } = {}): Usage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    requests: 1,
    failedRequests: outcome.failed ? 1 : 0,
    unknownRequests: outcome.unknown ? 1 : 0,
  };
}

function providerMessage(error: ModelRuntimeClientError, apiKey: string): string | undefined {
  const message = error.details.providerMessage?.split(apiKey).join('***').trim();
  return message ? Array.from(message).slice(0, PROVIDER_MESSAGE_CHARS).join('') : undefined;
}

type Outcome = { result: ModelRuntimeTextResult } | { error: unknown } | { aborted: true };

/**
 * Sends a request and waits for it unless `signal` aborts first. The pool slot is released when the
 * request itself settles, so a slot always stands for a request the provider may still be serving.
 */
function sendRequest(send: SendText, request: ModelRuntimeTextRequest, release: () => void, signal: AbortSignal): Promise<Outcome> {
  let pending: Promise<ModelRuntimeTextResult>;
  try {
    pending = Promise.resolve(send(request));
  } catch (error) {
    release();
    return Promise.resolve({ error });
  }
  pending.then(release, release);
  return new Promise(resolve => {
    const onAbort = () => resolve({ aborted: true });
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      result => {
        signal.removeEventListener('abort', onAbort);
        // DeepSeek: the provider ran out of capacity mid-answer. A busy server, not a bad answer.
        resolve(result.apiFormat !== 'responses' && result.finishReason === 'insufficient_system_resource'
          ? { error: new ModelRuntimeClientError('provider_retryable', 'The model service ran out of resources mid-answer.', true, { status: 503, ...(result.usage ? { usage: result.usage } : {}) }) }
          : { result });
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        resolve(error instanceof ModelRuntimeClientError && error.code === 'aborted' ? { aborted: true } : { error });
      },
    );
  });
}

type Failure =
  | { kind: 'fatal'; error: LongTextError }
  | { kind: 'json_mode' }
  | { kind: 'transport'; category: ModelErrorCategory; retryAfterMs?: number; rateLimited: boolean; timeout: boolean }
  | { kind: 'invalid'; reason: 'truncated' | 'protocol' | 'filtered' | 'empty' };

// Provider refusals of the batch's own text: DashScope `data_inspection_failed`, Azure `content_filter`,
// OpenAI `invalid_prompt`, DeepSeek "Content Exists Risk".
const REFUSAL_MARKERS: ReadonlySet<string> = new Set(['data_inspection_failed', 'content_filter', 'content_policy_violation', 'invalid_prompt']);
const REFUSAL_TEXT = /inappropriate content|content exists risk|content (management )?policy|content[ _-]?filter|considered high risk|flagged|不安全|敏感|违规/i;
// The batch did not fit the model's context after all (the token estimate is OpenAI's, the model's tokenizer may differ).
const OVERFLOW_MARKERS: ReadonlySet<string> = new Set(['context_length_exceeded', 'string_above_max_length']);
const OVERFLOW_TEXT = /maximum context length|context[ _-]?(length|window)|too many (input )?tokens|(prompt|input) is too long/i;

/** A 4xx answer caused by the batch's content rather than the model setup: split it like a refused or cut-off answer. */
function contentFailure(error: ModelRuntimeClientError): 'filtered' | 'truncated' | null {
  if (error.code !== 'http_non_retryable') return null;
  const markers = [error.details.providerCode, error.details.providerType]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const text = error.details.providerMessage ?? '';
  if (markers.some(marker => REFUSAL_MARKERS.has(marker)) || REFUSAL_TEXT.test(text)) return 'filtered';
  if (error.details.status === 413 || markers.some(marker => OVERFLOW_MARKERS.has(marker)) || OVERFLOW_TEXT.test(text)) return 'truncated';
  return null;
}

/**
 * What a failed request means (§6.8.4). `jsonModeRetry`: an HTTP 400 may come from the JSON mode.
 * `setupAccepted`: a request of this run was accepted, so the model setup works and an HTTP 400/422
 * is about the batch (its content or the output boost).
 */
function classify(error: unknown, apiKey: string, jsonModeRetry: boolean, setupAccepted = false): Failure {
  if (!(error instanceof ModelRuntimeClientError)) return { kind: 'transport', category: 'unknown', rateLimited: false, timeout: false };
  const category = modelErrorCategory(error);
  // A gateway's HTML or empty 408/409/425 page is a transient answer, not a wrong address
  // (the same page on a 5xx already classifies as 'server').
  const transientPage = error.code === 'http_retryable' && category === 'bad_url'
    && (error.details.nonJsonResponse === true || error.details.emptyBody === true);
  const fatal = (): Failure => {
    const message = providerMessage(error, apiKey);
    return { kind: 'fatal', error: { code: 'model_failed', category, ...(message ? { message } : {}) } };
  };
  if (FATAL_CATEGORIES.has(category) && !transientPage) return fatal();
  // Before the JSON mode check: a moderation 400 never turns the JSON mode off.
  const content = contentFailure(error);
  if (content) return { kind: 'invalid', reason: content };
  if (jsonModeRetry && error.code === 'http_non_retryable' && error.details.status === 400) return { kind: 'json_mode' };
  if (error.code === 'length_truncated') return { kind: 'invalid', reason: 'truncated' };
  if (error.code === 'invalid_response') return { kind: 'invalid', reason: 'protocol' };
  // Providers that filter an answer (Azure, Gemini compat, Zhipu) often send content_filter with no content, and the
  // adapter reports that as empty_response without the finish reason: split it like a refusal, never count it as transport.
  if (error.code === 'empty_response') return { kind: 'invalid', reason: 'empty' };
  if (RETRYABLE_CODES.has(error.code)) {
    return {
      kind: 'transport', category: transientPage ? 'server' : category, retryAfterMs: error.details.retryAfterMs,
      rateLimited: error.code === 'http_rate_limited', timeout: error.code === 'request_timeout',
    };
  }
  if (setupAccepted && error.code === 'http_non_retryable' && (error.details.status === 400 || error.details.status === 422)) {
    return { kind: 'invalid', reason: 'protocol' };
  }
  // http_unauthorized, http_forbidden, http_non_retryable, unsupported_api_format.
  return fatal();
}

/**
 * A boosted request refused by the provider (e.g. "Range of max_tokens should be [1, 8192]"): the
 * doubled limit is too large, nothing else changed. A refusal of the content is not about the boost.
 */
function boostRefused(error: unknown): error is ModelRuntimeClientError {
  return error instanceof ModelRuntimeClientError && error.code === 'http_non_retryable'
    && !FATAL_CATEGORIES.has(modelErrorCategory(error)) && contentFailure(error) !== 'filtered';
}

/** Delay before transport retry `attempt` (0-based): `1000 × 2^attempt ± 20%`, never shorter than the provider's `retryAfterMs`. */
function retryDelay(attempt: number, retryAfterMs: number | undefined, random: () => number): number {
  const backoff = RETRY_BASE_MS * 2 ** attempt * (1 + (random() * 2 - 1) * RETRY_JITTER);
  return Math.max(retryAfterMs ?? 0, Math.round(backoff));
}

type Rejection = 'markup' | 'empty' | 'sibling' | 'omission' | 'oversize';
interface Accepted { text: string; repaired: RepairKind[]; measure: LengthMeasure }
type Evaluation =
  | { kind: 'invalid'; reason: 'protocol' | 'truncated' | 'filtered' }
  | { kind: 'items'; accepted: Map<number, Accepted>; rejected: Map<number, Rejection>; terms: TermPair[] };

interface Prepared {
  /** The segments sent: the batch, possibly without some segments at its end. */
  indices: number[];
  request: ModelRuntimeTextRequest;
  itemIds: Map<number, string>;
  projections: Map<number, Projection>;
  compiled: CompiledKnowledge | null;
}
type Preparation = { ok: true; prepared: Prepared } | { ok: false; reason: 'too_long' | 'budget_required' };

interface Revision { request?: string; currentTranslation?: string }

/** The failure code of a single segment whose last attempt failed. */
function exhaustedCode(reason: 'protocol' | 'truncated' | 'filtered' | Rejection): SegmentFailureCode {
  switch (reason) {
    case 'truncated': return 'too_long';
    case 'filtered': return 'content_filtered';
    case 'empty': return 'empty_output';
    default: return 'protocol_invalid';
  }
}

/**
 * Builds, checks and commits batch requests for one document with one model. Holds the API key;
 * dropped when its run or retranslation ends.
 */
class Translator {
  private readonly config: ModelRuntimeConfig;

  constructor(
    private readonly target: RunnerTarget,
    readonly model: LongTextModel,
    apiKey: string,
    readonly knowledge: RunKnowledge | null,
    private readonly now: () => number,
  ) {
    this.config = {
      profileId: model.profileId, apiKey, modelKey: model.modelKey, endpoint: model.endpoint, apiFormat: model.apiFormat,
      ...(model.outputTokenParameter ? { outputTokenParameter: model.outputTokenParameter } : {}),
      ...(model.thinkingEnabled !== undefined ? { thinkingEnabled: model.thinkingEnabled } : {}),
    };
  }

  get apiKey(): string {
    return this.config.apiKey;
  }

  /** The request for `requested`, or for the segments at its start, cut to fit the context window (§6.8.3). */
  prepare(requested: readonly number[], options: { boost: boolean; jsonMode: boolean; revision: Revision | null; signal: AbortSignal }): Preparation {
    const { document, ledger } = this.target;
    let indices: readonly number[] = requested;
    if (this.knowledge) {
      // Materials cannot be checked against a segment over 64 KiB: it fails on its own, later ones wait.
      const over = indices.findIndex(index => Buffer.byteLength(document.displayAt(index)) > KNOWLEDGE_CUE_BYTES);
      if (over === 0) return { ok: false, reason: 'too_long' };
      if (over > 0) indices = indices.slice(0, over);
    }
    const languages = document.languages();
    const settings = document.settings();
    const displays = new Map(indices.map(index => [index, document.displayAt(index)]));
    const projections = new Map(indices.map(index => [index, project(displays.get(index)!, kindOf(document, index), document.format, { refs: document.refs })]));
    // A batch whose materials hit a resolution budget (resource_limit, no segment ids) would lose every
    // item, required ones included (§6.9.5): resolve a shorter prefix; a single segment that still hits it fails.
    let environment: KnowledgeEnvironment | null = null;
    while (this.knowledge) {
      environment = resolveKnowledge(this.knowledge, indices.map(index => ({ index, text: displays.get(index)! })));
      if (!environment.issues.some(issue => issue.code === 'resource_limit')) break;
      if (indices.length === 1) return { ok: false, reason: 'budget_required' };
      indices = indices.slice(0, Math.ceil(indices.length / 2));
    }
    const batches = new Map<number, ReturnType<typeof batchKnowledge>>();
    const batchOf = (size: number) => {
      if (!environment) return null;
      let batch = batches.get(size);
      if (!batch) batches.set(size, batch = batchKnowledge(environment, indices.slice(0, size)));
      return batch;
    };
    const context = batchContext(document, indices);
    const maxOutputTokens = options.boost ? boostedOutputTokens(this.model) : this.model.maxOutputTokens;
    const compiledOf = new WeakMap<ModelRuntimeTextRequest, CompiledKnowledge | null>();

    const build = ({ size, context: level, optional }: DraftOptions): ModelRuntimeTextRequest => {
      const segment = indices.slice(0, size);
      const batch = batchOf(size);
      const compiled = batch && optional !== null ? compileKnowledge(batch, Math.min(optional, batch.optional.length)) : null;
      const itemIds = new Map(segment.map((index, position) => [index, `s${position + 1}`]));
      const items = compiled ? knowledgeItems(compiled, itemIds) : [];
      const payload = buildPayload({
        languages,
        requirements: [settings.instructions, compiled?.instructions ?? ''],
        background: compiled?.context ?? '',
        termLedger: ledger.select(segment.map(index => displays.get(index)!), knowledgeTermKeys(compiled)),
        knowledgeItems: items,
        context: contextAt(context, level),
        revision: options.revision,
        items: segment.map(index => ({ id: itemIds.get(index)!, text: projections.get(index)!.text })),
      });
      const request: ModelRuntimeTextRequest = {
        model: this.config,
        messages: [
          { role: 'system', content: systemPrompt({ languages, style: settings.style, knowledge: items.length > 0, revision: payload.revision !== undefined }) },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        maxOutputTokens,
        ...(options.jsonMode ? { responseFormat: 'json_object' as const } : {}),
        maxResponseBytes: maxResponseBytes(maxOutputTokens),
        timeoutMs: LONG_TEXT_LIMITS.requestTimeoutMs,
        retry: { maxRetries: 0 },
        signal: options.signal,
      };
      compiledOf.set(request, compiled);
      return request;
    };

    const fit = fitRequest({
      size: indices.length,
      build,
      optionalKnowledge: size => batchOf(size)?.optional.length ?? 0,
      requiredKnowledge: size => (batchOf(size)?.required.length ?? 0) > 0,
    }, { contextWindow: this.model.contextWindow, maxOutputTokens });
    if (!fit.ok) return fit;
    const sent = indices.slice(0, fit.size);
    return {
      ok: true,
      prepared: {
        indices: sent,
        request: fit.request,
        itemIds: new Map(sent.map((index, position) => [index, `s${position + 1}`])),
        projections,
        compiled: compiledOf.get(fit.request) ?? null,
      },
    };
  }

  /** Checks a model's answer: the finish reason, the response shape, then every item (§6.7.2). */
  evaluate(prepared: Prepared, result: ModelRuntimeTextResult, final: boolean): Evaluation {
    const problem = finishProblem(result);
    if (problem) return { kind: 'invalid', reason: problem };
    const ids = prepared.indices.map(index => prepared.itemIds.get(index)!);
    const parsed = parseBatchResponse(result.content, ids, prepared.request.maxResponseBytes ?? Infinity);
    if ('error' in parsed) return { kind: 'invalid', reason: 'protocol' };

    const { document, ledger } = this.target;
    const languages = document.languages();
    const accepted = new Map<number, Accepted>();
    const rejected = new Map<number, Rejection>();
    for (const index of prepared.indices) {
      const projection = prepared.projections.get(index)!;
      const text = parsed.items.get(prepared.itemIds.get(index)!)!;
      if (text.length > Math.max(4 * projection.text.length + 200, 2_000)) {
        rejected.set(index, 'oversize');
        continue;
      }
      const decoded = decode(text, projection.marks, kindOf(document, index), { final, joinerTarget: languages.target, format: document.format, source: projection.text });
      if (!decoded.ok) {
        rejected.set(index, decoded.reason);
        continue;
      }
      const display = document.displayAt(index);
      const terms = [...ledgerHits(ledger.entries, display), ...materialHits(prepared.compiled, index)];
      const measure = measureLength({ source: display, target: decoded.text, srcLang: languages.source, marks: projection.marks, terms });
      if (isOmission(measure, document.ratio.value)) {
        rejected.set(index, 'omission');
        continue;
      }
      accepted.set(index, { text: decoded.text, repaired: decoded.repaired, measure });
    }
    // Two different sources with the same translation: the model merged or shifted items.
    const byText = new Map<string, number[]>();
    for (const [index, item] of accepted) {
      const key = item.text.trim();
      byText.set(key, [...(byText.get(key) ?? []), index]);
    }
    for (const group of byText.values()) {
      const long = group.filter(index => nonSpaceLength(document.displayAt(index)) >= SIBLING_MIN_CHARS);
      if (new Set(long.map(index => document.displayAt(index))).size < 2) continue;
      for (const index of long) {
        accepted.delete(index);
        rejected.set(index, 'sibling');
      }
    }
    return { kind: 'items', accepted, rejected, terms: parsed.terms };
  }

  /**
   * One journal append for the accepted translations, the failures and the request's usage; a segment
   * whose rev moved since `revs` was taken (or, with `skipLocked`, that is now locked) is skipped.
   * Then the length reference and the glossary learn from what was written.
   */
  async commit(input: {
    prepared?: Prepared;
    accepted?: ReadonlyMap<number, Accepted>;
    failures?: ReadonlyArray<{ index: number; failure: SegmentFailure }>;
    terms?: readonly TermPair[];
    revs: ReadonlyMap<number, number>;
    /** Null when no request was sent. */
    usage: Usage | null;
    runId: string | null;
    skipLocked: boolean;
  }): Promise<{ done: number[]; failed: number[] }> {
    const { document, ledger } = this.target;
    const languages = document.languages();
    const at = this.now();
    const records: TranslationRecord[] = [];
    const accepted = input.accepted ?? new Map<number, Accepted>();
    if (input.prepared && accepted.size) {
      const { prepared } = input;
      const issues = requiredTermIssues(prepared.compiled, [...accepted].map(([index, item]) => ({ index, text: item.text })));
      for (const [index, item] of accepted) {
        const display = document.displayAt(index);
        const flags = checkModelOutput({
          source: display, target: item.text, srcLang: languages.source, tgtLang: languages.target,
          marks: prepared.projections.get(index)!.marks, repaired: item.repaired, ratioRef: document.ratio.value,
          confirmedLedgerHits: ledger.confirmedHits(display), requiredTermIssues: issues.get(index) ?? [],
          materialHits: materialHits(prepared.compiled, index),
        }).map((flag): Flag => ({ code: flag.code, dismissed: false, ...(flag.detail ? { detail: flag.detail } : {}) }));
        records.push({
          index, rev: input.revs.get(index)! + 1, status: 'done', target: item.text, origin: 'model', locked: false, flags, failure: null,
          previous: stateOf(document.translationAt(index)), runId: input.runId, at,
        });
      }
    }
    for (const { index, failure } of input.failures ?? []) {
      records.push({
        index, rev: input.revs.get(index)! + 1, status: 'failed', target: null, origin: null, locked: false, flags: [], failure,
        previous: stateOf(document.translationAt(index)), runId: input.runId, at,
      });
    }
    let written: number[];
    try {
      written = await document.commit(records, input.usage && { runId: input.runId, usage: input.usage }, { skipLocked: input.skipLocked });
    } catch (error) {
      throw new LongTextOperationError('storage_failed', { cause: error });
    }
    const committed = new Set(written);
    const done = [...accepted.keys()].filter(index => committed.has(index));
    for (const index of done) {
      const { measure } = accepted.get(index)!;
      if (measure.eligible) document.ratio.push(measure.ratio);
    }
    if (done.length && input.terms?.length) {
      ledger.adopt(input.terms, {
        sources: done.map(index => ({ index, text: document.displayAt(index) })),
        translations: done.map(index => accepted.get(index)!.text),
      });
    }
    return { done, failed: (input.failures ?? []).map(item => item.index).filter(index => committed.has(index)) };
  }

  /** Writes the usage of a request that changed no segment. */
  async recordUsage(usage: Usage, runId: string | null): Promise<void> {
    try {
      await this.target.document.commit([], { runId, usage }, { skipLocked: true });
    } catch (error) {
      throw new LongTextOperationError('storage_failed', { cause: error });
    }
  }

  /** Measured input and output per source token, from requests that returned usage. */
  observe(indices: readonly number[], usage: ModelRuntimeUsage | undefined): void {
    if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return;
    const { observed, document } = this.target;
    observed.units++;
    observed.sourceTokens += indices.reduce((sum, index) => sum + document.table.tokens[index], 0);
    observed.inputTokens += usage.inputTokens ?? 0;
    observed.outputTokens += usage.outputTokens ?? 0;
  }
}

/**
 * Chat: `stop`, `end_turn`, `eos` or nothing is normal; `length` / `model_length` (Mistral) is a cut-off,
 * `content_filter` / `sensitive` (Zhipu) a refusal. Responses: `completed` (or no status) is normal.
 */
function finishProblem(result: ModelRuntimeTextResult): 'truncated' | 'filtered' | 'protocol' | null {
  if (result.apiFormat === 'responses') {
    if (result.rawStatus === undefined || result.rawStatus === 'completed') return null;
    // The adapter already throws length_truncated for max_output_tokens; the other documented incomplete reason is content_filter.
    return result.rawStatus === 'incomplete' ? 'filtered' : 'protocol';
  }
  const reason = result.finishReason ?? '';
  if (NORMAL_FINISH.has(reason)) return null;
  if (reason === 'length' || reason === 'model_length') return 'truncated';
  if (reason === 'content_filter' || reason === 'sensitive') return 'filtered';
  return 'protocol';
}

// ---------------------------------------------------------------------------------------------
// Runs

interface Unit {
  indices: number[];
  /** Extra requests left to the original batch, shared by its halves and single-segment retries. */
  family: { remaining: number };
  /** Single-segment retry after a cut-off answer: twice the output limit. */
  boost: boolean;
}
interface Lane { page: number | null; front: Unit[] }

/** Limits how many lanes may have a request at once (`effectiveLanes`); lanes queue in order. */
class LaneGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private limit: number) {}

  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      const waiter = () => {
        signal.removeEventListener('abort', onAbort);
        this.active++;
        resolve(true);
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  release(): void {
    this.active--;
    this.wake();
  }

  setLimit(limit: number): void {
    this.limit = limit;
    this.wake();
  }

  private wake(): void {
    while (this.active < this.limit && this.waiters.length) this.waiters.shift()!();
  }
}

export class Run {
  readonly id = randomUUID();
  readonly kind: RunKind;
  readonly startedAt: number;
  /** Resolves with the final record once every lane has stopped. */
  readonly done: Promise<RunRecord>;

  private status: RunStatus = 'running';
  private endedAt: number | null = null;
  private error: LongTextError | null = null;
  private stopping: 'graceful' | 'immediate' | null = null;
  /** Aborts the requests themselves: immediate stop and fatal errors. */
  private readonly requests = new AbortController();
  /** Aborts every wait (lanes, slots, retry delays) on any stop. */
  private readonly waits = new AbortController();
  /** Holds the API key; created once the run is validated, dropped when it ends. */
  private translator: Translator | null = null;
  private readonly modelInfo: RunRecord['model'];
  private readonly settingsDigest: string;
  private readonly document: DocumentPort;
  private readonly now: () => number;
  private readonly random: () => number;

  private pace: Pace;
  private effectiveLanes: number;
  private readonly gate: LaneGate;
  private successStreak = 0;
  private jsonMode = true;
  /** The provider refused a boosted output limit: no more boosts this run, it caps output at the normal limit. */
  private boostRefused = false;
  private consecutiveTransportFailures = 0;
  private okRequests = 0;
  private failedRequests = 0;

  private scope: RunScope = {};
  private pageQueue: number[] = [];
  private readonly lanes: Lane[] = [];
  private readonly laneTasks: Array<Promise<void>> = [];
  private readonly attempts = new Map<number, number>();
  private readonly deferred = new Set<number>();
  /** Segments that failed in this run: not dispatched again until the next run. */
  private readonly settled = new Set<number>();
  private readonly inFlight = new Set<number>();
  /** Requests sent and not settled yet: what "等待 n 个请求完成…" counts while pausing. */
  private requestsInFlight = 0;
  private readonly filter: CandidateFilter;

  private total = 0;
  private doneCount = 0;
  private failedCount = 0;
  private remainingTokens = 0;
  private readonly finished = new Set<number>();
  private usage: Usage = emptyUsage();
  private secondsPerToken: number | null = null;
  private timedUnits = 0;
  private finish!: (record: RunRecord) => void;

  /**
   * Validates and starts a run (§6.8.1 “开始”): the model, distinct languages, the materials; clears
   * what a from run or a resample replaces; `nothing_to_do` without candidates; then saves the run
   * record and starts the lanes. The caller checks that no other run of the document is active and
   * that its encoding is confirmed.
   */
  static async start(target: RunnerTarget, start: RunStart, services: RunnerServices, hooks: RunHooks): Promise<Run> {
    checkModel(start.model);
    const languages = checkLanguages(target.document);
    const run = new Run(target, start, services, hooks);
    await run.begin(languages, start, services.readKnowledge);
    return run;
  }

  private constructor(
    private readonly target: RunnerTarget,
    start: RunStart,
    private readonly services: RunnerServices,
    private readonly hooks: RunHooks,
  ) {
    this.document = target.document;
    this.kind = start.kind;
    this.now = services.now ?? Date.now;
    this.random = services.random ?? Math.random;
    this.startedAt = this.now();
    this.pace = this.document.settings().pace;
    this.effectiveLanes = this.pace;
    this.gate = new LaneGate(this.pace);
    this.modelInfo = { profileId: start.model.profileId, modelKey: start.model.modelKey, label: start.model.label };
    this.settingsDigest = start.settingsDigest;
    this.filter = {
      skip: index => this.deferred.has(index) || this.settled.has(index) || (this.attempts.get(index) ?? 0) >= LONG_TEXT_LIMITS.soloAttempts,
    };
    this.done = new Promise(resolve => { this.finish = resolve; });
  }

  private async begin(languages: { source: LanguageTag; target: LanguageTag }, start: RunStart, readKnowledge: ReadKnowledge): Promise<void> {
    const document = this.document;
    const resample = start.kind === 'sample' ? (start.resample ?? []).filter(index => isTranslatable(document.table, index)) : [];
    const probe = this.probe(start, resample);
    if (probe === null) throw new LongTextOperationError('nothing_to_do');
    const knowledge = await prepareKnowledge(document.settings().knowledge, languages, readKnowledge, { index: probe, text: document.displayAt(probe) });
    this.translator = new Translator(this.target, start.model, start.apiKey, knowledge, this.now);

    let cleared: number[] = [];
    try {
      if (start.kind === 'from') {
        const replaced: number[] = [];
        for (let index = start.fromIndex!; index < document.table.count; index++) {
          const status = document.translationAt(index)?.status;
          if (status && status !== 'pending') replaced.push(index);
        }
        cleared = await document.clear(replaced, this.id);
      } else if (resample.length) {
        cleared = await document.clear(resample, this.id);
      }
    } catch (error) {
      throw new LongTextOperationError('storage_failed', { cause: error });
    }
    if (cleared.length) emitIndices(document, cleared);

    if (start.kind === 'from') this.scope = { minIndex: start.fromIndex };
    if (start.kind === 'sample') {
      const sample = resample.length
        ? resample.filter(index => document.candidates(document.pageOf(index), { sample: new Set([index]) }).length > 0)
        : firstUnit(document, {}, this.limits());
      this.scope = { sample: new Set(sample) };
    }
    Object.assign(this.filter, this.scope);
    this.pageQueue = document.pagesWithCandidates(this.filter);
    for (const page of this.pageQueue) {
      for (const index of document.candidates(page, this.filter)) {
        this.total++;
        this.remainingTokens += document.table.tokens[index];
      }
    }
    if (!this.total) {
      this.translator = null;
      throw new LongTextOperationError('nothing_to_do');
    }
    try {
      await this.hooks.save(this.record(), {
        fullRunStarted: start.kind !== 'sample',
        sample: start.kind === 'sample' ? [...this.scope.sample!].sort((a, b) => a - b) : null,
      });
    } catch (error) {
      this.translator = null;
      throw new LongTextOperationError('storage_failed', { cause: error });
    }
    for (let k = 0; k < this.pace; k++) this.spawnLane();
    void this.waitForLanes();
  }

  /** A segment to check the materials with: the first one the run will translate (or replace). */
  private probe(start: RunStart, resample: readonly number[]): number | null {
    const document = this.document;
    const unlocked = (index: number) => isTranslatable(document.table, index) && !document.translationAt(index)?.locked;
    if (start.kind === 'from') {
      for (let index = start.fromIndex!; index < document.table.count; index++) if (unlocked(index)) return index;
      return null;
    }
    const replaced = resample.find(unlocked);
    if (replaced !== undefined) return replaced;
    const page = document.pagesWithCandidates({})[0];
    return page === undefined ? null : document.candidates(page, {})[0] ?? null;
  }

  // Control.

  /** Graceful: no new requests, those in flight finish and are saved. Immediate: requests in flight are aborted. */
  pause(immediate: boolean): 'pausing' | 'paused' {
    if (this.endedAt !== null) return 'paused';
    this.stop(immediate ? 'immediate' : 'graceful');
    return immediate ? 'paused' : 'pausing';
  }

  view(): RunView {
    const frontier = this.frontier();
    return {
      id: this.id, kind: this.kind, status: this.status,
      total: this.total, done: this.doneCount, failed: this.failedCount, deferred: this.deferred.size, inFlight: this.requestsInFlight,
      frontier, frontierPage: frontier === null ? null : this.document.pageOf(frontier),
      pace: this.pace, effectiveLanes: this.effectiveLanes, etaSeconds: this.eta(),
      startedAt: this.startedAt, endedAt: this.endedAt,
      model: { ...this.modelInfo },
      ...(this.error ? { error: { ...this.error } } : {}),
      usage: { ...this.usage },
    };
  }

  private record(): RunRecord {
    return {
      id: this.id, kind: this.kind, status: this.status, startedAt: this.startedAt,
      ...(this.endedAt !== null ? { endedAt: this.endedAt } : {}),
      settingsDigest: this.settingsDigest, model: { ...this.modelInfo },
      total: this.total, done: this.doneCount, failed: this.failedCount, deferred: this.deferred.size,
      ...(this.error ? { error: { ...this.error } } : {}),
    };
  }

  private stop(mode: 'graceful' | 'immediate'): void {
    if (this.stopping === 'immediate' || this.stopping === mode) return;
    this.stopping = mode;
    this.waits.abort();
    if (mode === 'immediate') this.requests.abort();
    if (this.status === 'running' && !this.error) this.setStatus('pausing');
  }

  private fail(error: LongTextError): void {
    if (this.error || this.endedAt !== null) return;
    this.error = error;
    this.stop('immediate');
  }

  private setStatus(status: RunStatus): void {
    this.status = status;
    this.hooks.save(this.record()).catch(error => console.warn('[long-text] Could not save the run', error));
    this.hooks.changed?.(this.view());
  }

  // Lanes.

  private spawnLane(): void {
    const lane: Lane = { page: null, front: [] };
    this.lanes.push(lane);
    this.laneTasks.push(this.runLane(lane).catch(error => {
      console.warn('[long-text] A translation lane stopped unexpectedly', error);
      this.fail({ code: 'internal' });
    }));
  }

  private async waitForLanes(): Promise<void> {
    for (let k = 0; k < this.laneTasks.length; k++) await this.laneTasks[k];
    this.endedAt = this.now();
    this.translator = null;
    this.status = this.error ? 'failed' : this.stopping ? 'paused' : 'completed';
    try {
      await this.hooks.save(this.record());
    } catch (error) {
      console.warn('[long-text] Could not save the finished run', error);
    }
    this.hooks.changed?.(this.view());
    this.finish(this.record());
  }

  private async runLane(lane: Lane): Promise<void> {
    while (!this.stopping) {
      this.syncPace();
      if (!(await this.gate.acquire(this.waits.signal))) return;
      try {
        const unit = lane.front.shift() ?? (lane.page === null ? null : this.nextUnit(lane.page));
        if (!unit) {
          lane.page = this.pageQueue.shift() ?? null;
          if (lane.page === null) return;
          continue;
        }
        await this.dispatch(lane, unit);
      } finally {
        this.gate.release();
      }
    }
  }

  /** Pace changes during a run apply from the next batch: more lanes, or fewer requests at once. */
  private syncPace(): void {
    const pace = this.document.settings().pace;
    if (pace === this.pace) return;
    this.effectiveLanes = pace > this.pace ? Math.min(pace, this.effectiveLanes + pace - this.pace) : Math.min(this.effectiveLanes, pace);
    this.pace = pace;
    this.gate.setLimit(this.effectiveLanes);
    while (this.lanes.length < pace) this.spawnLane();
    this.hooks.changed?.(this.view());
  }

  private limits(): UnitLimits {
    return unitLimits({
      batchSourceTokens: this.document.settings().batchSourceTokens,
      maxOutputTokens: this.translator!.model.maxOutputTokens,
      knowledge: this.translator!.knowledge !== null,
      sample: this.kind === 'sample',
    });
  }

  private nextUnit(page: number): Unit | null {
    const indices = selectUnit(this.document.candidates(page, this.filter), index => this.document.table.tokens[index], this.limits());
    return indices.length ? { indices, family: { remaining: familyBudget(indices.length) }, boost: false } : null;
  }

  // Dispatch (§6.8.2) and results (§6.8.4).

  private async dispatch(lane: Lane, unit: Unit): Promise<void> {
    const translator = this.translator!;
    const document = this.document;
    let release = await this.slot();
    if (!release) return;
    // A retranslation may have taken a queued segment, or the user changed it, since the batch was chosen.
    const eligible = new Set(document.candidates(lane.page!, this.filter));
    let indices = unit.indices.filter(index => eligible.has(index));
    if (!indices.length || !document.markInFlight(indices)) {
      release();
      return;
    }
    for (const index of indices) this.inFlight.add(index);
    this.requestsInFlight++;
    const revs = new Map(indices.map(index => [index, document.rev(index)]));
    emitIndices(document, indices);
    const startedAt = this.now();
    let counted: number | null = null;
    let transportFailures = 0;
    const uncount = () => {
      if (counted !== null) this.attempts.set(counted, this.attempts.get(counted)! - 1);
      counted = null;
    };
    const releaseSegments = (segments: readonly number[]) => {
      document.releaseInFlight(segments);
      for (const index of segments) this.inFlight.delete(index);
      emitIndices(document, segments);
    };

    try {
      for (;;) {
        const preparation = translator.prepare(indices, { boost: unit.boost && !this.boostRefused, jsonMode: this.jsonMode, revision: null, signal: this.requests.signal });
        if (!preparation.ok) {
          // Not even the first segment fits: it fails, the rest go back to the candidates.
          releaseSegments(indices.slice(1));
          indices = indices.slice(0, 1);
          await this.settle({ failures: [{ index: indices[0], failure: { code: preparation.reason } }], revs, usage: null });
          return;
        }
        const { prepared } = preparation;
        if (prepared.indices.length < indices.length) {
          releaseSegments(indices.slice(prepared.indices.length));
          indices = prepared.indices;
        }
        if (indices.length === 1 && counted === null) {
          counted = indices[0];
          this.attempts.set(counted, (this.attempts.get(counted) ?? 0) + 1);
        }
        const final = indices.length === 1 && (this.attempts.get(indices[0]) ?? 0) >= LONG_TEXT_LIMITS.soloAttempts;

        const outcome = await sendRequest(this.services.send, prepared.request, release, this.requests.signal);
        release = null;
        if ('aborted' in outcome) {
          uncount();
          await this.recordUsage(usageDelta(undefined, { unknown: true }));
          return;
        }
        if ('error' in outcome) {
          const boosted = (prepared.request.maxOutputTokens ?? 0) > translator.model.maxOutputTokens;
          if (boosted && !this.boostRefused && indices.length === 1 && boostRefused(outcome.error)) {
            // The segment was already cut off at the normal limit: another truncated attempt, without boosts from now on.
            this.boostRefused = true;
            await this.invalid(lane, unit, indices, 'truncated', revs, usageDelta(outcome.error.details.usage, { failed: true, unknown: !outcome.error.details.usage }));
            return;
          }
          const failure = classify(outcome.error, translator.apiKey, prepared.request.responseFormat === 'json_object' && this.okRequests === 0, this.okRequests > 0);
          const details = outcome.error instanceof ModelRuntimeClientError ? outcome.error.details : {};
          if (failure.kind === 'json_mode') {
            // Some providers reject `response_format`: drop it for the whole run and resend at once.
            this.jsonMode = false;
            await this.recordUsage(usageDelta(details.usage));
            release = await this.slot();
            if (!release) return uncount();
            continue;
          }
          if (failure.kind === 'fatal') {
            uncount();
            this.fail(failure.error);
            await this.recordUsage(usageDelta(details.usage, { failed: true }));
            return;
          }
          if (failure.kind === 'transport') {
            if (failure.rateLimited) this.rateLimited();
            const usage = usageDelta(details.usage, { failed: true, unknown: failure.timeout });
            const delay = retryDelay(transportFailures, failure.retryAfterMs, this.random);
            transportFailures++;
            if (transportFailures > LONG_TEXT_LIMITS.transportRetries || delay > LONG_TEXT_LIMITS.maxRetryWaitMs) {
              await this.settle({ failures: indices.map(index => ({ index, failure: { code: 'transport', category: failure.category } })), revs, usage });
              if (++this.consecutiveTransportFailures >= LONG_TEXT_LIMITS.consecutiveTransportFailures) this.fail({ code: 'model_failed', category: failure.category });
              return;
            }
            await this.recordUsage(usage);
            if (!(await sleep(delay, this.waits.signal))) return uncount();
            release = await this.slot();
            if (!release) return uncount();
            continue;
          }
          await this.invalid(lane, unit, indices, failure.reason, revs, usageDelta(details.usage, { failed: true, unknown: !details.usage }));
          return;
        }

        const { result } = outcome;
        const evaluation = translator.evaluate(prepared, result, final);
        if (evaluation.kind === 'invalid') {
          await this.invalid(lane, unit, indices, evaluation.reason, revs, usageDelta(result.usage, { failed: true, unknown: !result.usage }));
          return;
        }
        this.succeeded();
        translator.observe(indices, result.usage);
        this.timeUnit(indices, this.now() - startedAt);
        await this.items(lane, unit, indices, prepared, evaluation, revs, usageDelta(result.usage));
        return;
      }
    } catch (error) {
      if (error instanceof LongTextOperationError && error.code === 'storage_failed') {
        this.fail({ code: 'storage_failed' });
        return;
      }
      throw error;
    } finally {
      release?.();
      this.requestsInFlight--;
      releaseSegments(indices);
    }
  }

  /** A batch-level failure: split a batch, retry a single segment, or fail it on its last attempt. */
  private async invalid(lane: Lane, unit: Unit, indices: number[], reason: 'protocol' | 'truncated' | 'filtered' | 'empty', revs: Map<number, number>, usage: Usage): Promise<void> {
    this.requestFailed();
    if (indices.length > 1) {
      if (unit.family.remaining >= 2) {
        unit.family.remaining -= 2;
        const middle = Math.ceil(indices.length / 2);
        lane.front.unshift(
          { indices: indices.slice(0, middle), family: unit.family, boost: false },
          { indices: indices.slice(middle), family: unit.family, boost: false },
        );
      } else {
        this.defer(indices);
      }
      await this.recordUsage(usage);
      return;
    }
    await this.single(lane, unit, indices[0], reason, revs, usage);
  }

  /** A model answer with items: commit the good ones; send bad items again on their own. */
  private async items(lane: Lane, unit: Unit, indices: number[], prepared: Prepared, evaluation: Extract<Evaluation, { kind: 'items' }>, revs: Map<number, number>, usage: Usage): Promise<void> {
    if (indices.length === 1 && evaluation.rejected.size) {
      await this.single(lane, unit, indices[0], evaluation.rejected.get(indices[0])!, revs, usage);
      return;
    }
    const retries: Unit[] = [];
    for (const index of [...evaluation.rejected.keys()].sort((a, b) => a - b)) {
      if (unit.family.remaining >= 1) {
        unit.family.remaining--;
        retries.push({ indices: [index], family: unit.family, boost: false });
      } else {
        this.defer([index]);
      }
    }
    lane.front.unshift(...retries);
    await this.settle({ prepared, accepted: evaluation.accepted, terms: evaluation.terms, revs, usage });
  }

  /** A single segment that failed: again while attempts and the batch's budget last, otherwise failed or deferred. */
  private async single(lane: Lane, unit: Unit, index: number, reason: 'protocol' | 'truncated' | 'filtered' | Rejection, revs: Map<number, number>, usage: Usage): Promise<void> {
    if ((this.attempts.get(index) ?? 0) < LONG_TEXT_LIMITS.soloAttempts) {
      if (unit.family.remaining >= 1) {
        unit.family.remaining--;
        lane.front.unshift({ indices: [index], family: unit.family, boost: unit.boost || reason === 'truncated' });
      } else {
        this.defer([index]);
      }
      await this.recordUsage(usage);
      return;
    }
    await this.settle({ failures: [{ index, failure: { code: exhaustedCode(reason) } }], revs, usage });
  }

  /** Commits for this run and counts what was written. */
  private async settle(input: Omit<Parameters<Translator['commit']>[0], 'runId' | 'skipLocked'>): Promise<void> {
    if (input.usage) this.usage = sumUsage(this.usage, input.usage);
    const { done, failed } = await this.translator!.commit({ ...input, runId: this.id, skipLocked: true });
    this.doneCount += done.length;
    this.failedCount += failed.length;
    for (const index of failed) this.settled.add(index);
    this.leave([...done, ...failed]);
  }

  private async recordUsage(usage: Usage): Promise<void> {
    this.usage = sumUsage(this.usage, usage);
    try {
      await this.translator!.recordUsage(usage, this.id);
    } catch (error) {
      // Aborted runs still try to keep their usage; a failing disk only matters while the run goes on.
      if (!this.stopping) throw error;
    }
  }

  private defer(indices: readonly number[]): void {
    for (const index of indices) this.deferred.add(index);
    this.leave(indices);
  }

  /** Segments this run is finished with leave the remaining estimate. */
  private leave(indices: readonly number[]): void {
    for (const index of indices) {
      if (this.finished.has(index)) continue;
      this.finished.add(index);
      this.remainingTokens -= this.document.table.tokens[index];
    }
  }

  private async slot(): Promise<(() => void) | null> {
    if (this.stopping) return null;
    const release = await acquireSlot(this.services.pool, this.waits.signal, 'run');
    if (release && this.stopping) {
      release();
      return null;
    }
    return release;
  }

  // Counters (§6.8.4, §6.8.5).

  private succeeded(): void {
    this.okRequests++;
    this.consecutiveTransportFailures = 0;
    if (++this.successStreak >= RATE_LIMIT_RECOVERY && this.effectiveLanes < this.pace) {
      this.successStreak = 0;
      this.effectiveLanes++;
      this.gate.setLimit(this.effectiveLanes);
      this.hooks.changed?.(this.view());
    }
  }

  private requestFailed(): void {
    this.failedRequests++;
    if (this.failedRequests >= LONG_TEXT_LIMITS.unstableMinFailed && this.failedRequests > LONG_TEXT_LIMITS.unstableRatio * this.okRequests) {
      this.fail({ code: 'unstable_output' });
    }
  }

  private rateLimited(): void {
    this.successStreak = 0;
    if (this.effectiveLanes === 1) return;
    this.effectiveLanes--;
    this.gate.setLimit(this.effectiveLanes);
    this.hooks.changed?.(this.view());
  }

  private timeUnit(indices: readonly number[], elapsedMs: number): void {
    const tokens = indices.reduce((sum, index) => sum + this.document.table.tokens[index], 0);
    if (!tokens) return;
    const sample = elapsedMs / 1000 / tokens;
    this.secondsPerToken = this.secondsPerToken === null ? sample : ETA_SMOOTHING * sample + (1 - ETA_SMOOTHING) * this.secondsPerToken;
    this.timedUnits++;
  }

  private eta(): number | null {
    if (this.endedAt !== null || this.timedUnits < ETA_MIN_UNITS || this.secondsPerToken === null) return null;
    return Math.ceil(Math.max(0, this.remainingTokens) * this.secondsPerToken / this.effectiveLanes);
  }

  /** The smallest segment in flight or next in a lane. */
  private frontier(): number | null {
    let frontier = Infinity;
    for (const index of this.inFlight) frontier = Math.min(frontier, index);
    if (this.endedAt === null) {
      for (const lane of this.lanes) {
        const next = lane.front[0]?.indices[0] ?? (lane.page === null ? undefined : this.document.candidates(lane.page, this.filter)[0]);
        if (next !== undefined) frontier = Math.min(frontier, next);
      }
    }
    return Number.isFinite(frontier) ? frontier : null;
  }
}

// ---------------------------------------------------------------------------------------------
// Single-segment retranslation (§6.9.6)

export interface RetranslateRequest {
  index: number;
  rev: number;
  instruction?: string;
  model: LongTextModel;
  apiKey: string;
}

/**
 * Translates one segment again, with the user's request and the current translation in the payload.
 * The segment is taken in flight at once, so a run that queued it skips it. Up to 3 attempts at
 * interactive priority; errors that would stop a run only fail this retranslation (`model_failed`).
 * Resolves with the committed record: done, unlocked, the old version as `previous`; or failed when
 * every attempt was rejected.
 */
export async function retranslate(target: RunnerTarget, request: RetranslateRequest, services: RunnerServices, signal: AbortSignal = new AbortController().signal): Promise<TranslationRecord> {
  const { document } = target;
  const { index } = request;
  checkModel(request.model);
  if (!isTranslatable(document.table, index)) throw new LongTextOperationError('invalid_request');
  const languages = checkLanguages(document);
  if (!document.markInFlight([index])) throw new LongTextOperationError('busy');
  try {
    if (document.rev(index) !== request.rev) throw new LongTextOperationError('revision_conflict');
    emitIndices(document, [index]);
    const now = services.now ?? Date.now;
    const random = services.random ?? Math.random;
    const knowledge = await prepareKnowledge(document.settings().knowledge, languages, services.readKnowledge, { index, text: document.displayAt(index) });
    const translator = new Translator(target, request.model, request.apiKey, knowledge, now);
    const current = document.translationAt(index);
    const revision: Revision = {
      ...(request.instruction?.trim() ? { request: request.instruction.trim() } : {}),
      ...(current?.status === 'done' && current.target ? { currentTranslation: current.target } : {}),
    };
    const revs = new Map([[index, request.rev]]);
    const commit = async (input: Omit<Parameters<Translator['commit']>[0], 'revs' | 'runId' | 'skipLocked'>) => {
      const { done, failed } = await translator.commit({ ...input, revs, runId: null, skipLocked: false });
      if (!done.length && !failed.length) throw new LongTextOperationError('revision_conflict');
      return document.translationAt(index)!;
    };
    const record = (usage: Usage) => translator.recordUsage(usage, null);
    const fail = (reason: 'protocol' | 'truncated' | 'filtered' | Rejection, usage: Usage) =>
      commit({ failures: [{ index, failure: { code: exhaustedCode(reason) } }], usage });

    let jsonMode = true;
    let boost = false;
    /** The provider refused the boosted output limit: no boost again. */
    let refused = false;
    let transportFailures = 0;
    for (let attempt = 1; ; ) {
      const preparation = translator.prepare([index], { boost, jsonMode, revision, signal });
      if (!preparation.ok) return await commit({ failures: [{ index, failure: { code: preparation.reason } }], usage: null });
      const { prepared } = preparation;
      const release = await acquireSlot(services.pool, signal, 'interactive');
      if (!release) throw new LongTextOperationError('unavailable');
      const outcome = await sendRequest(services.send, prepared.request, release, signal);
      const last = attempt >= LONG_TEXT_LIMITS.soloAttempts;
      if ('aborted' in outcome) {
        await record(usageDelta(undefined, { unknown: true })).catch(() => undefined);
        throw new LongTextOperationError('unavailable');
      }
      if ('error' in outcome) {
        if (boost && (prepared.request.maxOutputTokens ?? 0) > request.model.maxOutputTokens && boostRefused(outcome.error)) {
          // Like a run: another truncated attempt at the normal limit (before `classify`, so it is not read as the JSON mode).
          boost = false;
          refused = true;
          const usage = usageDelta(outcome.error.details.usage, { failed: true, unknown: !outcome.error.details.usage });
          if (last) return await fail('truncated', usage);
          await record(usage);
          attempt++;
          continue;
        }
        const failure = classify(outcome.error, request.apiKey, jsonMode);
        const details = outcome.error instanceof ModelRuntimeClientError ? outcome.error.details : {};
        if (failure.kind === 'json_mode') {
          jsonMode = false;
          await record(usageDelta(details.usage));
          continue;
        }
        if (failure.kind === 'fatal') {
          await record(usageDelta(details.usage, { failed: true }));
          throw new LongTextRunError(failure.error);
        }
        if (failure.kind === 'transport') {
          const usage = usageDelta(details.usage, { failed: true, unknown: failure.timeout });
          const delay = retryDelay(transportFailures, failure.retryAfterMs, random);
          transportFailures++;
          await record(usage);
          if (transportFailures > LONG_TEXT_LIMITS.transportRetries || delay > LONG_TEXT_LIMITS.maxRetryWaitMs) {
            throw new LongTextRunError({ code: 'model_failed', category: failure.category });
          }
          if (!(await sleep(delay, signal))) throw new LongTextOperationError('unavailable');
          continue;
        }
        const usage = usageDelta(details.usage, { failed: true, unknown: !details.usage });
        if (last) return await fail(failure.reason, usage);
        await record(usage);
        boost ||= !refused && failure.reason === 'truncated';
        attempt++;
        continue;
      }
      const evaluation = translator.evaluate(prepared, outcome.result, last);
      if (evaluation.kind === 'invalid' || evaluation.rejected.size) {
        const reason = evaluation.kind === 'invalid' ? evaluation.reason : evaluation.rejected.get(index)!;
        const usage = usageDelta(outcome.result.usage, { failed: evaluation.kind === 'invalid', unknown: evaluation.kind === 'invalid' && !outcome.result.usage });
        if (last) return await fail(reason, usage);
        await record(usage);
        boost ||= !refused && reason === 'truncated';
        attempt++;
        continue;
      }
      translator.observe([index], outcome.result.usage);
      return await commit({ prepared, accepted: evaluation.accepted, terms: evaluation.terms, usage: usageDelta(outcome.result.usage) });
    }
  } finally {
    document.releaseInFlight([index]);
    emitIndices(document, [index]);
  }
}

// ---------------------------------------------------------------------------------------------
// Length reference of loaded documents

/** What `LENGTH_RATIOS.sample` reads; `LoadedDocument` has it all. */
export interface RatioSource extends DocumentPort {
  readonly ledger: readonly LedgerEntry[];
}

/**
 * The `RatioModel` of loaded documents (`document-state.ts`): a `RatioReference` for the languages,
 * seeded with the length ratio of each model translation whose source is long enough, measured as
 * the runner measures it at commit (confirmed glossary terms left out).
 */
export const LENGTH_RATIOS = {
  create: (languages: { source: LanguageTag; target: LanguageTag }) => new RatioReference(languages),
  sample(document: RatioSource, index: number): number | null {
    const record = document.translationAt(index);
    if (record?.status !== 'done' || record.origin !== 'model' || !record.target) return null;
    const display = document.displayAt(index);
    const { marks } = project(display, kindOf(document, index), document.format, { refs: document.refs });
    const measure = measureLength({ source: display, target: record.target, srcLang: document.languages().source, marks, terms: ledgerHits(document.ledger, display) });
    return measure.eligible ? measure.ratio : null;
  },
};
