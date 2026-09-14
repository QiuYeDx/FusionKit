import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KnowledgeExportPlans } from '../../electron/main/translation-knowledge/export-plans';
import type { ExportSelectionRequest } from '../../src/translation-knowledge/export-contract';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import { knowledgeFixture } from './fixtures';

const snapshot = (): LibrarySnapshot => ({ generation: 2, data: knowledgeFixture(), approvals: {}, imports: [] });
const request = (): ExportSelectionRequest => ({ generation: 2, purpose: 'backup', collectionIds: [], recipeIds: [], includeMemories: true, includeInactive: true, includeUnreviewed: true, excludedSourceIds: [] });
const alive = () => {};

describe('frozen knowledge export plans', () => {
  it('saves exactly the previewed bytes and keeps knowledge identities unchanged', async () => {
    const library = snapshot();
    const manager = new KnowledgeExportPlans(async () => structuredClone(library));
    const preview = await manager.plan('one', request(), alive);
    const first = await manager.prepare('one', { planId: preview.planId }, alive);
    const again = await manager.prepare('one', { planId: preview.planId }, alive);
    expect(first.text).toBe(again.text);
    expect(Buffer.byteLength(first.text)).toBe(preview.bytes);
    expect(createHash('sha256').update(first.text).digest('hex')).toBe(preview.digest);
    expect(JSON.parse(first.text).entries).toEqual(library.data.entries);
    expect(preview.canExport).toBe(true);
    manager.dispose();
  });

  it('rejects another owner, changed generations, released owners and expired plans', async () => {
    const library = snapshot(); let now = Date.now();
    const manager = new KnowledgeExportPlans(async () => structuredClone(library), () => now);
    let preview = await manager.plan('one', request(), alive);
    await expect(manager.prepare('two', { planId: preview.planId }, alive)).rejects.toMatchObject({ code: 'plan_expired' });
    library.generation++;
    await expect(manager.prepare('one', { planId: preview.planId }, alive)).rejects.toMatchObject({ code: 'revision_conflict' });
    library.generation--;
    manager.releaseOwner('one');
    await expect(manager.prepare('one', { planId: preview.planId }, alive)).rejects.toMatchObject({ code: 'plan_expired' });
    preview = await manager.plan('one', request(), alive);
    now += 16 * 60 * 1000;
    await expect(manager.prepare('one', { planId: preview.planId }, alive)).rejects.toMatchObject({ code: 'plan_expired' });
    manager.dispose();
  });

  it('discards an older in-flight preview when selection changes or a write begins', async () => {
    let finish!: (value: LibrarySnapshot) => void;
    let reads = 0;
    const manager = new KnowledgeExportPlans(async () => ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : snapshot());
    const older = manager.plan('one', request(), alive);
    const newer = await manager.plan('one', request(), alive);
    finish(snapshot());
    await expect(older).rejects.toMatchObject({ code: 'plan_expired' });
    expect((await manager.prepare('one', { planId: newer.planId }, alive)).preview.digest).toBe(newer.digest);
    manager.invalidate();
    expect(() => manager.guard('one', newer.planId)).toThrow();
    manager.dispose();
  });

  it('keeps blocked selections reviewable while refusing file publication', async () => {
    const library = snapshot();
    const manager = new KnowledgeExportPlans(async () => library);
    const preview = await manager.plan('one', { ...request(), purpose: 'share', collectionIds: [], recipeIds: [] }, alive);
    expect(preview.canExport).toBe(false);
    expect(preview.errors.length).toBeGreaterThan(0);
    await expect(manager.prepare('one', { planId: preview.planId }, alive)).rejects.toMatchObject({ code: 'invalid_input' });
    manager.dispose();
  });
});
