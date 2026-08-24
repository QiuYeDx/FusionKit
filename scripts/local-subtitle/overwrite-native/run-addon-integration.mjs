#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const DEFAULT_TEMP_ROOT = "/tmp";

export function parseIntegrationArguments(argv) {
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

export async function runOverwriteNativeIntegration(options = {}) {
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
    throw integrationError("invalid_addon", "The addon must be a regular non-symlink file.");
  }
  const canonicalAddonPath = await realpath(addonPath);
  const addon = options.loadAddon
    ? options.loadAddon(canonicalAddonPath)
    : require(canonicalAddonPath);
  assertAddonContract(addon);

  const tempRoot = options.tempRoot === undefined
    ? DEFAULT_TEMP_ROOT
    : normalizeAbsoluteDirectoryPath(options.tempRoot, "tempRoot");
  const workRoot = await mkdtemp(
    path.join(tempRoot, "fusionkit-overwrite-native-integration-"),
  );
  try {
    const cases = [
      runTerminalCase(addon, workRoot, {
        id: "existing-victim-finalize",
        victim: true,
        terminal: "finalize",
      }),
      runTerminalCase(addon, workRoot, {
        id: "existing-victim-rollback",
        victim: true,
        terminal: "rollback",
      }),
      runTerminalCase(addon, workRoot, {
        id: "absent-victim-finalize",
        victim: false,
        terminal: "finalize",
      }),
      runTerminalCase(addon, workRoot, {
        id: "absent-victim-rollback",
        victim: false,
        terminal: "rollback",
      }),
    ];
    const retainedDirectory = runRetainedDirectoryCase(addon, workRoot);
    const openJournalDecisions = runOpenJournalDecisionCases(addon, workRoot);
    const terminalDecisionConflicts = runTerminalDecisionConflictCases(
      addon,
      workRoot,
    );
    const recoveryRequestCases = runRecoveryRequestCases(addon, workRoot);
    const journalValidationCases = runJournalValidationCases(addon, workRoot);
    const rollbackCleanupRetry = runRollbackCleanupRetryCase(addon, workRoot);
    const rejectionCases = [
      runIdentityMismatchCase(addon, workRoot),
      runSizeMismatchCase(addon, workRoot),
      runSymlinkRejectionCase(addon, workRoot),
      runHardLinkRejectionCase(addon, workRoot),
      runFifoRejectionCase(canonicalAddonPath, workRoot),
      runBeginFailureHandleReleaseCase(addon, workRoot),
    ];
    const report = deepFreeze({
      schemaVersion: 1,
      workPackage: "FS-TXN-001F",
      target: { platform: "darwin", arch: "arm64" },
      addon: {
        component: "local-subtitle-overwrite",
        protocolVersion: addon.protocolVersion,
        platform: addon.platform,
        architecture: addon.architecture,
      },
      cases,
      retainedDirectory,
      openJournalDecisions,
      terminalDecisionConflicts,
      recoveryRequestCases,
      journalValidationCases,
      rollbackCleanupRetry,
      rejectionCases,
      status: "passed",
      productionGateChanged: false,
      privacy: {
        absolutePathsRecorded: false,
        fileContentRecorded: false,
        usernameRecorded: false,
      },
    });
    assert.equal(JSON.stringify(report).includes(workRoot), false);
    return report;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

function runJournalValidationCases(addon, workRoot) {
  return [
    runJournalValidationCase(addon, workRoot, {
      id: "journal-truncated",
      mutate(fixture) {
        writeFileSync(
          fixture.journalPath,
          fixture.journalBytes.subarray(0, Math.floor(fixture.journalBytes.length / 2)),
          { flag: "w" },
        );
        return () => restoreJournalBytes(fixture);
      },
    }),
    runJournalValidationCase(addon, workRoot, {
      id: "journal-checksum-mismatch",
      mutate(fixture) {
        const changed = Buffer.from(fixture.journalBytes);
        changed[20] ^= 0x01;
        writeFileSync(fixture.journalPath, changed, { flag: "w" });
        return () => restoreJournalBytes(fixture);
      },
    }),
    runJournalValidationCase(addon, workRoot, {
      id: "journal-version-mismatch",
      mutate(fixture) {
        const changed = Buffer.from(fixture.journalBytes);
        changed.writeUInt32LE(2, 8);
        changed.writeUInt32LE(
          journalChecksum(changed.subarray(0, changed.length - 4)),
          changed.length - 4,
        );
        writeFileSync(fixture.journalPath, changed, { flag: "w" });
        return () => restoreJournalBytes(fixture);
      },
    }),
    runJournalValidationCase(addon, workRoot, {
      id: "journal-transaction-id-mismatch",
      mutate(fixture) {
        const changed = Buffer.from(fixture.journalBytes);
        const transactionIdLength = changed.readUInt16LE(20);
        assert.equal(transactionIdLength, fixture.request.transactionId.length);
        changed[22] = changed[22] === 0x41 ? 0x42 : 0x41;
        changed.writeUInt32LE(
          journalChecksum(changed.subarray(0, changed.length - 4)),
          changed.length - 4,
        );
        writeFileSync(fixture.journalPath, changed, { flag: "w" });
        return () => restoreJournalBytes(fixture);
      },
    }),
    runJournalValidationCase(addon, workRoot, {
      id: "journal-symlink-replacement",
      mutate(fixture) {
        const displacedLeaf = `${fixture.journalLeaf}.displaced`;
        const displacedPath = path.join(fixture.directoryPath, displacedLeaf);
        renameSync(fixture.journalPath, displacedPath);
        symlinkSync(displacedLeaf, fixture.journalPath);
        return () => {
          unlinkSync(fixture.journalPath);
          renameSync(displacedPath, fixture.journalPath);
        };
      },
    }),
    runJournalValidationCase(addon, workRoot, {
      id: "journal-hardlink",
      mutate(fixture) {
        const aliasPath = path.join(
          fixture.directoryPath,
          `${fixture.journalLeaf}.alias`,
        );
        linkSync(fixture.journalPath, aliasPath);
        return () => unlinkSync(aliasPath);
      },
    }),
    runJournalValidationCase(addon, workRoot, {
      id: "journal-regular-file-replacement",
      mutate(fixture) {
        const displacedPath = path.join(
          fixture.directoryPath,
          `${fixture.journalLeaf}.displaced`,
        );
        renameSync(fixture.journalPath, displacedPath);
        writeFileSync(fixture.journalPath, "foreign-journal", {
          flag: "wx",
          mode: 0o600,
        });
        return () => {
          unlinkSync(fixture.journalPath);
          renameSync(displacedPath, fixture.journalPath);
        };
      },
    }),
    runJournalValidationCase(addon, workRoot, {
      id: "journal-open-and-rollback",
      mutate(fixture) {
        const rollbackPath = path.join(
          fixture.directoryPath,
          `${fixture.request.partialLeaf}.fusionkit-overwrite.rollback`,
        );
        linkSync(fixture.journalPath, rollbackPath);
        return () => unlinkSync(rollbackPath);
      },
    }),
  ];
}

function runJournalValidationCase(addon, workRoot, options) {
  const fixture = createOpenJournalFixture(addon, workRoot, options.id);
  const before = businessNamespaceSnapshot(fixture);
  const restore = options.mutate?.(fixture);
  try {
    let observedError;
    try {
      addon.recover(
        options.recoveryRequest?.(fixture) ?? recoveryRequest(fixture.request),
      );
    } catch (error) {
      observedError = error;
    }
    assert.equal(
      observedError?.code,
      "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
    );
    assert.deepEqual(businessNamespaceSnapshot(fixture), before);

  } finally {
    restore?.();
    invokeSynchronous(
      fixture.receipt.rollback,
      fixture.receipt,
      `${options.id} cleanup rollback`,
    );
    invokeSynchronous(
      fixture.receipt.acknowledge,
      fixture.receipt,
      `${options.id} cleanup acknowledge`,
    );
  }
  return Object.freeze({
    id: options.id,
    recoveryErrorCode: "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
    outputNamespaceUnchanged: true,
    rejected: true,
    passed: true,
  });
}

function createOpenJournalFixture(addon, workRoot, id) {
  const directoryPath = path.join(workRoot, id);
  const partialLeaf = partialLeafFor(transactionIdFor(id));
  const finalLeaf = `${id}.srt`;
  const partialPath = path.join(directoryPath, partialLeaf);
  const finalPath = path.join(directoryPath, finalLeaf);
  const journalLeaf = `${partialLeaf}.fusionkit-overwrite.open`;
  const journalPath = path.join(directoryPath, journalLeaf);
  const newBytes = Buffer.from(`new-${id}`, "utf8");
  const victimBytes = Buffer.from(`victim-${id}`, "utf8");
  mkdirSync(directoryPath, { mode: 0o700 });
  writeFileSync(partialPath, newBytes, { flag: "wx", mode: 0o600 });
  writeFileSync(finalPath, victimBytes, { flag: "wx", mode: 0o600 });
  const request = createRequest(
    directoryPath,
    partialLeaf,
    finalLeaf,
    newBytes.byteLength,
  );
  const receipt = addon.begin(request);
  assertReceiptContract(receipt);
  const journalStat = lstatSync(journalPath);
  assert.equal(journalStat.isFile(), true);
  assert.equal(journalStat.isSymbolicLink(), false);
  assert.equal(journalStat.nlink, 1);
  return {
    directoryPath,
    partialLeaf,
    finalLeaf,
    partialPath,
    finalPath,
    journalLeaf,
    journalPath,
    journalBytes: readFileSync(journalPath),
    request,
    receipt,
  };
}

function restoreJournalBytes(fixture) {
  writeFileSync(fixture.journalPath, fixture.journalBytes, { flag: "w" });
}

function businessNamespaceSnapshot(fixture) {
  return {
    partial: businessLeafSnapshot(fixture.partialPath),
    final: businessLeafSnapshot(fixture.finalPath),
  };
}

function businessLeafSnapshot(filePath) {
  const value = lstatSync(filePath, { bigint: true });
  assert.equal(value.isFile(), true);
  assert.equal(value.isSymbolicLink(), false);
  return {
    dev: value.dev,
    ino: value.ino,
    birthtimeNs: value.birthtimeNs,
    ctimeNs: value.ctimeNs,
    mtimeNs: value.mtimeNs,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
    bytes: readFileSync(filePath),
  };
}

function journalChecksum(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (value ^ byte) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = ((value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320)) >>> 0;
    }
  }
  return (~value) >>> 0;
}

function runOpenJournalDecisionCases(addon, workRoot) {
  return ["rollback", "finalize"].map((decision) => {
    const fixture = createOpenJournalFixture(
      addon,
      workRoot,
      `open-journal-${decision}`,
    );
    const recovery = addon.recover(recoveryRequest(fixture.request, decision));
    assertExactOwnKeys(recovery, ["state"]);
    const expectedState = decision === "finalize" ? "finalized" : "rolled_back";
    assert.equal(recovery.state, expectedState);
    assert.deepEqual(
      addon.acknowledge(recoveryRequest(fixture.request, decision)),
      { state: "acknowledged" },
    );
    assert.equal(
      addon.recover(recoveryRequest(fixture.request, decision)).state,
      "not_found",
    );
    assert.equal(pathExists(fixture.partialPath), false);
    assert.deepEqual(
      readFileSync(fixture.finalPath),
      decision === "finalize" ? Buffer.from(`new-open-journal-${decision}`) :
        Buffer.from(`victim-open-journal-${decision}`),
    );
    return Object.freeze({
      id: `open-journal-${decision}`,
      decision,
      recoveryState: expectedState,
      explicitTerminalDecisionApplied: true,
      passed: true,
    });
  });
}

function runTerminalDecisionConflictCases(addon, workRoot) {
  return ["rollback", "finalize"].map((terminalDecision) => {
    const fixture = createOpenJournalFixture(
      addon,
      workRoot,
      `terminal-conflict-${terminalDecision}`,
    );
    const terminalJournalPath = path.join(
      fixture.directoryPath,
      `${fixture.partialLeaf}.fusionkit-overwrite.${terminalDecision}`,
    );
    renameSync(fixture.journalPath, terminalJournalPath);
    const before = businessNamespaceSnapshot(fixture);
    const conflictingDecision = terminalDecision === "finalize"
      ? "rollback"
      : "finalize";
    assert.throws(
      () => addon.recover(
        recoveryRequest(fixture.request, conflictingDecision),
      ),
      (error) => error?.code === "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
    );
    assert.deepEqual(businessNamespaceSnapshot(fixture), before);
    assert.throws(
      () => addon.acknowledge(
        recoveryRequest(fixture.request, conflictingDecision),
      ),
      (error) => error?.code === "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
    );
    assert.deepEqual(businessNamespaceSnapshot(fixture), before);
    const recovery = addon.recover(
      recoveryRequest(fixture.request, terminalDecision),
    );
    assert.equal(
      recovery.state,
      terminalDecision === "finalize" ? "finalized" : "rolled_back",
    );
    assert.deepEqual(
      addon.acknowledge(
        recoveryRequest(fixture.request, terminalDecision),
      ),
      { state: "acknowledged" },
    );
    return Object.freeze({
      id: `terminal-conflict-${terminalDecision}`,
      terminalDecision,
      conflictingDecision,
      conflictRejectedWithoutBusinessMutation: true,
      passed: true,
    });
  });
}

function runRecoveryRequestCases(addon, workRoot) {
  const fixture = createOpenJournalFixture(
    addon,
    workRoot,
    "recovery-request-contract",
  );
  const before = businessNamespaceSnapshot(fixture);
  try {
    assert.throws(
      () => addon.recover(fixture.request),
      (error) => error?.code === "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST",
    );
    assert.deepEqual(businessNamespaceSnapshot(fixture), before);

    assert.throws(
      () => addon.acknowledge(fixture.request),
      (error) => error?.code === "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST",
    );
    assert.deepEqual(businessNamespaceSnapshot(fixture), before);

    assert.throws(
      () => addon.acknowledge(recoveryRequest(fixture.request)),
      (error) => error?.code === "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
    );
    assert.deepEqual(businessNamespaceSnapshot(fixture), before);

    assert.throws(
      () => addon.recover({
        ...recoveryRequest(fixture.request),
        transactionId: "invalid_transaction_id",
      }),
      (error) => error?.code === "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST",
    );
    assert.deepEqual(businessNamespaceSnapshot(fixture), before);

    assert.throws(
      () => addon.recover({
        ...recoveryRequest(fixture.request),
        decision: "undecided",
      }),
      (error) => error?.code === "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST",
    );
    assert.deepEqual(businessNamespaceSnapshot(fixture), before);

    const wrongIdRecovery = addon.recover({
      ...recoveryRequest(fixture.request),
      transactionId: "different-valid-transaction",
    });
    assert.deepEqual(wrongIdRecovery, { state: "not_found" });
    assert.deepEqual(businessNamespaceSnapshot(fixture), before);
  } finally {
    invokeSynchronous(
      fixture.receipt.rollback,
      fixture.receipt,
      "recovery request contract cleanup rollback",
    );
    invokeSynchronous(
      fixture.receipt.acknowledge,
      fixture.receipt,
      "recovery request contract cleanup acknowledge",
    );
  }

  const mismatch = createRejectionFixture(
    workRoot,
    "begin-transaction-leaf-mismatch",
  );
  const mismatchRequest = createRequest(
    mismatch.directoryPath,
    mismatch.partialLeaf,
    mismatch.finalLeaf,
    mismatch.partialBytes.byteLength,
  );
  mismatchRequest.transactionId = "different-valid-transaction";
  assert.throws(
    () => addon.begin(mismatchRequest),
    (error) => error?.code === "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST",
  );
  assertRejectionFixtureUnchanged(mismatch);

  return Object.freeze([
    Object.freeze({ id: "recover-exact-own-keys", passed: true }),
    Object.freeze({ id: "acknowledge-exact-own-keys", passed: true }),
    Object.freeze({ id: "acknowledge-rejects-open-journal", passed: true }),
    Object.freeze({ id: "recover-transaction-id-validation", passed: true }),
    Object.freeze({ id: "recover-decision-validation", passed: true }),
    Object.freeze({ id: "recover-exact-id-no-scan", passed: true }),
    Object.freeze({ id: "begin-transaction-partial-match", passed: true }),
  ]);
}

function runTerminalCase(addon, workRoot, options) {
  const directoryPath = path.join(workRoot, options.id);
  mkdirSync(directoryPath, { mode: 0o700 });
  const partialLeaf = partialLeafFor(transactionIdFor(options.id));
  const finalLeaf = "meeting.srt";
  const partialPath = path.join(directoryPath, partialLeaf);
  const finalPath = path.join(directoryPath, finalLeaf);
  const newBytes = Buffer.from(`new-${options.id}`, "utf8");
  const victimBytes = Buffer.from(`victim-${options.id}`, "utf8");
  writeFileSync(partialPath, newBytes, { flag: "wx", mode: 0o600 });
  if (options.victim) {
    writeFileSync(finalPath, victimBytes, { flag: "wx", mode: 0o600 });
  }

  const request = createRequest(
    directoryPath,
    partialLeaf,
    finalLeaf,
    newBytes.byteLength,
  );
  const receipt = addon.begin(request);
  assertReceiptContract(receipt);
  if (options.victim) {
    assert.deepEqual(readFileSync(partialPath), victimBytes);
  } else {
    assert.equal(pathExists(partialPath), false);
  }
  assert.deepEqual(readFileSync(finalPath), newBytes);
  assert.deepEqual(receipt.expectedFinalIdentity, fileIdentity(finalPath));
  invokeSynchronous(receipt[options.terminal], receipt, options.terminal);
  const recovery = addon.recover(recoveryRequest(request, options.terminal));
  assertExactOwnKeys(recovery, ["state"]);
  assert.equal(
    recovery.state,
    options.terminal === "finalize" ? "finalized" : "rolled_back",
  );
  invokeSynchronous(receipt.acknowledge, receipt, "acknowledge");
  assert.equal(
    addon.recover(recoveryRequest(request, options.terminal)).state,
    "not_found",
  );

  if (options.terminal === "finalize") {
    assert.equal(pathExists(partialPath), false);
    assert.deepEqual(readFileSync(finalPath), newBytes);
    assert.deepEqual(readdirSync(directoryPath).sort(), [finalLeaf]);
  } else {
    assert.equal(pathExists(partialPath), false);
    if (options.victim) {
      assert.deepEqual(readFileSync(finalPath), victimBytes);
      assert.deepEqual(readdirSync(directoryPath), [finalLeaf]);
    } else {
      assert.equal(pathExists(finalPath), false);
      assert.deepEqual(readdirSync(directoryPath), []);
    }
  }
  return Object.freeze({
    id: options.id,
    priorVictim: options.victim ? "existing" : "absent",
    terminal: options.terminal,
    terminalJournalRemovedAfterAcknowledge: true,
    passed: true,
  });
}

function runRetainedDirectoryCase(addon, workRoot) {
  const activePath = path.join(workRoot, "retained-directory-active");
  const retainedPath = path.join(workRoot, "retained-directory-renamed");
  const partialLeaf = partialLeafFor("retained-directory");
  const finalLeaf = "retained.srt";
  const partialBytes = Buffer.from("retained-directory-new", "utf8");
  const victimBytes = Buffer.from("retained-directory-victim", "utf8");
  const replacementBytes = Buffer.from("replacement-directory-sentinel", "utf8");
  mkdirSync(activePath, { mode: 0o700 });
  writeFileSync(path.join(activePath, partialLeaf), partialBytes, {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(path.join(activePath, finalLeaf), victimBytes, {
    flag: "wx",
    mode: 0o600,
  });

  const receipt = addon.begin(
    createRequest(activePath, partialLeaf, finalLeaf, partialBytes.byteLength),
  );
  assertReceiptContract(receipt);
  renameSync(activePath, retainedPath);
  mkdirSync(activePath, { mode: 0o700 });
  writeFileSync(path.join(activePath, finalLeaf), replacementBytes, {
    flag: "wx",
    mode: 0o600,
  });
  invokeSynchronous(receipt.rollback, receipt, "rollback");
  invokeSynchronous(receipt.acknowledge, receipt, "acknowledge");

  assert.equal(pathExists(path.join(retainedPath, partialLeaf)), false);
  assert.deepEqual(readFileSync(path.join(retainedPath, finalLeaf)), victimBytes);
  assert.deepEqual(readdirSync(retainedPath), [finalLeaf]);
  assert.deepEqual(readFileSync(path.join(activePath, finalLeaf)), replacementBytes);
  assert.deepEqual(readdirSync(activePath), [finalLeaf]);
  return Object.freeze({
    id: "retained-dirfd-parent-replacement-rollback",
    originalDirectoryRenamed: true,
    replacementDirectoryUntouched: true,
    victimRestoredAndNewPartialRemovedInRetainedDirectory: true,
    passed: true,
  });
}

function runRollbackCleanupRetryCase(addon, workRoot) {
  const directoryPath = path.join(workRoot, "rollback-cleanup-retry");
  const partialLeaf = partialLeafFor("rollback-cleanup-retry");
  const finalLeaf = "retry.srt";
  const aliasLeaf = ".retry.srt.external-link";
  const partialPath = path.join(directoryPath, partialLeaf);
  const finalPath = path.join(directoryPath, finalLeaf);
  const aliasPath = path.join(directoryPath, aliasLeaf);
  const partialBytes = Buffer.from("rollback-retry-new", "utf8");
  const victimBytes = Buffer.from("rollback-retry-victim", "utf8");
  mkdirSync(directoryPath, { mode: 0o700 });
  writeFileSync(partialPath, partialBytes, { flag: "wx", mode: 0o600 });
  writeFileSync(finalPath, victimBytes, { flag: "wx", mode: 0o600 });

  const receipt = addon.begin(
    createRequest(directoryPath, partialLeaf, finalLeaf, partialBytes.byteLength),
  );
  assertReceiptContract(receipt);
  linkSync(finalPath, aliasPath);

  assert.throws(
    () => invokeSynchronous(receipt.rollback, receipt, "rollback"),
    (error) => error?.code === "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
  );
  assert.deepEqual(readFileSync(finalPath), victimBytes);
  assert.deepEqual(readFileSync(partialPath), partialBytes);
  assert.deepEqual(readFileSync(aliasPath), partialBytes);

  unlinkSync(aliasPath);
  invokeSynchronous(receipt.rollback, receipt, "rollback retry");
  invokeSynchronous(receipt.acknowledge, receipt, "rollback acknowledge");
  assert.deepEqual(readFileSync(finalPath), victimBytes);
  assert.equal(pathExists(partialPath), false);
  assert.deepEqual(readdirSync(directoryPath), [finalLeaf]);
  return Object.freeze({
    id: "rollback-cleanup-hard-link-retry",
    firstRollbackRestoredVictim: true,
    firstRollbackRemainedCleanupPending: true,
    retryRemovedExactNewInode: true,
    passed: true,
  });
}

function runIdentityMismatchCase(addon, workRoot) {
  const fixture = createRejectionFixture(workRoot, "identity-mismatch");
  const request = createRequest(
    fixture.directoryPath,
    fixture.partialLeaf,
    fixture.finalLeaf,
    fixture.partialBytes.byteLength,
  );
  request.expectedPartialIdentity.ino += 1;
  assert.throws(() => addon.begin(request));
  assertRejectionFixtureUnchanged(fixture);
  return Object.freeze({ id: "partial-identity-mismatch", rejected: true, passed: true });
}

function runSizeMismatchCase(addon, workRoot) {
  const fixture = createRejectionFixture(workRoot, "size-mismatch");
  const request = createRequest(
    fixture.directoryPath,
    fixture.partialLeaf,
    fixture.finalLeaf,
    fixture.partialBytes.byteLength + 1,
  );
  assert.throws(() => addon.begin(request));
  assertRejectionFixtureUnchanged(fixture);
  return Object.freeze({ id: "partial-size-mismatch", rejected: true, passed: true });
}

function runSymlinkRejectionCase(addon, workRoot) {
  const directoryPath = path.join(workRoot, "symlink-rejection");
  const sourceLeaf = "source.tmp";
  const transactionId = "symlink-rejection";
  const partialLeaf = partialLeafFor(transactionId);
  const finalLeaf = "symlink.srt";
  const sourceBytes = Buffer.from("symlink-source", "utf8");
  const victimBytes = Buffer.from("symlink-victim", "utf8");
  mkdirSync(directoryPath, { mode: 0o700 });
  writeFileSync(path.join(directoryPath, sourceLeaf), sourceBytes, {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(path.join(directoryPath, finalLeaf), victimBytes, {
    flag: "wx",
    mode: 0o600,
  });
  symlinkSync(sourceLeaf, path.join(directoryPath, partialLeaf));
  const partialStat = lstatSync(path.join(directoryPath, partialLeaf));
  const request = {
    directoryPath,
    expectedDirectoryIdentity: directoryIdentity(directoryPath),
    transactionId,
    partialLeaf,
    finalLeaf,
    expectedPartialIdentity: identityFromStat(partialStat),
    expectedByteSize: partialStat.size,
  };
  assert.throws(() => addon.begin(request));
  assert.equal(lstatSync(path.join(directoryPath, partialLeaf)).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(path.join(directoryPath, sourceLeaf)), sourceBytes);
  assert.deepEqual(readFileSync(path.join(directoryPath, finalLeaf)), victimBytes);
  assert.deepEqual(
    readdirSync(directoryPath).sort(),
    [sourceLeaf, partialLeaf, finalLeaf].sort(),
  );
  return Object.freeze({ id: "partial-symlink", rejected: true, passed: true });
}

function runHardLinkRejectionCase(addon, workRoot) {
  const fixture = createRejectionFixture(workRoot, "hard-link-rejection");
  const aliasLeaf = `${fixture.partialLeaf}.alias`;
  linkSync(
    path.join(fixture.directoryPath, fixture.partialLeaf),
    path.join(fixture.directoryPath, aliasLeaf),
  );
  const request = createRequest(
    fixture.directoryPath,
    fixture.partialLeaf,
    fixture.finalLeaf,
    fixture.partialBytes.byteLength,
  );

  assert.throws(() => addon.begin(request));
  assertRejectionFixtureUnchanged(fixture, [aliasLeaf]);
  assert.deepEqual(
    readFileSync(path.join(fixture.directoryPath, aliasLeaf)),
    fixture.partialBytes,
  );
  return Object.freeze({
    id: "partial-multiple-links",
    rejected: true,
    passed: true,
  });
}

function runFifoRejectionCase(addonPath, workRoot) {
  const directoryPath = path.join(workRoot, "fifo-rejection");
  const transactionId = "fifo-rejection";
  const partialLeaf = partialLeafFor(transactionId);
  const finalLeaf = "fifo.srt";
  const partialPath = path.join(directoryPath, partialLeaf);
  const finalPath = path.join(directoryPath, finalLeaf);
  const victimBytes = Buffer.from("fifo-victim", "utf8");
  mkdirSync(directoryPath, { mode: 0o700 });
  const mkfifo = spawnSync("/usr/bin/mkfifo", [partialPath], {
    encoding: "utf8",
    shell: false,
    timeout: 2_000,
  });
  assert.equal(mkfifo.status, 0, mkfifo.stderr);
  writeFileSync(finalPath, victimBytes, { flag: "wx", mode: 0o600 });
  const partialStat = lstatSync(partialPath);
  assert.equal(partialStat.isFIFO(), true);
  const request = {
    directoryPath,
    expectedDirectoryIdentity: directoryIdentity(directoryPath),
    transactionId,
    partialLeaf,
    finalLeaf,
    expectedPartialIdentity: identityFromStat(partialStat),
    expectedByteSize: 1,
  };
  const childSource = [
    "const addon = require(process.argv[1]);",
    "const request = JSON.parse(process.argv[2]);",
    "try { addon.begin(request); process.exitCode = 2; }",
    "catch { process.exitCode = 0; }",
  ].join("\n");
  const rejection = spawnSync(
    process.execPath,
    ["-e", childSource, addonPath, JSON.stringify(request)],
    {
      encoding: "utf8",
      shell: false,
      timeout: 2_000,
    },
  );
  assert.equal(rejection.error, undefined);
  assert.equal(rejection.signal, null);
  assert.equal(rejection.status, 0, rejection.stderr);
  assert.equal(lstatSync(partialPath).isFIFO(), true);
  assert.deepEqual(readFileSync(finalPath), victimBytes);
  assert.deepEqual(readdirSync(directoryPath).sort(), [partialLeaf, finalLeaf].sort());
  return Object.freeze({
    id: "partial-fifo-nonblocking-rejection",
    rejectedWithoutBlocking: true,
    passed: true,
  });
}

function runBeginFailureHandleReleaseCase(addon, workRoot) {
  const fixture = createRejectionFixture(workRoot, "begin-failure-handle-release");
  const request = createRequest(
    fixture.directoryPath,
    fixture.partialLeaf,
    fixture.finalLeaf,
    fixture.partialBytes.byteLength,
  );
  const attempts = 64;
  const before = readdirSync("/dev/fd").length;

  chmodSync(fixture.directoryPath, 0o500);
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      assert.throws(
        () => addon.begin(request),
        (error) => error?.code === "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
      );
    }
  } finally {
    chmodSync(fixture.directoryPath, 0o700);
  }

  const after = readdirSync("/dev/fd").length;
  assert.equal(after, before);
  assertRejectionFixtureUnchanged(fixture);
  return Object.freeze({
    id: "begin-failure-handle-release",
    attempts,
    openFileDescriptorDelta: after - before,
    rejectedWithoutHandleLeak: true,
    passed: true,
  });
}

function createRejectionFixture(workRoot, id) {
  const directoryPath = path.join(workRoot, id);
  const partialLeaf = partialLeafFor(transactionIdFor(id));
  const finalLeaf = `${id}.srt`;
  const partialBytes = Buffer.from(`new-${id}`, "utf8");
  const victimBytes = Buffer.from(`victim-${id}`, "utf8");
  mkdirSync(directoryPath, { mode: 0o700 });
  writeFileSync(path.join(directoryPath, partialLeaf), partialBytes, {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(path.join(directoryPath, finalLeaf), victimBytes, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    directoryPath,
    partialLeaf,
    finalLeaf,
    partialBytes,
    victimBytes,
  };
}

function assertRejectionFixtureUnchanged(fixture, additionalLeaves = []) {
  assert.deepEqual(
    readFileSync(path.join(fixture.directoryPath, fixture.partialLeaf)),
    fixture.partialBytes,
  );
  assert.deepEqual(
    readFileSync(path.join(fixture.directoryPath, fixture.finalLeaf)),
    fixture.victimBytes,
  );
  assert.deepEqual(
    readdirSync(fixture.directoryPath).sort(),
    [fixture.partialLeaf, fixture.finalLeaf, ...additionalLeaves].sort(),
  );
}

function createRequest(directoryPath, partialLeaf, finalLeaf, expectedByteSize) {
  const transactionId = transactionIdFromPartialLeaf(partialLeaf);
  return {
    directoryPath,
    expectedDirectoryIdentity: directoryIdentity(directoryPath),
    transactionId,
    partialLeaf,
    finalLeaf,
    expectedPartialIdentity: fileIdentity(path.join(directoryPath, partialLeaf)),
    expectedByteSize,
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

function transactionIdFromPartialLeaf(partialLeaf) {
  const match = /^\.fusionkit-local-subtitle-([A-Za-z0-9-]{1,80})\.partial$/u.exec(
    partialLeaf,
  );
  assert.ok(match);
  return match[1];
}

function directoryIdentity(directoryPath) {
  const directoryStat = lstatSync(directoryPath);
  assert.equal(directoryStat.isDirectory(), true);
  assert.equal(directoryStat.isSymbolicLink(), false);
  return identityFromStat(directoryStat);
}

function fileIdentity(filePath) {
  const fileStat = lstatSync(filePath);
  assert.equal(fileStat.isFile(), true);
  assert.equal(fileStat.isSymbolicLink(), false);
  return identityFromStat(fileStat);
}

function identityFromStat(fileStat) {
  for (const value of [fileStat.dev, fileStat.ino]) {
    assert.equal(Number.isSafeInteger(value), true);
    assert.equal(value >= 0, true);
  }
  assert.equal(Number.isFinite(fileStat.birthtimeMs), true);
  assert.equal(fileStat.birthtimeMs >= 0, true);
  return {
    dev: fileStat.dev,
    ino: fileStat.ino,
    birthtimeMs: fileStat.birthtimeMs,
  };
}

function assertAddonContract(addon) {
  assertExactOwnKeys(addon, [
    "acknowledge",
    "architecture",
    "begin",
    "platform",
    "protocolVersion",
    "recover",
  ]);
  assert.equal(addon.protocolVersion, 4);
  assert.equal(addon.platform, "darwin");
  assert.equal(addon.architecture, "arm64");
  assert.equal(typeof addon.begin, "function");
  assert.equal(typeof addon.recover, "function");
  assert.equal(typeof addon.acknowledge, "function");
}

function assertReceiptContract(receipt) {
  assertExactOwnKeys(receipt, [
    "acknowledge",
    "expectedFinalIdentity",
    "finalize",
    "rollback",
  ]);
  assert.equal(typeof receipt.acknowledge, "function");
  assert.equal(typeof receipt.finalize, "function");
  assert.equal(typeof receipt.rollback, "function");
  assertExactOwnKeys(receipt.expectedFinalIdentity, ["birthtimeMs", "dev", "ino"]);
}

function assertExactOwnKeys(value, expected) {
  assert.ok((typeof value === "object" || typeof value === "function") && value !== null);
  const keys = Reflect.ownKeys(value);
  assert.equal(keys.every((key) => typeof key === "string"), true);
  assert.deepEqual([...keys].sort(), [...expected].sort());
}

function invokeSynchronous(method, receiver, label) {
  const result = method.call(receiver);
  if (
    result &&
    (typeof result === "object" || typeof result === "function") &&
    typeof result.then === "function"
  ) {
    void Promise.resolve(result).catch(() => undefined);
    throw integrationError("async_receipt", `${label} returned a thenable.`);
  }
  assert.equal(result, undefined);
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
      "The overwrite addon integration currently supports only macOS.",
    );
  }
  if (arch !== "arm64") {
    throw integrationError(
      "unsupported_architecture",
      "The overwrite addon integration currently supports only macOS arm64.",
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
  const options = parseIntegrationArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node run-addon-integration.mjs --addon </absolute/path/addon.node> " +
        "[--output </absolute/path/integration-report.json>]\n",
    );
    return;
  }
  const report = await runOverwriteNativeIntegration(options);
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
      `overwrite_native_integration_failed:${error?.code ?? "unknown"}: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
