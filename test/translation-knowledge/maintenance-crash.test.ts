import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KnowledgeService } from '../../electron/main/translation-knowledge/service';
import { knowledgeFixture } from './fixtures';

let runtimeDirectory: string;
const directories: string[] = [];
const services: KnowledgeService[] = [];

beforeAll(async () => {
  runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'fktk-crash-runtime-'));
  await build({ entryPoints: ['electron/main/translation-knowledge/service.ts'], outfile: path.join(runtimeDirectory, 'service.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  // process.exit deliberately bypasses repository catch/finally cleanup. A thrown
  // publicationHook alone cannot reproduce a file left half-written by a crash.
  await writeFile(path.join(runtimeDirectory, 'crash.mjs'), `
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { KnowledgeService } from './service.mjs';
const [root, entryId, mode, requestFile] = process.argv.slice(2);
let armed = false;
const service = new KnowledgeService(root, { publicationHook(stage) {
  if (armed && ((mode === 'journal_published' && stage === 'purge_journal_synced') || (mode === 'pointer_published' && stage === 'pointer_directory_synced'))) process.exit(77);
} });
const current = await service.read();
const plan = await service.planMaintenance('owner', { generation: current.generation, action: 'purge', targets: [{ group: 'entries', id: entryId }] });
if (!plan.canCommit) throw new Error(JSON.stringify(plan.blockers));
const request = { planId: plan.planId, confirmHistoryRemoval: true };
await fs.writeFile(requestFile, JSON.stringify(request));
const originalOpen = fs.open;
fs.open = async function(file, ...args) {
  const handle = await originalOpen.call(this, file, ...args);
  const name = path.basename(String(file));
  const interrupt = mode === 'journal_partial' ? /^(?:\\.pending-)?purge-/.test(name) : mode === 'generation_partial' && name.startsWith('generation-');
  if (armed && interrupt) handle.writeFile = async function(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    // For generation writes, cut inside a multibyte UTF-8 character when present.
    const unicode = mode === 'generation_partial' ? bytes.findIndex(byte => byte >= 0xc2) : -1;
    await this.write(bytes.subarray(0, unicode >= 0 ? unicode + 1 : 20));
    await this.sync();
    process.exit(77);
  };
  return handle;
};
syncBuiltinESMExports();
armed = true;
await service.commitMaintenance('owner', request);
throw new Error('The selected crash boundary was not reached');
`);
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
afterAll(async () => { if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true }); });

async function seed() {
  const root = await mkdtemp(path.join(tmpdir(), 'fktk-crash-library-')); directories.push(root);
  const service = new KnowledgeService(root); services.push(service);
  const data = knowledgeFixture();
  const plan = await service.planImport('owner', JSON.stringify(data));
  await service.commitImport('owner', { planId: plan.planId, decisions: [], adoptReady: false });
  const state = await service.read();
  const archive = await service.planMaintenance('owner', { generation: state.generation, action: 'archive', targets: [{ group: 'entries', id: data.entries[0].id }] });
  await service.commitMaintenance('owner', { planId: archive.planId });
  const before = await service.read();
  const originalFiles = new Map<string, Buffer>();
  for (const name of await readdir(root)) originalFiles.set(name, await readFile(path.join(root, name)));
  await service.dispose();
  return { root, entryId: data.entries[0].id, before, originalFiles };
}

function crash(root: string, entryId: string, mode: string) {
  const requestFile = path.join(runtimeDirectory, `${randomUUID()}.json`);
  const result = spawnSync(process.execPath, [path.join(runtimeDirectory, 'crash.mjs'), root, entryId, mode, requestFile], { encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(77);
  return requestFile;
}

async function reopen(root: string) {
  const service = new KnowledgeService(root); services.push(service);
  return { service, state: await service.read() };
}

describe('knowledge purge recovery after real process termination', () => {
  it.each(['journal_partial', 'generation_partial'])('keeps the old library usable after %s and can clean the orphan on a later purge', async mode => {
    const { root, entryId, before, originalFiles } = await seed();
    crash(root, entryId, mode);
    expect(await readFile(path.join(root, 'current.json'))).toEqual(originalFiles.get('current.json'));
    const interruptedFiles = await readdir(root);
    expect(interruptedFiles.some(name => name.startsWith('purge-'))).toBe(false);
    if (mode === 'journal_partial') expect(interruptedFiles.some(name => name.startsWith('.pending-purge-'))).toBe(true);
    else {
      const partial = interruptedFiles.find(name => name.startsWith('generation-') && !originalFiles.has(name))!;
      const bytes = await readFile(path.join(root, partial));
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow();
    }
    const { service, state } = await reopen(root);
    expect(state).toEqual(before);
    for (const [name, bytes] of originalFiles) expect(await readFile(path.join(root, name))).toEqual(bytes);
    const purge = await service.planMaintenance('owner', { generation: state.generation, action: 'purge', targets: [{ group: 'entries', id: entryId }] });
    expect(purge.canCommit).toBe(true);
    const receipt = await service.commitMaintenance('owner', { planId: purge.planId, confirmHistoryRemoval: true });
    expect(receipt.cleanupPending).toBe(false);
    const remaining = await readdir(root);
    expect(remaining.filter(name => name.startsWith('generation-'))).toHaveLength(1);
    expect(remaining.some(name => name.startsWith('.pending-') || name.startsWith('purge-'))).toBe(false);
    expect((await service.read()).data.entries.some(entry => entry.id === entryId)).toBe(false);
  });

  it('discards an uncommitted complete journal without deleting prior history', async () => {
    const { root, entryId, before, originalFiles } = await seed();
    crash(root, entryId, 'journal_published');
    expect(await readFile(path.join(root, 'current.json'))).toEqual(originalFiles.get('current.json'));
    expect((await readdir(root)).some(name => name.startsWith('purge-'))).toBe(true);
    const { state } = await reopen(root);
    expect(state).toEqual(before);
    expect((await readdir(root)).sort()).toEqual([...originalFiles.keys()].sort());
    for (const [name, bytes] of originalFiles) expect(await readFile(path.join(root, name))).toEqual(bytes);
  });

  it('finishes a published purge after restart and replays the persisted receipt', async () => {
    const { root, entryId, before, originalFiles } = await seed();
    const requestFile = crash(root, entryId, 'pointer_published');
    const request = JSON.parse(await readFile(requestFile, 'utf8'));
    expect(await readFile(path.join(root, 'current.json'))).not.toEqual(originalFiles.get('current.json'));
    expect((await readdir(root)).some(name => name.startsWith('purge-'))).toBe(true);
    const { service, state } = await reopen(root);
    expect(state.generation).toBe(before.generation + 1);
    expect(state.data.entries).toEqual(before.data.entries.filter(entry => entry.id !== entryId));
    expect(state.maintenance?.cleanupPending).toBe(false);
    const receipt = await service.commitMaintenance('owner', request);
    expect(receipt).toMatchObject({ id: request.planId, action: 'purge', generation: state.generation, cleanupPending: false });
    expect(await service.commitMaintenance('owner', request)).toEqual(receipt);
    expect((await service.read()).generation).toBe(state.generation);
    const files = await readdir(root);
    expect(files.filter(name => name.startsWith('generation-'))).toHaveLength(1);
    expect(files.some(name => name.startsWith('purge-') || name.startsWith('.pending-'))).toBe(false);
    expect(JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8')).previous).toBeUndefined();
  });
});
