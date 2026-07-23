#!/usr/bin/env node

import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const GENERIC_JOURNAL_POINT = "journal_after_unlink_before_sync";
const ROLLBACK_OPEN_LAYOUT_POINTS = new Set([
  "rollback_after_intent_sync",
  "rollback_before_namespace",
]);
const ROLLBACK_PARTIAL_CLEANUP_POINTS = new Set([
  "rollback_after_namespace_sync",
  "rollback_before_cleanup_unlink",
]);
const ROLLBACK_COMPLETE_LAYOUT_POINTS = new Set([
  "rollback_after_cleanup_sync",
  "rollback_before_journal_remove",
  GENERIC_JOURNAL_POINT,
]);

function readInput() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  assert.ok(input && typeof input === "object");
  assert.equal(typeof input.action, "string");
  assert.equal(typeof input.addonPath, "string");
  if (input.action === "recover") {
    assert.ok(
      input.recoveryRequest && typeof input.recoveryRequest === "object",
    );
  } else {
    assert.ok(input.request && typeof input.request === "object");
  }
  if (input.victimExisted) {
    assert.ok(input.victimIdentity && typeof input.victimIdentity === "object");
  }
  return input;
}

function assertTestAddon(addon) {
  assert.deepEqual(Reflect.ownKeys(addon).sort(), [
    "architecture",
    "begin",
    "platform",
    "protocolVersion",
    "recover",
    "testFaultInjection",
  ]);
  assert.equal(addon.protocolVersion, 3);
  assert.equal(addon.platform, "darwin");
  assert.equal(addon.architecture, "arm64");
  assert.equal(addon.testFaultInjection, true);
  assert.equal(typeof addon.begin, "function");
  assert.equal(typeof addon.recover, "function");
}

function assertConfiguredFault(input, action) {
  assert.equal(process.env.FUSIONKIT_OVERWRITE_TEST_FAULT_ACTION, action);
  assert.equal(
    process.env.FUSIONKIT_OVERWRITE_TEST_FAULT_POINT,
    input.faultPoint,
  );
}

function clearConfiguredFault() {
  delete process.env.FUSIONKIT_OVERWRITE_TEST_FAULT_ACTION;
  delete process.env.FUSIONKIT_OVERWRITE_TEST_FAULT_POINT;
}

function run() {
  const input = readInput();
  const addon = require(input.addonPath);
  assertTestAddon(addon);

  if (input.action === "begin-crash") {
    assertConfiguredFault(input, "exit");
    addon.begin(input.request);
    throw new Error("begin crash checkpoint did not terminate the process");
  }

  if (input.action === "rollback-crash") {
    assertConfiguredFault(input, "exit");
    const receipt = addon.begin(input.request);
    receipt.rollback();
    throw new Error("rollback crash checkpoint did not terminate the process");
  }

  if (input.action === "recover") {
    const result = addon.recover(input.recoveryRequest);
    assert.deepEqual(Reflect.ownKeys(result), ["state"]);
    assert.ok(
      ["decision_required", "rolled_back", "not_found"].includes(result.state),
    );
    process.stdout.write(`${JSON.stringify({ state: result.state })}\n`);
    return;
  }

  if (input.action === "rollback-error-retry") {
    assertConfiguredFault(input, "error");
    const receipt = addon.begin(input.request);
    const firstError = invokeAndCapture(() => receipt.rollback());
    assert.equal(
      firstError?.code,
      "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
    );
    const journalState = assertRollbackIntermediate(input);
    const oppositeTerminalError = invokeAndCapture(() => receipt.finalize());
    assert.equal(
      oppositeTerminalError?.code,
      "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_STATE",
    );
    clearConfiguredFault();
    assert.equal(receipt.rollback(), undefined);
    writeResult({
      firstAction: "error",
      firstErrorCode: firstError.code,
      intermediateLayoutVerified: true,
      journalStateBeforeRetry: journalState,
      oppositeTerminalRejected: true,
      sameReceiptRetried: true,
      retryCompleted: true,
    });
    return;
  }

  if (input.action === "finalize-error-retry") {
    assertConfiguredFault(input, "error");
    const receipt = addon.begin(input.request);
    const firstError = invokeAndCapture(() => receipt.finalize());
    assert.equal(
      firstError?.code,
      "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
    );
    const intermediate = assertFinalizeIntermediate(input);
    let oppositeTerminalRejected = null;
    if (intermediate.cleanupEntered) {
      const oppositeTerminalError = invokeAndCapture(() => receipt.rollback());
      assert.equal(
        oppositeTerminalError?.code,
        "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_STATE",
      );
      oppositeTerminalRejected = true;
    }
    clearConfiguredFault();
    assert.equal(receipt.finalize(), undefined);
    writeResult({
      firstAction: "error",
      firstErrorCode: firstError.code,
      intermediateLayoutVerified: true,
      journalStateBeforeRetry: intermediate.journalState,
      cleanupEntered: intermediate.cleanupEntered,
      oppositeTerminalRejected,
      sameReceiptRetried: true,
      retryCompleted: true,
    });
    return;
  }

  if (input.action === "finalize-unreachable-point") {
    assertConfiguredFault(input, "error");
    const receipt = addon.begin(input.request);
    assert.equal(receipt.finalize(), undefined);
    clearConfiguredFault();
    writeResult({
      configuredAction: "error",
      faultPointReached: false,
      finalizeCompleted: true,
    });
    return;
  }

  throw new Error("unsupported recovery child action");
}

function assertRollbackIntermediate(input) {
  if (ROLLBACK_OPEN_LAYOUT_POINTS.has(input.faultPoint)) {
    assertInstalledLayout(input);
  } else if (ROLLBACK_PARTIAL_CLEANUP_POINTS.has(input.faultPoint)) {
    assertPriorFinalState(input);
    assertExactFile(
      leafPath(input, input.request.partialLeaf),
      input.request.expectedPartialIdentity,
      input.request.expectedByteSize,
    );
  } else if (ROLLBACK_COMPLETE_LAYOUT_POINTS.has(input.faultPoint)) {
    assertPriorFinalState(input);
    assertAbsent(leafPath(input, input.request.partialLeaf));
  } else {
    throw new Error("unsupported rollback fault point");
  }
  const journalState = input.faultPoint === GENERIC_JOURNAL_POINT
    ? "absent"
    : "rollback";
  assertJournalState(input, journalState);
  return journalState;
}

function assertFinalizeIntermediate(input) {
  if (input.faultPoint === "finalize_before_namespace") {
    assertInstalledLayout(input);
    assertJournalState(input, "open");
    return { cleanupEntered: false, journalState: "open" };
  }
  if (input.faultPoint === "finalize_after_namespace_sync") {
    assert.equal(input.victimExisted, true);
    assertFinalizedLayout(input);
    assertJournalState(input, "open");
    return { cleanupEntered: true, journalState: "open" };
  }
  if (input.faultPoint === GENERIC_JOURNAL_POINT) {
    assertFinalizedLayout(input);
    assertJournalState(input, "absent");
    return { cleanupEntered: true, journalState: "absent" };
  }
  throw new Error("unsupported finalize fault point");
}

function assertInstalledLayout(input) {
  assertExactFile(
    leafPath(input, input.request.finalLeaf),
    input.request.expectedPartialIdentity,
    input.request.expectedByteSize,
  );
  if (input.victimExisted) {
    assertExactFile(
      leafPath(input, input.request.partialLeaf),
      input.victimIdentity,
    );
  } else {
    assertAbsent(leafPath(input, input.request.partialLeaf));
  }
}

function assertPriorFinalState(input) {
  if (input.victimExisted) {
    assertExactFile(
      leafPath(input, input.request.finalLeaf),
      input.victimIdentity,
    );
  } else {
    assertAbsent(leafPath(input, input.request.finalLeaf));
  }
}

function assertFinalizedLayout(input) {
  assertExactFile(
    leafPath(input, input.request.finalLeaf),
    input.request.expectedPartialIdentity,
    input.request.expectedByteSize,
  );
  assertAbsent(leafPath(input, input.request.partialLeaf));
}

function assertJournalState(input, expected) {
  const base = `${input.request.partialLeaf}.fusionkit-overwrite`;
  const openPath = leafPath(input, `${base}.open`);
  const rollbackPath = leafPath(input, `${base}.rollback`);
  if (expected === "open") {
    assertOwnedJournal(openPath);
    assertAbsent(rollbackPath);
    return;
  }
  if (expected === "rollback") {
    assertAbsent(openPath);
    assertOwnedJournal(rollbackPath);
    return;
  }
  assert.equal(expected, "absent");
  assertAbsent(openPath);
  assertAbsent(rollbackPath);
}

function assertOwnedJournal(filePath) {
  const value = lstatSync(filePath);
  assert.equal(value.isFile(), true);
  assert.equal(value.isSymbolicLink(), false);
  assert.equal(value.nlink, 1);
}

function assertExactFile(filePath, expectedIdentity, expectedSize) {
  const value = lstatSync(filePath);
  assert.equal(value.isFile(), true);
  assert.equal(value.isSymbolicLink(), false);
  assert.equal(value.dev, expectedIdentity.dev);
  assert.equal(value.ino, expectedIdentity.ino);
  assert.equal(value.birthtimeMs, expectedIdentity.birthtimeMs);
  if (expectedSize !== undefined) assert.equal(value.size, expectedSize);
}

function assertAbsent(filePath) {
  assert.equal(pathExists(filePath), false);
}

function leafPath(input, leaf) {
  return path.join(input.request.directoryPath, leaf);
}

function pathExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function invokeAndCapture(operation) {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function writeResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  run();
} catch (error) {
  process.stderr.write(
    `overwrite_native_recovery_child_failed:${error?.code ?? "unknown"}\n`,
  );
  process.exitCode = 1;
}
