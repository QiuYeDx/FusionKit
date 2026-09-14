import { createHash, randomUUID } from 'node:crypto';
import type { ExportCommit, ExportPreview, ExportSelectionRequest } from '../../../src/translation-knowledge/export-contract';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import { KnowledgeServiceError } from './errors';
import { buildExportSelection } from './export-selection';

const PLAN_TTL_MS = 15 * 60 * 1000;
interface FrozenExport { owner: string; expires: number; preview: ExportPreview; text: string }

/** The file confirmed by the native save dialog is exactly the file previewed. */
export class KnowledgeExportPlans {
  private plans = new Map<string, FrozenExport>();
  private ownerRevisions = new Map<string, number>();
  private revision = 0;
  private closed = false;
  constructor(private readonly read: () => Promise<LibrarySnapshot>, private readonly now = Date.now) {}

  async plan(owner: string, request: ExportSelectionRequest, alive: () => void): Promise<ExportPreview> {
    this.assertOpen(); alive(); this.releaseOwner(owner);
    const revision = this.revision;
    const ownerRevision = this.ownerRevisions.get(owner);
    const snapshot = await this.read(); alive(); this.assertOpen();
    if (revision !== this.revision || ownerRevision !== this.ownerRevisions.get(owner)) throw new KnowledgeServiceError('plan_expired');
    if (snapshot.generation !== request.generation) throw new KnowledgeServiceError('revision_conflict');
    if (snapshot.maintenance?.cleanupPending) throw new KnowledgeServiceError('storage_unavailable');
    const result = buildExportSelection(snapshot, request, {
      id: randomUUID(), revision: 1, name: request.purpose === 'backup' ? 'Translation knowledge backup' : 'Translation knowledge selection',
      description: '', purpose: request.purpose, createdAt: new Date(this.now()).toISOString(), generator: { name: 'FusionKit', version: '0.3.1' },
    });
    const text = result.data && !result.preview.errors.length ? `${JSON.stringify(result.data, null, 2)}\n` : '';
    const preview: ExportPreview = { ...result.preview, planId: randomUUID(), generation: snapshot.generation, purpose: request.purpose,
      bytes: Buffer.byteLength(text), digest: text ? createHash('sha256').update(text).digest('hex') : '', canExport: !!text };
    if (preview.bytes > 32 * 1024 * 1024) throw new KnowledgeServiceError('limit_exceeded');
    this.plans.set(preview.planId, { owner, expires: this.now() + PLAN_TTL_MS, preview, text });
    return structuredClone(preview);
  }

  guard(owner: string, planId: string): void {
    this.assertOpen();
    const plan = this.plans.get(planId);
    if (!plan || plan.owner !== owner || plan.expires < this.now()) throw new KnowledgeServiceError('plan_expired');
    if (!plan.preview.canExport) throw new KnowledgeServiceError('invalid_input', plan.preview.errors);
  }

  async prepare(owner: string, request: ExportCommit, alive: () => void): Promise<{ text: string; preview: ExportPreview }> {
    alive(); this.guard(owner, request.planId);
    const plan = this.plans.get(request.planId)!;
    const snapshot = await this.read();
    alive(); this.guard(owner, request.planId);
    if (snapshot.generation !== plan.preview.generation) throw new KnowledgeServiceError('revision_conflict');
    if (snapshot.maintenance?.cleanupPending) throw new KnowledgeServiceError('storage_unavailable');
    return { text: plan.text, preview: structuredClone(plan.preview) };
  }
  releaseOwner(owner: string): void {
    this.ownerRevisions.set(owner, (this.ownerRevisions.get(owner) ?? 0) + 1);
    for (const [id, plan] of this.plans) if (plan.owner === owner) this.plans.delete(id);
  }
  invalidate(): void { this.revision++; this.plans.clear(); }
  dispose(): void { this.closed = true; this.invalidate(); this.ownerRevisions.clear(); }
  private assertOpen(): void { if (this.closed) throw new KnowledgeServiceError('access_denied'); }
}
