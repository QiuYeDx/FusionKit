#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const identity = file => {
  const proof = lstatSync(file, { bigint: true });
  assert.equal(proof.isSymbolicLink(), false);
  const volumeSerialHex = proof.dev.toString(16).padStart(8, '0');
  const fileIdHex = proof.ino.toString(16).padStart(32, '0');
  assert.match(volumeSerialHex, /^[a-f0-9]{8}$/); assert.match(fileIdHex, /^[a-f0-9]{32}$/);
  return { volumeSerialHex, fileIdHex };
};

/** New T07 acceptance. Foreign names are rejection fixtures; the old addon is never loaded. */
export function runWindowsAddonNamespaceIntegration({ addonPath, tempRoot = os.tmpdir() }) {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  assert.equal(typeof process.versions.electron, 'string', 'Use the actual Electron host with ELECTRON_RUN_AS_NODE=1');
  assert.equal(path.isAbsolute(addonPath), true);
  const proof = lstatSync(addonPath); assert.equal(proof.isFile() && !proof.isSymbolicLink(), true);
  const bytes = readFileSync(addonPath), addon = require(addonPath);
  assert.deepEqual(Reflect.ownKeys(addon).sort(), ['acknowledge', 'architecture', 'begin', 'platform', 'protocolVersion', 'recover']);
  assert.equal(addon.protocolVersion, 4); assert.equal(addon.platform, 'win32'); assert.equal(addon.architecture, 'x64');
  const directoryPath = realpathSync.native(mkdtempSync(path.join(tempRoot, 'studio-windows-namespace-')));
  try {
    const transactionId = 'studio-namespace-fixture';
    const partialLeaf = `.fusionkit-subtitle-studio-${transactionId}.partial`;
    const foreignPartialLeaf = `.fusionkit-local-subtitle-${transactionId}.partial`;
    const foreignJournalLeaf = `${foreignPartialLeaf}.fusionkit-overwrite.open`;
    const oldSuffixJournalLeaf = `${partialLeaf}.fusionkit-overwrite.open`;
    const journalLeaf = `${partialLeaf}.fusionkit-subtitle-studio-overwrite.open`;
    const finalLeaf = 'result.srt';
    writeFileSync(path.join(directoryPath, foreignPartialLeaf), 'foreign partial', { flag: 'wx' });
    writeFileSync(path.join(directoryPath, foreignJournalLeaf), 'foreign journal', { flag: 'wx' });
    writeFileSync(path.join(directoryPath, finalLeaf), 'original', { flag: 'wx' });
    const request = { directoryPath, expectedDirectoryIdentity: identity(directoryPath), transactionId, partialLeaf: foreignPartialLeaf,
      finalLeaf, expectedPartialIdentity: identity(path.join(directoryPath, foreignPartialLeaf)), expectedByteSize: 15 };
    const before = readdirSync(directoryPath).sort();
    assert.throws(() => addon.begin(request), { code: 'ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST' });
    assert.deepEqual(readdirSync(directoryPath).sort(), before); assert.equal(readFileSync(path.join(directoryPath, finalLeaf), 'utf8'), 'original');
    const recovery = { directoryPath, expectedDirectoryIdentity: identity(directoryPath), transactionId, decision: 'finalize' };
    assert.deepEqual(addon.recover(recovery), { state: 'not_found' }); assert.deepEqual(addon.acknowledge(recovery), { state: 'not_found' });
    assert.deepEqual(readdirSync(directoryPath).sort(), before);
    writeFileSync(path.join(directoryPath, partialLeaf), 'studio output', { flag: 'wx' });
    const receipt = addon.begin({ ...request, partialLeaf, expectedPartialIdentity: identity(path.join(directoryPath, partialLeaf)), expectedByteSize: 13 });
    const journalBytes = readFileSync(path.join(directoryPath, journalLeaf));
    renameSync(path.join(directoryPath, journalLeaf), path.join(directoryPath, oldSuffixJournalLeaf));
    assert.deepEqual(addon.recover(recovery), { state: 'not_found' }); assert.deepEqual(addon.acknowledge(recovery), { state: 'not_found' });
    assert.deepEqual(readFileSync(path.join(directoryPath, oldSuffixJournalLeaf)), journalBytes);
    renameSync(path.join(directoryPath, oldSuffixJournalLeaf), path.join(directoryPath, journalLeaf));
    receipt.finalize(); receipt.acknowledge();
    assert.equal(readFileSync(path.join(directoryPath, finalLeaf), 'utf8'), 'studio output');
    assert.equal(readFileSync(path.join(directoryPath, foreignPartialLeaf), 'utf8'), 'foreign partial');
    assert.equal(readFileSync(path.join(directoryPath, foreignJournalLeaf), 'utf8'), 'foreign journal');
    assert.deepEqual(readdirSync(directoryPath).sort(), [foreignPartialLeaf, foreignJournalLeaf, finalLeaf].sort());
  } finally {
    const relative = path.relative(realpathSync.native(tempRoot), directoryPath);
    assert.equal(!relative || relative.startsWith('..') || path.isAbsolute(relative), false);
    rmSync(directoryPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
  assert.equal(existsSync(directoryPath), false);
  return { schemaVersion: 1, status: 'passed', host: { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch },
    addonSha256: createHash('sha256').update(bytes).digest('hex'),
    cases: ['old-partial-rejected-without-mutation', 'old-prefix-journal-ignored', 'old-suffix-journal-ignored', 'new-journal-finalize-and-acknowledge'],
    productionGateChanged: false, powerLossSafetyClaimed: false, foreignFilesUntouched: true, temporaryDirectoryRemoved: true, privatePathsRecorded: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { addon: { type: 'string' }, output: { type: 'string' }, 'temp-root': { type: 'string' } }, allowPositionals: false, strict: true });
  const report = runWindowsAddonNamespaceIntegration({ addonPath: values.addon, tempRoot: values['temp-root'] });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) { assert.equal(path.isAbsolute(values.output), true); writeFileSync(values.output, serialized, { flag: 'wx' }); }
  process.stdout.write(serialized);
}
