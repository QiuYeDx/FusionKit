import { z } from 'zod';
import { executionRefSchema, idSchema, LIMITS, StudioError, type ExecutionRef } from './domain';
import { translationConfigSchema, translationModelSchema } from './translation-contract';
import { validateTranslationResponse } from './translation-protocol';
import { sha256Canonical } from '../translation-knowledge/canonicalize';
import { frozenKnowledgeSnapshotSchema, validateFrozenKnowledgeSnapshot } from '../translation-knowledge/snapshot-contract';

export { executionRefSchema, type ExecutionRef };
export const EXECUTION_RECORD_LIMITS = { aggregateBytes: 32 * 1024 * 1024, records: 1000 } as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const batchId = z.string().min(1).max(100);
const text = z.string().max(EXECUTION_RECORD_LIMITS.aggregateBytes);
const message = z.object({ role: z.enum(['system', 'user', 'assistant']), content: text }).strict();
const messages = z.array(message).min(1).max(100);
const protectedMark = z.object({ id: z.number().int().min(1).max(512), mark: z.enum(['b', 'i', 'u']), parentId: z.number().int().min(1).max(512).nullable() }).strict();
const unit = z.object({
  id: z.string().min(1).max(100), cueId: idSchema, sourceRevision: integer.positive(), sourceHash: digest,
  text: z.string().min(1).max(LIMITS.cueBytes + 512 * 16), protectedMarks: z.array(protectedMark).max(512),
}).strict();
export const frozenTranslationPlanSchema = z.object({
  config: translationConfigSchema, documentId: idSchema, revision: integer.positive(),
  batches: z.array(z.object({
    id: batchId, units: z.array(unit).min(1).max(100),
    before: z.array(z.string().max(LIMITS.cueBytes)).max(2), after: z.array(z.string().max(LIMITS.cueBytes)).max(2),
    estimatedInputTokens: integer, priorContextReserve: integer,
  }).strict()).min(1).max(LIMITS.cues),
}).strict();
export type FrozenTranslationPlan = z.infer<typeof frozenTranslationPlanSchema>;

/** Explicit persistent subset. API keys, signals, proxies and arbitrary headers are forbidden. */
export const frozenModelRuntimeRequestSchema = z.object({
  model: translationModelSchema, messages,
  temperature: z.number().finite().optional(), maxOutputTokens: integer.positive().optional(), maxResponseBytes: integer.positive().optional(),
  responseFormat: z.enum(['text', 'json_object']).optional(), timeoutMs: integer.positive().optional(),
  retry: z.object({ maxRetries: integer.max(10).optional(), baseDelayMs: integer.optional(), maxDelayMs: integer.optional(), jitterRatio: z.number().min(0).max(1).optional() }).strict().optional(),
}).strict();
export type FrozenModelRuntimeRequest = z.infer<typeof frozenModelRuntimeRequestSchema>;
const chatBody = z.object({
  model: z.string().min(1).max(200), messages, temperature: z.number().finite().optional(),
  max_tokens: integer.positive().optional(), max_completion_tokens: integer.positive().optional(),
  thinking: z.object({ type: z.enum(['enabled', 'disabled']) }).strict().optional(),
  response_format: z.object({ type: z.literal('json_object') }).strict().optional(),
}).strict();
const responsesBody = z.object({
  model: z.string().min(1).max(200), store: z.literal(false), instructions: text.optional(),
  input: z.union([text, z.array(z.object({ role: z.enum(['user', 'assistant']), content: text }).strict()).max(100)]),
  temperature: z.number().finite().optional(), max_output_tokens: integer.positive().optional(),
  text: z.object({ format: z.object({ type: z.literal('json_object') }).strict() }).strict().optional(),
}).strict();
const httpBody = text.refine(value => {
  try { return z.union([chatBody, responsesBody]).safeParse(JSON.parse(value)).success; } catch { return false; }
});
export const frozenExecutionRequestSchema = z.object({
  version: z.literal(1), batchId, createdAt: z.string().datetime(), request: frozenModelRuntimeRequestSchema,
  httpBody, digest,
}).strict();
export type FrozenExecutionRequest = z.infer<typeof frozenExecutionRequestSchema>;
export const executionRecordSchema = z.object({
  version: z.literal(1), id: idSchema, documentId: idSchema, taskId: idSchema, trackId: idSchema,
  createdAt: z.string().datetime(), sourceDigest: digest, configDigest: digest, policyVersion: z.string().min(1).max(300),
  plan: frozenTranslationPlanSchema, baseRequests: z.record(batchId, frozenExecutionRequestSchema), requests: z.record(batchId, frozenExecutionRequestSchema),
  knowledge: frozenKnowledgeSnapshotSchema.optional(),
}).strict();
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;
/** Readable document generations retain incompatible/corrupt records for explicit recovery errors.
 * New and changed records are strictly validated by the repository mutation boundary. */
export const executionRecordsSchema = z.record(idSchema, z.unknown()).refine(records => Object.keys(records).length <= EXECUTION_RECORD_LIMITS.records);

// Match JSON persistence for absent optional properties; never hash a runtime request.
const persisted = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
/** Stable across request additions: the public track reference identifies the frozen base. */
export function recordBaseDigest(record: Omit<ExecutionRecord, 'requests'> | ExecutionRecord): string {
  const { requests: _requests, ...base } = record as ExecutionRecord;
  return sha256Canonical(persisted(base));
}
/** Binds the exact HTTP body string, including whitespace, and all persistent request settings. */
export function executionRequestDigest(request: Omit<FrozenExecutionRequest, 'digest'> | FrozenExecutionRequest): string {
  const { digest: _digest, ...base } = request as FrozenExecutionRequest;
  return sha256Canonical(persisted(base));
}
export function assertExecutionRecordsSize(records: unknown): void {
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(records)).byteLength; }
  catch { throw new StudioError('invalid_input'); }
  if (bytes > EXECUTION_RECORD_LIMITS.aggregateBytes) throw new StudioError('limit_exceeded');
}

/** Semantic checks run at trace/recovery/admission, not while selecting a document generation.
 * A missing or mismatched record must never silently select an older document commit. */
export function validateExecutionRecord(value: unknown, expected?: { ref?: ExecutionRef; documentId?: string; taskId?: string; trackId?: string }): ExecutionRecord {
  assertExecutionRecordsSize(value);
  const parsed = executionRecordSchema.safeParse(value);
  if (!parsed.success) throw new StudioError('invalid_input');
  const record = parsed.data;
  if (record.documentId !== record.plan.documentId || record.configDigest !== sha256Canonical(persisted(record.plan.config))
    || expected?.documentId !== undefined && record.documentId !== expected.documentId
    || expected?.taskId !== undefined && record.taskId !== expected.taskId
    || expected?.trackId !== undefined && record.trackId !== expected.trackId
    || expected?.ref && (expected.ref.version !== 1 || expected.ref.id !== record.id || expected.ref.digest !== recordBaseDigest(record))) throw new StudioError('invalid_input');
  const batches = new Set<string>(), units = new Set<string>(), cues = new Set<string>();
  for (const batch of record.plan.batches) {
    if (batches.has(batch.id)) throw new StudioError('invalid_input');
    batches.add(batch.id);
    for (const item of batch.units) {
      if (units.has(item.id) || cues.has(item.cueId)) throw new StudioError('invalid_input');
      units.add(item.id); cues.add(item.cueId);
      if (new Set(item.protectedMarks.map(mark => mark.id)).size !== item.protectedMarks.length) throw new StudioError('invalid_input');
    }
    try { validateTranslationResponse(JSON.stringify({ items: batch.units.map(item => ({ id: item.id, text: item.text })) }), batch.units, EXECUTION_RECORD_LIMITS.aggregateBytes); }
    catch { throw new StudioError('invalid_input'); }
  }
  if (cues.size > LIMITS.cues) throw new StudioError('invalid_input');
  if (record.knowledge) {
    try { validateFrozenKnowledgeSnapshot(record.knowledge); } catch { throw new StudioError('invalid_input'); }
    if (record.policyVersion !== 'studio-knowledge-translation/1;request-body/1'
      || Object.keys(record.knowledge.batches).length !== batches.size
      || [...record.knowledge.selection.bindings, ...record.knowledge.selection.confirmations].some(binding => binding.cueIds.some(id => !cues.has(id)))) throw new StudioError('invalid_input');
    for (const batch of record.plan.batches) {
      const compiled = record.knowledge.batches[batch.id], batchCues = new Set(batch.units.map(unit => unit.cueId));
      if (!compiled || compiled.items.some(item => item.applicableCueIds.some(id => !batchCues.has(id))
        || item.matches.some(match => !batchCues.has(match.cueId)))
        || compiled.issues.some(issue => issue.cueIds.some(id => !batchCues.has(id)))) throw new StudioError('invalid_input');
    }
  } else if (record.policyVersion === 'studio-knowledge-translation/1;request-body/1') throw new StudioError('invalid_input');
  if (Object.keys(record.baseRequests).length !== batches.size) throw new StudioError('invalid_input');
  for (const [id, request] of [...Object.entries(record.baseRequests), ...Object.entries(record.requests)]) {
    if (!batches.has(id) || id !== request.batchId || request.digest !== executionRequestDigest(request)
      || sha256Canonical(persisted(request.request.model)) !== sha256Canonical(persisted(record.plan.config.model))) throw new StudioError('invalid_input');
    const body = JSON.parse(request.httpBody);
    if (body.model !== request.request.model.modelKey || !(request.request.model.apiFormat === 'responses' ? responsesBody : chatBody).safeParse(body).success) throw new StudioError('invalid_input');
  }
  return record;
}
