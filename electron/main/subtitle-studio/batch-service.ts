import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import type { z } from 'zod';
import { StudioError } from '../../../src/subtitle-studio/domain';
import { batchRequestSchemas, type BatchFailure, type DocumentReference, type TranslationBatchPlan, type TranslationBatchResult, type ExportBatchPlan, type ExportBatchResult, type SourceBatchResult } from '../../../src/subtitle-studio/batch-contract';
import type { ExportOptions, ExportIssueCode, ExportPlanSummary } from '../../../src/subtitle-studio/export-contract';
import type { TranslationConfig } from '../../../src/subtitle-studio/translation-contract';
import type { DocumentRepository } from './document-repository';
import type { TranslationService } from './translation-service';
import { planTranslation } from './translation-planner';
import { planSubtitleExport } from './export-planner';
import { publishBytes, publishSource } from './export-service';

type EntryBase = { owner: number; created: number; executing: boolean };
type TranslationEntry = EntryBase & { kind: 'translation'; config: TranslationConfig; summary: TranslationBatchPlan; documents: DocumentReference[] };
type ExportEntry = EntryBase & { kind: 'export'; summary: ExportBatchPlan; prepared: Map<string, { reference: DocumentReference; options: ExportOptions; digest: string | null }> };
type BatchEntry = TranslationEntry | ExportEntry;
const failure = (documentId: string, displayName: string, error: unknown): BatchFailure => ({ documentId, displayName, ok: false, error: error instanceof StudioError ? error.code : 'document_unavailable' });
const contentDigest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Batch plans retain bounded metadata. Only one document's export bytes exist at a time. */
export class BatchService {
  private plans = new Map<string, BatchEntry>();
  constructor(private repository: DocumentRepository, private translation: TranslationService) {}
  forgetOwner(owner: number) { for (const [id, entry] of this.plans) if (entry.owner === owner) this.plans.delete(id); }
  dispose() { this.plans.clear(); }
  private remember(id: string, entry: BatchEntry) {
    for (const [key, existing] of this.plans) {
      if (Date.now() - existing.created > 15 * 60000 || (existing.owner === entry.owner && existing.kind === entry.kind && !existing.executing)) this.plans.delete(key);
    }
    if (this.plans.size >= 8) throw new StudioError('limit_exceeded');
    this.plans.set(id, entry);
  }
  private resolve(owner: number, batchId: string, kind: BatchEntry['kind']) {
    const entry = this.plans.get(batchId);
    if (!entry || entry.owner !== owner || entry.kind !== kind) throw new StudioError('access_denied');
    if (Date.now() - entry.created > 15 * 60000 || entry.executing) throw new StudioError('revision_conflict');
    return entry;
  }
  async planTranslation(owner: number, input: z.infer<typeof batchRequestSchemas.planTranslationBatch>, guard: () => void = () => {}): Promise<TranslationBatchPlan> {
    const request = batchRequestSchemas.planTranslationBatch.parse(input);
    const summary: TranslationBatchPlan = { batchId: randomUUID(), items: [], totalEstimatedInputTokens: 0, totalOutputTokenReserve: 0 };
    for (const ref of request.documents) {
      let displayName = ref.documentId;
      try {
        const snapshot = await this.repository.readSnapshot(ref.documentId); guard();
        displayName = snapshot.document.origin.displayName;
        if (snapshot.document.revision !== ref.revision || snapshot.tasks.some(task => ['queued', 'running'].includes(task.status))) throw new StudioError('revision_conflict');
        const planned = planTranslation(snapshot.document, request.config);
        const plan = { documentId: ref.documentId, revision: ref.revision, cueCount: planned.batches.reduce((n, batch) => n + batch.units.length, 0), batchCount: planned.batches.length,
          estimatedInputTokens: planned.batches.reduce((n, batch) => n + batch.estimatedInputTokens, 0), outputTokenReserve: planned.batches.length * request.config.maxOutputTokens,
          contextTokenReserve: planned.batches.reduce((n, batch) => n + batch.priorContextReserve, 0) };
        summary.totalEstimatedInputTokens += plan.estimatedInputTokens;
        summary.totalOutputTokenReserve += plan.outputTokenReserve;
        summary.items.push({ documentId: ref.documentId, displayName, ok: true, plan });
      } catch (error) { guard(); summary.items.push(failure(ref.documentId, displayName, error)); }
    }
    guard();
    this.remember(summary.batchId, { owner, kind: 'translation', created: Date.now(), executing: false, config: structuredClone(request.config), documents: request.documents, summary: structuredClone(summary) });
    return summary;
  }
  async createTranslation(owner: number, batchId: string, apiKey: string, guard: () => void = () => {}): Promise<TranslationBatchResult> {
    if (!apiKey.trim() || apiKey.length > 8000) throw new StudioError('needs_configuration');
    const entry = this.resolve(owner, batchId, 'translation') as TranslationEntry;
    entry.executing = true;
    const alive = () => { guard(); if (this.plans.get(batchId) !== entry) throw new StudioError('access_denied'); };
    const result: TranslationBatchResult = { items: [] };
    try {
      for (const item of entry.summary.items) {
        alive();
        if (!item.ok) { result.items.push(item); continue; }
        try {
          const { taskId } = await this.translation.startConfigured(item.documentId, item.plan.revision, entry.config, apiKey, alive);
          result.items.push({ documentId: item.documentId, displayName: item.displayName, ok: true, taskId });
        } catch (error) { alive(); result.items.push(failure(item.documentId, item.displayName, error)); }
      }
      this.plans.delete(batchId);
      return result;
    } finally { entry.executing = false; }
  }
  async planExport(owner: number, input: z.infer<typeof batchRequestSchemas.planExportBatch>, guard: () => void = () => {}): Promise<ExportBatchPlan> {
    const request = batchRequestSchemas.planExportBatch.parse(input);
    const summary: ExportBatchPlan = { batchId: randomUUID(), items: [] };
    const prepared: ExportEntry['prepared'] = new Map();
    for (const ref of request.documents) {
      let displayName = ref.documentId;
      try {
        const doc = await this.repository.read(ref.documentId); guard();
        displayName = doc.origin.displayName;
        if (doc.revision !== ref.revision) throw new StudioError('revision_conflict');
        const options: ExportOptions = { ...request.options, ...(ref.trackId ? { trackId: ref.trackId } : {}) };
        const { bytes, ...metadata } = planSubtitleExport(doc, options);
        const plan: ExportPlanSummary = { ...metadata, planId: null };
        prepared.set(ref.documentId, { reference: { documentId: ref.documentId, revision: ref.revision }, options, digest: bytes ? contentDigest(bytes) : null });
        summary.items.push({ documentId: ref.documentId, displayName, ok: true, plan });
      } catch (error) { guard(); summary.items.push(failure(ref.documentId, displayName, error)); }
    }
    guard();
    this.remember(summary.batchId, { owner, kind: 'export', created: Date.now(), executing: false, summary: structuredClone(summary), prepared });
    return summary;
  }
  inspectExport(owner: number, batchId: string, accepted: { documentId: string; codes: ExportIssueCode[] }[]) {
    const entry = this.resolve(owner, batchId, 'export') as ExportEntry;
    if (new Set(accepted.map(item => item.documentId)).size !== accepted.length || accepted.some(item => !entry.summary.items.some(plan => plan.documentId === item.documentId && plan.ok))) throw new StudioError('invalid_input');
    for (const item of entry.summary.items) {
      if (!item.ok) continue;
      const codes = accepted.find(value => value.documentId === item.documentId)?.codes ?? [];
      const blocked = item.plan.issues.some(issue => issue.blocking);
      if (new Set(codes).size !== codes.length || codes.some(code => !item.plan.issues.some(issue => issue.code === code && issue.confirmation))
        || (!blocked && item.plan.issues.some(issue => issue.confirmation && !codes.includes(issue.code)))) throw new StudioError('invalid_input');
    }
    return structuredClone(entry.summary);
  }
  async export(owner: number, batchId: string, accepted: { documentId: string; codes: ExportIssueCode[] }[], directory: string, guard: () => void = () => {}): Promise<ExportBatchResult> {
    this.inspectExport(owner, batchId, accepted);
    const entry = this.resolve(owner, batchId, 'export') as ExportEntry;
    entry.executing = true;
    const alive = () => { guard(); if (this.plans.get(batchId) !== entry) throw new StudioError('access_denied'); };
    const result: ExportBatchResult = { items: [] };
    try {
      for (const item of entry.summary.items) {
        alive();
        if (!item.ok) { result.items.push(item); continue; }
        try {
          const prepared = entry.prepared.get(item.documentId)!;
          if (!prepared.digest || item.plan.issues.some(issue => issue.blocking)) throw new StudioError('unsupported_feature');
          const doc = await this.repository.read(item.documentId); alive();
          if (doc.revision !== prepared.reference.revision) throw new StudioError('revision_conflict');
          const rebuilt = planSubtitleExport(doc, prepared.options);
          if (!rebuilt.bytes || contentDigest(rebuilt.bytes) !== prepared.digest) throw new StudioError('revision_conflict');
          const output = await publishBytes(rebuilt.bytes, path.join(directory, path.basename(item.plan.fileName)), alive, 'indexed',
            action => this.repository.withDocument(item.documentId, prepared.reference.revision, async () => action()));
          result.items.push({ documentId: item.documentId, displayName: item.displayName, ok: true, result: { fileName: path.basename(output), revision: prepared.reference.revision, partial: item.plan.partial, mode: item.plan.options.mode, incomplete: item.plan.options.incomplete } });
        } catch (error) { alive(); result.items.push(failure(item.documentId, item.displayName, error)); }
      }
      this.plans.delete(batchId);
      return result;
    } finally { entry.executing = false; }
  }
  async exportSources(documents: DocumentReference[], directory: string, guard: () => void = () => {}): Promise<SourceBatchResult> {
    const result: SourceBatchResult = { items: [] };
    for (const ref of documents) {
      let displayName = ref.documentId;
      try {
        const doc = await this.repository.read(ref.documentId); guard(); displayName = doc.origin.displayName;
        if (doc.revision !== ref.revision) throw new StudioError('revision_conflict');
        const output = await this.repository.withDocument(ref.documentId, ref.revision, async () => publishSource(doc, path.join(directory, path.basename(displayName)), guard, 'indexed'));
        result.items.push({ documentId: ref.documentId, displayName, ok: true, fileName: path.basename(output) });
      } catch (error) { guard(); result.items.push(failure(ref.documentId, displayName, error)); }
    }
    return result;
  }
}
