import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  WINDOWS_CUDA_PACK_CONTRACT,
  WINDOWS_CUDA_PACK_MANIFEST_RELATIVE_PATH,
  WINDOWS_CUDA_PACK_PROJECT_ROOT,
  assertIndependentWindowsCudaPackRoot,
  assertWindowsCudaPackOutputAuthority,
  getWindowsCudaPackArtifact,
  resolveWindowsCudaPackRoot,
  validateWindowsCudaArchiveObservation,
  validateWindowsCudaArtifactObservation,
  validateWindowsCudaPackContract,
} from "./windows-cuda-pack-contract.mjs";

function cloneContract() {
  return JSON.parse(JSON.stringify(WINDOWS_CUDA_PACK_CONTRACT));
}

test("pins the exact self-contained 20-file Windows CUDA candidate", () => {
  assert.equal(WINDOWS_CUDA_PACK_CONTRACT.schemaVersion, 1);
  assert.equal(WINDOWS_CUDA_PACK_CONTRACT.target.platform, "win32");
  assert.equal(WINDOWS_CUDA_PACK_CONTRACT.target.arch, "x64");
  assert.equal(WINDOWS_CUDA_PACK_CONTRACT.target.backend, "cuda");
  assert.equal(WINDOWS_CUDA_PACK_CONTRACT.target.cudaVersion, "12.4");
  assert.equal(WINDOWS_CUDA_PACK_CONTRACT.artifacts.length, 20);
  assert.equal(
    WINDOWS_CUDA_PACK_CONTRACT.artifacts.reduce(
      (sum, artifact) => sum + artifact.byteSize,
      0,
    ),
    1199083008,
  );
  assert.equal(
    WINDOWS_CUDA_PACK_CONTRACT.selection.selectedArtifactByteSize,
    1199083008,
  );
  assert.deepEqual(
    WINDOWS_CUDA_PACK_CONTRACT.artifacts
      .filter((artifact) => artifact.kind === "server")
      .map((artifact) => artifact.fileName),
    ["whisper-server.exe"],
  );
  for (const excluded of ["SDL2.dll", "parakeet.dll", "whisper-cli.exe"]) {
    assert.equal(
      WINDOWS_CUDA_PACK_CONTRACT.artifacts.some(
        (artifact) => artifact.fileName === excluded,
      ),
      false,
    );
    assert.equal(
      WINDOWS_CUDA_PACK_CONTRACT.selection.excludedArchiveEntries.includes(
        excluded,
      ),
      true,
    );
  }
});

test("records on-demand, unsigned, external-smoke, MODEL-002, and license boundaries", () => {
  assert.equal(WINDOWS_CUDA_PACK_CONTRACT.delivery.bundledInInstaller, false);
  assert.equal(
    WINDOWS_CUDA_PACK_CONTRACT.delivery.includedInDefaultExtraResources,
    false,
  );
  assert.equal(WINDOWS_CUDA_PACK_CONTRACT.delivery.signatureKind, "unsigned");
  assert.equal(WINDOWS_CUDA_PACK_CONTRACT.acceptance.targetSmokeStatus, "pending");
  assert.deepEqual(
    WINDOWS_CUDA_PACK_CONTRACT.acceptance.model002.excludedOperations,
    ["download", "install", "update", "rollback"],
  );
  assert.deepEqual(
    WINDOWS_CUDA_PACK_CONTRACT.licenses.map((license) => license.id),
    ["whisper-cpp-mit", "nvidia-cuda-runtime-eula"],
  );
  assert.equal(
    WINDOWS_CUDA_PACK_CONTRACT.licenses[1].closureGate,
    "QA-005",
  );
  assert.equal(
    WINDOWS_CUDA_PACK_CONTRACT.licenses[1].artifactSharingAllowed,
    false,
  );
  const licenseIds = new Set(
    WINDOWS_CUDA_PACK_CONTRACT.licenses.map((license) => license.id),
  );
  assert.equal(
    WINDOWS_CUDA_PACK_CONTRACT.artifacts.every(
      (artifact) => licenseIds.has(artifact.licenseRef),
    ),
    true,
  );
});

test("rejects unknown fields and any nested contract drift", () => {
  const topLevelUnknown = cloneContract();
  topLevelUnknown.cudaReady = true;
  assert.throws(
    () => validateWindowsCudaPackContract(topLevelUnknown),
    (error) => error?.code === "cuda_pack_contract_invalid",
  );

  const nestedUnknown = cloneContract();
  nestedUnknown.delivery.ready = true;
  assert.throws(
    () => validateWindowsCudaPackContract(nestedUnknown),
    (error) => error?.code === "cuda_pack_contract_invalid",
  );

  const artifactDrift = cloneContract();
  artifactDrift.artifacts[0].sha256 = "0".repeat(64);
  assert.throws(
    () => validateWindowsCudaPackContract(artifactDrift),
    (error) => error?.code === "cuda_pack_contract_invalid",
  );
});

test("rejects source archive drift", () => {
  validateWindowsCudaArchiveObservation({
    byteSize: 677887125,
    sha256:
      "106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b",
  });
  assert.throws(
    () =>
      validateWindowsCudaArchiveObservation({
        byteSize: 677887124,
        sha256:
          "106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b",
      }),
    (error) => error?.code === "cuda_pack_archive_invalid",
  );
});

test("rejects a same-name DLL copied from the CPU release", () => {
  assert.throws(
    () =>
      validateWindowsCudaArtifactObservation("ggml-base.dll", {
        byteSize: 656384,
        sha256:
          "8be6f3e06388b3a9aac75d29bec86363e2e2f5b0cee86ce6438866bcac0bcf86",
        format: "pe",
        architectures: ["x64"],
      }),
    (error) => error?.code === "cuda_pack_artifact_invalid",
  );
  const cudaArtifact = getWindowsCudaPackArtifact("ggml-base.dll");
  validateWindowsCudaArtifactObservation("ggml-base.dll", {
    byteSize: cudaArtifact.byteSize,
    sha256: cudaArtifact.sha256,
    format: "pe",
    architectures: ["x64"],
  });
});

test("keeps the accelerator output independent from the canonical base root", () => {
  assert.equal(
    WINDOWS_CUDA_PACK_CONTRACT.staging.manifestRelativePath,
    WINDOWS_CUDA_PACK_MANIFEST_RELATIVE_PATH,
  );
  assert.equal(
    resolveWindowsCudaPackRoot({ projectRoot: WINDOWS_CUDA_PACK_PROJECT_ROOT }),
    path.join(
      WINDOWS_CUDA_PACK_PROJECT_ROOT,
      "build",
      "local-subtitle-accelerators",
      "win32-x64",
      "cuda-12.4",
      "v1",
    ),
  );
  assert.throws(
    () =>
      assertIndependentWindowsCudaPackRoot(
        path.join(
          WINDOWS_CUDA_PACK_PROJECT_ROOT,
          "build",
          "local-subtitle-resources",
          "local-subtitle",
          "cuda",
        ),
      ),
    (error) => error?.code === "cuda_pack_output_boundary",
  );
  assert.throws(
    () =>
      resolveWindowsCudaPackRoot({
        projectRoot: WINDOWS_CUDA_PACK_PROJECT_ROOT,
        outputRoot: WINDOWS_CUDA_PACK_PROJECT_ROOT,
      }),
    (error) => error?.code === "cuda_pack_output_boundary",
  );
});

test("rejects linked accelerator output ancestors", async () => {
  const projectRoot = path.resolve("cuda-authority-project");
  const outputRoot = path.join(
    projectRoot,
    "build",
    "local-subtitle-accelerators",
    "v1",
  );
  const linkedAncestor = path.join(
    projectRoot,
    "build",
    "local-subtitle-accelerators",
  );
  await assert.rejects(
    assertWindowsCudaPackOutputAuthority(
      outputRoot,
      projectRoot,
      {
        lstatImpl: async (candidate) => ({
          isDirectory: () => true,
          isSymbolicLink: () =>
            path.resolve(candidate) === path.resolve(linkedAncestor),
        }),
      },
    ),
    (error) => error?.code === "cuda_pack_output_boundary",
  );
});
