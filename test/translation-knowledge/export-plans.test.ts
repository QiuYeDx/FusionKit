import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KnowledgeExportPlans } from '../../electron/main/translation-knowledge/export-plans';
import type { ExportSelectionRequest } from '../../src/translation-knowledge/export-contract';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import { validatePackage } from '../../src/translation-knowledge/validation';
import { knowledgeFixture } from './fixtures';

const snapshot = (): LibrarySnapshot => ({ generation: 2, data: knowledgeFixture() });
const [game, common] = knowledgeFixture().collections;
const request = (overrides: Partial<ExportSelectionRequest> = {}): ExportSelectionRequest => ({ generation: 2, collectionIds: [game.id], includeDisabled: false, includePresets: false, ...overrides });
const alive = () => {};

describe('knowledge export', () => {
  it('exports the selected collections with their enabled entries as a valid v2 file', async () => {
    const library = snapshot();
    const manager = new KnowledgeExportPlans(async () => structuredClone(library));
    const preview = await manager.plan('one', request({ collectionIds: [game.id, common.id] }), alive);
    const { text } = await manager.prepare('one', { planId: preview.planId }, alive);
    const data = JSON.parse(text);
    expect(validatePackage(data).valid).toBe(true);
    expect(data.collections.map((item: { id: string }) => item.id)).toEqual([game.id, common.id]);
    expect(data.entries).toEqual(library.data.entries.filter(entry => [game.id, common.id].includes(entry.collectionId) && entry.enabled));
    expect(data.presets).toEqual([]);
    expect(data.package.name).toBe('Translation knowledge');
    expect(preview.counts).toEqual({ collections: 2, entries: data.entries.length, presets: 0 });
    expect(preview.warnings).toEqual([]);
    manager.dispose();
  });

  it('includes disabled entries and presets that only use exported collections when asked', async () => {
    const library = snapshot();
    const manager = new KnowledgeExportPlans(async () => structuredClone(library));
    const single = JSON.parse((await manager.prepare('one', { planId: (await manager.plan('one', request({ includeDisabled: true, includePresets: true }), alive)).planId }, alive)).text);
    expect(single.package.name).toBe(game.name);
    expect(single.entries.some((entry: { enabled: boolean }) => !entry.enabled)).toBe(true);
    expect(single.presets).toEqual([]);
    const both = JSON.parse((await manager.prepare('one', { planId: (await manager.plan('one', request({ collectionIds: [game.id, common.id], includePresets: true }), alive)).planId }, alive)).text);
    expect(both.presets).toEqual(library.data.presets);
    manager.dispose();
  });

  it('warns about local paths and credential-like text without blocking the export', async () => {
    const library = snapshot();
    const entry = library.data.entries.find(item => item.collectionId === game.id && item.kind === 'term')!;
    if (entry.kind === 'term') entry.payload.note = 'See C:\\Users\\me\\notes.txt and ?api_key=secret';
    const manager = new KnowledgeExportPlans(async () => structuredClone(library));
    const preview = await manager.plan('one', request(), alive);
    expect(preview.warnings).toEqual([expect.objectContaining({ code: 'EXPORT_PRIVATE_CONTENT', path: expect.stringMatching(/^\/entries\/\d+\/payload\/note$/) })]);
    await expect(manager.prepare('one', { planId: preview.planId }, alive)).resolves.toMatchObject({ preview: { planId: preview.planId } });
    manager.dispose();
  });

  it('saves exactly the previewed bytes', async () => {
    const manager = new KnowledgeExportPlans(async () => snapshot());
    const preview = await manager.plan('one', request(), alive);
    const first = await manager.prepare('one', { planId: preview.planId }, alive);
    const again = await manager.prepare('one', { planId: preview.planId }, alive);
    expect(first.text).toBe(again.text);
    expect(Buffer.byteLength(first.text)).toBe(preview.bytes);
    expect(createHash('sha256').update(first.text).digest('hex')).toBe(preview.digest);
    manager.dispose();
  });

  it('rejects empty, duplicate and unknown selections', async () => {
    const manager = new KnowledgeExportPlans(async () => snapshot());
    await expect(manager.plan('one', request({ collectionIds: [] }), alive)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(manager.plan('one', request({ collectionIds: [game.id, game.id] }), alive)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(manager.plan('one', request({ collectionIds: ['30000000-0000-4000-8000-0000000000ff'] }), alive)).rejects.toMatchObject({ code: 'not_found' });
    await expect(manager.plan('one', request({ generation: 1 }), alive)).rejects.toMatchObject({ code: 'revision_conflict' });
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
});
