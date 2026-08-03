#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export function parseWindowsIntegrationArguments(argv) {
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

export async function runWindowsOverwriteNativeIntegration(options = {}) {
  assertSupportedHost(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  const addonPath = normalizeAbsoluteFile(
    options.addonPath,
    "addonPath",
    ".node",
  );
  const addonProof = await lstat(addonPath);
  if (!addonProof.isFile() || addonProof.isSymbolicLink()) {
    throw integrationError(
      "invalid_addon",
      "The Windows overwrite addon must be a regular non-symlink file.",
    );
  }
  const canonicalAddonPath = await realpath(addonPath);
  const addon = require(canonicalAddonPath);
  assertAddonContract(addon);
  const workRoot = await mkdtemp(
    path.join(options.tempRoot ?? os.tmpdir(), "fusionkit-overwrite-win-"),
  );
  try {
    const terminalCases = [
      runTerminalCase(addon, workRoot, "existing-finalize", true, "finalize"),
      runTerminalCase(addon, workRoot, "existing-rollback", true, "rollback"),
      runTerminalCase(addon, workRoot, "absent-finalize", false, "finalize"),
      runTerminalCase(addon, workRoot, "absent-rollback", false, "rollback"),
    ];
    const recoveryCases = [
      runOpenDecisionCase(addon, workRoot, true, "finalize"),
      runOpenDecisionCase(addon, workRoot, true, "rollback"),
      runOpenDecisionCase(addon, workRoot, false, "finalize"),
      runOpenDecisionCase(addon, workRoot, false, "rollback"),
      ...runRecoveryRequestCases(addon, workRoot),
    ];
    const rejectionCases = [
      runIdentityMismatchCase(addon, workRoot),
      runSizeMismatchCase(addon, workRoot),
      runHardLinkRejectionCase(addon, workRoot),
      runPartialReparseRejectionCase(addon, workRoot),
      runFinalReparseRejectionCase(addon, workRoot),
      runCaseCollisionRejectionCase(addon, workRoot),
    ];
    const report = deepFreeze({
      schemaVersion: 1,
      workPackage: "FS-TXN-001F",
      target: { platform: "win32", arch: "x64" },
      addon: {
        component: "local-subtitle-overwrite",
        protocolVersion: 4,
        journalVersion: 3,
        testOnly: false,
      },
      terminalCases,
      recoveryCases,
      rejectionCases,
      claims: {
        rootDirectoryRelativeChildOperations: true,
        reparseNoFollowBoundary: true,
        losslessWindowsIdentityStrings: true,
        durableTerminalDecisionRecovery: true,
        terminalAcknowledgementRequired: true,
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
    assert.equal(serialized.includes("new-"), false);
    assert.equal(serialized.includes("victim-"), false);
    return report;
  } finally {
    await rm(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function runTerminalCase(
  addon,
  workRoot,
  id,
  victimExisted,
  terminal,
) {
  const fixture = createFixture(workRoot, id, victimExisted);
  const receipt = invokeSync(
    () => addon.begin(fixture.request),
    "begin",
  );
  assertReceiptContract(receipt);
  assert.deepEqual(
    receipt.expectedFinalIdentity,
    fixture.request.expectedPartialIdentity,
  );
  assertInstalledLayout(fixture);
  assert.throws(
    () => receipt.acknowledge(),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_STATE" },
  );
  invokeSync(() => receipt[terminal](), terminal);
  assertSettledLayout(fixture, terminal);
  assert.throws(
    () => receipt[terminal === "finalize" ? "rollback" : "finalize"](),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_STATE" },
  );
  invokeSync(() => receipt.acknowledge(), "acknowledge");
  if (terminal === "finalize") assertFinalizedLayout(fixture);
  else assertRolledBackLayout(fixture);
  return {
    id,
    priorVictim: victimExisted ? "existing" : "absent",
    terminal,
    status: "passed",
  };
}

function runOpenDecisionCase(addon, workRoot, victimExisted, decision) {
  const id = `open-decision-${victimExisted ? "existing" : "absent"}-${decision}`;
  const fixture = createFixture(workRoot, id, victimExisted);
  const receipt = invokeSync(() => addon.begin(fixture.request), `${id}: begin`);
  assertReceiptContract(receipt);
  const request = recoveryRequest(fixture.request, decision);
  const expectedState = decision === "finalize" ? "finalized" : "rolled_back";
  const result = invokeSync(() => addon.recover(request), `${id}: recover`);
  assert.deepEqual(result, { state: expectedState });
  assertSettledLayout(fixture, decision);
  assert.deepEqual(
    invokeSync(() => addon.acknowledge(request), `${id}: acknowledge`),
    { state: "acknowledged" },
  );
  if (decision === "finalize") assertFinalizedLayout(fixture);
  else assertRolledBackLayout(fixture);
  return {
    id,
    decision,
    state: expectedState,
    acknowledged: true,
    status: "passed",
  };
}

function runRecoveryRequestCases(addon, workRoot) {
  const fixture = createFixture(workRoot, "recovery-request", false);
  assert.deepEqual(addon.recover(recoveryRequest(fixture.request, "rollback")), {
    state: "not_found",
  });
  assert.deepEqual(
    addon.acknowledge(recoveryRequest(fixture.request, "rollback")),
    { state: "not_found" },
  );
  const changedIdentity = {
    ...fixture.request.expectedDirectoryIdentity,
    fileIdHex: flipHex(fixture.request.expectedDirectoryIdentity.fileIdHex),
  };
  assert.throws(
    () => addon.recover({
      ...recoveryRequest(fixture.request, "rollback"),
      expectedDirectoryIdentity: changedIdentity,
    }),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM" },
  );
  assert.throws(
    () => addon.recover({
      ...recoveryRequest(fixture.request, "rollback"),
      fallbackPath: fixture.directoryPath,
    }),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST" },
  );
  assert.throws(
    () => addon.recover({
      directoryPath: fixture.request.directoryPath,
      expectedDirectoryIdentity: fixture.request.expectedDirectoryIdentity,
      transactionId: fixture.request.transactionId,
    }),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST" },
  );
  assert.throws(
    () => addon.recover({
      ...recoveryRequest(fixture.request, "rollback"),
      decision: "commit",
    }),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST" },
  );
  return [
    { id: "not-found", status: "passed" },
    { id: "directory-identity-mismatch", status: "passed" },
    { id: "expanded-request", status: "passed" },
    { id: "missing-decision", status: "passed" },
    { id: "invalid-decision", status: "passed" },
  ];
}

function runIdentityMismatchCase(addon, workRoot) {
  const fixture = createFixture(workRoot, "identity-mismatch", false);
  fixture.request.expectedPartialIdentity = {
    ...fixture.request.expectedPartialIdentity,
    fileIdHex: flipHex(fixture.request.expectedPartialIdentity.fileIdHex),
  };
  assertBeginRejectedUnchanged(addon, fixture);
  return { id: "identity-mismatch", status: "passed" };
}

function runSizeMismatchCase(addon, workRoot) {
  const fixture = createFixture(workRoot, "size-mismatch", true);
  fixture.request.expectedByteSize += 1;
  assertBeginRejectedUnchanged(addon, fixture);
  return { id: "size-mismatch", status: "passed" };
}

function runHardLinkRejectionCase(addon, workRoot) {
  const fixture = createFixture(workRoot, "hard-link", true);
  const aliasLeaf = "partial-alias.srt";
  linkSync(
    path.join(fixture.directoryPath, fixture.partialLeaf),
    path.join(fixture.directoryPath, aliasLeaf),
  );
  assertBeginRejectedUnchanged(addon, fixture, [aliasLeaf]);
  return { id: "multiple-links", status: "passed" };
}

function runPartialReparseRejectionCase(addon, workRoot) {
  const directoryPath = path.join(workRoot, "partial-reparse");
  mkdirSync(directoryPath);
  const transactionId = transactionIdFor("partial-reparse");
  const partialLeaf = partialLeafFor(transactionId);
  const targetPath = path.join(directoryPath, "junction-target");
  mkdirSync(targetPath);
  const partialPath = path.join(directoryPath, partialLeaf);
  symlinkSync(targetPath, partialPath, "junction");
  const request = {
    directoryPath,
    expectedDirectoryIdentity: windowsIdentity(directoryPath),
    transactionId,
    partialLeaf,
    finalLeaf: "meeting.srt",
    expectedPartialIdentity: windowsIdentity(partialPath, true),
    expectedByteSize: 1,
  };
  assert.throws(
    () => addon.begin(request),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM" },
  );
  assert.equal(lstatSync(partialPath).isSymbolicLink(), true);
  assertNoJournal(request);
  return { id: "partial-reparse", status: "passed" };
}

function runFinalReparseRejectionCase(addon, workRoot) {
  const fixture = createFixture(workRoot, "final-reparse", false);
  const target = path.join(fixture.directoryPath, "target-directory");
  mkdirSync(target);
  symlinkSync(
    target,
    path.join(fixture.directoryPath, fixture.finalLeaf),
    "junction",
  );
  assert.throws(
    () => addon.begin(fixture.request),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM" },
  );
  assert.equal(
    lstatSync(path.join(fixture.directoryPath, fixture.finalLeaf))
      .isSymbolicLink(),
    true,
  );
  assertNoJournal(fixture.request);
  return { id: "final-reparse", status: "passed" };
}

function runCaseCollisionRejectionCase(addon, workRoot) {
  const fixture = createFixture(workRoot, "case-collision", false);
  fixture.request.finalLeaf = fixture.partialLeaf.toUpperCase();
  assert.throws(
    () => addon.begin(fixture.request),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST" },
  );
  assertNoJournal(fixture.request);
  return { id: "case-insensitive-leaf-collision", status: "passed" };
}

function assertBeginRejectedUnchanged(
  addon,
  fixture,
  additionalLeaves = [],
) {
  const before = namespaceSnapshot(fixture.directoryPath);
  assert.throws(
    () => addon.begin(fixture.request),
    { code: "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM" },
  );
  assert.deepEqual(namespaceSnapshot(fixture.directoryPath), before);
  assertNoJournal(fixture.request);
  for (const leaf of additionalLeaves) {
    assert.equal(
      lstatSync(path.join(fixture.directoryPath, leaf)).isFile(),
      true,
    );
  }
}

function createFixture(workRoot, id, victimExisted) {
  const directoryPath = path.join(workRoot, id);
  mkdirSync(directoryPath);
  const transactionId = transactionIdFor(id);
  const partialLeaf = partialLeafFor(transactionId);
  const finalLeaf = "meeting.srt";
  const partialPath = path.join(directoryPath, partialLeaf);
  const finalPath = path.join(directoryPath, finalLeaf);
  const newBytes = Buffer.from(`new-${id}`, "utf8");
  const victimBytes = Buffer.from(`victim-${id}`, "utf8");
  writeFileSync(partialPath, newBytes, { flag: "wx" });
  if (victimExisted) writeFileSync(finalPath, victimBytes, { flag: "wx" });
  return {
    directoryPath,
    transactionId,
    partialLeaf,
    finalLeaf,
    victimExisted,
    newBytes,
    victimBytes,
    newIdentity: windowsIdentity(partialPath),
    victimIdentity: victimExisted ? windowsIdentity(finalPath) : undefined,
    request: {
      directoryPath,
      expectedDirectoryIdentity: windowsIdentity(directoryPath),
      transactionId,
      partialLeaf,
      finalLeaf,
      expectedPartialIdentity: windowsIdentity(partialPath),
      expectedByteSize: newBytes.byteLength,
    },
  };
}

function assertInstalledLayout(fixture) {
  assertExactFile(
    path.join(fixture.directoryPath, fixture.finalLeaf),
    fixture.newIdentity,
    fixture.newBytes,
  );
  assertAbsent(path.join(fixture.directoryPath, fixture.partialLeaf));
  assertOwnedJournal(journalPath(fixture, "open"));
  assertAbsent(journalPath(fixture, "finalize"));
  assertAbsent(journalPath(fixture, "rollback"));
  if (fixture.victimExisted) {
    assertExactFile(
      victimBackupPath(fixture),
      fixture.victimIdentity,
      fixture.victimBytes,
    );
  } else {
    assertAbsent(victimBackupPath(fixture));
  }
}

function assertSettledLayout(fixture, decision) {
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
  assertAbsent(victimBackupPath(fixture));
  assertAbsent(journalPath(fixture, "open"));
  assertOwnedJournal(journalPath(fixture, decision));
  assertAbsent(journalPath(
    fixture,
    decision === "finalize" ? "rollback" : "finalize",
  ));
}

function assertFinalizedLayout(fixture) {
  assertExactFile(
    path.join(fixture.directoryPath, fixture.finalLeaf),
    fixture.newIdentity,
    fixture.newBytes,
  );
  assertAbsent(path.join(fixture.directoryPath, fixture.partialLeaf));
  assertAbsent(journalPath(fixture, "open"));
  assertAbsent(journalPath(fixture, "finalize"));
  assertAbsent(journalPath(fixture, "rollback"));
  assertAbsent(victimBackupPath(fixture));
  assert.deepEqual(readdirSync(fixture.directoryPath), [fixture.finalLeaf]);
}

function assertRolledBackLayout(fixture) {
  const finalPath = path.join(fixture.directoryPath, fixture.finalLeaf);
  if (fixture.victimExisted) {
    assertExactFile(finalPath, fixture.victimIdentity, fixture.victimBytes);
    assert.deepEqual(readdirSync(fixture.directoryPath), [fixture.finalLeaf]);
  } else {
    assertAbsent(finalPath);
    assert.deepEqual(readdirSync(fixture.directoryPath), []);
  }
  assertAbsent(path.join(fixture.directoryPath, fixture.partialLeaf));
  assertAbsent(journalPath(fixture, "open"));
  assertAbsent(journalPath(fixture, "finalize"));
  assertAbsent(journalPath(fixture, "rollback"));
  assertAbsent(victimBackupPath(fixture));
}

function assertExactFile(filePath, identity, bytes) {
  const proof = lstatSync(filePath);
  assert.equal(proof.isFile(), true);
  assert.equal(proof.isSymbolicLink(), false);
  assert.equal(proof.nlink, 1);
  assert.deepEqual(windowsIdentity(filePath), identity);
  assert.deepEqual(readFileSync(filePath), bytes);
}

function assertOwnedJournal(filePath) {
  const proof = lstatSync(filePath);
  assert.equal(proof.isFile(), true);
  assert.equal(proof.isSymbolicLink(), false);
  assert.equal(proof.nlink, 1);
  assert.equal(proof.size > 0, true);
}

function assertNoJournal(request) {
  const base = `${request.partialLeaf}.fusionkit-overwrite`;
  for (const suffix of ["open", "finalize", "rollback", "victim"]) {
    assertAbsent(path.join(request.directoryPath, `${base}.${suffix}`));
  }
}

function assertAbsent(filePath) {
  try {
    lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.fail(`expected an absent path: ${path.basename(filePath)}`);
}

function windowsIdentity(filePath, lstat = false) {
  const value = lstat
    ? lstatSync(filePath, { bigint: true })
    : lstatSync(filePath, { bigint: true });
  assert.equal(value.dev >= 0n, true);
  assert.equal(value.ino >= 0n, true);
  return {
    volumeSerialHex: toFixedHex(value.dev, 8),
    fileIdHex: toFixedHex(value.ino, 32),
  };
}

function toFixedHex(value, digits) {
  const result = value.toString(16);
  assert.equal(result.length <= digits, true);
  return result.padStart(digits, "0");
}

function flipHex(value) {
  return `${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`;
}

function transactionIdFor(value) {
  const result = value.replace(/[^A-Za-z0-9-]/gu, "-").slice(0, 80);
  assert.match(result, /^[A-Za-z0-9-]{1,80}$/u);
  return result;
}

function partialLeafFor(transactionId) {
  return `.fusionkit-local-subtitle-${transactionId}.partial`;
}

function recoveryRequest(request, decision) {
  return {
    directoryPath: request.directoryPath,
    expectedDirectoryIdentity: request.expectedDirectoryIdentity,
    transactionId: request.transactionId,
    decision,
  };
}

function journalPath(fixture, state) {
  return path.join(
    fixture.directoryPath,
    `${fixture.partialLeaf}.fusionkit-overwrite.${state}`,
  );
}

function victimBackupPath(fixture) {
  return journalPath(fixture, "victim");
}

function namespaceSnapshot(directoryPath) {
  return readdirSync(directoryPath)
    .sort()
    .map((leaf) => {
      const value = lstatSync(path.join(directoryPath, leaf), {
        bigint: true,
      });
      return {
        leaf,
        dev: value.dev,
        ino: value.ino,
        birthtimeNs: value.birthtimeNs,
        size: value.size,
        nlink: value.nlink,
        mode: value.mode,
      };
    });
}

function assertAddonContract(addon) {
  assert.deepEqual(Reflect.ownKeys(addon).sort(), [
    "acknowledge",
    "architecture",
    "begin",
    "platform",
    "protocolVersion",
    "recover",
  ]);
  assert.equal(addon.protocolVersion, 4);
  assert.equal(addon.platform, "win32");
  assert.equal(addon.architecture, "x64");
  assert.equal(typeof addon.begin, "function");
  assert.equal(typeof addon.recover, "function");
  assert.equal(typeof addon.acknowledge, "function");
}

function assertReceiptContract(receipt) {
  assert.deepEqual(Reflect.ownKeys(receipt).sort(), [
    "acknowledge",
    "expectedFinalIdentity",
    "finalize",
    "rollback",
  ]);
  assert.equal(typeof receipt.finalize, "function");
  assert.equal(typeof receipt.rollback, "function");
  assert.equal(typeof receipt.acknowledge, "function");
}

function invokeSync(operation, label) {
  let result;
  try {
    result = operation();
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
  assert.equal(
    Boolean(result && typeof result.then === "function"),
    false,
    `${label} must be synchronous`,
  );
  return result;
}

function assertSupportedHost(platform, arch) {
  assert.equal(platform, "win32");
  assert.equal(arch, "x64");
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
  const options = parseWindowsIntegrationArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node run-addon-windows-integration.mjs " +
        "--addon <absolute.node> [--output <absolute.json>]\n",
    );
    return;
  }
  const report = await runWindowsOverwriteNativeIntegration(options);
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
      `overwrite_native_windows_integration_failed:${error?.code ?? "unknown"}: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
