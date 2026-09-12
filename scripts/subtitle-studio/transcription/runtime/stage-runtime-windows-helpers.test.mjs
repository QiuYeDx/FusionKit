import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertRuntimeOutputMissing, copyRuntimeArtifact, getRuntimeLayout,
  resolveRuntimeOutputParent, verifyStagedCopyMatches, withRuntimePublication } from './stage-runtime-windows-helpers.mjs';
import { stageWindowsX64Runtime } from './stage-runtime-windows-x64.mjs';

const cleanup = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-win-stage-test-'));
  t.after(() => rm(root, cleanup));
  return root;
}
const identity = bytes => ({ byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

test('selects only the new runtime root and canonical Windows layout', () => {
  assert.equal(path.basename(resolveRuntimeOutputParent()), 'subtitle-studio-resources');
  assert.equal(getRuntimeLayout('win32', 'x64').server, 'win-x64/cpu/whisper-server.exe');
  assert.throws(() => getRuntimeLayout('darwin', 'arm64'), /only supports Windows/);
  assert.throws(() => resolveRuntimeOutputParent(''), /non-empty/);
});

test('publishes a private verified directory and releases its lock', async t => {
  const root = await fixture(t);
  const result = await withRuntimePublication(root, async ({ partialRoot, publish }) => {
    assert.match(path.basename(partialRoot), /^transcription\.partial-/);
    await writeFile(path.join(partialRoot, 'manifest.json'), 'verified');
    await publish();
    return 'complete';
  });
  assert.equal(result, 'complete');
  assert.equal(await readFile(path.join(root, 'transcription', 'manifest.json'), 'utf8'), 'verified');
  assert.deepEqual(await readdir(root), ['transcription']);
});

test('rejects an existing final directory before invoking work', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'transcription'));
  await writeFile(path.join(root, 'transcription', 'user.txt'), 'preserve');
  let called = false;
  await assert.rejects(withRuntimePublication(root, async () => { called = true; }), /already exists/);
  assert.equal(called, false);
  assert.equal(await readFile(path.join(root, 'transcription', 'user.txt'), 'utf8'), 'preserve');
});

test('rejects a concurrent publisher while the first owns the lock', async t => {
  const root = await fixture(t);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const first = withRuntimePublication(root, async ({ publish }) => { entered(); await held; await publish(); });
  await started;
  try { await assert.rejects(withRuntimePublication(root, async () => assert.fail('concurrent publisher ran')), /EEXIST/); }
  finally { release(); }
  await first;
  assert.deepEqual(await readdir(root), ['transcription']);
});

test('removes only its partial output after failure and permits a clean retry', async t => {
  const root = await fixture(t), failure = new Error('intentional validation failure');
  await writeFile(path.join(root, 'unrelated.txt'), 'preserve');
  await assert.rejects(withRuntimePublication(root, async ({ partialRoot }) => {
    await writeFile(path.join(partialRoot, 'incomplete'), 'bytes');
    throw failure;
  }), error => error === failure);
  assert.deepEqual(await readdir(root), ['unrelated.txt']);
  await withRuntimePublication(root, async ({ publish }) => { await publish(); });
  assert.equal(await readFile(path.join(root, 'unrelated.txt'), 'utf8'), 'preserve');
});

test('never overwrites a final directory appearing during verification', async t => {
  const root = await fixture(t);
  await assert.rejects(withRuntimePublication(root, async ({ publish }) => {
    await mkdir(path.join(root, 'transcription'));
    await writeFile(path.join(root, 'transcription', 'other'), 'other writer');
    await publish();
  }), /already exists/);
  assert.deepEqual(await readdir(root), ['transcription']);
  assert.equal(await readFile(path.join(root, 'transcription', 'other'), 'utf8'), 'other writer');
});

test('rejects symlink/junction final roots and output ancestors', async t => {
  const root = await fixture(t), outside = await fixture(t);
  await symlink(outside, path.join(root, 'transcription'), 'junction');
  await assert.rejects(assertRuntimeOutputMissing(root), /already exists/);
  await rm(path.join(root, 'transcription'), { force: true });
  await symlink(outside, path.join(root, 'linked-parent'), 'junction');
  await assert.rejects(withRuntimePublication(path.join(root, 'linked-parent'), async () => assert.fail()), /regular directories/);
  assert.deepEqual(await readdir(outside), []);
});

test('copies independent bytes with exclusive leaves and rejects altered or linked output', async t => {
  const root = await fixture(t), bytes = Buffer.from('pinned bytes');
  const input = path.join(root, 'input'), output = path.join(root, 'output');
  await writeFile(input, bytes);
  await copyRuntimeArtifact(input, output);
  await verifyStagedCopyMatches(output, identity(bytes), 'fixture');
  await assert.rejects(copyRuntimeArtifact(input, output), /EEXIST/);
  await writeFile(input, 'source changed');
  assert.equal(await readFile(output, 'utf8'), 'pinned bytes');
  await assert.rejects(verifyStagedCopyMatches(output, identity(Buffer.from('bad')), 'fixture'), /do not match/);
  await link(output, path.join(root, 'hardlink'));
  await assert.rejects(verifyStagedCopyMatches(output, identity(bytes), 'fixture'), /do not match/);
});

test('rejects a tampered release archive before creating output', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async t => {
  const root = await fixture(t), archive = path.join(root, 'tampered.zip');
  await writeFile(archive, 'not the pinned official archive');
  const outputParent = path.join(root, 'staging');
  await assert.rejects(stageWindowsX64Runtime({ outputParent, whisperArchivePath: archive,
    whisperRoot: root, ffmpegRoot: root, ffmpegAuditReceiptPath: path.join(root, 'unread.json') }), /pinned integrity/);
  await assert.rejects(readdir(outputParent), /ENOENT/);
});

test('an operation must explicitly publish before it can report success', async t => {
  const root = await fixture(t);
  await assert.rejects(withRuntimePublication(root, async () => 'premature'), /did not publish/);
  assert.deepEqual(await readdir(root), []);
});
