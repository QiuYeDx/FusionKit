import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT,
  buildWindowsX64OverwriteAddon,
  createWindowsDryRunCommandDescriptor,
  parseWindowsBuildArguments,
} from "./build-addon-windows-x64.mjs";
import {
  OVERWRITE_NATIVE_WINDOWS_TEST_BUILD_CONTRACT,
  buildTestWindowsX64OverwriteAddon,
  createWindowsTestDryRunCommandDescriptor,
} from "./build-test-addon-windows-x64.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const WINDOWS_X64 = process.platform === "win32" && process.arch === "x64";
const HAS_EXPLICIT_TOOLCHAIN = [
  process.env.FUSIONKIT_LLVM_MINGW_ROOT,
  process.env.FUSIONKIT_NODE_HEADERS_DIR,
  process.env.FUSIONKIT_NODE_LIB_PATH,
].every((value) => typeof value === "string" && path.isAbsolute(value));

test("freezes a shell-free Windows x64 N-API v8 build descriptor", () => {
  const descriptor = createWindowsDryRunCommandDescriptor({
    platform: "win32",
    arch: "x64",
    outputPath: path.resolve("transaction.node"),
  });

  assert.equal(Object.isFrozen(descriptor), true);
  assert.deepEqual(descriptor.contract.target, {
    platform: "win32",
    arch: "x64",
  });
  assert.equal(descriptor.contract.napiVersion, 8);
  assert.equal(descriptor.contract.nativeProtocolVersion, 3);
  assert.equal(descriptor.contract.journalVersion, 2);
  assert.equal(descriptor.commands.length, 1);
  const compile = descriptor.commands[0];
  assert.match(compile.command, /x86_64-w64-mingw32-clang\+\+\.exe$/u);
  for (const required of [
    "-std=c++17",
    "-DNAPI_VERSION=8",
    "-D_WIN32_WINNT=0x0A00",
    "-shared",
    "-static-libstdc++",
    "native/local-subtitle-overwrite/src/addon-win32.cc",
  ]) {
    assert.ok(compile.args.includes(required), `missing compile argument: ${required}`);
  }
  assert.equal(compile.options.shell, false);
  assert.equal(
    JSON.stringify(descriptor).includes(process.env.USERNAME ?? "\0"),
    false,
  );
});

test("rejects unsupported Windows native build hosts", () => {
  assert.throws(
    () =>
      createWindowsDryRunCommandDescriptor({
        platform: "darwin",
        arch: "arm64",
      }),
    (error) => error?.code === "unsupported_platform",
  );
  assert.throws(
    () =>
      createWindowsDryRunCommandDescriptor({
        platform: "win32",
        arch: "arm64",
      }),
    (error) => error?.code === "unsupported_architecture",
  );
});

test("keeps fault injection in a distinct Windows test-only build", () => {
  const production = createWindowsDryRunCommandDescriptor({
    platform: "win32",
    arch: "x64",
  });
  const faultTest = createWindowsTestDryRunCommandDescriptor({
    platform: "win32",
    arch: "x64",
  });

  assert.equal(
    production.commands[0].args.includes(
      "-DFUSIONKIT_OVERWRITE_TEST_FAULTS=1",
    ),
    false,
  );
  assert.equal(
    faultTest.commands[0].args.includes(
      "-DFUSIONKIT_OVERWRITE_TEST_FAULTS=1",
    ),
    true,
  );
  assert.equal(OVERWRITE_NATIVE_WINDOWS_TEST_BUILD_CONTRACT.testOnly, true);
  assert.equal(
    OVERWRITE_NATIVE_WINDOWS_TEST_BUILD_CONTRACT.faultInjection.crashExitCode,
    86,
  );
});

test("parses only explicit absolute typed Windows build inputs", () => {
  const root = path.parse(process.cwd()).root;
  const output = path.join(root, "tmp", "overwrite.node");
  const receipt = path.join(root, "tmp", "overwrite.json");
  const toolchain = path.join(root, "toolchains", "llvm-mingw");
  const headers = path.join(root, "toolchains", "node", "include", "node");
  const nodeLib = path.join(root, "toolchains", "node.lib");
  assert.deepEqual(
    parseWindowsBuildArguments([
      "--output",
      output,
      "--receipt",
      receipt,
      "--toolchain-root",
      toolchain,
      "--node-headers",
      headers,
      "--node-lib",
      nodeLib,
      "--dry-run",
    ]),
    {
      outputPath: output,
      receiptPath: receipt,
      toolchainRoot: toolchain,
      nodeHeadersPath: headers,
      nodeLibPath: nodeLib,
      dryRun: true,
    },
  );
  for (const args of [
    ["--output", "relative.node"],
    ["--output", output, "--toolchain-root", "relative"],
    ["--output", output, "--node-headers", "relative"],
    ["--output", output, "--node-lib", "relative.lib"],
    ["unexpected-positional"],
  ]) {
    assert.throws(() => parseWindowsBuildArguments(args));
  }
});

test(
  "builds, loads, and exercises both Windows x64 addon variants",
  { skip: !WINDOWS_X64 || !HAS_EXPLICIT_TOOLCHAIN, timeout: 120_000 },
  async () => {
    const outputRoot = await mkdtemp(
      path.join(os.tmpdir(), "fusionkit-overwrite-win-test-"),
    );
    try {
      const productionPath = path.join(outputRoot, "production.node");
      const testPath = path.join(outputRoot, "fault-test.node");
      const productionReceipt = await buildWindowsX64OverwriteAddon({
        outputPath: productionPath,
      });
      const testReceipt = await buildTestWindowsX64OverwriteAddon({
        outputPath: testPath,
      });

      assert.equal(productionReceipt.artifact.format, "pe");
      assert.equal(productionReceipt.artifact.architecture, "x64");
      assert.equal(productionReceipt.build.nodeVersion, process.versions.node);
      assert.equal(testReceipt.testFaultInjection, true);
      assert.equal(
        JSON.stringify([productionReceipt, testReceipt]).includes(
          process.env.USERNAME ?? "\0",
        ),
        false,
      );

      const integration = runIntegrationChild(
        "run-addon-windows-integration.mjs",
        productionPath,
      );
      const recovery = runIntegrationChild(
        "run-addon-windows-recovery-integration.mjs",
        testPath,
      );
      assert.equal(integration.status, "passed");
      assert.equal(integration.terminalCases.length, 4);
      assert.equal(integration.rejectionCases.length, 6);
      assert.equal(recovery.status, "passed");
      assert.equal(recovery.beginCrashCases.length, 3);
      assert.equal(recovery.rollbackCrashCases.length, 14);
      assert.equal(recovery.rollbackErrorRetryCases.length, 14);
      assert.equal(recovery.finalizeErrorRetryCases.length, 5);
      assert.equal(recovery.productionGateChanged, false);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  },
);

test("declares the Windows component boundary without changing the gate", () => {
  assert.equal(OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT.workPackage, "FS-TXN-001D");
  assert.deepEqual(OVERWRITE_NATIVE_WINDOWS_BUILD_CONTRACT.target, {
    platform: "win32",
    arch: "x64",
  });
});

function runIntegrationChild(scriptLeaf, addonPath) {
  const result = spawnSync(
    process.execPath,
    [path.join(SCRIPT_DIRECTORY, scriptLeaf), "--addon", addonPath],
    {
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}
