import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { cleanupWindowsBuildWorkspaces } from './build-addon-windows-x64.mjs';
import { buildTestWindowsX64OverwriteAddon } from './build-test-addon-windows-x64.mjs';

test('a first workspace cleanup failure still joins receipt cleanup and preserves the primary build error', async () => {
  const primary = Object.assign(new Error('Primary compile failure'), { code: 'compile_failed' });
  const cleanup = new Error('First directory is busy');
  const calls = [];
  let releaseReceipt;
  const receipt = new Promise(resolve => { releaseReceipt = resolve; });
  let settled = false;
  const operation = cleanupWindowsBuildWorkspaces(['work', 'receipt'], primary, (directory, options) => {
    calls.push({ directory, options }); if (directory === 'work') throw cleanup; return receipt;
  }).finally(() => { settled = true; });
  const verification = assert.rejects(operation, error => {
    assert.equal(error instanceof AggregateError, true); assert.equal(error.cause, primary); assert.equal(error.code, 'compile_failed');
    assert.deepEqual(error.errors, [primary, cleanup]); return true;
  });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false); assert.deepEqual(calls.map(call => call.directory), ['work', 'receipt']);
  assert.equal(calls.every(call => call.options.maxRetries === 3 && call.options.retryDelay === 20), true);
  releaseReceipt(); await verification;
});

test('successful work reports all cleanup failures instead of skipping later directories', async () => {
  const failures = [new Error('work busy'), new Error('receipt busy')];
  await assert.rejects(cleanupWindowsBuildWorkspaces(['work', 'receipt'], undefined, directory => {
    throw failures[directory === 'work' ? 0 : 1];
  }), error => { assert.equal(error.code, 'build_cleanup_failed'); assert.deepEqual(error.errors, failures); return true; });
  await cleanupWindowsBuildWorkspaces(['work', 'receipt'], new Error('preserved by caller'), async () => {});
});

test('fault-test build rejects receiptPath before invoking the production builder', async () => {
  for (const receiptPath of [undefined, path.resolve('must-not-publish-production-receipt.json')]) {
    let invoked = false;
    await assert.rejects(buildTestWindowsX64OverwriteAddon({ receiptPath, commandRunner() { invoked = true; throw new Error('must not compile'); } }),
      error => error.code === 'invalid_arguments');
    assert.equal(invoked, false);
  }
});
