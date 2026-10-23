import { encode } from 'gpt-tokenizer';
import { LONG_TEXT_LIMITS, type Estimate, type LanguageTag, type LongTextModel } from '../../../src/long-text/contract';
import { LANGUAGE_INFO } from '../../../src/long-text/languages';
import { cutUtf16, isTranslatable, SEGMENT_FLAG, type CandidateFilter, type DocumentPort } from '../../../src/long-text/model';
import { estimateTokens } from '../../../src/long-text/text-stats';
import { buildChatCompletionBody } from '../ai/adapters/chat-completions-adapter';
import { buildResponsesBody } from '../ai/adapters/responses-adapter';
import type { ModelRuntimeTextRequest } from '../ai/model-runtime-client';
import type { PromptContext } from './prompt';

/**
 * Batch planning (design §6.8.1–6.8.3, §6.9.1–6.9.2, §6.13): which segments go into one request, the
 * context around them, fitting the request into the model's context window, and the cost estimate.
 */

/** Output a batch is expected to need: `ceil(Σn × 1.6) + 16 × segments + 32`, which must stay within 75% of the output limit. */
const OUTPUT_PER_SOURCE_TOKEN = 1.6;
const OUTPUT_PER_SEGMENT = 16;
const OUTPUT_BASE = 32;
const OUTPUT_SHARE = 0.75;
const REQUEST_MARGIN = 64;
const MAX_BOOSTED_OUTPUT = 16_384;
const RESPONSE_BYTES_PER_TOKEN = 32;
const RESPONSE_BYTES_BASE = 65_536;
/** How many translatable segments before a batch are searched for translated neighbours. */
const PRIOR_SCAN = 30;
/** Estimated input besides the source: system prompt (~450) plus context, glossary and materials (~650). */
const ESTIMATE_OVERHEAD_PER_REQUEST = 1_100;
const OBSERVED_MIN_UNITS = 10;
const MODEL_RANGE: readonly [number, number] = [0.8, 1.3];
const OBSERVED_RANGE: readonly [number, number] = [0.9, 1.15];

// ---------------------------------------------------------------------------------------------
// Batches

export interface UnitLimits { segments: number; sourceTokens: number; maxOutputTokens: number }

export function unitLimits(options: { batchSourceTokens: number; maxOutputTokens: number; knowledge: boolean; sample: boolean }): UnitLimits {
  const segments = options.knowledge ? LONG_TEXT_LIMITS.batchSegmentsWithKnowledge : LONG_TEXT_LIMITS.batchSegments;
  return {
    segments: options.sample ? Math.min(segments, LONG_TEXT_LIMITS.sampleSegments) : segments,
    sourceTokens: options.sample ? LONG_TEXT_LIMITS.sampleTokens : options.batchSourceTokens,
    maxOutputTokens: options.maxOutputTokens,
  };
}

const expectedOutput = (sourceTokens: number, segments: number) =>
  Math.ceil(sourceTokens * OUTPUT_PER_SOURCE_TOKEN) + OUTPUT_PER_SEGMENT * segments + OUTPUT_BASE;

/**
 * The next batch: candidates in order until the next one would exceed the segment count, the source
 * tokens or the expected output. The first candidate always goes in.
 */
export function selectUnit(candidates: readonly number[], tokensOf: (index: number) => number, limits: UnitLimits): number[] {
  const unit: number[] = [];
  let tokens = 0;
  for (const index of candidates) {
    const nextTokens = tokens + tokensOf(index);
    const size = unit.length + 1;
    if (unit.length && (size > limits.segments || nextTokens > limits.sourceTokens || expectedOutput(nextTokens, size) > OUTPUT_SHARE * limits.maxOutputTokens)) break;
    unit.push(index);
    tokens = nextTokens;
  }
  return unit;
}

/** The first batch of the first page with candidates: what a sample run translates. */
export function firstUnit(document: DocumentPort, filter: CandidateFilter, limits: UnitLimits): number[] {
  for (const page of document.pagesWithCandidates(filter)) {
    const unit = selectUnit(document.candidates(page, filter), index => document.table.tokens[index], limits);
    if (unit.length) return unit;
  }
  return [];
}

/** Extra requests one original batch of `size` segments may make: `2·⌈log₂ n⌉ + 3`. */
export const familyBudget = (size: number) => (size <= 1 ? 3 : 2 * Math.ceil(Math.log2(size)) + 3);

/** A single segment cut off by the output limit is retried once with twice the limit, at most 16,384 and half the context window. */
export const boostedOutputTokens = (model: Pick<LongTextModel, 'maxOutputTokens' | 'contextWindow'>) =>
  Math.max(model.maxOutputTokens, Math.min(model.maxOutputTokens * 2, MAX_BOOSTED_OUTPUT, Math.floor(model.contextWindow / 2)));

export const maxResponseBytes = (maxOutputTokens: number) => maxOutputTokens * RESPONSE_BYTES_PER_TOKEN + RESPONSE_BYTES_BASE;

// ---------------------------------------------------------------------------------------------
// Context (§6.9.1–6.9.2)

/** At most 400 characters, without splitting a surrogate pair. */
const contextText = (text: string) => cutUtf16(text, LONG_TEXT_LIMITS.contextChars);

function translationOf(document: DocumentPort, index: number) {
  const record = document.translationAt(index);
  return record?.status === 'done' && record.target ? record : null;
}

/**
 * The read-only context of a batch: up to 3 translated segments before it (600 tokens, user edits
 * marked `reviewed`), the source of the segment right before it when that one is not translated, the
 * source of up to 2 segments after it (300 tokens), and the nearest chapter heading before it (120 tokens).
 */
export function batchContext(document: DocumentPort, indices: readonly number[]): PromptContext {
  const first = Math.min(...indices);
  const last = Math.max(...indices);
  const inUnit = new Set(indices);
  const context: PromptContext = {};

  const pairs: NonNullable<PromptContext['precedingPairs']> = [];
  let tokens = 0;
  let previous: number | null = null;
  let scanned = 0;
  for (let index = first - 1; index >= 0 && pairs.length < LONG_TEXT_LIMITS.priorPairs && scanned < PRIOR_SCAN; index--) {
    if (!isTranslatable(document.table, index)) continue;
    scanned++;
    previous ??= index;
    const record = translationOf(document, index);
    if (!record) continue;
    const source = contextText(document.displayAt(index));
    const translation = contextText(record.target!);
    const cost = estimateTokens(source) + estimateTokens(translation);
    if (tokens + cost > LONG_TEXT_LIMITS.priorTokens) break;
    tokens += cost;
    pairs.unshift({ source, translation, ...(record.origin === 'user' ? { reviewed: true as const } : {}) });
  }
  if (pairs.length) context.precedingPairs = pairs;
  if (previous !== null && !translationOf(document, previous)) context.precedingSource = [contextText(document.displayAt(previous))];

  const following: string[] = [];
  tokens = 0;
  for (let index = last + 1; index < document.table.count && following.length < LONG_TEXT_LIMITS.followingSource; index++) {
    if (!isTranslatable(document.table, index) || inUnit.has(index)) continue;
    const text = contextText(document.displayAt(index));
    const cost = estimateTokens(text);
    if (tokens + cost > LONG_TEXT_LIMITS.followingTokens) break;
    tokens += cost;
    following.push(text);
  }
  if (following.length) context.followingSource = following;

  for (let index = first - 1; index >= 0; index--) {
    if (!(document.table.flags[index] & SEGMENT_FLAG.chapter)) continue;
    const heading = contextText(document.displayAt(index));
    const headingTokens = estimateTokens(heading);
    if (headingTokens > LONG_TEXT_LIMITS.sectionTokens) break;
    const target = translationOf(document, index)?.target;
    const translation = target ? contextText(target) : null;
    context.section = translation && headingTokens + estimateTokens(translation) <= LONG_TEXT_LIMITS.sectionTokens ? { heading, translation } : { heading };
    break;
  }
  return context;
}

// ---------------------------------------------------------------------------------------------
// Fitting a request (§6.8.3)

export function serializeRequest(request: ModelRuntimeTextRequest): string {
  return JSON.stringify(request.model.apiFormat === 'responses' ? buildResponsesBody(request) : buildChatCompletionBody(request));
}

/** Input tokens of the request body as the provider will see it, plus a margin. */
export function requestTokenEstimate(request: ModelRuntimeTextRequest): number {
  return encode(serializeRequest(request)).length + REQUEST_MARGIN;
}

/** How much context a request keeps, cut in this order: preceding pairs, then the neighbouring sources, then the section. */
export const CONTEXT_LEVELS = ['full', 'noPairs', 'noSources', 'none'] as const;
export type ContextLevel = (typeof CONTEXT_LEVELS)[number];

export function contextAt(context: PromptContext, level: ContextLevel): PromptContext {
  switch (level) {
    case 'full': return context;
    case 'noPairs': return { ...context, precedingPairs: undefined };
    case 'noSources': return context.section ? { section: context.section } : {};
    case 'none': return {};
  }
}

export interface DraftOptions {
  /** The first `size` segments of the batch. */
  size: number;
  context: ContextLevel;
  /** Optional material items kept (a prefix of the ranked list); null leaves the materials out entirely. */
  optional: number | null;
}

/** A batch request that can be built with less context, fewer optional materials or fewer segments. */
export interface RequestDraft {
  readonly size: number;
  build(options: DraftOptions): ModelRuntimeTextRequest;
  optionalKnowledge(size: number): number;
  requiredKnowledge(size: number): boolean;
}

export type FitResult =
  | { ok: true; request: ModelRuntimeTextRequest; size: number }
  | { ok: false; reason: 'too_long' | 'budget_required' };

/**
 * Cuts the request until its input estimate plus the output limit fits the context window: preceding
 * pairs, neighbouring sources, the section, then optional materials (longest fitting prefix), then the
 * last segment of the batch, one at a time. A single segment that still does not fit fails with
 * `budget_required` when only its required materials are in the way, otherwise `too_long`.
 */
export function fitRequest(draft: RequestDraft, budget: { contextWindow: number; maxOutputTokens: number }): FitResult {
  const fits = (request: ModelRuntimeTextRequest) => requestTokenEstimate(request) + budget.maxOutputTokens <= budget.contextWindow;
  for (const context of CONTEXT_LEVELS) {
    const request = draft.build({ size: draft.size, context, optional: draft.optionalKnowledge(draft.size) });
    if (fits(request)) return { ok: true, request, size: draft.size };
  }
  for (let size = draft.size; size >= 1; size--) {
    const all = draft.optionalKnowledge(size);
    if (size < draft.size) {
      const request = draft.build({ size, context: 'none', optional: all });
      if (fits(request)) return { ok: true, request, size };
    }
    if (!all) continue;
    let low = 0;
    let request = draft.build({ size, context: 'none', optional: 0 });
    if (!fits(request)) continue;
    let high = all - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = draft.build({ size, context: 'none', optional: middle });
      if (fits(candidate)) {
        low = middle;
        request = candidate;
      } else {
        high = middle - 1;
      }
    }
    return { ok: true, request, size };
  }
  const bare = draft.build({ size: 1, context: 'none', optional: null });
  return { ok: false, reason: draft.requiredKnowledge(1) && fits(bare) ? 'budget_required' : 'too_long' };
}

// ---------------------------------------------------------------------------------------------
// Estimate (§6.13)

/** Measured totals of the batches committed in this document, for the observed estimate. */
export interface ObservedTotals { units: number; sourceTokens: number; inputTokens: number; outputTokens: number }
export const emptyObserved = (): ObservedTotals => ({ units: 0, sourceTokens: 0, inputTokens: 0, outputTokens: 0 });

/** Output tokens per source token, by language family. */
function outputFactor(languages: { source: LanguageTag; target: LanguageTag }): number {
  const source = LANGUAGE_INFO[languages.source].family;
  const target = LANGUAGE_INFO[languages.target].family;
  if ((source === 'cjk' || source === 'ko') && target === 'alpha') return 1;
  if (source === 'alpha' && (target === 'cjk' || target === 'ko')) return 1.3;
  return 1.2;
}

export interface EstimateInput {
  /** Source tokens of each segment that would be translated. */
  tokens: readonly number[];
  languages: { source: LanguageTag; target: LanguageTag };
  batchSourceTokens: number;
  maxOutputTokens: number;
  observed: ObservedTotals | null;
}

export function estimate(input: EstimateInput): Estimate {
  const segments = input.tokens.length;
  const sourceTokens = input.tokens.reduce((sum, tokens) => sum + tokens, 0);
  const effectiveBatch = Math.max(1, Math.min(input.batchSourceTokens, Math.floor((OUTPUT_SHARE * input.maxOutputTokens - OUTPUT_BASE) / OUTPUT_PER_SOURCE_TOKEN)));
  const requests = segments ? Math.max(Math.ceil(sourceTokens / effectiveBatch), Math.ceil(segments / LONG_TEXT_LIMITS.batchSegments)) : 0;
  const { observed } = input;
  const range = (center: number, [low, high]: readonly [number, number]): [number, number] => [Math.floor(center * low), Math.ceil(center * high)];
  if (observed && observed.units >= OBSERVED_MIN_UNITS && observed.sourceTokens > 0) {
    return {
      segments, sourceTokens, requests,
      inputTokens: range(sourceTokens * observed.inputTokens / observed.sourceTokens, OBSERVED_RANGE),
      outputTokens: range(sourceTokens * observed.outputTokens / observed.sourceTokens, OBSERVED_RANGE),
      basis: 'observed',
    };
  }
  return {
    segments, sourceTokens, requests,
    inputTokens: range(sourceTokens + requests * ESTIMATE_OVERHEAD_PER_REQUEST, MODEL_RANGE),
    outputTokens: range(sourceTokens * outputFactor(input.languages) + segments * OUTPUT_PER_SEGMENT, MODEL_RANGE),
    basis: 'model',
  };
}

/**
 * The `estimate` command: every pending or failed segment that is not locked (`full`), or the
 * segments a sample run would take (`sample`).
 */
export function estimateDocument(document: DocumentPort, scope: 'full' | 'sample', maxOutputTokens: number, observed: ObservedTotals | null): Estimate {
  const settings = document.settings();
  const tokensOf = (index: number) => document.table.tokens[index];
  let indices: number[];
  if (scope === 'sample') {
    indices = firstUnit(document, {}, unitLimits({ batchSourceTokens: settings.batchSourceTokens, maxOutputTokens, knowledge: false, sample: true }));
  } else {
    indices = document.pagesWithCandidates({}).flatMap(page => document.candidates(page, {}));
  }
  return estimate({
    tokens: indices.map(tokensOf), languages: document.languages(),
    batchSourceTokens: settings.batchSourceTokens, maxOutputTokens, observed,
  });
}
