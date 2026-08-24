import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WHISPER_SERVER_BUILD_CONTRACT,
  WHISPER_SERVER_CMAKE_DEFINITIONS,
  WHISPER_SERVER_PATH_MAP_DEFINITIONS,
  assertCleanSourceStatus,
  assertNoPrivateBuildPath,
  runBoundedBuildCommand,
  validateWhisperServerBuildReceipt,
} from "./build-whisper-server-macos-arm64.mjs";

test("freezes the NATIVE-002A whisper-server source and build contract", () => {
  assert.equal(WHISPER_SERVER_BUILD_CONTRACT.version, "v1.9.1");
  assert.equal(
    WHISPER_SERVER_BUILD_CONTRACT.commit,
    "f049fff95a089aa9969deb009cdd4892b3e74916",
  );
  assert.equal(WHISPER_SERVER_BUILD_CONTRACT.deploymentTarget, "11.0");
  assert.equal(WHISPER_SERVER_BUILD_CONTRACT.cmakeVersion, "4.4.0");
  assert.equal(WHISPER_SERVER_BUILD_CONTRACT.sdkVersion, "26.5");
  assert.equal(
    WHISPER_SERVER_BUILD_CONTRACT.cmakeExecutableSha256,
    "8f136fce6bb8e9dbea38320f8a615b1f4896fe80cc7da5c1ff3da69e834f5d4c",
  );
  assert.equal(
    WHISPER_SERVER_BUILD_CONTRACT.compilerVersion,
    "Apple clang version 21.0.0 (clang-2100.1.1.101)",
  );
  assert.deepEqual(WHISPER_SERVER_CMAKE_DEFINITIONS, [
    "CMAKE_BUILD_TYPE=Release",
    "CMAKE_OSX_ARCHITECTURES=arm64",
    "CMAKE_OSX_DEPLOYMENT_TARGET=11.0",
    "BUILD_SHARED_LIBS=OFF",
    "GGML_NATIVE=OFF",
    "GGML_METAL=ON",
    "GGML_METAL_EMBED_LIBRARY=ON",
    "WHISPER_BUILD_SERVER=ON",
  ]);
  assert.equal(WHISPER_SERVER_PATH_MAP_DEFINITIONS.length, 2);
  assert.match(WHISPER_SERVER_PATH_MAP_DEFINITIONS[0], /<SOURCE>/u);
  assert.match(WHISPER_SERVER_PATH_MAP_DEFINITIONS[0], /<WORK>/u);
});

test("rejects private source and temporary paths embedded in final bytes", () => {
  for (const marker of [
    "/Users/person/source.cpp",
    "/private/tmp/build/source.cpp",
    "/private/var/folders/aa/build/source.cpp",
    "/Volumes/build/source.cpp",
    "/home/runner/source.cpp",
  ]) {
    assert.throws(
      () => assertNoPrivateBuildPath(Buffer.from(`prefix ${marker} suffix`)),
      /private build path/u,
    );
  }
  assert.equal(
    assertNoPrivateBuildPath(Buffer.from("./ggml/src/ggml-metal.cpp")),
    true,
  );
});

test("rejects ignored or untracked source checkout content", () => {
  assert.equal(assertCleanSourceStatus(""), true);
  for (const status of ["?? local.patch\n", "!! build-cache/\n", " M CMakeLists.txt\n"]) {
    assert.throws(
      () => assertCleanSourceStatus(status),
      /not completely clean/u,
    );
  }
});

test("rejects unknown build receipt fields before inspecting an artifact", async () => {
  await assert.rejects(
    validateWhisperServerBuildReceipt(
      { schemaVersion: 1, unexpected: true },
      { serverPath: "/does/not/exist" },
    ),
    /missing or unknown fields/u,
  );
});

test("bounds build command time and closes descendants after the leader exits", {
  skip: process.platform === "win32",
}, async () => {
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-build-command-"));
  const childPidPath = path.join(workRoot, "child.pid");
  const descendantSource =
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const leaderSource = [
    "const {spawn}=require('node:child_process')",
    "const {writeFileSync}=require('node:fs')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],` +
      "{detached:false,stdio:'ignore'})",
    `writeFileSync(${JSON.stringify(childPidPath)},String(child.pid))`,
    "process.on('SIGTERM',()=>process.exit(0))",
    "setInterval(()=>{},1000)",
  ].join(";");
  const startedAt = Date.now();
  let descendantPid;
  try {
    await assert.rejects(
      runBoundedBuildCommand(process.execPath, ["-e", leaderSource], {
        cwd: workRoot,
        env: process.env,
        timeoutMs: 100,
        terminationGraceMs: 100,
        closeConfirmationMs: 1_000,
      }),
      /timed out/u,
    );
    descendantPid = Number(await readFile(childPidPath, "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.throws(
      () => process.kill(descendantPid, 0),
      (error) => error?.code === "ESRCH",
    );
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    if (Number.isSafeInteger(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    await rm(workRoot, { recursive: true, force: true });
  }
});
