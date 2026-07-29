import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WINDOWS_CUDA_PACK_CONTRACT,
  WINDOWS_CUDA_PACK_MANIFEST_RELATIVE_PATH,
} from "./windows-cuda-pack-contract.mjs";
import {
  WINDOWS_CUDA_PACK_STAGING_USAGE,
  parseWindowsCudaPackCliArguments,
  publishDirectoryWithRetries,
  stageWindowsX64CudaPack,
} from "./stage-runtime-windows-x64-cuda.mjs";

async function createFixture(t) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-cuda-pack-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const archivePath = path.join(projectRoot, "cuda.zip");
  const expandedRoot = path.join(projectRoot, "expanded");
  const outputRoot = path.join(projectRoot, "accelerator-pack");
  await writeFile(archivePath, "fixture", "utf8");
  await mkdir(expandedRoot);
  for (const [index, artifact] of WINDOWS_CUDA_PACK_CONTRACT.artifacts.entries()) {
    await writeFile(
      path.join(expandedRoot, artifact.fileName),
      Buffer.from([index + 1]),
    );
  }
  for (const excluded of ["SDL2.dll", "parakeet.dll", "whisper-cli.exe"]) {
    await writeFile(path.join(expandedRoot, excluded), "excluded", "utf8");
  }
  const dependencies = {
    platform: "win32",
    arch: "x64",
    projectRoot,
    observeArchive: async () => ({
      byteSize: WINDOWS_CUDA_PACK_CONTRACT.sourceArchive.byteSize,
      sha256: WINDOWS_CUDA_PACK_CONTRACT.sourceArchive.sha256,
    }),
    observeArtifact: async (_filePath, artifact) => ({
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      format: artifact.format,
      architectures: [artifact.architecture],
    }),
  };
  return {
    projectRoot,
    archivePath,
    expandedRoot,
    outputRoot,
    dependencies,
  };
}

async function listFiles(root, relativeRoot = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, relativeRoot), {
    withFileTypes: true,
  })) {
    const relativePath = relativeRoot
      ? `${relativeRoot}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

test("atomically stages only the pinned 20-file CUDA candidate", async (t) => {
  const fixture = await createFixture(t);
  const report = await stageWindowsX64CudaPack(
    {
      archivePath: fixture.archivePath,
      expandedRoot: fixture.expandedRoot,
      outputRoot: fixture.outputRoot,
    },
    fixture.dependencies,
  );

  assert.equal(report.artifactCount, 20);
  assert.equal(report.expandedByteSize, 1209487872);
  assert.equal(report.selectedArtifactByteSize, 1199083008);
  assert.equal(report.delivery.bundledInInstaller, false);
  assert.equal(report.delivery.includedInDefaultExtraResources, false);
  assert.equal(report.assembly.selfContained, true);
  assert.equal(report.assembly.baseRuntimeModified, false);
  assert.equal(report.targetSmoke.status, "pending");
  assert.equal(report.targetSmoke.backendVerified, false);
  assert.equal(report.licenseClosure.gate, "QA-005");
  assert.deepEqual(report.model002.excludedOperations, [
    "download",
    "install",
    "update",
    "rollback",
  ]);
  assert.equal(JSON.stringify(report).includes(fixture.projectRoot), false);

  const files = await listFiles(fixture.outputRoot);
  assert.deepEqual(
    files,
    [
      WINDOWS_CUDA_PACK_MANIFEST_RELATIVE_PATH,
      ...WINDOWS_CUDA_PACK_CONTRACT.artifacts.map(
        (artifact) => artifact.relativePath,
      ),
    ].sort(),
  );
  for (const excluded of ["SDL2.dll", "parakeet.dll", "whisper-cli.exe"]) {
    assert.equal(files.some((file) => file.endsWith(`/${excluded}`)), false);
  }
  const parentEntries = await readdir(path.dirname(fixture.outputRoot));
  assert.equal(
    parentEntries.some(
      (name) =>
        name.includes(".partial-") || name.endsWith(".publish.lock"),
    ),
    false,
  );
});

test("is no-clobber and preserves an existing destination", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(fixture.outputRoot);
  const sentinel = path.join(fixture.outputRoot, "sentinel.txt");
  await writeFile(sentinel, "keep", "utf8");

  await assert.rejects(
    stageWindowsX64CudaPack(
      {
        archivePath: fixture.archivePath,
        expandedRoot: fixture.expandedRoot,
        outputRoot: fixture.outputRoot,
      },
      fixture.dependencies,
    ),
    (error) => error?.code === "cuda_pack_staging_exists",
  );
  assert.equal(await readFile(sentinel, "utf8"), "keep");
});

test("rejects archive drift before creating the destination", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    stageWindowsX64CudaPack(
      {
        archivePath: fixture.archivePath,
        expandedRoot: fixture.expandedRoot,
        outputRoot: fixture.outputRoot,
      },
      {
        ...fixture.dependencies,
        observeArchive: async () => ({
          byteSize: WINDOWS_CUDA_PACK_CONTRACT.sourceArchive.byteSize - 1,
          sha256: WINDOWS_CUDA_PACK_CONTRACT.sourceArchive.sha256,
        }),
      },
    ),
    (error) => error?.code === "cuda_pack_archive_invalid",
  );
  await assert.rejects(readFile(fixture.outputRoot), /ENOENT/u);
});

test("rejects a same-name CPU DLL in the CUDA archive", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    stageWindowsX64CudaPack(
      {
        archivePath: fixture.archivePath,
        expandedRoot: fixture.expandedRoot,
        outputRoot: fixture.outputRoot,
      },
      {
        ...fixture.dependencies,
        observeArtifact: async (_filePath, artifact) =>
          artifact.fileName === "ggml-base.dll"
            ? {
                byteSize: 656384,
                sha256:
                  "8be6f3e06388b3a9aac75d29bec86363e2e2f5b0cee86ce6438866bcac0bcf86",
                format: "pe",
                architectures: ["x64"],
              }
            : {
                byteSize: artifact.byteSize,
                sha256: artifact.sha256,
                format: artifact.format,
                architectures: [artifact.architecture],
              },
      },
    ),
    (error) => error?.code === "cuda_pack_artifact_invalid",
  );
});

test("rejects base-root overlap and unknown option or CLI fields", async (t) => {
  const fixture = await createFixture(t);
  const baseChild = path.join(
    fixture.projectRoot,
    "build",
    "local-subtitle-resources",
    "local-subtitle",
    "cuda",
  );
  await assert.rejects(
    stageWindowsX64CudaPack(
      {
        archivePath: fixture.archivePath,
        expandedRoot: fixture.expandedRoot,
        outputRoot: baseChild,
      },
      fixture.dependencies,
    ),
    (error) => error?.code === "cuda_pack_output_boundary",
  );
  await assert.rejects(
    stageWindowsX64CudaPack(
      {
        archivePath: fixture.archivePath,
        expandedRoot: fixture.expandedRoot,
        outputRoot: fixture.outputRoot,
        cudaReady: true,
      },
      fixture.dependencies,
    ),
    (error) => error?.code === "cuda_pack_options_invalid",
  );
  assert.throws(
    () => parseWindowsCudaPackCliArguments(["--cuda-ready"]),
    (error) => error?.code === "cuda_pack_options_invalid",
  );
});

test("rejects a junction in the accelerator output ancestor chain", async (t) => {
  const fixture = await createFixture(t);
  const baseRoot = path.join(
    fixture.projectRoot,
    "build",
    "local-subtitle-resources",
    "local-subtitle",
  );
  const junctionPath = path.join(fixture.projectRoot, "junction-output");
  await mkdir(baseRoot, { recursive: true });
  await symlink(baseRoot, junctionPath, "junction");

  await assert.rejects(
    stageWindowsX64CudaPack({
      archivePath: fixture.archivePath,
      expandedRoot: fixture.expandedRoot,
      outputRoot: path.join(junctionPath, "cuda-pack"),
    }, fixture.dependencies),
    (error) => error?.code === "cuda_pack_output_boundary",
  );
  assert.deepEqual(await readdir(baseRoot), []);
});

test("help text makes the target smoke boundary explicit", () => {
  assert.match(WINDOWS_CUDA_PACK_STAGING_USAGE, /target smoke separately/iu);
  assert.match(WINDOWS_CUDA_PACK_STAGING_USAGE, /does not bundle/iu);
  assert.match(WINDOWS_CUDA_PACK_STAGING_USAGE, /does not .*establish CUDA readiness/isu);
  assert.doesNotMatch(WINDOWS_CUDA_PACK_STAGING_USAGE, /CUDA ready/iu);
});

test("retries transient Windows publication locks without weakening no-clobber", async () => {
  let attempts = 0;
  let missingChecks = 0;
  let authorityChecks = 0;
  let delays = 0;
  await publishDirectoryWithRetries("partial", "final", {
    renameImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("scanner lock");
        error.code = attempts === 1 ? "EPERM" : "EBUSY";
        throw error;
      }
    },
    assertMissingImpl: async () => {
      missingChecks += 1;
    },
    assertDestinationAuthorityImpl: async () => {
      authorityChecks += 1;
    },
    delayImpl: async () => {
      delays += 1;
    },
    maxRetries: 3,
  });
  assert.equal(attempts, 3);
  assert.equal(missingChecks, 3);
  assert.equal(authorityChecks, 3);
  assert.equal(delays, 2);

  await assert.rejects(
    publishDirectoryWithRetries("partial", "final", {
      renameImpl: async () => {
        const error = new Error("destination exists");
        error.code = "EEXIST";
        throw error;
      },
      assertMissingImpl: async () => {},
      delayImpl: async () => {
        throw new Error("must not delay");
      },
    }),
    (error) => error?.code === "EEXIST",
  );
});
