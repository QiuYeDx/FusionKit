#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  WINDOWS_CUDA_PACK_CONTRACT,
  WINDOWS_CUDA_PACK_MANIFEST_RELATIVE_PATH,
  WINDOWS_CUDA_PACK_PROJECT_ROOT,
  assertIndependentWindowsCudaPackRoot,
  assertWindowsCudaPackOutputAuthority,
  observeWindowsCudaArchive,
  observeWindowsCudaArtifact,
  resolveWindowsCudaPackRoot,
  serializeWindowsCudaPackContract,
  validateWindowsCudaArchiveObservation,
  validateWindowsCudaArtifactObservation,
  verifyWindowsCudaPack,
  WindowsCudaPackError,
} from "./windows-cuda-pack-contract.mjs";

const ALLOWED_OPTION_KEYS = new Set([
  "archivePath",
  "expandedRoot",
  "outputRoot",
]);

export const WINDOWS_CUDA_PACK_STAGING_USAGE = [
  "Usage: node stage-runtime-windows-x64-cuda.mjs",
  "  --archive-path <whisper-cublas-12.4.0-bin-x64.zip>",
  "  --expanded-root <expanded-archive-directory>",
  "  [--output-root <independent-accelerator-pack-root>]",
  "",
  "Stages and verifies the pinned, self-contained Windows x64 CUDA candidate.",
  "This integrity-only step does not bundle the pack, manage MODEL-002 models,",
  "or establish CUDA readiness; run the NATIVE-002 target smoke separately.",
].join("\n");

export async function stageWindowsX64CudaPack(options, dependencies = {}) {
  validateOptions(options);
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  if (platform !== "win32" || arch !== "x64") {
    throw new WindowsCudaPackError(
      "cuda_pack_staging_invalid",
      "Windows CUDA pack staging requires a native win32/x64 host.",
    );
  }
  const projectRoot = path.resolve(
    dependencies.projectRoot ?? WINDOWS_CUDA_PACK_PROJECT_ROOT,
  );
  const archivePath = path.resolve(requirePath(options.archivePath, "archivePath"));
  const expandedRoot = path.resolve(
    requirePath(options.expandedRoot, "expandedRoot"),
  );
  const outputRoot = resolveWindowsCudaPackRoot({
    projectRoot,
    outputRoot: options.outputRoot,
  });
  assertIndependentWindowsCudaPackRoot(outputRoot, projectRoot);
  const assertOutputAuthority =
    dependencies.assertOutputAuthority ??
    assertWindowsCudaPackOutputAuthority;
  await assertOutputAuthority(outputRoot, projectRoot);

  const expandedStat = await lstat(expandedRoot).catch(() => null);
  if (!expandedStat?.isDirectory() || expandedStat.isSymbolicLink()) {
    throw new WindowsCudaPackError(
      "cuda_pack_staging_invalid",
      "The expanded Windows CUDA archive root is not a regular directory.",
    );
  }

  const observeArchive =
    dependencies.observeArchive ?? observeWindowsCudaArchive;
  const observeArtifact =
    dependencies.observeArtifact ?? observeWindowsCudaArtifact;
  validateWindowsCudaArchiveObservation(await observeArchive(archivePath));

  const inputs = [];
  for (const artifact of WINDOWS_CUDA_PACK_CONTRACT.artifacts) {
    const inputPath = path.join(expandedRoot, artifact.fileName);
    validateWindowsCudaArtifactObservation(
      artifact.fileName,
      await observeArtifact(inputPath, artifact),
    );
    inputs.push({ artifact, inputPath });
  }

  const outputParent = path.dirname(outputRoot);
  const outputName = path.basename(outputRoot);
  const partialRoot = path.join(
    outputParent,
    `${outputName}.partial-${process.pid}-${randomUUID()}`,
  );
  const publicationLockPath = path.join(
    outputParent,
    `.${outputName}.publish.lock`,
  );
  await mkdir(outputParent, { recursive: true });
  await assertOutputAuthority(outputRoot, projectRoot);
  await assertMissing(outputRoot);
  await assertMissing(partialRoot);

  let publicationLock;
  let published = false;
  let report;
  let operationError;
  let cleanupError;
  try {
    publicationLock = await open(publicationLockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new WindowsCudaPackError(
        "cuda_pack_staging_exists",
        "Another Windows CUDA pack publication is already in progress.",
      );
    }
    throw error;
  }

  try {
    await assertMissing(outputRoot);
    await mkdir(partialRoot, { recursive: false });
    for (const { artifact, inputPath } of inputs) {
      const outputPath = path.join(
        partialRoot,
        ...artifact.relativePath.split("/"),
      );
      await mkdir(path.dirname(outputPath), { recursive: true });
      await copyFile(inputPath, outputPath, fsConstants.COPYFILE_EXCL);
      validateWindowsCudaArtifactObservation(
        artifact.fileName,
        await observeArtifact(outputPath, artifact),
      );
    }

    const manifestPath = path.join(
      partialRoot,
      ...WINDOWS_CUDA_PACK_MANIFEST_RELATIVE_PATH.split("/"),
    );
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      serializeWindowsCudaPackContract(),
      { flag: "wx", mode: 0o644 },
    );

    let verification = await verifyWindowsCudaPack(
      {
        runtimeRoot: partialRoot,
        observeArtifact,
      },
      dependencies,
    );
    const publishDirectory =
      dependencies.publishDirectory ?? publishDirectoryWithRetries;
    await assertOutputAuthority(outputRoot, projectRoot);
    await publishDirectory(partialRoot, outputRoot, {
      assertDestinationAuthorityImpl: () =>
        assertOutputAuthority(outputRoot, projectRoot),
    });
    published = true;
    await assertOutputAuthority(outputRoot, projectRoot);
    verification = await verifyWindowsCudaPack(
      {
        runtimeRoot: outputRoot,
        observeArtifact,
      },
      dependencies,
    );

    report = {
      schemaVersion: 1,
      packId: WINDOWS_CUDA_PACK_CONTRACT.packId,
      target: { ...WINDOWS_CUDA_PACK_CONTRACT.target },
      manifestSha256: verification.manifestSha256,
      archiveSha256: WINDOWS_CUDA_PACK_CONTRACT.sourceArchive.sha256,
      artifactCount: verification.artifactCount,
      expandedByteSize: verification.expandedByteSize,
      selectedArtifactByteSize: verification.selectedArtifactByteSize,
      delivery: {
        mode: "on_demand_accelerator_pack",
        bundledInInstaller: false,
        includedInDefaultExtraResources: false,
        signatureKind: "unsigned",
        distributionProfile: "unsigned_personal_distribution",
      },
      assembly: {
        selfContained: true,
        atomicDirectoryRename: true,
        noClobber: true,
        baseRuntimeModified: false,
      },
      targetSmoke: {
        status: "pending",
        backendVerified: false,
        requiredProof: "exact_pid_vram",
      },
      licenseClosure: {
        status: "pending",
        gate: "QA-005",
        artifactSharingAllowed: false,
      },
      model002: {
        owner: "MODEL-002",
        operationsImplementedByThisStager: [],
        excludedOperations: ["download", "install", "update", "rollback"],
      },
      privacy: {
        absolutePathsRecorded: false,
      },
    };
  } catch (error) {
    operationError = error;
  } finally {
    if (!published) {
      try {
        await rm(partialRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 250,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await publicationLock?.close();
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await rm(publicationLockPath, {
        force: true,
        maxRetries: 10,
        retryDelay: 250,
      });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (operationError) {
    if (cleanupError) {
      operationError.cleanupFailure = cleanupError.message;
    }
    throw operationError;
  }
  if (cleanupError) {
    throw new WindowsCudaPackError(
      "cuda_pack_cleanup_failed",
      "The Windows CUDA pack staging cleanup could not be confirmed.",
    );
  }
  return report;
}

export async function publishDirectoryWithRetries(
  source,
  destination,
  dependencies = {},
) {
  const renameImpl = dependencies.renameImpl ?? rename;
  const assertMissingImpl = dependencies.assertMissingImpl ?? assertMissing;
  const assertDestinationAuthorityImpl =
    dependencies.assertDestinationAuthorityImpl ?? (async () => {});
  const delayImpl = dependencies.delayImpl ?? delay;
  const maxRetries = dependencies.maxRetries ?? 120;
  for (let attempt = 0; ; attempt += 1) {
    await assertDestinationAuthorityImpl(destination);
    await assertMissingImpl(destination);
    try {
      await renameImpl(source, destination);
      return;
    } catch (error) {
      if (
        !new Set(["EBUSY", "EPERM", "EACCES"]).has(error?.code) ||
        attempt >= maxRetries
      ) {
        throw error;
      }
      await delayImpl(250);
    }
  }
}

export function parseWindowsCudaPackCliArguments(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "archive-path": { type: "string" },
        "expanded-root": { type: "string" },
        "output-root": { type: "string" },
        help: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch {
    throw new WindowsCudaPackError(
      "cuda_pack_options_invalid",
      "Windows CUDA pack staging arguments are invalid.",
    );
  }
  if (values.help) return { help: true };
  return {
    archivePath: values["archive-path"],
    expandedRoot: values["expanded-root"],
    outputRoot: values["output-root"],
  };
}

export async function runWindowsCudaPackCli(argv = process.argv.slice(2)) {
  const options = parseWindowsCudaPackCliArguments(argv);
  if (options.help) {
    process.stdout.write(`${WINDOWS_CUDA_PACK_STAGING_USAGE}\n`);
    return;
  }
  const report = await stageWindowsX64CudaPack(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function validateOptions(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Object.keys(options).some((key) => !ALLOWED_OPTION_KEYS.has(key))
  ) {
    throw new WindowsCudaPackError(
      "cuda_pack_options_invalid",
      "Windows CUDA pack staging options contain missing or unknown fields.",
    );
  }
}

function requirePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WindowsCudaPackError(
      "cuda_pack_options_invalid",
      `${label} is required.`,
    );
  }
  return value;
}

async function assertMissing(filePath) {
  const observed = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (observed) {
    throw new WindowsCudaPackError(
      "cuda_pack_staging_exists",
      "The Windows CUDA pack staging destination already exists.",
    );
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWindowsCudaPackCli().catch((error) => {
    process.stderr.write(
      `windows_cuda_pack_staging_failed: ${error?.code ?? "unknown"}: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
