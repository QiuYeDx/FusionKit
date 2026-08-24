#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CHILD_PATH = path.join(
  path.dirname(SCRIPT_PATH),
  "run-addon-recovery-child.mjs",
);
const DEFAULT_TEMP_ROOT = "/tmp";
const CRASH_EXIT_CODE = 86;
const BEGIN_CRASH_POINT = "begin_after_namespace";
const GENERIC_JOURNAL_POINT = "journal_after_unlink_before_sync";
const ROLLBACK_POINTS = Object.freeze([
  "rollback_after_intent_sync",
  "rollback_before_namespace",
  "rollback_after_namespace_sync",
  "rollback_before_cleanup_unlink",
  "rollback_after_cleanup_sync",
  "rollback_before_ack",
]);
const ROLLBACK_OPEN_LAYOUT_POINTS = new Set([
  "rollback_after_intent_sync",
  "rollback_before_namespace",
]);
const ROLLBACK_PARTIAL_CLEANUP_POINTS = new Set([
  "rollback_after_namespace_sync",
  "rollback_before_cleanup_unlink",
]);
const FINALIZE_ERROR_CASES = Object.freeze([
  { priorVictim: "existing", checkpoint: "finalize_after_intent_sync" },
  { priorVictim: "absent", checkpoint: "finalize_after_intent_sync" },
  { priorVictim: "existing", checkpoint: "finalize_before_namespace" },
  { priorVictim: "absent", checkpoint: "finalize_before_namespace" },
  { priorVictim: "existing", checkpoint: "finalize_after_namespace_sync" },
  { priorVictim: "existing", checkpoint: "finalize_before_ack" },
  { priorVictim: "absent", checkpoint: "finalize_before_ack" },
]);

export function parseRecoveryIntegrationArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      addon: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    addonPath: normalizeAbsoluteFilePath(values.addon, "addon", ".node"),
    outputPath: values.output === undefined
      ? undefined
      : normalizeAbsoluteFilePath(values.output, "output", ".json"),
  };
}

export async function runOverwriteNativeRecoveryIntegration(options = {}) {
  assertSupportedHost(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  const addonPath = normalizeAbsoluteFilePath(
    options.addonPath,
    "addonPath",
    ".node",
  );
  const addonStat = await lstat(addonPath);
  if (!addonStat.isFile() || addonStat.isSymbolicLink()) {
    throw integrationError(
      "invalid_addon",
      "The test addon must be a regular non-symlink file.",
    );
  }
  const canonicalAddonPath = await realpath(addonPath);
  assertTestAddonContract(require(canonicalAddonPath));

  const tempRoot = options.tempRoot === undefined
    ? DEFAULT_TEMP_ROOT
    : normalizeAbsoluteDirectoryPath(options.tempRoot, "tempRoot");
  const workRoot = await mkdtemp(
    path.join(tempRoot, "fusionkit-overwrite-native-recovery-"),
  );
  try {
    const beginCrashCases = ["existing", "absent"].flatMap((priorVictim) =>
      ["rollback", "finalize"].map((decision) =>
        runBeginCrashCase(canonicalAddonPath, workRoot, priorVictim, decision)
      )
    );
    const abandonedOpenReceiptCases = ["existing", "absent"].flatMap(
      (priorVictim) =>
        ["rollback", "finalize"].map((decision) =>
          runAbandonedOpenReceiptCase(
            canonicalAddonPath,
            workRoot,
            priorVictim,
            decision,
          )
        ),
    );
    const rollbackCrashCases = createPriorVictimMatrix(ROLLBACK_POINTS).map(
      ({ priorVictim, checkpoint }) =>
        runRollbackCrashCase(canonicalAddonPath, workRoot, {
          priorVictim,
          checkpoint,
        }),
    );
    const rollbackErrorRetryCases = createPriorVictimMatrix(ROLLBACK_POINTS).map(
      ({ priorVictim, checkpoint }) =>
        runRollbackErrorRetryCase(canonicalAddonPath, workRoot, {
          priorVictim,
          checkpoint,
        }),
    );
    const finalizeErrorRetryCases = FINALIZE_ERROR_CASES.map((entry) =>
      runFinalizeErrorRetryCase(canonicalAddonPath, workRoot, entry)
    );
    const finalizeCrashCases = FINALIZE_ERROR_CASES.map((entry) =>
      runFinalizeCrashCase(canonicalAddonPath, workRoot, entry)
    );
    const acknowledgeCases = ["existing", "absent"].flatMap((priorVictim) =>
      ["rollback", "finalize"].map((decision) => ({ priorVictim, decision }))
    );
    const acknowledgeCrashCases = acknowledgeCases.map((entry) =>
      runAcknowledgeCrashCase(canonicalAddonPath, workRoot, entry)
    );
    const acknowledgeErrorRetryCases = acknowledgeCases.map((entry) =>
      runAcknowledgeErrorRetryCase(canonicalAddonPath, workRoot, entry)
    );
    const report = deepFreeze({
      schemaVersion: 3,
      workPackage: "FS-TXN-001F",
      target: { platform: "darwin", arch: "arm64" },
      addon: {
        component: "local-subtitle-overwrite",
        protocolVersion: 4,
        testOnly: true,
        testFaultInjection: true,
      },
      beginCrashCases,
      abandonedOpenReceiptCases,
      rollbackCrashCases,
      rollbackErrorRetryCases,
      finalizeErrorRetryCases,
      finalizeCrashCases,
      acknowledgeCrashCases,
      acknowledgeErrorRetryCases,
      claims: {
        beginOpenJournalRequiresExplicitDecision: true,
        processCrashRecoveryClaimed: true,
        powerLossSafetyClaimed: false,
        nonCooperativeWriterSafetyClaimed: false,
      },
      status: "passed",
      productionGateChanged: false,
      privacy: {
        absolutePathsRecorded: false,
        fileContentRecorded: false,
        usernameRecorded: false,
      },
    });
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(workRoot), false);
    assert.equal(serialized.includes(canonicalAddonPath), false);
    assert.equal(serialized.includes("/"), false);
    assert.equal(serialized.includes("new-"), false);
    assert.equal(serialized.includes("victim-"), false);
    return report;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

function createPriorVictimMatrix(checkpoints) {
  return ["existing", "absent"].flatMap((priorVictim) =>
    checkpoints.map((checkpoint) => ({ priorVictim, checkpoint }))
  );
}

function runBeginCrashCase(addonPath, workRoot, priorVictim, decision) {
  const id = `begin-${priorVictim}-${decision}-${BEGIN_CRASH_POINT}`;
  const fixture = createFixture(workRoot, id, priorVictim === "existing");
  const crash = spawnChild(
    childInput("begin-crash", addonPath, fixture, BEGIN_CRASH_POINT),
    faultEnvironment("exit", BEGIN_CRASH_POINT),
  );
  assertCrashExit(crash);
  assertOpenTransactionLayout(fixture);
  const namespaceBeforeRecovery = namespaceSnapshot(fixture);

  const firstRecovery = recoverInFreshChild(addonPath, fixture, decision);
  const firstExpectedState = decision === "finalize"
    ? "finalized"
    : "rolled_back";
  assert.deepEqual(firstRecovery, { state: firstExpectedState });
  if (decision === "finalize") assertFixtureFinalizedLayout(fixture);
  else assertFixtureRolledBackLayout(fixture);
  assertJournalState(fixture, decision);
  assert.notDeepEqual(namespaceSnapshot(fixture), namespaceBeforeRecovery);
  const acknowledge = acknowledgeInFreshChild(addonPath, fixture, decision);
  assert.deepEqual(acknowledge, { state: "acknowledged" });
  if (decision === "finalize") assertFixtureFinalized(fixture);
  else assertFixtureRolledBack(fixture);
  const namespaceAfterAcknowledge = namespaceSnapshot(fixture);

  const repeatedRecovery = recoverInFreshChild(addonPath, fixture, decision);
  assert.deepEqual(repeatedRecovery, { state: "not_found" });
  assert.deepEqual(namespaceSnapshot(fixture), namespaceAfterAcknowledge);

  return Object.freeze({
    id,
    priorVictim,
    decision,
    checkpoint: BEGIN_CRASH_POINT,
    childA: {
      action: "begin",
      exitCode: CRASH_EXIT_CODE,
      processTerminatedAtCheckpoint: true,
    },
    childB: {
      freshProcess: true,
      recoveryState: firstRecovery.state,
      explicitDecisionApplied: true,
    },
    childC: {
      freshProcess: true,
      acknowledgeState: acknowledge.state,
    },
    childD: {
      freshProcess: true,
      recoveryState: repeatedRecovery.state,
      idempotent: true,
    },
    openJournalVerified: true,
    installedLayoutVerifiedWithExactIdentity: true,
    recoveryConvergedToExplicitDecision: true,
    idempotentNamespaceUnchanged: true,
    passed: true,
  });
}

function runAbandonedOpenReceiptCase(
  addonPath,
  workRoot,
  priorVictim,
  decision,
) {
  const id = `abandon-open-${priorVictim}-${decision}`;
  const fixture = createFixture(workRoot, id, priorVictim === "existing");
  const abandoned = spawnJsonChild(
    childInput("abandon-open", addonPath, fixture),
  );
  assert.deepEqual(abandoned, { receiptAbandoned: true });
  assertOpenTransactionLayout(fixture);
  assertJournalState(fixture, "open");
  const namespaceBeforeRecovery = namespaceSnapshot(fixture);

  const firstRecovery = recoverInFreshChild(addonPath, fixture, decision);
  const expectedState = decision === "finalize" ? "finalized" : "rolled_back";
  assert.deepEqual(firstRecovery, { state: expectedState });
  if (decision === "finalize") assertFixtureFinalizedLayout(fixture);
  else assertFixtureRolledBackLayout(fixture);
  assertJournalState(fixture, decision);
  assert.notDeepEqual(namespaceSnapshot(fixture), namespaceBeforeRecovery);

  const acknowledgement = acknowledgeInFreshChild(
    addonPath,
    fixture,
    decision,
  );
  assert.deepEqual(acknowledgement, { state: "acknowledged" });
  if (decision === "finalize") assertFixtureFinalized(fixture);
  else assertFixtureRolledBack(fixture);

  return Object.freeze({
    id,
    priorVictim,
    decision,
    childA: {
      action: "abandon-open",
      receiptAbandoned: true,
      normalExit: true,
    },
    childB: {
      freshProcess: true,
      recoveryState: firstRecovery.state,
      explicitDecisionApplied: true,
    },
    childC: {
      freshProcess: true,
      acknowledgeState: acknowledgement.state,
    },
    openJournalRetainedByFinalizer: true,
    presetRollbackMarkerAbsent: true,
    recoveryConvergedToExplicitDecision: true,
    passed: true,
  });
}

function runRollbackCrashCase(addonPath, workRoot, options) {
  const id =
    `rollback-crash-${options.priorVictim}-${options.checkpoint}`;
  const fixture = createFixture(
    workRoot,
    id,
    options.priorVictim === "existing",
  );
  const crash = spawnChild(
    childInput("rollback-crash", addonPath, fixture, options.checkpoint),
    faultEnvironment("exit", options.checkpoint),
  );
  assertCrashExit(crash);
  const journalStateAtCrash = assertRollbackIntermediate(
    fixture,
    options.checkpoint,
  );

  const firstRecovery = recoverInFreshChild(addonPath, fixture, "rollback");
  assert.deepEqual(firstRecovery, { state: "rolled_back" });
  assertFixtureRolledBackLayout(fixture);
  assertJournalState(fixture, "rollback");
  const acknowledge = acknowledgeInFreshChild(addonPath, fixture, "rollback");
  assert.deepEqual(acknowledge, { state: "acknowledged" });
  assertFixtureRolledBack(fixture);
  const namespaceBeforeIdempotencyCheck = namespaceSnapshot(fixture);

  const repeatedRecovery = recoverInFreshChild(addonPath, fixture, "rollback");
  assert.deepEqual(repeatedRecovery, { state: "not_found" });
  assert.deepEqual(
    namespaceSnapshot(fixture),
    namespaceBeforeIdempotencyCheck,
  );
  assertFixtureRolledBack(fixture);

  return Object.freeze({
    id,
    priorVictim: options.priorVictim,
    checkpoint: options.checkpoint,
    childA: {
      action: "rollback",
      exitCode: CRASH_EXIT_CODE,
      processTerminatedAtCheckpoint: true,
    },
    childB: {
      freshProcess: true,
      recoveryState: firstRecovery.state,
      recoveryApplied: true,
    },
    childC: {
      freshProcess: true,
      acknowledgeState: acknowledge.state,
    },
    childD: {
      freshProcess: true,
      recoveryState: repeatedRecovery.state,
      idempotent: true,
    },
    journalStateAtCrash,
    intermediateLayoutVerifiedWithExactIdentity: true,
    priorStateRestoredWithExactIdentity: true,
    idempotentNamespaceUnchanged: true,
    rollbackConverged: true,
    passed: true,
  });
}

function runRollbackErrorRetryCase(addonPath, workRoot, options) {
  const id =
    `rollback-error-${options.priorVictim}-${options.checkpoint}`;
  const fixture = createFixture(
    workRoot,
    id,
    options.priorVictim === "existing",
  );
  const result = spawnJsonChild(
    childInput(
      "rollback-error-retry",
      addonPath,
      fixture,
      options.checkpoint,
    ),
    faultEnvironment("error", options.checkpoint),
  );
  const expectedJournalState = "rollback";
  assert.deepEqual(result, {
    firstAction: "error",
    firstErrorCode: "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
    intermediateLayoutVerified: true,
    journalStateBeforeRetry: expectedJournalState,
    oppositeTerminalRejected: true,
    sameReceiptRetried: true,
    retryCompleted: true,
  });
  assertFixtureRolledBack(fixture);
  return Object.freeze({
    id,
    priorVictim: options.priorVictim,
    checkpoint: options.checkpoint,
    ...result,
    rollbackConverged: true,
    passed: true,
  });
}

function runFinalizeErrorRetryCase(addonPath, workRoot, options) {
  const id =
    `finalize-error-${options.priorVictim}-${options.checkpoint}`;
  const fixture = createFixture(
    workRoot,
    id,
    options.priorVictim === "existing",
  );
  const result = spawnJsonChild(
    childInput(
      "finalize-error-retry",
      addonPath,
      fixture,
      options.checkpoint,
    ),
    faultEnvironment("error", options.checkpoint),
  );
  const cleanupEntered = ![
    "finalize_after_intent_sync",
    "finalize_before_namespace",
  ].includes(options.checkpoint);
  const expectedJournalState = "finalize";
  assert.deepEqual(result, {
    firstAction: "error",
    firstErrorCode: "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
    intermediateLayoutVerified: true,
    journalStateBeforeRetry: expectedJournalState,
    cleanupEntered,
    oppositeTerminalRejected: true,
    sameReceiptRetried: true,
    retryCompleted: true,
  });
  assertFixtureFinalized(fixture);
  return Object.freeze({
    id,
    priorVictim: options.priorVictim,
    checkpoint: options.checkpoint,
    ...result,
    finalizedWithExactNewIdentity: true,
    durableFinalizeIntentVerified: true,
    passed: true,
  });
}

function runFinalizeCrashCase(addonPath, workRoot, options) {
  const id = `finalize-crash-${options.priorVictim}-${options.checkpoint}`;
  const fixture = createFixture(
    workRoot,
    id,
    options.priorVictim === "existing",
  );
  const crash = spawnChild(
    childInput("finalize-crash", addonPath, fixture, options.checkpoint),
    faultEnvironment("exit", options.checkpoint),
  );
  assertCrashExit(crash);
  const journalStateAtCrash = "finalize";
  if (["finalize_after_intent_sync", "finalize_before_namespace"].includes(
    options.checkpoint,
  )) {
    assertInstalledLayout(fixture);
  } else {
    assertFixtureFinalizedLayout(fixture);
  }
  assertJournalState(fixture, journalStateAtCrash);

  const firstRecovery = recoverInFreshChild(addonPath, fixture, "finalize");
  assert.deepEqual(firstRecovery, { state: "finalized" });
  assertFixtureFinalizedLayout(fixture);
  assertJournalState(fixture, "finalize");
  const acknowledge = acknowledgeInFreshChild(addonPath, fixture, "finalize");
  assert.deepEqual(acknowledge, { state: "acknowledged" });
  assertFixtureFinalized(fixture);
  const namespaceBeforeIdempotencyCheck = namespaceSnapshot(fixture);
  const repeatedRecovery = recoverInFreshChild(addonPath, fixture, "finalize");
  assert.deepEqual(repeatedRecovery, { state: "not_found" });
  assert.deepEqual(namespaceSnapshot(fixture), namespaceBeforeIdempotencyCheck);

  return Object.freeze({
    id,
    priorVictim: options.priorVictim,
    checkpoint: options.checkpoint,
    childA: {
      action: "finalize",
      exitCode: CRASH_EXIT_CODE,
      processTerminatedAtCheckpoint: true,
    },
    childB: {
      freshProcess: true,
      recoveryState: firstRecovery.state,
      recoveryApplied: true,
    },
    childC: {
      freshProcess: true,
      acknowledgeState: acknowledge.state,
    },
    childD: {
      freshProcess: true,
      recoveryState: repeatedRecovery.state,
      idempotent: true,
    },
    journalStateAtCrash,
    finalizedWithExactNewIdentity: true,
    idempotentNamespaceUnchanged: true,
    passed: true,
  });
}

function runAcknowledgeCrashCase(addonPath, workRoot, options) {
  const id =
    `acknowledge-crash-${options.priorVictim}-${options.decision}`;
  const fixture = createFixture(
    workRoot,
    id,
    options.priorVictim === "existing",
  );
  const crash = spawnChild(
    {
      ...childInput(
        "acknowledge-crash",
        addonPath,
        fixture,
        GENERIC_JOURNAL_POINT,
      ),
      terminal: options.decision,
    },
    faultEnvironment("exit", GENERIC_JOURNAL_POINT),
  );
  assertCrashExit(crash);
  if (options.decision === "finalize") assertFixtureFinalized(fixture);
  else assertFixtureRolledBack(fixture);
  const namespaceBeforeRetry = namespaceSnapshot(fixture);
  const acknowledge = acknowledgeInFreshChild(
    addonPath,
    fixture,
    options.decision,
  );
  assert.deepEqual(acknowledge, { state: "not_found" });
  assert.deepEqual(namespaceSnapshot(fixture), namespaceBeforeRetry);
  return Object.freeze({
    id,
    priorVictim: options.priorVictim,
    decision: options.decision,
    checkpoint: GENERIC_JOURNAL_POINT,
    childA: {
      action: "acknowledge",
      exitCode: CRASH_EXIT_CODE,
      processTerminatedAtCheckpoint: true,
    },
    childB: {
      freshProcess: true,
      acknowledgeState: acknowledge.state,
    },
    terminalLayoutPreserved: true,
    notFoundTreatedAsNativeSuccess: false,
    passed: true,
  });
}

function runAcknowledgeErrorRetryCase(addonPath, workRoot, options) {
  const id =
    `acknowledge-error-${options.priorVictim}-${options.decision}`;
  const fixture = createFixture(
    workRoot,
    id,
    options.priorVictim === "existing",
  );
  const result = spawnJsonChild(
    {
      ...childInput(
        "acknowledge-error-retry",
        addonPath,
        fixture,
        GENERIC_JOURNAL_POINT,
      ),
      terminal: options.decision,
    },
    faultEnvironment("error", GENERIC_JOURNAL_POINT),
  );
  assert.deepEqual(result, {
    firstAction: "error",
    firstErrorCode: "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
    sameReceiptRetried: true,
    retryCompleted: true,
  });
  if (options.decision === "finalize") assertFixtureFinalized(fixture);
  else assertFixtureRolledBack(fixture);
  return Object.freeze({
    id,
    priorVictim: options.priorVictim,
    decision: options.decision,
    checkpoint: GENERIC_JOURNAL_POINT,
    ...result,
    passed: true,
  });
}

function childInput(action, addonPath, fixture, faultPoint) {
  return {
    action,
    addonPath,
    request: fixture.request,
    recoveryRequest: recoveryRequest(fixture.request),
    victimExisted: fixture.victimExisted,
    victimIdentity: fixture.victimIdentity,
    faultPoint,
  };
}

function faultEnvironment(action, point) {
  return {
    FUSIONKIT_OVERWRITE_TEST_FAULT_ACTION: action,
    FUSIONKIT_OVERWRITE_TEST_FAULT_POINT: point,
  };
}

function recoverInFreshChild(addonPath, fixture, decision) {
  return spawnJsonChild({
    action: "recover",
    addonPath,
    recoveryRequest: recoveryRequest(fixture.request, decision),
    victimExisted: fixture.victimExisted,
    victimIdentity: fixture.victimIdentity,
  });
}

function acknowledgeInFreshChild(addonPath, fixture, decision) {
  return spawnJsonChild({
    action: "acknowledge",
    addonPath,
    recoveryRequest: recoveryRequest(fixture.request, decision),
    victimExisted: fixture.victimExisted,
    victimIdentity: fixture.victimIdentity,
  });
}

function assertCrashExit(result) {
  assert.equal(result.status, CRASH_EXIT_CODE);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

function createFixture(workRoot, id, victimExisted) {
  const directoryPath = path.join(workRoot, id);
  const transactionId = transactionIdFor(id);
  const partialLeaf = partialLeafFor(transactionId);
  const finalLeaf = "meeting.srt";
  const partialPath = path.join(directoryPath, partialLeaf);
  const finalPath = path.join(directoryPath, finalLeaf);
  const newBytes = Buffer.from(`new-${id}`, "utf8");
  const victimBytes = Buffer.from(`victim-${id}`, "utf8");
  mkdirSync(directoryPath, { mode: 0o700 });
  writeFileSync(partialPath, newBytes, { flag: "wx", mode: 0o600 });
  if (victimExisted) {
    writeFileSync(finalPath, victimBytes, { flag: "wx", mode: 0o600 });
  }
  const newIdentity = identityFromStat(lstatSync(partialPath));
  const victimIdentity = victimExisted
    ? identityFromStat(lstatSync(finalPath))
    : undefined;
  return {
    directoryPath,
    partialLeaf,
    finalLeaf,
    victimExisted,
    newBytes,
    newIdentity,
    victimBytes,
    victimIdentity,
    request: {
      directoryPath,
      expectedDirectoryIdentity: identityFromStat(lstatSync(directoryPath)),
      transactionId,
      partialLeaf,
      finalLeaf,
      expectedPartialIdentity: newIdentity,
      expectedByteSize: newBytes.byteLength,
    },
  };
}

function recoveryRequest(request, decision = "rollback") {
  return {
    directoryPath: request.directoryPath,
    expectedDirectoryIdentity: request.expectedDirectoryIdentity,
    transactionId: request.transactionId,
    decision,
  };
}

function transactionIdFor(value) {
  const transactionId = value.replace(/[^A-Za-z0-9-]/gu, "-").slice(0, 80);
  assert.match(transactionId, /^[A-Za-z0-9-]{1,80}$/u);
  return transactionId;
}

function partialLeafFor(transactionId) {
  assert.match(transactionId, /^[A-Za-z0-9-]{1,80}$/u);
  return `.fusionkit-local-subtitle-${transactionId}.partial`;
}

function assertOpenTransactionLayout(fixture) {
  assertInstalledLayout(fixture);
  assertJournalState(fixture, "open");
  assertDirectoryLeaves(fixture, [
    fixture.finalLeaf,
    ...(fixture.victimExisted ? [fixture.partialLeaf] : []),
    journalLeaf(fixture, "open"),
  ]);
}

function assertRollbackIntermediate(fixture, checkpoint) {
  if (ROLLBACK_OPEN_LAYOUT_POINTS.has(checkpoint)) {
    assertInstalledLayout(fixture);
  } else if (ROLLBACK_PARTIAL_CLEANUP_POINTS.has(checkpoint)) {
    assertPriorFinalState(fixture);
    assertExactRegularFile(
      path.join(fixture.directoryPath, fixture.partialLeaf),
      fixture.newIdentity,
      fixture.newBytes,
    );
  } else {
    assertPriorFinalState(fixture);
    assertPathAbsent(path.join(fixture.directoryPath, fixture.partialLeaf));
  }
  const journalState = "rollback";
  assertJournalState(fixture, journalState);
  const expectedLeaves = [];
  if (ROLLBACK_OPEN_LAYOUT_POINTS.has(checkpoint)) {
    expectedLeaves.push(fixture.finalLeaf);
    if (fixture.victimExisted) expectedLeaves.push(fixture.partialLeaf);
  } else if (ROLLBACK_PARTIAL_CLEANUP_POINTS.has(checkpoint)) {
    if (fixture.victimExisted) expectedLeaves.push(fixture.finalLeaf);
    expectedLeaves.push(fixture.partialLeaf);
  } else if (fixture.victimExisted) {
    expectedLeaves.push(fixture.finalLeaf);
  }
  if (journalState === "rollback") {
    expectedLeaves.push(journalLeaf(fixture, "rollback"));
  }
  assertDirectoryLeaves(fixture, expectedLeaves);
  return journalState;
}

function assertInstalledLayout(fixture) {
  assertExactRegularFile(
    path.join(fixture.directoryPath, fixture.finalLeaf),
    fixture.newIdentity,
    fixture.newBytes,
  );
  const partialPath = path.join(fixture.directoryPath, fixture.partialLeaf);
  if (fixture.victimExisted) {
    assertExactRegularFile(
      partialPath,
      fixture.victimIdentity,
      fixture.victimBytes,
    );
  } else {
    assertPathAbsent(partialPath);
  }
}

function assertPriorFinalState(fixture) {
  const finalPath = path.join(fixture.directoryPath, fixture.finalLeaf);
  if (fixture.victimExisted) {
    assertExactRegularFile(finalPath, fixture.victimIdentity, fixture.victimBytes);
  } else {
    assertPathAbsent(finalPath);
  }
}

function assertFixtureRolledBack(fixture) {
  assertFixtureRolledBackLayout(fixture);
  assertJournalState(fixture, "absent");
  assertDirectoryLeaves(
    fixture,
    fixture.victimExisted ? [fixture.finalLeaf] : [],
  );
}

function assertFixtureRolledBackLayout(fixture) {
  assertPriorFinalState(fixture);
  assertPathAbsent(path.join(fixture.directoryPath, fixture.partialLeaf));
}

function assertFixtureFinalized(fixture) {
  assertFixtureFinalizedLayout(fixture);
  assertJournalState(fixture, "absent");
  assertDirectoryLeaves(fixture, [fixture.finalLeaf]);
}

function assertFixtureFinalizedLayout(fixture) {
  assertExactRegularFile(
    path.join(fixture.directoryPath, fixture.finalLeaf),
    fixture.newIdentity,
    fixture.newBytes,
  );
  assertPathAbsent(path.join(fixture.directoryPath, fixture.partialLeaf));
}

function assertExactRegularFile(filePath, expectedIdentity, expectedBytes) {
  const value = lstatSync(filePath);
  assert.equal(value.isFile(), true);
  assert.equal(value.isSymbolicLink(), false);
  assert.equal(value.nlink, 1);
  assert.deepEqual(identityFromStat(value), expectedIdentity);
  assert.deepEqual(readFileSync(filePath), expectedBytes);
}

function assertJournalState(fixture, expected) {
  const openPath = path.join(fixture.directoryPath, journalLeaf(fixture, "open"));
  const rollbackPath = path.join(
    fixture.directoryPath,
    journalLeaf(fixture, "rollback"),
  );
  const finalizePath = path.join(
    fixture.directoryPath,
    journalLeaf(fixture, "finalize"),
  );
  if (expected === "open") {
    assertOwnedJournal(openPath);
    assertPathAbsent(finalizePath);
    assertPathAbsent(rollbackPath);
    return;
  }
  if (expected === "finalize") {
    assertPathAbsent(openPath);
    assertOwnedJournal(finalizePath);
    assertPathAbsent(rollbackPath);
    return;
  }
  if (expected === "rollback") {
    assertPathAbsent(openPath);
    assertPathAbsent(finalizePath);
    assertOwnedJournal(rollbackPath);
    return;
  }
  assert.equal(expected, "absent");
  assertPathAbsent(openPath);
  assertPathAbsent(finalizePath);
  assertPathAbsent(rollbackPath);
}

function assertOwnedJournal(filePath) {
  const value = lstatSync(filePath);
  assert.equal(value.isFile(), true);
  assert.equal(value.isSymbolicLink(), false);
  assert.equal(value.nlink, 1);
  assert.equal(value.size > 0, true);
}

function journalLeaf(fixture, state) {
  return `${fixture.partialLeaf}.fusionkit-overwrite.${state}`;
}

function assertDirectoryLeaves(fixture, expected) {
  assert.deepEqual(
    readdirSync(fixture.directoryPath).sort(),
    [...expected].sort(),
  );
}

function assertPathAbsent(filePath) {
  assert.equal(pathExists(filePath), false);
}

function namespaceSnapshot(fixture) {
  const entries = readdirSync(fixture.directoryPath).sort();
  return {
    directory: namespaceStatProof(fixture.directoryPath),
    entries: entries.map((leaf) => ({
      leaf,
      proof: namespaceStatProof(path.join(fixture.directoryPath, leaf)),
    })),
  };
}

function namespaceStatProof(filePath) {
  const value = lstatSync(filePath, { bigint: true });
  return {
    dev: value.dev,
    ino: value.ino,
    birthtimeNs: value.birthtimeNs,
    ctimeNs: value.ctimeNs,
    mtimeNs: value.mtimeNs,
    size: value.size,
    nlink: value.nlink,
    mode: value.mode,
  };
}

function spawnJsonChild(input, additionalEnvironment = {}) {
  const result = spawnChild(input, additionalEnvironment);
  if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
    throw integrationError(
      "child_failed",
      "A fresh overwrite recovery child process failed " +
        `(action=${input.action}, fault=${input.faultPoint ?? "none"}, ` +
        `terminal=${input.terminal ?? "none"}, status=${result.status}, ` +
        `signal=${result.signal ?? "none"}, ` +
        `stderr=${result.stderr.trim() || "none"}).`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw integrationError(
      "invalid_child_output",
      "A recovery child returned invalid JSON.",
      error,
    );
  }
  return parsed;
}

function spawnChild(input, additionalEnvironment = {}) {
  return spawnSync(process.execPath, [CHILD_PATH], {
    input: JSON.stringify(input),
    encoding: "utf8",
    shell: false,
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
      TMPDIR: "/tmp",
      ...additionalEnvironment,
    },
  });
}

function identityFromStat(value) {
  assert.equal(value.isSymbolicLink(), false);
  for (const field of [value.dev, value.ino]) {
    assert.equal(Number.isSafeInteger(field), true);
    assert.equal(field >= 0, true);
  }
  assert.equal(Number.isFinite(value.birthtimeMs), true);
  assert.equal(value.birthtimeMs >= 0, true);
  return {
    dev: value.dev,
    ino: value.ino,
    birthtimeMs: value.birthtimeMs,
  };
}

function assertTestAddonContract(addon) {
  assert.deepEqual(Reflect.ownKeys(addon).sort(), [
    "acknowledge",
    "architecture",
    "begin",
    "platform",
    "protocolVersion",
    "recover",
    "testFaultInjection",
  ]);
  assert.equal(addon.protocolVersion, 4);
  assert.equal(addon.platform, "darwin");
  assert.equal(addon.architecture, "arm64");
  assert.equal(addon.testFaultInjection, true);
  assert.equal(typeof addon.begin, "function");
  assert.equal(typeof addon.recover, "function");
  assert.equal(typeof addon.acknowledge, "function");
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

function assertSupportedHost(platform, arch) {
  if (platform !== "darwin") {
    throw integrationError(
      "unsupported_platform",
      "The recovery integration currently supports only macOS.",
    );
  }
  if (arch !== "arm64") {
    throw integrationError(
      "unsupported_architecture",
      "The recovery integration currently supports only macOS arm64.",
    );
  }
}

function normalizeAbsoluteFilePath(value, label, extension) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    !path.basename(value).endsWith(extension)
  ) {
    throw integrationError(
      "invalid_arguments",
      `${label} must be an absolute ${extension} file path.`,
    );
  }
  return path.normalize(value);
}

function normalizeAbsoluteDirectoryPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw integrationError(
      "invalid_arguments",
      `${label} must be an absolute directory path.`,
    );
  }
  return path.normalize(value);
}

function integrationError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseRecoveryIntegrationArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node run-addon-recovery-integration.mjs " +
        "--addon </absolute/path/test-addon.node> " +
        "[--output </absolute/path/recovery-report.json>]\n",
    );
    return;
  }
  const report = await runOverwriteNativeRecoveryIntegration(options);
  if (options.outputPath) {
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(
      `overwrite_native_recovery_integration_failed:${error?.code ?? "unknown"}\n`,
    );
    process.exitCode = 1;
  });
}
