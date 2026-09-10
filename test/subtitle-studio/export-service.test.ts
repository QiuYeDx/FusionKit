import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '../../src/subtitle-studio/domain';
import type { ExportIssueCode, ExportOptions, ExportPlanSummary } from '../../src/subtitle-studio/export-contract';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';

const filesystem = vi.hoisted(() => ({
  fail: null as 'write' | 'sync' | 'rename' | 'verify' | null,
  afterSync: undefined as (() => void | Promise<void>) | undefined,
  removed: [] as string[],
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const temporary = (name: unknown) => /(?:^|[\\/])\.subtitle-studio-[^\\/]+\.tmp$/.test(String(name));
  const failure = () => Object.assign(new Error('synthetic locked output'), { code: 'EACCES' });
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!temporary(args[0])) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'writeFile') return async (...input: Parameters<typeof handle.writeFile>) => {
            if (filesystem.fail === 'write') {
              await target.writeFile('partial temporary data');
              throw failure();
            }
            if (filesystem.fail === 'verify') return target.writeFile(Buffer.alloc(Buffer.byteLength(input[0] as Uint8Array), 0));
            return target.writeFile(...input);
          };
          if (property === 'sync') return async () => {
            if (filesystem.fail === 'sync') throw failure();
            await target.sync();
            await filesystem.afterSync?.();
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (temporary(args[0]) && filesystem.fail === 'rename') throw failure();
      return actual.rename(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      filesystem.removed.push(String(args[0]));
      return actual.rm(...args);
    },
  };
});
import { ExportService, publishBytes, publishSource, sourceBytes, unusedOutputPath } from '../../electron/main/subtitle-studio/export-service';

const roots: string[] = [];
const options = (overrides: Partial<ExportOptions> = {}): ExportOptions => ({
  mode: 'source', format: 'srt', order: 'source-first', encoding: 'utf-8', bom: false,
  newline: 'lf', incomplete: 'block', missingEnd: { mode: 'block' }, ...overrides,
});
const parse = (raw: string, format: 'srt' | 'lrc' = 'srt') => importSubtitleText(raw, {
  format, displayName: `synthetic-source.${format}`, encoding: 'utf-8', digest: createHash('sha256').update(raw).digest('hex'),
}, randomUUID);
const raw = '1\n00:00:01,000 --> 00:00:02,000\nFirst source\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond source\n';
const accepted = (plan: ExportPlanSummary): ExportIssueCode[] => plan.issues.filter(issue => issue.confirmation).map(issue => issue.code);
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-export-service-'));
  roots.push(root);
  return root;
}
async function fixture(content = raw, format: 'srt' | 'lrc' = 'srt') {
  const root = await directory();
  const repository = new DocumentRepository(path.join(root, 'documents'));
  const imported = parse(content, format);
  const source = path.join(root, imported.origin.displayName);
  await writeFile(source, content);
  await repository.create(imported);
  const trackId = randomUUID();
  const translated = await repository.transact(imported.id, imported.revision, snapshot => {
    snapshot.document.translationTracks.push({ id: trackId, language: 'zh', revision: 1, origin: 'ai', entries: Object.fromEntries(snapshot.document.cues.map((cue, index) => {
      const text = `Frozen target ${index + 1}`;
      return [cue.id, { sourceRevision: cue.sourceRevision, sourceHash: createHash('sha256').update(JSON.stringify(cue.source)).digest('hex'), text: { plain: text, spans: [{ text, marks: [] }] }, origin: 'ai', reviewStatus: 'unreviewed' }];
    })) });
  });
  return { root, source, repository, doc: translated.document, trackId, service: new ExportService(repository) };
}
async function noOwnedTemporary(root: string) {
  expect((await readdir(root)).filter(name => /^\.subtitle-studio-.*\.tmp$/.test(name))).toEqual([]);
}

afterEach(async () => {
  filesystem.fail = null;
  filesystem.afterSync = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  filesystem.removed.length = 0;
});

describe('frozen export plans and owner authority', () => {
  it('publishes only the chosen revision after a newer translation commits', async () => {
    const current = await fixture();
    const plan = await current.service.plan(7, current.doc.id, current.doc.revision, options({ mode: 'target', trackId: current.trackId }));
    expect(plan.planId).toBeTypeOf('string');
    const updated = await current.repository.transact(current.doc.id, current.doc.revision, snapshot => {
      const track = snapshot.document.translationTracks[0];
      for (const entry of Object.values(track.entries)) entry.text = { plain: 'Newer committed result', spans: [{ text: 'Newer committed result', marks: [] }] };
      track.revision++;
    });
    const target = path.join(current.root, 'chosen-revision.srt');
    const result = await current.service.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), target);
    expect(result).toMatchObject({ revision: plan.revision, fileName: 'chosen-revision.srt', mode: 'target', incomplete: 'block', partial: false });
    expect(parse(await readFile(target, 'utf8')).cues.map(cue => cue.source.plain)).toEqual(['Frozen target 1', 'Frozen target 2']);
    expect(await current.repository.readSnapshot(current.doc.id)).toEqual(updated);
    expect(await readFile(current.source, 'utf8')).toBe(raw);
    await noOwnedTemporary(current.root);
  });

  it('does not let caller mutation of options or a plan summary change the frozen output', async () => {
    const current = await fixture();
    const request = options({ mode: 'target', trackId: current.trackId });
    const plan = await current.service.plan(7, current.doc.id, current.doc.revision, request);
    const losses = accepted(plan);
    request.mode = 'source'; request.format = 'lrc'; request.missingEnd = { mode: 'next-start', finalDurationMs: 1 };
    plan.options.mode = 'source'; plan.preview = 'forged preview'; plan.issues.length = 0;
    const target = path.join(current.root, 'frozen.srt');
    await current.service.publish(7, current.doc.id, plan.revision, plan.planId!, losses, target);
    expect(parse(await readFile(target, 'utf8')).cues.map(cue => cue.source.plain)).toEqual(['Frozen target 1', 'Frozen target 2']);
  });

  it('rejects stale planning revisions and mismatched publication identities before writing', async () => {
    const current = await fixture();
    const target = path.join(current.root, 'unchanged.srt');
    await writeFile(target, 'existing output');
    await expect(current.service.plan(7, current.doc.id, current.doc.revision - 1, options())).rejects.toThrow('revision_conflict');
    const plan = await current.service.plan(7, current.doc.id, current.doc.revision, options());
    for (const [owner, documentId, revision] of [[8, current.doc.id, plan.revision], [7, randomUUID(), plan.revision], [7, current.doc.id, plan.revision + 1]] as const) {
      await expect(current.service.publish(owner, documentId, revision, plan.planId!, accepted(plan), target)).rejects.toThrow();
      expect(await readFile(target, 'utf8')).toBe('existing output');
    }
    await noOwnedTemporary(current.root);
  });

  it('invalidates a previous plan for the same owner and revokes plans on owner removal', async () => {
    const current = await fixture();
    const first = await current.service.plan(7, current.doc.id, current.doc.revision, options());
    const second = await current.service.plan(7, current.doc.id, current.doc.revision, options({ mode: 'target', trackId: current.trackId }));
    const target = path.join(current.root, 'not-created.srt');
    await expect(current.service.publish(7, current.doc.id, first.revision, first.planId!, accepted(first), target)).rejects.toThrow();
    current.service.forgetOwner(7);
    await expect(current.service.publish(7, current.doc.id, second.revision, second.planId!, accepted(second), target)).rejects.toThrow();
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await noOwnedTemporary(current.root);
  });

  it('rejects an expired plan without touching an existing destination', async () => {
    const current = await fixture();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const plan = await current.service.plan(7, current.doc.id, current.doc.revision, options());
    const target = path.join(current.root, 'expired.srt');
    await writeFile(target, 'previous output');
    vi.spyOn(Date, 'now').mockReturnValue(now + 15 * 60000 + 1);
    await expect(current.service.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), target)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('previous output');
    await noOwnedTemporary(current.root);
  });

  it('refuses a frozen export after document deletion and preserves source and previous export', async () => {
    const current = await fixture();
    const plan = await current.service.plan(7, current.doc.id, current.doc.revision, options());
    const target = path.join(current.root, 'previous.srt');
    await writeFile(target, 'previous output');
    await current.repository.delete(current.doc.id, current.doc.revision);
    await expect(current.service.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), target)).rejects.toThrow('document_unavailable');
    expect(await readFile(target, 'utf8')).toBe('previous output');
    expect(await readFile(current.source, 'utf8')).toBe(raw);
    await noOwnedTemporary(current.root);
  });

  it('allows document deletion while writing a temporary export and rejects its final publication', async () => {
    const current = await fixture();
    const plan = await current.service.plan(7, current.doc.id, current.doc.revision, options());
    const target = path.join(current.root, 'deleted-during-write.srt');
    await writeFile(target, 'previous output');
    let deleted = false;
    filesystem.afterSync = async () => {
      await current.repository.delete(current.doc.id, current.doc.revision);
      deleted = true;
    };
    await expect(current.service.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), target)).rejects.toThrow('document_unavailable');
    expect(deleted).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('previous output');
    expect(await readFile(current.source, 'utf8')).toBe(raw);
    await noOwnedTemporary(current.root);
  });

  it('requires explicit acceptance of the frozen loss report before publication', async () => {
    const current = await fixture(raw.replace('First source', '<b>First source</b>'));
    const before = await current.repository.readSnapshot(current.doc.id);
    const plan = await current.service.plan(7, current.doc.id, current.doc.revision, options({ format: 'lrc' }));
    expect(plan.planId).toBeTypeOf('string');
    expect(accepted(plan)).toContain('styles_removed');
    const target = path.join(current.root, 'plain.lrc');
    await writeFile(target, 'previous output');
    await expect(current.service.publish(7, current.doc.id, plan.revision, plan.planId!, [], target)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('previous output');
    await current.service.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), target);
    expect(parse(await readFile(target, 'utf8'), 'lrc').cues.map(cue => cue.source.plain)).toEqual(['First source', 'Second source']);
    expect(await current.repository.readSnapshot(current.doc.id)).toEqual(before);
  });

  it('checks owner authority again after bytes are synced and before replacing the destination', async () => {
    const current = await fixture();
    const plan = await current.service.plan(7, current.doc.id, current.doc.revision, options());
    const target = path.join(current.root, 'revoked.srt');
    await writeFile(target, 'previous output');
    let alive = true;
    filesystem.afterSync = () => { alive = false; current.service.forgetOwner(7); };
    await expect(current.service.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), target, () => {
      if (!alive) throw new StudioError('access_denied');
    })).rejects.toThrow('access_denied');
    expect(await readFile(target, 'utf8')).toBe('previous output');
    expect(await readFile(current.source, 'utf8')).toBe(raw);
    await noOwnedTemporary(current.root);
  });

  it('does not write export plans or paths into the persistent document', async () => {
    const current = await fixture();
    const before = await current.repository.readSnapshot(current.doc.id);
    const plan = await current.service.plan(7, current.doc.id, current.doc.revision, options());
    expect(await current.repository.readSnapshot(current.doc.id)).toEqual(before);
    const target = path.join(current.root, 'private-destination.srt');
    await current.service.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), target);
    expect(await current.repository.readSnapshot(current.doc.id)).toEqual(before);
    const documentDirectory = path.join(current.root, 'documents', current.doc.id);
    for (const name of await readdir(documentDirectory)) {
      const persisted = await readFile(path.join(documentDirectory, name), 'utf8');
      expect(persisted).not.toContain(plan.planId);
      expect(persisted).not.toContain(target);
    }
  });

  it('consumes a successfully published plan and keeps a failed publication retryable', async () => {
    const current = await fixture();
    const plan = await current.service.plan(7, current.doc.id, current.doc.revision, options());
    const target = path.join(current.root, 'retry.srt');
    await writeFile(target, 'previous output');
    filesystem.fail = 'rename';
    await expect(current.service.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), target)).rejects.toThrow('output_write_failed');
    expect(await readFile(target, 'utf8')).toBe('previous output');
    filesystem.fail = null;
    await current.service.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), target);
    const saved = await readFile(target);
    await expect(current.service.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), target)).rejects.toThrow();
    expect(await readFile(target)).toEqual(saved);
    await noOwnedTemporary(current.root);
  });

  it('publishes concurrent indexed exports to distinct files without replacing a competing file', async () => {
    const current = await fixture();
    const sourcePlan = await current.service.plan(7, current.doc.id, current.doc.revision, options());
    const targetPlan = await current.service.plan(8, current.doc.id, current.doc.revision, options({ mode: 'target', trackId: current.trackId }));
    const destination = path.join(current.root, 'same-name.srt');
    // Another writer occupies the path after the native dialog suggested it.
    await writeFile(destination, 'competing existing output');
    const results = await Promise.all([
      current.service.publish(7, current.doc.id, sourcePlan.revision, sourcePlan.planId!, accepted(sourcePlan), destination, undefined, 'indexed'),
      current.service.publish(8, current.doc.id, targetPlan.revision, targetPlan.planId!, accepted(targetPlan), destination, undefined, 'indexed'),
    ]);
    expect(new Set(results.map(result => result.fileName))).toEqual(new Set(['same-name (1).srt', 'same-name (2).srt']));
    expect(await readFile(destination, 'utf8')).toBe('competing existing output');
    for (const result of results) {
      const body = parse(await readFile(path.join(current.root, result.fileName), 'utf8')).cues.map(cue => cue.source.plain);
      expect(body).toEqual(result.mode === 'source' ? ['First source', 'Second source'] : ['Frozen target 1', 'Frozen target 2']);
    }
    await noOwnedTemporary(current.root);
  });

  it('rejects concurrent reuse of the same frozen plan', async () => {
    const current = await fixture();
    const plan = await current.service.plan(7, current.doc.id, current.doc.revision, options());
    const first = path.join(current.root, 'first.srt');
    const second = path.join(current.root, 'second.srt');
    const results = await Promise.allSettled([
      current.service.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), first),
      current.service.publish(7, current.doc.id, plan.revision, plan.planId!, accepted(plan), second),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(parse(await readFile(first, 'utf8')).cues).toHaveLength(2);
    await expect(readFile(second)).rejects.toMatchObject({ code: 'ENOENT' });
    await noOwnedTemporary(current.root);
  });
});

describe('native-authorized export publication', () => {
  it.each(['write', 'sync', 'rename', 'verify'] as const)('preserves an existing output after %s failure and removes only its temporary file', async failure => {
    const root = await directory();
    const target = path.join(root, 'existing.srt');
    const unrelated = path.join(root, '.subtitle-studio-unrelated.tmp');
    await writeFile(target, 'previous complete output');
    await writeFile(unrelated, 'another operation owns this');
    filesystem.removed.length = 0;
    filesystem.fail = failure;
    await expect(publishBytes(Buffer.from('replacement output'), target)).rejects.toThrow('output_write_failed');
    expect(await readFile(target, 'utf8')).toBe('previous complete output');
    expect(await readFile(unrelated, 'utf8')).toBe('another operation owns this');
    expect(filesystem.removed).not.toContain(target);
    expect(filesystem.removed).not.toContain(unrelated);
    expect((await readdir(root)).sort()).toEqual(['.subtitle-studio-unrelated.tmp', 'existing.srt']);
  });

  it.each(['write', 'sync', 'rename', 'verify'] as const)('does not publish a partial new output after %s failure', async failure => {
    const root = await directory();
    const target = path.join(root, 'new.srt');
    filesystem.fail = failure;
    await expect(publishBytes(Buffer.from('new output'), target)).rejects.toThrow('output_write_failed');
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual([]);
  });

  it('replaces an explicitly selected output in one publication and never deletes the old target first', async () => {
    const root = await directory();
    const target = path.join(root, 'selected.srt');
    await writeFile(target, 'previous output');
    filesystem.removed.length = 0;
    let previousAtPublish = '';
    await publishBytes(Buffer.from('new complete output'), target, () => {
      expect(filesystem.removed).not.toContain(target);
      previousAtPublish = 'guard reached';
    });
    expect(previousAtPublish).toBe('guard reached');
    expect(await readFile(target, 'utf8')).toBe('new complete output');
    expect(filesystem.removed).not.toContain(target);
    await noOwnedTemporary(root);
  });

  it('preserves original byte downloads and offers indexed names without reserving or replacing files', async () => {
    const root = await directory();
    const original = parse('7\r\n00:00:01,000 --> 00:00:02,000\r\n<b>Original</b>\r\n旧译文\r\n');
    original.preservation.bom = true;
    const first = path.join(root, 'subtitle.srt');
    const second = path.join(root, 'subtitle (1).srt');
    await writeFile(first, 'first existing file');
    await writeFile(second, 'second existing file');
    const proposed = await unusedOutputPath(root, '../subtitle.srt');
    expect(proposed).toBe(path.join(root, 'subtitle (2).srt'));
    await expect(readFile(proposed)).rejects.toMatchObject({ code: 'ENOENT' });
    await publishSource(original, proposed);
    expect(await readFile(proposed)).toEqual(sourceBytes(original));
    expect(await readFile(first, 'utf8')).toBe('first existing file');
    expect(await readFile(second, 'utf8')).toBe('second existing file');
    await noOwnedTemporary(root);
  });
});
