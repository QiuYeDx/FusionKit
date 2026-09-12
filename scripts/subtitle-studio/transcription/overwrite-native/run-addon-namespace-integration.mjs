#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const identity = file => {
  const stat = lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
};

// New T03 acceptance, rather than source-copy evidence. All old names below
// identify foreign fixtures that must remain untouched; no old addon is loaded.
export function runAddonNamespaceIntegration({ addonPath, tempRoot = os.tmpdir() }) {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  assert.equal(typeof process.versions.electron, 'string', 'Run this acceptance in the actual Electron host');
  assert.equal(path.isAbsolute(addonPath), true);
  const stat = lstatSync(addonPath);
  assert.equal(stat.isFile() && !stat.isSymbolicLink(), true);
  const addon = require(addonPath);
  assert.deepEqual(Reflect.ownKeys(addon).sort(), ['acknowledge', 'architecture', 'begin', 'platform', 'protocolVersion', 'recover']);
  assert.equal(addon.protocolVersion, 4);
  const directoryPath = mkdtempSync(path.join(tempRoot, 'subtitle-studio-namespace-'));
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
    assert.deepEqual(readdirSync(directoryPath).sort(), before);
    assert.equal(readFileSync(path.join(directoryPath, finalLeaf), 'utf8'), 'original');
    const recovery = { directoryPath, expectedDirectoryIdentity: identity(directoryPath), transactionId, decision: 'finalize' };
    assert.deepEqual(addon.recover(recovery), { state: 'not_found' });
    assert.deepEqual(addon.acknowledge(recovery), { state: 'not_found' });
    assert.deepEqual(readdirSync(directoryPath).sort(), before);

    writeFileSync(path.join(directoryPath, partialLeaf), 'studio output', { flag: 'wx' });
    const receipt = addon.begin({ ...request, partialLeaf, expectedPartialIdentity: identity(path.join(directoryPath, partialLeaf)), expectedByteSize: 13 });
    const journalBytes = readFileSync(path.join(directoryPath, journalLeaf));
    renameSync(path.join(directoryPath, journalLeaf), path.join(directoryPath, oldSuffixJournalLeaf));
    assert.deepEqual(addon.recover(recovery), { state: 'not_found' });
    assert.deepEqual(addon.acknowledge(recovery), { state: 'not_found' });
    assert.deepEqual(readFileSync(path.join(directoryPath, oldSuffixJournalLeaf)), journalBytes);
    renameSync(path.join(directoryPath, oldSuffixJournalLeaf), path.join(directoryPath, journalLeaf));
    receipt.finalize();
    receipt.acknowledge();
    assert.equal(readFileSync(path.join(directoryPath, finalLeaf), 'utf8'), 'studio output');
    assert.equal(readFileSync(path.join(directoryPath, foreignPartialLeaf), 'utf8'), 'foreign partial');
    assert.equal(readFileSync(path.join(directoryPath, foreignJournalLeaf), 'utf8'), 'foreign journal');
    assert.deepEqual(readdirSync(directoryPath).sort(), [foreignPartialLeaf, foreignJournalLeaf, finalLeaf].sort());
    return { schemaVersion: 1, status: 'passed', host: { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch },
      cases: ['old-partial-rejected-without-mutation', 'old-prefix-journal-ignored', 'old-suffix-journal-ignored', 'new-journal-finalize-and-acknowledge'],
      productionGateChanged: false, foreignFilesUntouched: true, privatePathsRecorded: false };
  } finally { rmSync(directoryPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { addon: { type: 'string' }, output: { type: 'string' } }, allowPositionals: false, strict: true });
  const report = runAddonNamespaceIntegration({ addonPath: values.addon });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) { assert.equal(path.isAbsolute(values.output), true); writeFileSync(values.output, serialized, { flag: 'wx' }); }
  process.stdout.write(serialized);
}
