import { randomUUID } from 'node:crypto';
import { encode } from 'gpt-tokenizer';
import { StudioError, type ExecutionRef } from '../../../src/subtitle-studio/domain';
import {
  executionRequestDigest, frozenModelRuntimeRequestSchema, recordBaseDigest, validateExecutionRecord,
  type ExecutionRecord, type FrozenExecutionRequest, type FrozenModelRuntimeRequest,
} from '../../../src/subtitle-studio/execution-record-contract';
import type { DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';
import { sha256Canonical } from '../../../src/translation-knowledge/canonicalize';
import type { ModelRuntimeTextRequest } from '../ai/model-runtime-client';
import { buildTranslationRequest, requestTokenEstimate, serializeTranslationRequest, type TranslationPlan } from './translation-planner';

/** Keep this implementation for old records when introducing a new prompt/context policy. */
export const EXECUTION_POLICY_VERSION = 'studio-translation/2;request-body/1';
const canonical = (value: unknown) => sha256Canonical(JSON.parse(JSON.stringify(value)));

function recordOperation<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof StudioError && error.code === 'limit_exceeded') throw error;
    throw new StudioError('translation_record_unavailable');
  }
}

function persistentRequest(request: ModelRuntimeTextRequest): FrozenModelRuntimeRequest {
  const { apiKey: _apiKey, ...model } = request.model;
  const { signal: _signal, proxy: _proxy, ...rest } = request;
  return frozenModelRuntimeRequestSchema.parse({ ...rest, model });
}

export function freezeExecutionRequest(batchId: string, request: ModelRuntimeTextRequest): FrozenExecutionRequest {
  const base = { version: 1 as const, batchId, createdAt: new Date().toISOString(), request: persistentRequest(request), httpBody: serializeTranslationRequest(request) };
  return { ...base, digest: executionRequestDigest(base) };
}

/** The returned ref binds the complete admission plan and every static request template. */
export function createExecutionRecord(plan: TranslationPlan, sourceDigest: string, taskId: string, trackId: string): { record: ExecutionRecord; ref: ExecutionRef } {
  const record: ExecutionRecord = {
    version: 1, id: randomUUID(), documentId: plan.documentId, taskId, trackId,
    createdAt: new Date().toISOString(), sourceDigest, configDigest: canonical(plan.config), policyVersion: EXECUTION_POLICY_VERSION,
    plan: structuredClone(plan), baseRequests: Object.fromEntries(plan.batches.map(batch => [batch.id, freezeExecutionRequest(batch.id, buildTranslationRequest(plan.config, batch))])), requests: {},
  };
  const ref: ExecutionRef = { version: 1, id: record.id, digest: recordBaseDigest(record) };
  const validated = validateExecutionRecord(record, { ref });
  validateExecutionPlan(validated);
  return { record: validated, ref };
}

/** Refuse serializer drift before any provider call, including an unstarted batch's base. */
export function runtimeExecutionRequest(frozen: FrozenExecutionRequest, apiKey = '', signal?: AbortSignal): ModelRuntimeTextRequest {
  return recordOperation(() => {
    if (frozen.digest !== executionRequestDigest(frozen)) throw new StudioError('invalid_input');
    const request: ModelRuntimeTextRequest = { ...structuredClone(frozen.request), model: { ...frozen.request.model, apiKey }, ...(signal ? { signal } : {}) };
    if (serializeTranslationRequest(request) !== frozen.httpBody) throw new StudioError('translation_record_unavailable');
    return request;
  });
}

function basePayload(record: ExecutionRecord, batchId: string) {
  const batch = record.plan.batches.find(item => item.id === batchId);
  const base = record.baseRequests[batchId];
  if (!batch || !base || base.request.messages.length !== 2 || base.request.messages[0].role !== 'system' || base.request.messages[1].role !== 'user') throw new StudioError('invalid_input');
  let payload: { targetLanguage: string; translationRequirements: string; context: { precedingSource: string[]; followingSource: string[]; priorModelTranslations: string[] }; items: { id: string; text: string }[] };
  try { payload = JSON.parse(base.request.messages[1].content); } catch { throw new StudioError('invalid_input'); }
  const expected = { targetLanguage: record.plan.config.language, translationRequirements: record.plan.config.instructions,
    context: { precedingSource: batch.before, followingSource: batch.after, priorModelTranslations: [] }, items: batch.units.map(unit => ({ id: unit.id, text: unit.text })) };
  if (canonical(payload) !== canonical(expected) || base.request.maxOutputTokens !== record.plan.config.maxOutputTokens || base.request.responseFormat !== 'json_object'
    || base.request.retry?.maxRetries !== 0) throw new StudioError('invalid_input');
  return { batch, base, payload };
}

export function resolveExecutionRecord(snapshot: DocumentSnapshot, taskId: string): ExecutionRecord {
  return recordOperation(() => {
    const task = snapshot.tasks.find(item => item.id === taskId);
    const checkpoint = task?.translation?.checkpoint;
    const track = snapshot.document.translationTracks.find(item => item.id === task?.trackId);
    if (!task || checkpoint?.version !== 2 || !track?.executionRef || canonical(track.executionRef) !== canonical(checkpoint.executionRef)) throw new StudioError('invalid_input');
    const record = validateExecutionRecord(snapshot.executionRecords?.[checkpoint.executionRef.id], { ref: checkpoint.executionRef, documentId: snapshot.document.id, taskId, trackId: track.id });
    if (record.policyVersion !== EXECUTION_POLICY_VERSION) throw new StudioError('translation_record_unavailable');
    if (record.sourceDigest !== checkpoint.sourceDigest || canonical(record.plan.config) !== canonical(task.translation!.config)) throw new StudioError('invalid_input');
    return record;
  });
}

function validateExecutionBatch(record: ExecutionRecord, batchId: string) {
  const { base, batch } = basePayload(record, batchId);
  const request = runtimeExecutionRequest(base);
  if (requestTokenEstimate(request) > batch.estimatedInputTokens || batch.estimatedInputTokens + record.plan.config.maxOutputTokens > record.plan.config.contextWindow) throw new StudioError('limit_exceeded');
  const actual = record.requests[batch.id];
  if (actual) {
    const runtime = runtimeExecutionRequest(actual);
    if (requestTokenEstimate(runtime) > batch.estimatedInputTokens) throw new StudioError('limit_exceeded');
    let payload: ReturnType<typeof basePayload>['payload'];
    try { payload = JSON.parse(runtime.messages[1]?.content); } catch { throw new StudioError('invalid_input'); }
    if (!payload?.context || !Array.isArray(payload.context.priorModelTranslations) || payload.context.priorModelTranslations.length > 2 || payload.context.priorModelTranslations.some(text => typeof text !== 'string')) throw new StudioError('invalid_input');
    payload.context.priorModelTranslations = [];
    runtime.messages[1].content = JSON.stringify(payload);
    if (canonical(persistentRequest(runtime)) !== canonical(base.request)) throw new StudioError('invalid_input');
  }
}

/** Full request/token validation is performed once at admission/recovery, not per commit. */
export function validateExecutionPlan(record: ExecutionRecord): void {
  recordOperation(() => {
    if (record.policyVersion !== EXECUTION_POLICY_VERSION) throw new StudioError('translation_record_unavailable');
    for (const batch of record.plan.batches) validateExecutionBatch(record, batch.id);
  });
}

/** v2 only changes the prior output field; it never calls the current prompt builder. */
export function requestForExecution(record: ExecutionRecord, batchId: string, previous: string[]): FrozenExecutionRequest {
  return recordOperation(() => {
    if (record.policyVersion !== EXECUTION_POLICY_VERSION) throw new StudioError('translation_record_unavailable');
    validateExecutionBatch(record, batchId);
    const saved = record.requests[batchId];
    if (saved) { runtimeExecutionRequest(saved); return saved; }
    const { batch, base, payload } = basePayload(record, batchId);
    const request = runtimeExecutionRequest(base);
    const prior = payload.context.priorModelTranslations;
    for (const text of previous.slice(-2)) {
      if (encode(JSON.stringify([...prior, text])).length > batch.priorContextReserve) break;
      prior.push(text);
    }
    request.messages[1].content = JSON.stringify(payload);
    while (prior.length && requestTokenEstimate(request) > batch.estimatedInputTokens) {
      prior.pop(); request.messages[1].content = JSON.stringify(payload);
    }
    if (requestTokenEstimate(request) > batch.estimatedInputTokens || requestTokenEstimate(request) + record.plan.config.maxOutputTokens > record.plan.config.contextWindow) throw new StudioError('limit_exceeded');
    return freezeExecutionRequest(batchId, request);
  });
}
