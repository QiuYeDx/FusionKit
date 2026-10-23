import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import { SEGMENT_KINDS, type LanguageTag, type LedgerEntry, type LongTextFormat, type LongTextModel, type LongTextSettings, type RunView } from '../../src/long-text/contract';
import * as inline from '../../src/long-text/inline';
import {
  pendingState, SEGMENT_FLAG, stateOf,
  type CandidateFilter, type DocumentPort, type PageRecord, type RunRecord, type RunScope, type SegmentTable, type TranslationRecord,
  type TranslationState, type UsageDelta,
} from '../../src/long-text/model';
import { RatioReference } from '../../src/long-text/quality';
import { displayAt, segmentDocument } from '../../src/long-text/segments';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult, ModelRuntimeUsage } from '../../electron/main/ai/model-runtime-client';
import { ModelRuntimeClientError, type ModelRuntimeErrorCode, type ModelRuntimeErrorDetails } from '../../electron/main/ai/model-runtime-errors';
import { DocumentLedger } from '../../electron/main/long-text/ledger';
import { emptyObserved } from '../../electron/main/long-text/planner';
import type { BatchPayload } from '../../electron/main/long-text/prompt';
import { RequestPool } from '../../electron/main/long-text/request-pool';
import type { RunHooks, RunnerServices, RunnerTarget } from '../../electron/main/long-text/runner';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';

/** An in-memory `DocumentPort` with the same rules as `LoadedDocument`, plus hooks for tests. */
export class MemoryDocument implements DocumentPort {
  readonly id = randomUUID();
  readonly ratio: RatioReference;
  readonly records: Array<TranslationRecord | undefined>;
  readonly inFlight = new Set<number>();
  readonly ledger: LedgerEntry[] = [];
  /** Every append, in order: the records written and the usage line. */
  readonly appends: Array<{ records: TranslationRecord[]; usage: UsageDelta | null }> = [];
  readonly events: Array<{ start: number; end: number }> = [];
  ledgerSaves = 0;
  /** Makes every following append fail, like a full disk. */
  writeError: Error | null = null;
  current: LongTextSettings;

  constructor(
    readonly format: LongTextFormat,
    readonly source: string,
    readonly table: SegmentTable,
    readonly pages: readonly PageRecord[],
    readonly refs: ReadonlySet<string>,
    settings: Partial<LongTextSettings>,
    private readonly detected: LanguageTag,
  ) {
    this.current = {
      sourceLanguage: 'auto', targetLanguage: 'zh-Hans', style: 'general', instructions: '', knowledge: null, profileId: null,
      pace: 2, batchSourceTokens: 1500, maxOutputTokens: null, ...settings,
    };
    this.records = new Array(table.count);
    this.ratio = new RatioReference(this.languages());
  }

  settings(): LongTextSettings {
    return this.current;
  }

  languages(): { source: LanguageTag; target: LanguageTag } {
    const { sourceLanguage, targetLanguage } = this.current;
    return { source: sourceLanguage === 'auto' ? this.detected : sourceLanguage, target: targetLanguage };
  }

  isTranslatable(index: number): boolean {
    return (this.table.flags[index] & SEGMENT_FLAG.translatable) !== 0;
  }

  /** Translatable segment indices, in order. */
  translatable(): number[] {
    return Array.from({ length: this.table.count }, (_, index) => index).filter(index => this.isTranslatable(index));
  }

  candidates(page: number, filter: CandidateFilter): number[] {
    const { start, end } = this.pages[page];
    const result: number[] = [];
    for (let index = start; index <= end; index++) if (this.isCandidate(index, filter)) result.push(index);
    return result;
  }

  pagesWithCandidates(scope: RunScope): number[] {
    return this.pages.map((_, page) => page).filter(page => this.candidates(page, scope).length > 0);
  }

  markInFlight(indices: readonly number[]): boolean {
    if (indices.some(index => this.inFlight.has(index))) return false;
    for (const index of indices) this.inFlight.add(index);
    return true;
  }

  releaseInFlight(indices: readonly number[]): void {
    for (const index of indices) this.inFlight.delete(index);
  }

  rev(index: number): number {
    return this.records[index]?.rev ?? 0;
  }

  displayAt(index: number): string {
    return displayAt(this.source, this.table, index);
  }

  translationAt(index: number): TranslationRecord | undefined {
    return this.records[index];
  }

  pageOf(index: number): number {
    return this.table.page[index];
  }

  async commit(records: readonly TranslationRecord[], usage: UsageDelta | null, options: { skipLocked: boolean }): Promise<number[]> {
    await Promise.resolve();
    if (this.writeError) throw this.writeError;
    const accepted = records.filter(record => {
      const current = this.records[record.index];
      return this.isTranslatable(record.index) && (current?.rev ?? 0) === record.rev - 1 && !(options.skipLocked && current?.locked);
    });
    this.appends.push({ records: accepted.map(record => structuredClone(record)), usage: usage && structuredClone(usage) });
    for (const record of accepted) this.records[record.index] = record;
    return accepted.map(record => record.index);
  }

  async clear(indices: readonly number[], runId: string | null): Promise<number[]> {
    await Promise.resolve();
    if (this.writeError) throw this.writeError;
    const cleared: number[] = [];
    for (const index of indices) {
      const current = this.records[index];
      if (!current || current.status === 'pending' || current.locked || this.inFlight.has(index)) continue;
      this.records[index] = { index, rev: current.rev + 1, ...PENDING, previous: stateOf(current), runId, at: Date.now() };
      cleared.push(index);
    }
    this.appends.push({ records: cleared.map(index => structuredClone(this.records[index]!)), usage: null });
    return cleared;
  }

  emit(range: { start: number; end: number }): void {
    this.events.push(range);
  }

  async saveLedger(): Promise<void> {
    this.ledgerSaves++;
  }

  /** The user's edit, as `LoadedDocument.edit` stores it (without the in-flight check, to simulate races). */
  edit(index: number, target: string, locked = true): void {
    const current = this.records[index];
    this.records[index] = {
      index, rev: (current?.rev ?? 0) + 1, status: 'done', target, origin: 'user', locked, flags: [], failure: null,
      previous: stateOf(current), runId: null, at: Date.now(),
    };
  }

  /** A model translation committed earlier. */
  translate(index: number, target: string, extra: Partial<TranslationRecord> = {}): void {
    const current = this.records[index];
    this.records[index] = {
      index, rev: (current?.rev ?? 0) + 1, status: 'done', target, origin: 'model', locked: false, flags: [], failure: null,
      previous: stateOf(current), runId: null, at: Date.now(), ...extra,
    };
  }

  /** Usage lines written, summed. */
  usage() {
    const lines = this.appends.flatMap(append => (append.usage ? [append.usage.usage] : []));
    return {
      requests: lines.reduce((sum, usage) => sum + usage.requests, 0),
      failedRequests: lines.reduce((sum, usage) => sum + usage.failedRequests, 0),
      unknownRequests: lines.reduce((sum, usage) => sum + usage.unknownRequests, 0),
      inputTokens: lines.reduce((sum, usage) => sum + usage.inputTokens, 0),
      outputTokens: lines.reduce((sum, usage) => sum + usage.outputTokens, 0),
    };
  }

  status(index: number): TranslationRecord['status'] {
    return this.records[index]?.status ?? 'pending';
  }

  private isCandidate(index: number, filter: CandidateFilter): boolean {
    if (!this.isTranslatable(index) || this.inFlight.has(index)) return false;
    const record = this.records[index];
    if (record && (record.status === 'done' || record.locked)) return false;
    if (filter.minIndex !== undefined && index < filter.minIndex) return false;
    if (filter.sample && !filter.sample.has(index)) return false;
    return !filter.skip?.(index);
  }
}

export const PENDING: TranslationState = pendingState();

export async function memoryDocument(S: string, options: { format?: LongTextFormat; settings?: Partial<LongTextSettings>; source?: LanguageTag } = {}): Promise<MemoryDocument> {
  const format = options.format ?? 'txt';
  const segmented = await segmentDocument(format, S, { txtSplit: 'line', inline });
  return new MemoryDocument(format, S, segmented.table, segmented.pages, new Set(segmented.refs), options.settings ?? {}, options.source ?? 'en');
}

/** `count` lines of English text, one segment each. */
export const storyLines = (count: number, text: (index: number) => string = index => `Line number ${index} of the story.`) =>
  Array.from({ length: count }, (_, index) => text(index)).join('\n');

export const MODEL: LongTextModel = {
  profileId: 'profile', label: 'Test model', modelKey: 'test-model', endpoint: 'https://models.example.com/v1',
  apiFormat: 'chat_completions', contextWindow: 131_072, maxOutputTokens: 8192,
};
export const API_KEY = 'sk-test-secret';

// ---------------------------------------------------------------------------------------------
// A fake model

export interface Call {
  request: ModelRuntimeTextRequest;
  payload: BatchPayload;
  /** Segment indices of the items, in item order. */
  indices: number[];
}
export type Reply = ModelRuntimeTextResult | Error;
export type Responder = (call: Call, document: MemoryDocument) => Reply | Promise<Reply>;

export const USAGE: ModelRuntimeUsage = { inputTokens: 100, outputTokens: 40 };

export function answer(items: Array<{ id: string; text: string }>, extra: { terms?: unknown; finishReason?: string; usage?: ModelRuntimeUsage } = {}): ModelRuntimeTextResult {
  return {
    content: JSON.stringify({ items, terms: extra.terms ?? [] }),
    finishReason: extra.finishReason ?? 'stop',
    usage: extra.usage ?? USAGE,
    apiFormat: 'chat_completions',
  };
}

/** Every item translated as `【译】` + its text, tokens kept. */
export const translateAll = (call: Call) => answer(call.payload.items.map(item => ({ id: item.id, text: `【译】${item.text}` })));

export function modelError(code: ModelRuntimeErrorCode, details: ModelRuntimeErrorDetails = {}): ModelRuntimeClientError {
  return new ModelRuntimeClientError(code, `fake ${code}`, false, details);
}

/**
 * A `send` that answers with `responder`; `delayMs` makes every answer take that long (fake timers).
 * Records every call and the largest number of requests in flight at once.
 */
export function fakeModel(document: MemoryDocument, responder: Responder = translateAll, options: { delayMs?: number } = {}) {
  const byText = new Map<string, number>();
  for (const index of document.translatable()) {
    const text = inline.project(document.displayAt(index), SEGMENT_KINDS[document.table.kind[index]], document.format, { refs: document.refs }).text;
    if (!byText.has(text)) byText.set(text, index);
  }
  let active = 0;
  const model = {
    calls: [] as Call[],
    maxActive: 0,
    send: vi.fn(async (request: ModelRuntimeTextRequest): Promise<ModelRuntimeTextResult> => {
      const payload = JSON.parse(request.messages[1].content) as BatchPayload;
      const call: Call = { request, payload, indices: payload.items.map(item => byText.get(item.text) ?? -1) };
      model.calls.push(call);
      model.maxActive = Math.max(model.maxActive, ++active);
      try {
        if (options.delayMs) await abortableDelay(options.delayMs, request.signal);
        const reply = await responder(call, document);
        if (reply instanceof Error) throw reply;
        return reply;
      } finally {
        active--;
      }
    }),
  };
  return model;
}

/** Waits like a slow provider; rejects as the runtime client does when the request is aborted. */
export function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(modelError('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Wiring

export function runnerSetup(document: MemoryDocument, send: RunnerServices['send'], options: { library?: () => LibrarySnapshot | Promise<LibrarySnapshot>; pool?: RequestPool } = {}) {
  const target: RunnerTarget = { document, ledger: new DocumentLedger(document), observed: emptyObserved() };
  const saved: Array<{ record: RunRecord; start?: { fullRunStarted: boolean; sample: number[] | null } }> = [];
  const views: RunView[] = [];
  const hooks: RunHooks = {
    save: async (record, start) => { saved.push({ record: structuredClone(record), ...(start ? { start } : {}) }); },
    changed: view => views.push(view),
  };
  const services: RunnerServices = {
    send,
    pool: options.pool ?? new RequestPool(),
    readKnowledge: options.library ?? (() => { throw new Error('No library in this test'); }),
    random: () => 0.5,
  };
  return { target, hooks, services, saved, views };
}

/** Advances fake time until `promise` settles. */
export async function settle<T>(promise: Promise<T>, stepMs = 500, maxSteps = 2_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let step = 0; step < maxSteps && !settled; step++) await vi.advanceTimersByTimeAsync(stepMs);
  expect(settled).toBe(true);
  return promise;
}
