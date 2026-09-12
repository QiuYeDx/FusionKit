import { access, link, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import iconv from 'iconv-lite';
import { LIMITS, StudioError, validateDocument, type SubtitleDocument } from '../../../src/subtitle-studio/domain';
import { exportOptionsSchema, type ExportIssueCode, type ExportOptions, type ExportPlanSummary, type ExportResult } from '../../../src/subtitle-studio/export-contract';
import type { DocumentRepository } from './document-repository';
import { planSubtitleExport } from './export-planner';
import { SourceLocationService } from './source-location-service';
import { localSubtitleFilesystemObjectIdentityForHandle, localSubtitleFilesystemObjectIdentityForPath, sameLocalSubtitleFilesystemObjectIdentity,
  type LocalSubtitleFilesystemObjectIdentity } from './transcription/native/filesystem-object-identity';

export function sourceBytes(value: SubtitleDocument): Buffer {
  const doc = validateDocument(value);
  if (doc.schemaVersion === 2) throw new StudioError('unsupported_feature');
  return iconv.encode(doc.preservation.rawText, doc.origin.encoding, { addBOM: doc.preservation.bom });
}

export async function unusedOutputPath(directory: string, displayName: string): Promise<string> {
  const name = path.parse(path.basename(displayName));
  for (let index = 0; index < 10000; index++) {
    const candidate = path.join(directory, `${name.name}${index ? ` (${index})` : ''}${name.ext}`);
    try { await access(candidate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate; throw error; }
  }
  throw new StudioError('output_write_failed');
}

type PublishPolicy = 'replace' | 'indexed';
export async function publishBytes(bytes: Buffer, authorizedPath: string, beforePublish: () => void | Promise<void> = () => {}, policy: PublishPolicy = 'replace', commit: (action: () => Promise<string>) => Promise<string> = action => action()): Promise<string> {
  if (bytes.byteLength > LIMITS.snapshotBytes) throw new StudioError('limit_exceeded');
  const temporary = path.join(path.dirname(authorizedPath), `.subtitle-studio-${randomUUID()}.tmp`);
  let identity: LocalSubtitleFilesystemObjectIdentity | undefined;
  try {
    await beforePublish();
    const handle = await open(temporary, 'wx+', 0o600);
    try {
      identity = await localSubtitleFilesystemObjectIdentityForHandle(handle);
      await beforePublish();
      await handle.writeFile(bytes); await handle.sync();
      if ((await handle.stat()).size !== bytes.byteLength) throw new StudioError('output_write_failed');
      const checked = Buffer.alloc(Math.min(65536, bytes.byteLength));
      for (let offset = 0; offset < bytes.byteLength;) {
        const { bytesRead } = await handle.read(checked, 0, Math.min(checked.byteLength, bytes.byteLength - offset), offset);
        if (!bytesRead || !checked.subarray(0, bytesRead).equals(bytes.subarray(offset, offset + bytesRead))) throw new StudioError('output_write_failed');
        offset += bytesRead;
      }
    }
    finally { await handle.close(); }
    return await commit(async () => {
      await beforePublish();
      if (!identity || !sameLocalSubtitleFilesystemObjectIdentity(identity, await localSubtitleFilesystemObjectIdentityForPath(temporary))) throw new StudioError('output_write_failed');
      if (policy === 'replace') { await rename(temporary, authorizedPath); return authorizedPath; }
      const name = path.parse(authorizedPath);
      for (let index = 0; index < 10000; index++) {
        const candidate = path.join(name.dir, `${name.name}${index ? ` (${index})` : ''}${name.ext}`);
        await beforePublish();
        try { await link(temporary, candidate); return candidate; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      throw new StudioError('output_write_failed');
    });
  } catch (error) { throw error instanceof StudioError ? error : new StudioError('output_write_failed'); }
  finally {
    if (identity) try {
      if (sameLocalSubtitleFilesystemObjectIdentity(identity, await localSubtitleFilesystemObjectIdentityForPath(temporary))) await rm(temporary, { force: true });
    } catch { /* Never remove a replaced or unavailable temporary path. */ }
  }
}

export async function publishSource(doc: SubtitleDocument, authorizedPath: string, beforePublish: () => void = () => {}, policy: PublishPolicy = 'replace') {
  return publishBytes(sourceBytes(doc), authorizedPath, beforePublish, policy);
}

type CachedExport = { owner: number; created: number; summary: ExportPlanSummary; bytes: Buffer; publishing: boolean; sourceBindingId?: string };
export class ExportService {
  private plans = new Map<string, CachedExport>();
  private readonly sources: SourceLocationService;
  constructor(private readonly repository: DocumentRepository) { this.sources = new SourceLocationService(repository); }
  forgetOwner(owner: number) { for (const [id, plan] of this.plans) if (plan.owner === owner) this.plans.delete(id); }
  dispose() { this.plans.clear(); }
  private prune() { for (const [id, plan] of this.plans) if (Date.now() - plan.created > 15 * 60000) this.plans.delete(id); }
  async plan(owner: number, documentId: string, revision: number, options: ExportOptions, guard: () => void = () => {}): Promise<ExportPlanSummary> {
    const parsed = exportOptionsSchema.safeParse(options);
    if (!parsed.success) throw new StudioError('invalid_input');
    const doc = await this.repository.read(documentId); guard();
    if (doc.revision !== revision) throw new StudioError('revision_conflict');
    const { bytes, ...metadata } = planSubtitleExport(doc, parsed.data);
    const location = await this.sources.inspect(documentId, guard); guard();
    const summary = { ...metadata, sourceLocation: location.summary };
    this.prune(); this.forgetOwner(owner);
    if (!bytes || summary.issues.some(issue => issue.blocking)) return { ...summary, planId: null };
    if (this.plans.size >= 8 || [...this.plans.values()].reduce((total, entry) => total + entry.bytes.byteLength, bytes.byteLength) > LIMITS.snapshotBytes) throw new StudioError('limit_exceeded');
    const planId = randomUUID();
    const result = { ...summary, planId };
    this.plans.set(planId, { owner, created: Date.now(), summary: structuredClone(result), bytes: Buffer.from(bytes), publishing: false, sourceBindingId: location.bindingId });
    return result;
  }
  inspect(owner: number, documentId: string, revision: number, planId: string, acceptedLosses: ExportIssueCode[]): ExportPlanSummary {
    return structuredClone(this.resolve(owner, documentId, revision, planId, acceptedLosses).summary);
  }
  private resolve(owner: number, documentId: string, revision: number, planId: string, acceptedLosses: ExportIssueCode[]) {
    const plan = this.plans.get(planId);
    if (!plan || plan.owner !== owner || plan.summary.documentId !== documentId) throw new StudioError('access_denied');
    if (Date.now() - plan.created > 15 * 60000 || plan.summary.revision !== revision) throw new StudioError('revision_conflict');
    if (new Set(acceptedLosses).size !== acceptedLosses.length || acceptedLosses.some(code => !plan.summary.issues.some(issue => issue.code === code && issue.confirmation))
      || plan.summary.issues.some(issue => issue.blocking || (issue.confirmation && !acceptedLosses.includes(issue.code)))) throw new StudioError('invalid_input');
    return plan;
  }
  async publish(owner: number, documentId: string, revision: number, planId: string, acceptedLosses: ExportIssueCode[], authorizedPath: string, guard: () => void = () => {}, policy: PublishPolicy = 'replace'): Promise<ExportResult> {
    const plan = this.resolve(owner, documentId, revision, planId, acceptedLosses);
    if (plan.publishing) throw new StudioError('revision_conflict');
    plan.publishing = true;
    const alive = () => { guard(); if (this.plans.get(planId) !== plan) throw new StudioError('access_denied'); };
    try {
      alive();
      const output = await publishBytes(plan.bytes, authorizedPath, alive, policy, action => this.repository.withExistingDocument(documentId, action));
      this.plans.delete(planId);
      return { fileName: path.basename(output), revision, partial: plan.summary.partial, mode: plan.summary.options.mode, incomplete: plan.summary.options.incomplete };
    } finally { plan.publishing = false; }
  }
  async publishToSource(owner: number, documentId: string, revision: number, planId: string, acceptedLosses: ExportIssueCode[], guard: () => void = () => {}): Promise<ExportResult> {
    const plan = this.resolve(owner, documentId, revision, planId, acceptedLosses);
    if (plan.publishing) throw new StudioError('revision_conflict');
    plan.publishing = true;
    const alive = () => { guard(); if (this.plans.get(planId) !== plan) throw new StudioError('access_denied'); };
    try {
      const output = await this.sources.publish(documentId, plan.sourceBindingId,
        (directory, verify) => publishBytes(plan.bytes, path.join(directory, plan.summary.fileName), verify, 'indexed'), alive);
      this.plans.delete(planId);
      return { fileName: path.basename(output), revision, partial: plan.summary.partial, mode: plan.summary.options.mode, incomplete: plan.summary.options.incomplete };
    } finally { plan.publishing = false; }
  }
  async exportOriginalToSource(documentId: string, revision: number, guard: () => void = () => {}) {
    const doc = await this.repository.read(documentId); guard();
    if (doc.revision !== revision) throw new StudioError('revision_conflict');
    const location = await this.sources.inspect(documentId, guard);
    const output = await this.sources.publish(documentId, location.bindingId,
      (directory, verify) => publishBytes(sourceBytes(doc), path.join(directory, path.basename(doc.origin.displayName)), verify, 'indexed'), guard, revision);
    return { fileName: path.basename(output) };
  }
}
