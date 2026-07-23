import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  OVERWRITE_NATIVE_BUILD_CONTRACT,
  buildMacosArm64OverwriteAddon,
  createDryRunCommandDescriptor,
  currentNodeHeaderCandidates,
  locateCurrentNodeHeaders,
  parseBuildArguments,
  parseNodeHeaderVersion,
} from "./build-addon-macos-arm64.mjs";
import {
  OVERWRITE_NATIVE_TEST_BUILD_CONTRACT,
  buildTestMacosArm64OverwriteAddon,
  createTestDryRunCommandDescriptor,
} from "./build-test-addon-macos-arm64.mjs";
import { runOverwriteNativeIntegration } from "./run-addon-integration.mjs";
import { runOverwriteNativeRecoveryIntegration } from "./run-addon-recovery-integration.mjs";

const require = createRequire(import.meta.url);
const MACOS_ARM64 = process.platform === "darwin" && process.arch === "arm64";

test("freezes a shell-free N-API v8 macOS arm64 build descriptor", () => {
  const descriptor = createDryRunCommandDescriptor({
    platform: "darwin",
    arch: "arm64",
    outputLeaf: "transaction.node",
  });

  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.commands), true);
  assert.deepEqual(descriptor.contract.target, {
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(descriptor.contract.napiVersion, 8);
  assert.equal(descriptor.contract.deploymentTarget, "11.0");
  assert.deepEqual(
    descriptor.commands.slice(0, 3).map(({ command, args }) => [command, args]),
    [
      ["/usr/bin/xcrun", ["--sdk", "macosx", "--find", "clang++"]],
      ["/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]],
      ["/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"]],
    ],
  );

  const compile = descriptor.commands.at(-1);
  assert.equal(compile.command, "/usr/bin/xcrun");
  assert.deepEqual(compile.args.slice(0, 3), ["--sdk", "macosx", "clang++"]);
  for (const required of [
    "-std=c++17",
    "-DNAPI_VERSION=8",
    "-arch",
    "arm64",
    "-mmacosx-version-min=11.0",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "native/local-subtitle-overwrite/src/addon.cc",
  ]) {
    assert.ok(compile.args.includes(required), `missing compile argument: ${required}`);
  }
  assert.equal(compile.args.includes("-Wl,-no_uuid"), false);
  assert.equal(
    compile.args.at(-1),
    "<temporary-output>/local-subtitle-overwrite.node",
  );
  assert.equal(descriptor.commands.every((entry) => entry.options.shell === false), true);
  assert.equal(JSON.stringify(descriptor).includes("/Users/"), false);
  assert.equal(JSON.stringify(descriptor).includes("/private/"), false);
});

test("rejects unsupported platforms and architectures before describing commands", () => {
  assert.throws(
    () => createDryRunCommandDescriptor({ platform: "win32", arch: "x64" }),
    (error) => error?.code === "unsupported_platform",
  );
  assert.throws(
    () => createDryRunCommandDescriptor({ platform: "darwin", arch: "x64" }),
    (error) => error?.code === "unsupported_architecture",
  );
});

test("keeps deterministic fault injection in a distinct test-only build", () => {
  const production = createDryRunCommandDescriptor({
    platform: "darwin",
    arch: "arm64",
    outputLeaf: "production.node",
  });
  const testOnly = createTestDryRunCommandDescriptor({
    platform: "darwin",
    arch: "arm64",
    outputLeaf: "test-only.node",
  });
  const productionCompile = production.commands.at(-1).args;
  const testCompile = testOnly.commands.at(-1).args;

  assert.equal(
    productionCompile.includes("-DFUSIONKIT_OVERWRITE_TEST_FAULTS=1"),
    false,
  );
  assert.equal(
    testCompile.includes("-DFUSIONKIT_OVERWRITE_TEST_FAULTS=1"),
    true,
  );
  assert.equal(testOnly.contract.testOnly, true);
  assert.equal(testOnly.contract.workPackage, "FS-TXN-001B");
  assert.equal(
    testOnly.contract.faultInjection.crashExitCode,
    86,
  );
  assert.throws(() => parseBuildArguments(["--test-faults"]));
  assert.equal(JSON.stringify(testOnly).includes("/Users/"), false);
  assert.equal(JSON.stringify(testOnly).includes("/private/"), false);
});

test("accepts only absolute typed artifact paths and no positional arguments", () => {
  const parsed = parseBuildArguments([
    "--output",
    "/tmp/local-subtitle-overwrite.node",
    "--receipt",
    "/tmp/local-subtitle-overwrite-build.json",
    "--dry-run",
  ]);
  assert.deepEqual(parsed, {
    outputPath: "/tmp/local-subtitle-overwrite.node",
    receiptPath: "/tmp/local-subtitle-overwrite-build.json",
    dryRun: true,
  });

  for (const args of [
    ["--output", "relative.node"],
    ["--output", "/tmp/not-an-addon.txt"],
    ["--receipt", "relative.json"],
    ["--receipt", "/tmp/not-json.txt"],
    ["unexpected-positional"],
  ]) {
    assert.throws(() => parseBuildArguments(args));
  }
  assert.throws(
    () =>
      parseBuildArguments([
        "--output",
        "/tmp/same.node",
        "--receipt",
        "/tmp/same.node",
      ]),
    (error) => error?.code === "invalid_arguments",
  );
});

test("derives header candidates from the running Node installation", () => {
  const executable = path.join(
    path.parse(process.cwd()).root,
    "toolchains",
    "node-v20",
    "bin",
    "node",
  );
  assert.equal(
    currentNodeHeaderCandidates(executable)[0],
    path.join(path.parse(process.cwd()).root, "toolchains", "node-v20", "include", "node"),
  );
  assert.equal(
    parseNodeHeaderVersion(
      "#define NODE_MAJOR_VERSION 20\n" +
        "#define NODE_MINOR_VERSION 19\n" +
        "#define NODE_PATCH_VERSION 5\n",
    ),
    "20.19.5",
  );
  assert.throws(
    () => parseNodeHeaderVersion("#define NODE_MAJOR_VERSION 20\n"),
    (error) => error?.code === "invalid_node_headers",
  );
});

test("locates headers that exactly match the running Node binary", async () => {
  const located = await locateCurrentNodeHeaders();
  assert.equal(located.nodeVersion, process.versions.node);
  assert.equal(path.isAbsolute(located.headersPath), true);
  assert.equal(path.basename(located.headersPath), "node");
});

test("fails closed when no matching current-Node headers exist", async () => {
  await assert.rejects(
    locateCurrentNodeHeaders({
      candidates: ["/tmp/fusionkit-definitely-missing-node-headers"],
    }),
    (error) => error?.code === "node_headers_unavailable",
  );
});

test(
  "maps a shell-free compiler failure without publishing a partial addon",
  { skip: !MACOS_ARM64 },
  async () => {
    const outputRoot = await mkdtemp("/tmp/fusionkit-overwrite-build-failure-");
    const outputPath = path.join(outputRoot, "compile-failure.node");
    try {
      const commandRunner = (command, args, options) => {
        if (args.includes("native/local-subtitle-overwrite/src/addon.cc")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "synthetic compiler failure",
          };
        }
        const result = spawnSync(command, args, {
          cwd: options.cwd,
          env: options.env,
          encoding: "utf8",
          shell: false,
          timeout: options.timeoutMs,
        });
        return {
          exitCode: result.status,
          errorCode: result.error?.code,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      };
      await assert.rejects(
        buildMacosArm64OverwriteAddon({ outputPath, commandRunner }),
        (error) => error?.code === "compile_failed",
      );
      assert.throws(
        () => require(outputPath),
        (error) => error?.code === "MODULE_NOT_FOUND",
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  },
);

test(
  "builds a loadable thin addon with the exact native module surface",
  { skip: !MACOS_ARM64 },
  async () => {
    const outputRoot = await mkdtemp("/tmp/fusionkit-overwrite-build-load-");
    const outputPath = path.join(outputRoot, "first", "loadable-first.node");
    const repeatedOutputPath = path.join(outputRoot, "second", "loadable-second.node");
    try {
      const receipt = await buildMacosArm64OverwriteAddon({ outputPath });
      const repeatedReceipt = await buildMacosArm64OverwriteAddon({
        outputPath: repeatedOutputPath,
      });
      assert.equal(receipt.artifact.architecture, "arm64");
      assert.equal(receipt.artifact.minimumMacosVersion, "11.0.0");
      assert.equal(receipt.build.napiVersion, 8);
      assert.equal(repeatedReceipt.artifact.byteSize, receipt.artifact.byteSize);
      assert.equal(repeatedReceipt.artifact.sha256, receipt.artifact.sha256);
      assert.equal(JSON.stringify(receipt).includes("/Users/"), false);
      assert.equal(JSON.stringify(receipt).includes("/private/"), false);

      const addon = require(outputPath);
      assert.deepEqual(Reflect.ownKeys(addon).sort(), [
        "architecture",
        "begin",
        "platform",
        "protocolVersion",
        "recover",
      ]);
      assert.equal(addon.protocolVersion, 3);
      assert.equal(addon.platform, "darwin");
      assert.equal(addon.architecture, "arm64");
      assert.equal(typeof addon.begin, "function");
      assert.equal(typeof addon.recover, "function");
      assert.equal(Reflect.has(addon, "testFaultInjection"), false);

      const integration = await runOverwriteNativeIntegration({
        addonPath: outputPath,
      });
      assert.equal(integration.status, "passed");
      assert.equal(integration.productionGateChanged, false);
      assert.deepEqual(
        integration.rejectionCases.find(
          ({ id }) => id === "begin-failure-handle-release",
        ),
        {
          id: "begin-failure-handle-release",
          attempts: 64,
          openFileDescriptorDelta: 0,
          rejectedWithoutHandleLeak: true,
          passed: true,
        },
      );
      assert.equal(integration.journalValidationCases.length, 8);
      assert.deepEqual(
        integration.recoveryRequestCases.map(({ id, passed }) => ({ id, passed })),
        [
          { id: "recover-exact-own-keys", passed: true },
          { id: "recover-transaction-id-validation", passed: true },
          { id: "recover-exact-id-no-scan", passed: true },
          { id: "begin-transaction-partial-match", passed: true },
        ],
      );
      assert.deepEqual(
        new Set(integration.journalValidationCases.map(({ id }) => id)),
        new Set([
          "journal-truncated",
          "journal-checksum-mismatch",
          "journal-version-mismatch",
          "journal-transaction-id-mismatch",
          "journal-symlink-replacement",
          "journal-hardlink",
          "journal-regular-file-replacement",
          "journal-open-and-rollback",
        ]),
      );
      for (const journalCase of integration.journalValidationCases) {
        assert.equal(
          journalCase.recoveryErrorCode,
          "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
        );
        assert.equal(journalCase.outputNamespaceUnchanged, true);
        assert.equal(journalCase.rejected, true);
        assert.equal(journalCase.passed, true);
      }
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  },
);

test(
  "proves native terminal fault boundaries and rollback recovery in fresh processes",
  { skip: !MACOS_ARM64 },
  async () => {
    const outputRoot = await mkdtemp("/tmp/fusionkit-overwrite-recovery-");
    const outputPath = path.join(outputRoot, "test-only.node");
    try {
      const receipt = await buildTestMacosArm64OverwriteAddon({ outputPath });
      assert.equal(receipt.testOnly, true);
      assert.equal(receipt.testFaultInjection, true);
      assert.deepEqual(receipt.build.compileDefinitions, [
        "FUSIONKIT_OVERWRITE_TEST_FAULTS=1",
      ]);
      assert.equal(receipt.productionGateChanged, false);
      assert.equal(JSON.stringify(receipt).includes(outputRoot), false);

      const addon = require(outputPath);
      assert.deepEqual(Reflect.ownKeys(addon).sort(), [
        "architecture",
        "begin",
        "platform",
        "protocolVersion",
        "recover",
        "testFaultInjection",
      ]);
      assert.equal(addon.testFaultInjection, true);

      const integration = await runOverwriteNativeRecoveryIntegration({
        addonPath: outputPath,
      });
      assert.equal(integration.status, "passed");
      assert.equal(integration.schemaVersion, 2);
      assert.equal(integration.productionGateChanged, false);
      assert.equal(integration.beginCrashCases.length, 2);
      for (const beginCase of integration.beginCrashCases) {
        assert.equal(beginCase.checkpoint, "begin_after_namespace");
        assert.equal(beginCase.childA.exitCode, 86);
        assert.equal(beginCase.childB.recoveryState, "decision_required");
        assert.equal(beginCase.childC.recoveryState, "decision_required");
        assert.equal(beginCase.openJournalVerified, true);
        assert.equal(beginCase.installedLayoutVerifiedWithExactIdentity, true);
        assert.equal(beginCase.recoveryNamespaceUnchanged, true);
        assert.equal(beginCase.automaticTerminalDecision, false);
        assert.equal(beginCase.passed, true);
      }

      const rollbackPoints = new Set([
        "rollback_after_intent_sync",
        "rollback_before_namespace",
        "rollback_after_namespace_sync",
        "rollback_before_cleanup_unlink",
        "rollback_after_cleanup_sync",
        "rollback_before_journal_remove",
        "journal_after_unlink_before_sync",
      ]);
      assert.equal(integration.rollbackCrashCases.length, 14);
      assert.deepEqual(
        new Set(
          integration.rollbackCrashCases.map(({ checkpoint }) => checkpoint),
        ),
        rollbackPoints,
      );
      assert.deepEqual(
        new Set(
          integration.rollbackCrashCases.map(({ priorVictim }) => priorVictim),
        ),
        new Set(["existing", "absent"]),
      );
      for (const crashCase of integration.rollbackCrashCases) {
        assert.equal(crashCase.childA.exitCode, 86);
        assert.equal(crashCase.childA.processTerminatedAtCheckpoint, true);
        assert.equal(
          crashCase.childB.recoveryState,
          crashCase.checkpoint === "journal_after_unlink_before_sync"
            ? "not_found"
            : "rolled_back",
        );
        assert.equal(crashCase.childC.recoveryState, "not_found");
        assert.equal(crashCase.childC.idempotent, true);
        assert.equal(
          crashCase.intermediateLayoutVerifiedWithExactIdentity,
          true,
        );
        assert.equal(crashCase.priorStateRestoredWithExactIdentity, true);
        assert.equal(crashCase.idempotentNamespaceUnchanged, true);
        assert.equal(crashCase.passed, true);
      }

      assert.equal(integration.rollbackErrorRetryCases.length, 14);
      assert.deepEqual(
        new Set(
          integration.rollbackErrorRetryCases.map(
            ({ checkpoint }) => checkpoint,
          ),
        ),
        rollbackPoints,
      );
      for (const retryCase of integration.rollbackErrorRetryCases) {
        assert.equal(
          retryCase.firstErrorCode,
          "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
        );
        assert.equal(retryCase.intermediateLayoutVerified, true);
        assert.equal(retryCase.oppositeTerminalRejected, true);
        assert.equal(retryCase.sameReceiptRetried, true);
        assert.equal(retryCase.retryCompleted, true);
        assert.equal(retryCase.rollbackConverged, true);
        assert.equal(retryCase.passed, true);
      }

      assert.equal(integration.finalizeErrorRetryCases.length, 5);
      for (const finalizeCase of integration.finalizeErrorRetryCases) {
        assert.equal(
          finalizeCase.firstErrorCode,
          "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM",
        );
        assert.equal(finalizeCase.intermediateLayoutVerified, true);
        assert.equal(finalizeCase.sameReceiptRetried, true);
        assert.equal(finalizeCase.retryCompleted, true);
        assert.equal(finalizeCase.finalizedWithExactNewIdentity, true);
        assert.equal(finalizeCase.crashRecoveryClaimed, false);
        assert.equal(
          finalizeCase.oppositeTerminalRejected,
          finalizeCase.cleanupEntered ? true : null,
        );
        assert.equal(finalizeCase.passed, true);
      }
      assert.deepEqual(integration.finalizeUnsupportedCases, [
        {
          id:
            "finalize-unsupported-absent-finalize_after_namespace_sync",
          priorVictim: "absent",
          checkpoint: "finalize_after_namespace_sync",
          configuredAction: "error",
          faultPointReached: false,
          finalizeCompleted: true,
          reason: "absent_finalize_has_no_namespace_mutation_checkpoint",
          crashRecoveryClaimed: false,
          passed: true,
        },
      ]);
      assert.deepEqual(integration.claims, {
        beginOpenJournalAutomaticallyDecided: false,
        finalizeCrashRecoveryClaimed: false,
        powerLossSafetyClaimed: false,
      });
      assert.equal(JSON.stringify(integration).includes(outputRoot), false);
      assert.equal(JSON.stringify(integration).includes("/"), false);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  },
);

test("keeps the checked-in developer build contract free of package-manager inputs", () => {
  assert.equal(OVERWRITE_NATIVE_BUILD_CONTRACT.napiVersion, 8);
  assert.equal(
    Object.values(OVERWRITE_NATIVE_BUILD_CONTRACT).some((value) =>
      String(value).includes("node-gyp") || String(value).includes("pnpm")
    ),
    false,
  );
  assert.equal(OVERWRITE_NATIVE_TEST_BUILD_CONTRACT.testOnly, true);
});
