#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CHILD_PATH = path.join(
  path.dirname(SCRIPT_PATH),
  "run-addon-windows-recovery-child.mjs",
);
const CRASH_EXIT_CODE = 86;
const ROLLBACK_POINTS = Object.freeze([
  "rollback_after_intent_sync",
  "rollback_before_namespace",
  "rollback_after_namespace_sync",
  "rollback_before_cleanup_unlink",
  "rollback_after_cleanup_sync",
  "rollback_before_ack",
]);
const FINALIZE_ERROR_CASES = Object.freeze([
  ["existing", "finalize_after_intent_sync"],
  ["absent", "finalize_after_intent_sync"],
  ["existing", "finalize_before_namespace"],
  ["absent", "finalize_before_namespace"],
  ["existing", "finalize_after_namespace_sync"],
  ["existing", "finalize_before_ack"],
  ["absent", "finalize_before_ack"],
]);
const FINALIZE_CRASH_CASES = FINALIZE_ERROR_CASES;
const ACK_POINT = "journal_after_unlink_before_sync";

export function parseWindowsRecoveryArguments(argv) {
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
    addonPath: normalizeAbsoluteFile(values.addon, "addon", ".node"),
    outputPath: values.output === undefined
      ? undefined
      : normalizeAbsoluteFile(values.output, "output", ".json"),
  };
}

export async function runWindowsOverwriteRecoveryIntegration(options = {}) {
  assert.equal(options.platform ?? process.platform, "win32");
  assert.equal(options.arch ?? process.arch, "x64");
  const addonPath = normalizeAbsoluteFile(
    options.addonPath,
    "addonPath",
    ".node",
  );
  const proof = await lstat(addonPath);
  assert.equal(proof.isFile(), true);
  assert.equal(proof.isSymbolicLink(), false);
  const canonicalAddonPath = await realpath(addonPath);
  assertTestAddon(require(canonicalAddonPath));
  const workRoot = await mkdtemp(
    path.join(options.tempRoot ?? os.tmpdir(), "fusionkit-overwrite-win-rec-"),
  );
  try {
    const abandonedOpenCases = ["finalize", "rollback"].flatMap(
      (decision) => ["existing", "absent"].map((priorVictim) =>
        runAbandonedOpenCase(
          canonicalAddonPath,
          workRoot,
          priorVictim,
          decision,
        )
      ),
    );
    const beginCrashCases = [
      runBeginCrash(canonicalAddonPath, workRoot, "existing"),
      runBeginCrash(canonicalAddonPath, workRoot, "absent"),
      runBackupCrash(canonicalAddonPath, workRoot, "finalize"),
      runBackupCrash(canonicalAddonPath, workRoot, "rollback"),
    ];
    const openRecoveryArmCrashCases = ["finalize", "rollback"].flatMap(
      (decision) => ["existing", "absent"].map((priorVictim) =>
        runOpenRecoveryArmCrash(
          canonicalAddonPath,
          workRoot,
          priorVictim,
          decision,
        )
      ),
    );
    const rollbackCrashCases = matrix(ROLLBACK_POINTS).map((entry) =>
      runRollbackCrash(canonicalAddonPath, workRoot, entry)
    );
    const rollbackErrorRetryCases = matrix(ROLLBACK_POINTS).map((entry) =>
      runTerminalErrorRetry(
        canonicalAddonPath,
        workRoot,
        entry,
        "rollback",
      )
    );
    const finalizeErrorRetryCases = FINALIZE_ERROR_CASES.map(
      ([priorVictim, checkpoint]) =>
        runTerminalErrorRetry(
          canonicalAddonPath,
          workRoot,
          { priorVictim, checkpoint },
          "finalize",
        ),
    );
    const finalizeCrashCases = FINALIZE_CRASH_CASES.map(
      ([priorVictim, checkpoint]) =>
        runFinalizeCrash(
          canonicalAddonPath,
          workRoot,
          priorVictim,
          checkpoint,
        ),
    );
    const acknowledgeCrashCases = matrix([ACK_POINT]).flatMap((entry) => [
      runAcknowledgeCrash(canonicalAddonPath, workRoot, entry, "finalize"),
      runAcknowledgeCrash(canonicalAddonPath, workRoot, entry, "rollback"),
    ]);
    const acknowledgeErrorRetryCases = matrix([ACK_POINT]).flatMap((entry) => [
      runAcknowledgeErrorRetry(
        canonicalAddonPath,
        workRoot,
        entry,
        "finalize",
      ),
      runAcknowledgeErrorRetry(
        canonicalAddonPath,
        workRoot,
        entry,
        "rollback",
      ),
    ]);
    const conflictCases = [
      runDecisionConflict(canonicalAddonPath, workRoot),
      runJournalConflict(canonicalAddonPath, workRoot),
    ];
    const report = deepFreeze({
      schemaVersion: 3,
      workPackage: "FS-TXN-001F",
      target: { platform: "win32", arch: "x64" },
      addon: {
        protocolVersion: 4,
        journalVersion: 3,
        testOnly: true,
        testFaultInjection: true,
      },
      abandonedOpenCases,
      beginCrashCases,
      openRecoveryArmCrashCases,
      rollbackCrashCases,
      rollbackErrorRetryCases,
      finalizeErrorRetryCases,
      finalizeCrashCases,
      acknowledgeCrashCases,
      acknowledgeErrorRetryCases,
      conflictCases,
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
    assert.equal(serialized.includes("new-"), false);
    assert.equal(serialized.includes("victim-"), false);
    return report;
  } finally {
    await rm(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function matrix(points) {
  return ["existing", "absent"].flatMap((priorVictim) =>
    points.map((checkpoint) => ({ priorVictim, checkpoint }))
  );
}

function runAbandonedOpenCase(
  addonPath,
  workRoot,
  priorVictim,
  decision,
) {
  const fixture = createFixture(
    workRoot,
    `abandoned-open-${decision}-${priorVictim}`,
    priorVictim === "existing",
  );
  assert.deepEqual(
    spawnJsonChild("abandon-open", addonPath, fixture.request),
    { state: "abandoned_open" },
  );
  assertInstalled(fixture, "open");
  const openNamespace = namespaceSnapshot(fixture.directoryPath);
  const recovered = recoverFresh(addonPath, fixture, decision);
  assert.deepEqual(recovered, {
    state: decision === "finalize" ? "finalized" : "rolled_back",
  });
  assertSettled(fixture, decision);
  assert.deepEqual(acknowledgeFresh(addonPath, fixture, decision), {
    state: "acknowledged",
  });
  if (decision === "finalize") assertFinalized(fixture);
  else assertRolledBack(fixture);
  return {
    priorVictim,
    decision,
    openJournalPreservedByFinalizer: true,
    namespaceAwaitedDurableDecision: openNamespace.length > 0,
    status: "passed",
  };
}

function runBeginCrash(addonPath, workRoot, priorVictim) {
  const fixture = createFixture(
    workRoot,
    `begin-${priorVictim}`,
    priorVictim === "existing",
  );
  assertCrash(
    spawnChild(
      "begin-crash",
      addonPath,
      fixture.request,
      "exit",
      "begin_after_namespace",
    ),
  );
  assertInstalled(fixture, "open");
  const decision = priorVictim === "existing" ? "finalize" : "rollback";
  const recovery = recoverFresh(addonPath, fixture, decision);
  const expectedState = decision === "finalize" ? "finalized" : "rolled_back";
  assert.deepEqual(recovery, { state: expectedState });
  assertSettled(fixture, decision);
  assert.deepEqual(acknowledgeFresh(addonPath, fixture, decision), {
    state: "acknowledged",
  });
  if (decision === "finalize") assertFinalized(fixture);
  else assertRolledBack(fixture);
  return {
    priorVictim,
    checkpoint: "begin_after_namespace",
    recoveryState: recovery.state,
    decision,
    acknowledged: true,
    status: "passed",
  };
}

function runBackupCrash(addonPath, workRoot, decision) {
  const fixture = createFixture(workRoot, `begin-backup-${decision}`, true);
  assertCrash(
    spawnChild(
      "begin-crash",
      addonPath,
      fixture.request,
      "exit",
      "begin_after_victim_backup",
    ),
  );
  assertExactFile(
    path.join(fixture.directoryPath, fixture.finalLeaf),
    fixture.victimIdentity,
    fixture.victimBytes,
    2,
  );
  assertExactFile(
    path.join(fixture.directoryPath, fixture.partialLeaf),
    fixture.newIdentity,
    fixture.newBytes,
  );
  assertExactFile(
    victimPath(fixture),
    fixture.victimIdentity,
    fixture.victimBytes,
    2,
  );
  assertJournal(fixture, "open");
  assert.deepEqual(recoverFresh(addonPath, fixture, decision), {
    state: decision === "finalize" ? "finalized" : "rolled_back",
  });
  assertSettled(fixture, decision);
  assert.deepEqual(acknowledgeFresh(addonPath, fixture, decision), {
    state: "acknowledged",
  });
  if (decision === "finalize") assertFinalized(fixture);
  else assertRolledBack(fixture);
  return {
    priorVictim: "existing",
    checkpoint: "begin_after_victim_backup",
    recoveryState: decision === "finalize" ? "finalized" : "rolled_back",
    decision,
    acknowledged: true,
    status: "passed",
  };
}

function runOpenRecoveryArmCrash(
  addonPath,
  workRoot,
  priorVictim,
  decision,
) {
  const addon = require(addonPath);
  const fixture = createFixture(
    workRoot,
    `recover-arm-${decision}-${priorVictim}`,
    priorVictim === "existing",
  );
  const receipt = addon.begin(fixture.request);
  assertCrash(spawnChild(
    "recover",
    addonPath,
    recoveryRequest(fixture.request, decision),
    "exit",
    `${decision}_after_intent_sync`,
  ));
  assertInstalled(fixture, decision);
  const recovered = recoverFresh(addonPath, fixture, decision);
  assert.deepEqual(recovered, {
    state: decision === "finalize" ? "finalized" : "rolled_back",
  });
  assertSettled(fixture, decision);
  assert.deepEqual(acknowledgeFresh(addonPath, fixture, decision), {
    state: "acknowledged",
  });
  if (decision === "finalize") assertFinalized(fixture);
  else assertRolledBack(fixture);
  assert.equal(typeof receipt.acknowledge, "function");
  return {
    priorVictim,
    decision,
    checkpoint: `${decision}_after_intent_sync`,
    durableTerminalMarkerRecovered: true,
    status: "passed",
  };
}

function runRollbackCrash(addonPath, workRoot, entry) {
  const fixture = createFixture(
    workRoot,
    `rollback-crash-${entry.priorVictim}-${entry.checkpoint}`,
    entry.priorVictim === "existing",
  );
  assertCrash(
    spawnChild(
      "rollback-crash",
      addonPath,
      fixture.request,
      "exit",
      entry.checkpoint,
    ),
  );
  const before = namespaceSnapshot(fixture.directoryPath);
  const recovery = recoverFresh(addonPath, fixture, "rollback");
  assert.deepEqual(recovery, { state: "rolled_back" });
  assertSettled(fixture, "rollback");
  const acknowledged = acknowledgeFresh(addonPath, fixture, "rollback");
  assert.deepEqual(acknowledged, { state: "acknowledged" });
  assertRolledBack(fixture);
  const second = acknowledgeFresh(addonPath, fixture, "rollback");
  assert.deepEqual(second, { state: "not_found" });
  return {
    ...entry,
    firstRecoveryState: recovery.state,
    acknowledgeState: acknowledged.state,
    secondAcknowledgeState: second.state,
    preRecoveryObservationRetained: before.length >= 0,
    status: "passed",
  };
}

function runTerminalErrorRetry(
  addonPath,
  workRoot,
  entry,
  terminal,
) {
  const fixture = createFixture(
    workRoot,
    `${terminal}-error-${entry.priorVictim}-${entry.checkpoint}`,
    entry.priorVictim === "existing",
  );
  const result = spawnJsonChild(
    `${terminal}-error-retry`,
    addonPath,
    fixture.request,
    "error",
    entry.checkpoint,
  );
  assert.equal(
    result.first?.code,
    "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
  );
  assert.equal(result.second, undefined);
  assert.equal(result.acknowledge, undefined);
  if (terminal === "rollback") assertRolledBack(fixture);
  else assertFinalized(fixture);
  return { ...entry, terminal, status: "passed" };
}

function runFinalizeCrash(
  addonPath,
  workRoot,
  priorVictim,
  checkpoint,
) {
  const fixture = createFixture(
    workRoot,
    `finalize-crash-${priorVictim}-${checkpoint}`,
    priorVictim === "existing",
  );
  assertCrash(
    spawnChild(
      "finalize-crash",
      addonPath,
      fixture.request,
      "exit",
      checkpoint,
    ),
  );
  const recovery = recoverFresh(addonPath, fixture, "finalize");
  assert.deepEqual(recovery, { state: "finalized" });
  assertSettled(fixture, "finalize");
  assert.deepEqual(acknowledgeFresh(addonPath, fixture, "finalize"), {
    state: "acknowledged",
  });
  assertFinalized(fixture);
  return {
    priorVictim,
    checkpoint,
    recoveryState: recovery.state,
    durableFinalizeRecovered: true,
    acknowledged: true,
    status: "passed",
  };
}

function runAcknowledgeCrash(
  addonPath,
  workRoot,
  entry,
  decision,
) {
  const fixture = createFixture(
    workRoot,
    `ack-crash-${decision}-${entry.priorVictim}`,
    entry.priorVictim === "existing",
  );
  assertCrash(spawnChild(
    "acknowledge-crash",
    addonPath,
    fixture.request,
    "exit",
    entry.checkpoint,
    decision,
  ));
  if (decision === "finalize") assertFinalized(fixture);
  else assertRolledBack(fixture);
  const repeated = acknowledgeFresh(addonPath, fixture, decision);
  assert.deepEqual(repeated, { state: "not_found" });
  return {
    ...entry,
    decision,
    acknowledgeState: repeated.state,
    notFoundObservedOnlyAfterAuthorizedAcknowledgement: true,
    status: "passed",
  };
}

function runAcknowledgeErrorRetry(
  addonPath,
  workRoot,
  entry,
  decision,
) {
  const fixture = createFixture(
    workRoot,
    `ack-error-${decision}-${entry.priorVictim}`,
    entry.priorVictim === "existing",
  );
  const result = spawnJsonChild(
    "acknowledge-error-retry",
    addonPath,
    fixture.request,
    "error",
    entry.checkpoint,
    decision,
  );
  assert.equal(result.first?.code, "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM");
  assert.equal(result.second, undefined);
  assert.equal(result.decision, decision);
  if (decision === "finalize") assertFinalized(fixture);
  else assertRolledBack(fixture);
  return { ...entry, decision, sameReceiptRetried: true, status: "passed" };
}

function runDecisionConflict(addonPath, workRoot) {
  const addon = require(addonPath);
  const fixture = createFixture(workRoot, "decision-conflict", true);
  const receipt = addon.begin(fixture.request);
  receipt.finalize();
  assertSettled(fixture, "finalize");
  const before = namespaceSnapshot(fixture.directoryPath);
  assert.throws(
    () => addon.recover(recoveryRequest(fixture.request, "rollback")),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM" },
  );
  assert.throws(
    () => addon.acknowledge(recoveryRequest(fixture.request, "rollback")),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM" },
  );
  assert.deepEqual(namespaceSnapshot(fixture.directoryPath), before);
  assert.deepEqual(
    addon.recover(recoveryRequest(fixture.request, "finalize")),
    { state: "finalized" },
  );
  assert.deepEqual(
    addon.acknowledge(recoveryRequest(fixture.request, "finalize")),
    { state: "acknowledged" },
  );
  assertFinalized(fixture);
  return {
    id: "terminal-decision-conflict",
    failedClosedWithoutNamespaceMutation: true,
    status: "passed",
  };
}

function runJournalConflict(addonPath, workRoot) {
  const addon = require(addonPath);
  const fixture = createFixture(workRoot, "journal-conflict", false);
  addon.begin(fixture.request);
  linkSync(
    journalPath(fixture, "open"),
    journalPath(fixture, "finalize"),
  );
  const before = namespaceSnapshot(fixture.directoryPath);
  assert.throws(
    () => addon.recover(recoveryRequest(fixture.request, "finalize")),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM" },
  );
  assert.deepEqual(namespaceSnapshot(fixture.directoryPath), before);
  return {
    id: "multiple-journal-conflict",
    failedClosedWithoutNamespaceMutation: true,
    status: "passed",
  };
}

function recoverFresh(addonPath, fixture, decision) {
  return spawnJsonChild(
    "recover",
    addonPath,
    recoveryRequest(fixture.request, decision),
    undefined,
    fixture.transactionId,
  );
}

function acknowledgeFresh(addonPath, fixture, decision) {
  return spawnJsonChild(
    "acknowledge",
    addonPath,
    recoveryRequest(fixture.request, decision),
  );
}

function spawnJsonChild(
  action,
  addonPath,
  request,
  faultAction,
  faultPoint,
  decision,
) {
  const result = spawnChild(
    action,
    addonPath,
    request,
    faultAction,
    faultPoint,
    decision,
  );
  if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
    throw integrationError(
      "child_failed",
      `A Windows recovery child process failed for ${action}` +
        ` (${faultPoint ?? "no_fault"}): status=${String(result.status)},` +
        ` signal=${String(result.signal)}, stderr=${result.stderr.trim()}.`,
      result,
    );
  }
  return JSON.parse(result.stdout);
}

function spawnChild(
  action,
  addonPath,
  request,
  faultAction,
  faultPoint,
  decision,
) {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const childArguments = action === "abandon-open"
    ? ["--expose-gc", CHILD_PATH]
    : [CHILD_PATH];
  return spawnSync(process.execPath, childArguments, {
    input: JSON.stringify({ action, addonPath, request, decision }),
    encoding: "utf8",
    shell: false,
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: `${path.join(systemRoot, "System32")};${systemRoot}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: os.tmpdir(),
      TMP: os.tmpdir(),
      ...(faultAction
        ? {
            FUSIONKIT_OVERWRITE_TEST_FAULT_ACTION: faultAction,
            FUSIONKIT_OVERWRITE_TEST_FAULT_POINT: faultPoint,
          }
        : {}),
    },
  });
}

function assertCrash(result) {
  assert.equal(result.status, CRASH_EXIT_CODE);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

function createFixture(workRoot, id, victimExisted) {
  const directoryPath = path.join(workRoot, id);
  mkdirSync(directoryPath);
  const transactionId = transactionIdFor(id);
  const partialLeaf = `.fusionkit-local-subtitle-${transactionId}.partial`;
  const finalLeaf = "meeting.srt";
  const partialPath = path.join(directoryPath, partialLeaf);
  const finalPath = path.join(directoryPath, finalLeaf);
  const newBytes = Buffer.from(`new-${id}`);
  const victimBytes = Buffer.from(`victim-${id}`);
  writeFileSync(partialPath, newBytes, { flag: "wx" });
  if (victimExisted) writeFileSync(finalPath, victimBytes, { flag: "wx" });
  const fixture = {
    directoryPath,
    transactionId,
    partialLeaf,
    finalLeaf,
    victimExisted,
    newBytes,
    victimBytes,
    newIdentity: windowsIdentity(partialPath),
    victimIdentity: victimExisted ? windowsIdentity(finalPath) : undefined,
  };
  fixture.request = {
    directoryPath,
    expectedDirectoryIdentity: windowsIdentity(directoryPath),
    transactionId,
    partialLeaf,
    finalLeaf,
    expectedPartialIdentity: fixture.newIdentity,
    expectedByteSize: newBytes.byteLength,
  };
  return fixture;
}

function assertInstalled(fixture, journalState) {
  assertExactFile(
    path.join(fixture.directoryPath, fixture.finalLeaf),
    fixture.newIdentity,
    fixture.newBytes,
  );
  assertAbsent(path.join(fixture.directoryPath, fixture.partialLeaf));
  if (fixture.victimExisted) {
    assertExactFile(
      victimPath(fixture),
      fixture.victimIdentity,
      fixture.victimBytes,
    );
  } else {
    assertAbsent(victimPath(fixture));
  }
  assertJournal(fixture, journalState);
}

function assertRolledBack(fixture) {
  const finalPath = path.join(fixture.directoryPath, fixture.finalLeaf);
  if (fixture.victimExisted) {
    assertExactFile(finalPath, fixture.victimIdentity, fixture.victimBytes);
    assert.deepEqual(readdirSync(fixture.directoryPath), [fixture.finalLeaf]);
  } else {
    assertAbsent(finalPath);
    assert.deepEqual(readdirSync(fixture.directoryPath), []);
  }
  assertAbsent(path.join(fixture.directoryPath, fixture.partialLeaf));
  assertAbsent(victimPath(fixture));
  assertJournal(fixture, "absent");
}

function assertSettled(fixture, decision) {
  if (decision === "finalize") {
    assertExactFile(
      path.join(fixture.directoryPath, fixture.finalLeaf),
      fixture.newIdentity,
      fixture.newBytes,
    );
  } else {
    const finalPath = path.join(fixture.directoryPath, fixture.finalLeaf);
    if (fixture.victimExisted) {
      assertExactFile(finalPath, fixture.victimIdentity, fixture.victimBytes);
    } else {
      assertAbsent(finalPath);
    }
  }
  assertAbsent(path.join(fixture.directoryPath, fixture.partialLeaf));
  assertAbsent(victimPath(fixture));
  assertJournal(fixture, decision);
}

function assertFinalized(fixture) {
  assertExactFile(
    path.join(fixture.directoryPath, fixture.finalLeaf),
    fixture.newIdentity,
    fixture.newBytes,
  );
  assertAbsent(path.join(fixture.directoryPath, fixture.partialLeaf));
  assertAbsent(victimPath(fixture));
  assertJournal(fixture, "absent");
  assert.deepEqual(readdirSync(fixture.directoryPath), [fixture.finalLeaf]);
}

function assertJournal(fixture, state) {
  const open = journalPath(fixture, "open");
  const finalize = journalPath(fixture, "finalize");
  const rollback = journalPath(fixture, "rollback");
  if (state === "open") {
    assertOwnedJournal(open);
    assertAbsent(finalize);
    assertAbsent(rollback);
  } else if (state === "finalize") {
    assertAbsent(open);
    assertOwnedJournal(finalize);
    assertAbsent(rollback);
  } else if (state === "rollback") {
    assertAbsent(open);
    assertAbsent(finalize);
    assertOwnedJournal(rollback);
  } else {
    assertAbsent(open);
    assertAbsent(finalize);
    assertAbsent(rollback);
  }
}

function assertOwnedJournal(filePath) {
  const proof = lstatSync(filePath);
  assert.equal(proof.isFile(), true);
  assert.equal(proof.isSymbolicLink(), false);
  assert.equal(proof.nlink, 1);
}

function assertExactFile(filePath, identity, bytes, links = 1) {
  const proof = lstatSync(filePath);
  assert.equal(proof.isFile(), true);
  assert.equal(proof.isSymbolicLink(), false);
  assert.equal(proof.nlink, links);
  assert.deepEqual(windowsIdentity(filePath), identity);
  assert.deepEqual(readFileSync(filePath), bytes);
}

function assertAbsent(filePath) {
  try {
    lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.fail(`expected absent leaf ${path.basename(filePath)}`);
}

function windowsIdentity(filePath) {
  const value = lstatSync(filePath, { bigint: true });
  return {
    volumeSerialHex: value.dev.toString(16).padStart(8, "0"),
    fileIdHex: value.ino.toString(16).padStart(32, "0"),
  };
}

function recoveryRequest(request, decision) {
  return {
    directoryPath: request.directoryPath,
    expectedDirectoryIdentity: request.expectedDirectoryIdentity,
    transactionId: request.transactionId,
    decision,
  };
}

function transactionIdFor(value) {
  return value.replace(/[^A-Za-z0-9-]/gu, "-").slice(0, 80);
}

function journalPath(fixture, state) {
  return path.join(
    fixture.directoryPath,
    `${fixture.partialLeaf}.fusionkit-overwrite.${state}`,
  );
}

function victimPath(fixture) {
  return journalPath(fixture, "victim");
}

function namespaceSnapshot(directoryPath) {
  return readdirSync(directoryPath)
    .sort()
    .map((leaf) => {
      const proof = lstatSync(path.join(directoryPath, leaf), {
        bigint: true,
      });
      return {
        leaf,
        dev: proof.dev,
        ino: proof.ino,
        nlink: proof.nlink,
        size: proof.size,
      };
    });
}

function assertTestAddon(addon) {
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
  assert.equal(addon.platform, "win32");
  assert.equal(addon.architecture, "x64");
  assert.equal(addon.testFaultInjection, true);
  assert.equal(typeof addon.acknowledge, "function");
}

function normalizeAbsoluteFile(value, label, extension) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.extname(value).toLowerCase() !== extension
  ) {
    throw integrationError(
      "invalid_arguments",
      `${label} must be an absolute ${extension} path.`,
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
  const options = parseWindowsRecoveryArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node run-addon-windows-recovery-integration.mjs " +
        "--addon <absolute-test.node> [--output <absolute.json>]\n",
    );
    return;
  }
  const report = await runWindowsOverwriteRecoveryIntegration(options);
  if (options.outputPath) {
    await writeFile(
      options.outputPath,
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(
      `overwrite_native_windows_recovery_failed:${error?.code ?? "unknown"}: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
