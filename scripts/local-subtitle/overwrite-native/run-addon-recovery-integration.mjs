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
  "rollback_before_journal_remove",
  GENERIC_JOURNAL_POINT,
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
  { priorVictim: "existing", checkpoint: "finalize_before_namespace" },
  { priorVictim: "absent", checkpoint: "finalize_before_namespace" },
  { priorVictim: "existing", checkpoint: "finalize_after_namespace_sync" },
  { priorVictim: "existing", checkpoint: GENERIC_JOURNAL_POINT },
  { priorVictim: "absent", checkpoint: GENERIC_JOURNAL_POINT },
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
    const beginCrashCases = ["existing", "absent"].map((priorVictim) =>
      runBeginCrashCase(canonicalAddonPath, workRoot, priorVictim)
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
    const finalizeUnsupportedCases = [
      runAbsentFinalizeAfterNamespaceUnsupportedCase(
        canonicalAddonPath,
        workRoot,
      ),
    ];
    const report = deepFreeze({
      schemaVersion: 2,
      workPackage: "FS-TXN-001B",
      target: { platform: "darwin", arch: "arm64" },
      addon: {
        component: "local-subtitle-overwrite",
        protocolVersion: 3,
        testOnly: true,
        testFaultInjection: true,
      },
      beginCrashCases,
      rollbackCrashCases,
      rollbackErrorRetryCases,
      finalizeErrorRetryCases,
      finalizeUnsupportedCases,
      claims: {
        beginOpenJournalAutomaticallyDecided: false,
        finalizeCrashRecoveryClaimed: false,
        powerLossSafetyClaimed: false,
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

function runBeginCrashCase(addonPath, workRoot, priorVictim) {
  const id = `begin-${priorVictim}-${BEGIN_CRASH_POINT}`;
  const fixture = createFixture(workRoot, id, priorVictim === "existing");
  const crash = spawnChild(
    childInput("begin-crash", addonPath, fixture, BEGIN_CRASH_POINT),
    faultEnvironment("exit", BEGIN_CRASH_POINT),
  );
  assertCrashExit(crash);
  assertOpenTransactionLayout(fixture);
  const namespaceBeforeRecovery = namespaceSnapshot(fixture);

  const firstRecovery = recoverInFreshChild(addonPath, fixture);
  assert.deepEqual(firstRecovery, { state: "decision_required" });
  assert.deepEqual(namespaceSnapshot(fixture), namespaceBeforeRecovery);
  assertOpenTransactionLayout(fixture);

  const repeatedRecovery = recoverInFreshChild(addonPath, fixture);
  assert.deepEqual(repeatedRecovery, { state: "decision_required" });
  assert.deepEqual(namespaceSnapshot(fixture), namespaceBeforeRecovery);
  assertOpenTransactionLayout(fixture);

  return Object.freeze({
    id,
    priorVictim,
    checkpoint: BEGIN_CRASH_POINT,
    childA: {
      action: "begin",
      exitCode: CRASH_EXIT_CODE,
      processTerminatedAtCheckpoint: true,
    },
    childB: {
      freshProcess: true,
      recoveryState: firstRecovery.state,
    },
    childC: {
      freshProcess: true,
      recoveryState: repeatedRecovery.state,
    },
    openJournalVerified: true,
    installedLayoutVerifiedWithExactIdentity: true,
    recoveryNamespaceUnchanged: true,
    automaticTerminalDecision: false,
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

  const firstExpectedState = options.checkpoint === GENERIC_JOURNAL_POINT
    ? "not_found"
    : "rolled_back";
  const namespaceBeforeFirstRecovery = options.checkpoint === GENERIC_JOURNAL_POINT
    ? namespaceSnapshot(fixture)
    : undefined;
  const firstRecovery = recoverInFreshChild(addonPath, fixture);
  assert.deepEqual(firstRecovery, { state: firstExpectedState });
  if (namespaceBeforeFirstRecovery) {
    assert.deepEqual(namespaceSnapshot(fixture), namespaceBeforeFirstRecovery);
  }
  assertFixtureRolledBack(fixture);
  const namespaceBeforeIdempotencyCheck = namespaceSnapshot(fixture);

  const repeatedRecovery = recoverInFreshChild(addonPath, fixture);
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
      recoveryApplied: firstExpectedState === "rolled_back",
    },
    childC: {
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
  const expectedJournalState = options.checkpoint === GENERIC_JOURNAL_POINT
    ? "absent"
    : "rollback";
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
  const cleanupEntered = options.checkpoint !== "finalize_before_namespace";
  const expectedJournalState = options.checkpoint === GENERIC_JOURNAL_POINT
    ? "absent"
    : "open";
  assert.deepEqual(result, {
    firstAction: "error",
    firstErrorCode: "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
    intermediateLayoutVerified: true,
    journalStateBeforeRetry: expectedJournalState,
    cleanupEntered,
    oppositeTerminalRejected: cleanupEntered ? true : null,
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
    errorRetryOnly: true,
    crashRecoveryClaimed: false,
    passed: true,
  });
}

function runAbsentFinalizeAfterNamespaceUnsupportedCase(addonPath, workRoot) {
  const checkpoint = "finalize_after_namespace_sync";
  const id = `finalize-unsupported-absent-${checkpoint}`;
  const fixture = createFixture(workRoot, id, false);
  const result = spawnJsonChild(
    childInput(
      "finalize-unreachable-point",
      addonPath,
      fixture,
      checkpoint,
    ),
    faultEnvironment("error", checkpoint),
  );
  assert.deepEqual(result, {
    configuredAction: "error",
    faultPointReached: false,
    finalizeCompleted: true,
  });
  assertFixtureFinalized(fixture);
  return Object.freeze({
    id,
    priorVictim: "absent",
    checkpoint,
    ...result,
    reason: "absent_finalize_has_no_namespace_mutation_checkpoint",
    crashRecoveryClaimed: false,
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

function recoverInFreshChild(addonPath, fixture) {
  return spawnJsonChild({
    action: "recover",
    addonPath,
    recoveryRequest: recoveryRequest(fixture.request),
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

function recoveryRequest(request) {
  return {
    directoryPath: request.directoryPath,
    expectedDirectoryIdentity: request.expectedDirectoryIdentity,
    transactionId: request.transactionId,
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
  const journalState = checkpoint === GENERIC_JOURNAL_POINT
    ? "absent"
    : "rollback";
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
  assertPriorFinalState(fixture);
  assertPathAbsent(path.join(fixture.directoryPath, fixture.partialLeaf));
  assertJournalState(fixture, "absent");
  assertDirectoryLeaves(
    fixture,
    fixture.victimExisted ? [fixture.finalLeaf] : [],
  );
}

function assertFixtureFinalized(fixture) {
  assertExactRegularFile(
    path.join(fixture.directoryPath, fixture.finalLeaf),
    fixture.newIdentity,
    fixture.newBytes,
  );
  assertPathAbsent(path.join(fixture.directoryPath, fixture.partialLeaf));
  assertJournalState(fixture, "absent");
  assertDirectoryLeaves(fixture, [fixture.finalLeaf]);
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
  if (expected === "open") {
    assertOwnedJournal(openPath);
    assertPathAbsent(rollbackPath);
    return;
  }
  if (expected === "rollback") {
    assertPathAbsent(openPath);
    assertOwnedJournal(rollbackPath);
    return;
  }
  assert.equal(expected, "absent");
  assertPathAbsent(openPath);
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
      "A fresh overwrite recovery child process failed.",
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
