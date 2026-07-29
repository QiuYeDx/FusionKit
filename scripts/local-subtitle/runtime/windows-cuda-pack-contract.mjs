import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  inspectNativeBinaryFile,
  sha256File,
} from "./runtime-manifest.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const WINDOWS_CUDA_PACK_PROJECT_ROOT = path.resolve(
  SCRIPT_DIRECTORY,
  "../../..",
);
export const WINDOWS_CUDA_PACK_MANIFEST_RELATIVE_PATH =
  "manifests/local-subtitle-windows-cuda-pack.v1.json";
export const WINDOWS_CUDA_PACK_SOURCE_MANIFEST_PATH = path.join(
  WINDOWS_CUDA_PACK_PROJECT_ROOT,
  "resources",
  "local-subtitle",
  ...WINDOWS_CUDA_PACK_MANIFEST_RELATIVE_PATH.split("/"),
);

const NVIDIA_LICENSE_REF = "nvidia-cuda-runtime-eula";
const WHISPER_LICENSE_REF = "whisper-cpp-mit";
const NVIDIA_FILES = new Set([
  "cublas64_12.dll",
  "cublasLt64_12.dll",
  "cudart64_12.dll",
  "nvblas64_12.dll",
  "nvrtc-builtins64_124.dll",
  "nvrtc64_120_0.dll",
]);
const ARTIFACT_PINS = Object.freeze([
  ["whisper-server-win-x64-cuda-12-4", "whisper-server.exe", 728576, "c72f99b75ae4111d6e7ddb62e04d3c0c94fea2ba6536412e517f256b4388dd37"],
  ["cuda-dependency-cublas64-12-dll", "cublas64_12.dll", 100033536, "e40202fe4223c1cd2d2dce7beec59e1ed61c7801bd827309183be9b50e358f4c"],
  ["cuda-dependency-cublas-lt64-12-dll", "cublasLt64_12.dll", 473551360, "2a896460bef60ed57ef32b0875812f355a6984e671d638bb632f5e8c1d7a831f"],
  ["cuda-dependency-cudart64-12-dll", "cudart64_12.dll", 553984, "d28e42265da7462162a54da6b7a99ea4fa2caf8139d862bb500db875d0b32dfc"],
  ["cuda-dependency-ggml-base-dll", "ggml-base.dll", 641024, "2fdf1dea0cbab9d796d1a6c2bca672a3784c5faec2f1df2a3812212fa7409747"],
  ["cuda-dependency-ggml-cpu-alderlake-dll", "ggml-cpu-alderlake.dll", 789504, "e9e27720fd14a33e86d13c1c8fee5a6afbf6a702e8472abb84cde23ccb4fb654"],
  ["cuda-dependency-ggml-cpu-cannonlake-dll", "ggml-cpu-cannonlake.dll", 833536, "63c136e823b85e519a2fd5d5085c7f28e9b07a7d23df99b6e2abd05dbcf4b47c"],
  ["cuda-dependency-ggml-cpu-cascadelake-dll", "ggml-cpu-cascadelake.dll", 830976, "9ab872d0e6e0dd6c5becd585cc84e1684ddfc603443904bc007af4a14e4a52fb"],
  ["cuda-dependency-ggml-cpu-haswell-dll", "ggml-cpu-haswell.dll", 790528, "cb4b01954b8b7bec4d891024192d3ed80c43102a4d17447ceefc4e183632df1f"],
  ["cuda-dependency-ggml-cpu-icelake-dll", "ggml-cpu-icelake.dll", 830976, "e97d8c4744c92e74190979a7d87a690d02d26373724d203722284e1cc837becb"],
  ["cuda-dependency-ggml-cpu-sandybridge-dll", "ggml-cpu-sandybridge.dll", 763904, "695b93cd2a2b4d30c60b722d0ff92870b308af82bf76be45a1ceb9aea8c3f611"],
  ["cuda-dependency-ggml-cpu-skylakex-dll", "ggml-cpu-skylakex.dll", 833536, "37ee8dd2620aa8e350f50ccc22e3fd3995ef63edb696d42c12830b06ef81ff28"],
  ["cuda-dependency-ggml-cpu-sse42-dll", "ggml-cpu-sse42.dll", 751104, "25db1975a6664ae7f77db3bce0ee6f35d4894514717a39cf97f833bf56a7d2c4"],
  ["cuda-dependency-ggml-cpu-x64-dll", "ggml-cpu-x64.dll", 752128, "b338f13d391470fd3dab3029df226f6306ca8140c69bc381725e39507b4d59f4"],
  ["cuda-dependency-ggml-cuda-dll", "ggml-cuda.dll", 564585984, "bdf5ba84f7014eaa8a4fae7a090ce222edf03432ef8d39d57fb615beea5c68ac"],
  ["cuda-dependency-ggml-dll", "ggml.dll", 66560, "3063b832600f58fb0e15af50a9ace99dbc15de02b8cb325df64390bfbcf22796"],
  ["cuda-dependency-nvblas64-12-dll", "nvblas64_12.dll", 331776, "e42a77405e6e4b1cc661dcfcddead35ec62dcf59c6f9be1a3b5fab73d1f4c616"],
  ["cuda-dependency-nvrtc-builtins64-124-dll", "nvrtc-builtins64_124.dll", 5367808, "79888dba26c51475ea21fc7b47d2b9dd5b1ffaecc8e5ea22a49fa5f5a722eb43"],
  ["cuda-dependency-nvrtc64-120-0-dll", "nvrtc64_120_0.dll", 44738048, "3aa3cd8aa10437e212760c0e1ed730807811ec3bc330216dbfde4b26211d2243"],
  ["cuda-dependency-whisper-dll", "whisper.dll", 1308160, "0c76791ffda66ce58b6247424ca750a4b1bff12fd52928abb81de3037172ce1b"],
]);
const EXCLUDED_ARCHIVE_ENTRIES = Object.freeze([
  "bench.exe",
  "command.exe",
  "main.exe",
  "parakeet-cli.exe",
  "parakeet-quantize.exe",
  "parakeet.dll",
  "SDL2.dll",
  "stream.exe",
  "test-common-utf8.exe",
  "test-parakeet-full-diffusion.exe",
  "test-parakeet-full-gb1.exe",
  "test-parakeet-full-jfk.exe",
  "test-parakeet.exe",
  "test-vad-full.exe",
  "test-vad.exe",
  "wchess.exe",
  "whisper-bench.exe",
  "whisper-cli.exe",
  "whisper-command.exe",
  "whisper-lsp.exe",
  "whisper-quantize.exe",
  "whisper-stream.exe",
  "whisper-talk-llama.exe",
  "whisper-vad-speech-segments.exe",
]);

const EXPECTED_CONTRACT = {
  schemaVersion: 1,
  packId: "local-subtitle-windows-x64-cuda-12.4-v1",
  engine: {
    id: "whisper.cpp",
    version: "v1.9.1",
    commit: "f049fff95a089aa9969deb009cdd4892b3e74916",
  },
  target: {
    platform: "win32",
    arch: "x64",
    backend: "cuda",
    cudaVersion: "12.4",
  },
  delivery: {
    mode: "on_demand_accelerator_pack",
    bundledInInstaller: false,
    includedInDefaultExtraResources: false,
    distributionProfile: "unsigned_personal_distribution",
    signatureKind: "unsigned",
    selfContained: true,
  },
  sourceArchive: {
    fileName: "whisper-cublas-12.4.0-bin-x64.zip",
    downloadUrl:
      "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-cublas-12.4.0-bin-x64.zip",
    byteSize: 677887125,
    sha256:
      "106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b",
    expandedFileCount: 44,
    expandedByteSize: 1209487872,
  },
  staging: {
    developmentPackRoot:
      "build/local-subtitle-accelerators/win32-x64/cuda-12.4/v1",
    baseRuntimeRoot: "build/local-subtitle-resources/local-subtitle",
    manifestRelativePath: WINDOWS_CUDA_PACK_MANIFEST_RELATIVE_PATH,
    artifactRoot: "win-x64/cuda",
    publication: "atomic_directory_rename_no_clobber",
  },
  acceptance: {
    targetSmokeStatus: "pending",
    backendVerificationRequired: "exact_pid_vram",
    licenseClosure: {
      status: "pending",
      gate: "QA-005",
      artifactSharingAllowed: false,
    },
    model002: {
      owner: "MODEL-002",
      downloadInstallUpdateImplementedByThisStager: false,
      excludedOperations: ["download", "install", "update", "rollback"],
    },
  },
  licenses: [
    {
      id: WHISPER_LICENSE_REF,
      component: "whisper.cpp v1.9.1",
      spdxExpression: "MIT",
      status: "declared",
      closureGate: "none",
      artifactSharingAllowed: true,
    },
    {
      id: NVIDIA_LICENSE_REF,
      component: "NVIDIA CUDA 12.4 redistributable runtime dependencies",
      spdxExpression: "LicenseRef-NVIDIA-CUDA-EULA",
      status: "pending",
      closureGate: "QA-005",
      artifactSharingAllowed: false,
    },
  ],
  selection: {
    selectedArtifactCount: 20,
    selectedArtifactByteSize: 1199083008,
    excludedArchiveEntries: [...EXCLUDED_ARCHIVE_ENTRIES],
  },
  artifacts: ARTIFACT_PINS.map(([id, fileName, byteSize, sha256], index) => ({
    id,
    kind: index === 0 ? "server" : "dynamic_library",
    fileName,
    relativePath: `win-x64/cuda/${fileName}`,
    byteSize,
    sha256,
    format: "pe",
    architecture: "x64",
    backend: "cuda",
    signatureKind: "unsigned",
    licenseRef: NVIDIA_FILES.has(fileName)
      ? NVIDIA_LICENSE_REF
      : WHISPER_LICENSE_REF,
  })),
};

export class WindowsCudaPackError extends Error {
  constructor(code, detail) {
    super(detail);
    this.name = "WindowsCudaPackError";
    this.code = code;
  }
}

export function validateWindowsCudaPackContract(value) {
  assertExactValue(value, EXPECTED_CONTRACT, "Windows CUDA pack contract");
  return value;
}

const sourceManifest = JSON.parse(
  await readFile(WINDOWS_CUDA_PACK_SOURCE_MANIFEST_PATH, "utf8"),
);
validateWindowsCudaPackContract(sourceManifest);
export const WINDOWS_CUDA_PACK_CONTRACT = deepFreeze(sourceManifest);
export const WINDOWS_CUDA_PACK_MANIFEST_BYTES = Buffer.from(
  `${JSON.stringify(WINDOWS_CUDA_PACK_CONTRACT, null, 2)}\n`,
  "utf8",
);
export const WINDOWS_CUDA_PACK_MANIFEST_SHA256 = createHash("sha256")
  .update(WINDOWS_CUDA_PACK_MANIFEST_BYTES)
  .digest("hex");

export function getWindowsCudaPackArtifact(fileName) {
  const artifact = WINDOWS_CUDA_PACK_CONTRACT.artifacts.find(
    (candidate) => candidate.fileName === fileName,
  );
  if (!artifact) {
    throw invalidArtifact("The Windows CUDA pack artifact is not selected.");
  }
  return artifact;
}

export function validateWindowsCudaArchiveObservation(observation) {
  if (
    !isPlainObject(observation) ||
    observation.byteSize !== WINDOWS_CUDA_PACK_CONTRACT.sourceArchive.byteSize ||
    observation.sha256 !== WINDOWS_CUDA_PACK_CONTRACT.sourceArchive.sha256
  ) {
    throw new WindowsCudaPackError(
      "cuda_pack_archive_invalid",
      "The Windows CUDA source archive does not match its pinned size and SHA-256.",
    );
  }
  return observation;
}

export function validateWindowsCudaArtifactObservation(
  fileName,
  observation,
) {
  const artifact = getWindowsCudaPackArtifact(fileName);
  if (
    !isPlainObject(observation) ||
    observation.byteSize !== artifact.byteSize ||
    observation.sha256 !== artifact.sha256 ||
    observation.format !== artifact.format ||
    !Array.isArray(observation.architectures) ||
    observation.architectures.length !== 1 ||
    observation.architectures[0] !== artifact.architecture
  ) {
    throw invalidArtifact(
      `The selected Windows CUDA artifact ${fileName} failed its pinned size, SHA-256, or PE x64 check.`,
    );
  }
  return observation;
}

export function resolveWindowsCudaPackRoot(options = {}) {
  if (!isPlainObject(options)) {
    throw boundaryError("Windows CUDA pack root options must be an object.");
  }
  const projectRoot = path.resolve(
    options.projectRoot ?? WINDOWS_CUDA_PACK_PROJECT_ROOT,
  );
  const outputRoot = path.resolve(
    options.outputRoot ??
      path.join(
        projectRoot,
        ...WINDOWS_CUDA_PACK_CONTRACT.staging.developmentPackRoot.split("/"),
      ),
  );
  assertIndependentWindowsCudaPackRoot(outputRoot, projectRoot);
  return outputRoot;
}

export function resolveWindowsCudaPackBaseRuntimeRoot(
  projectRoot = WINDOWS_CUDA_PACK_PROJECT_ROOT,
) {
  return path.resolve(
    projectRoot,
    ...WINDOWS_CUDA_PACK_CONTRACT.staging.baseRuntimeRoot.split("/"),
  );
}

export function assertIndependentWindowsCudaPackRoot(
  outputRoot,
  projectRoot = WINDOWS_CUDA_PACK_PROJECT_ROOT,
) {
  if (typeof outputRoot !== "string" || outputRoot.trim() === "") {
    throw boundaryError("Windows CUDA pack outputRoot must be a path.");
  }
  const resolvedProject = path.resolve(projectRoot);
  const resolvedOutput = path.resolve(outputRoot);
  const baseRoot = resolveWindowsCudaPackBaseRuntimeRoot(resolvedProject);
  if (
    resolvedOutput === path.parse(resolvedOutput).root ||
    pathsOverlap(resolvedOutput, resolvedProject) &&
      (samePath(resolvedOutput, resolvedProject) ||
        isContainedPath(resolvedOutput, resolvedProject)) ||
    pathsOverlap(resolvedOutput, baseRoot)
  ) {
    throw boundaryError(
      "The Windows CUDA accelerator root must be independent from the project and canonical base runtime roots.",
    );
  }
  return resolvedOutput;
}

export async function assertWindowsCudaPackOutputAuthority(
  outputRoot,
  projectRoot = WINDOWS_CUDA_PACK_PROJECT_ROOT,
  dependencies = {},
) {
  const resolvedOutput = assertIndependentWindowsCudaPackRoot(
    outputRoot,
    projectRoot,
  );
  const lstatImpl = dependencies.lstatImpl ?? lstat;
  await assertDirectoryAncestorChain(
    path.dirname(resolvedOutput),
    lstatImpl,
  );
  return resolvedOutput;
}

const verificationSecrets = new WeakMap();

export async function verifyWindowsCudaPack(options, dependencies = {}) {
  const normalized = typeof options === "string"
    ? { runtimeRoot: options }
    : options;
  if (!isPlainObject(normalized)) {
    throw invalidArtifact("Windows CUDA pack verification options are invalid.");
  }
  const allowed = new Set([
    "runtimeRoot",
    "launch",
    "commandRunner",
    "launchTimeoutMs",
    "observeArtifact",
  ]);
  if (Object.keys(normalized).some((key) => !allowed.has(key))) {
    throw invalidArtifact("Windows CUDA pack verification options contain unknown fields.");
  }
  const runtimeRoot = path.resolve(requirePath(normalized.runtimeRoot, "runtimeRoot"));
  const rootStat = await lstat(runtimeRoot).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw invalidArtifact("The Windows CUDA pack root is not a regular directory.");
  }
  const manifestPath = path.join(
    runtimeRoot,
    ...WINDOWS_CUDA_PACK_MANIFEST_RELATIVE_PATH.split("/"),
  );
  const manifestStat = await lstat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
    throw invalidArtifact("The Windows CUDA pack manifest is missing or invalid.");
  }
  const manifestBytes = await readFile(manifestPath);
  if (
    createHash("sha256").update(manifestBytes).digest("hex") !==
      WINDOWS_CUDA_PACK_MANIFEST_SHA256
  ) {
    throw invalidArtifact("The Windows CUDA pack manifest bytes are not canonical.");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw invalidArtifact("The Windows CUDA pack manifest is not valid JSON.");
  }
  validateWindowsCudaPackContract(manifest);
  await assertExactPackTree(runtimeRoot);

  const observeArtifact =
    normalized.observeArtifact ??
    dependencies.observeArtifact ??
    observeWindowsCudaArtifact;
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(
      runtimeRoot,
      ...artifact.relativePath.split("/"),
    );
    validateWindowsCudaArtifactObservation(
      artifact.fileName,
      await observeArtifact(artifactPath, artifact),
    );
  }
  const serverArtifact = manifest.artifacts.find(
    (artifact) => artifact.kind === "server",
  );
  const serverPath = path.join(
    runtimeRoot,
    ...serverArtifact.relativePath.split("/"),
  );
  const launchResults = [];
  if (normalized.launch === true) {
    const runner =
      normalized.commandRunner ??
      dependencies.commandRunner ??
      runServerIdentityProbe;
    const result = await runner(serverPath, ["--help"], {
      cwd: path.dirname(serverPath),
      timeoutMs: normalized.launchTimeoutMs ?? 15_000,
    });
    const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`;
    if (
      result?.exitCode !== 0 ||
      !/(?:whisper-server|whisper server|usage:)/iu.test(output)
    ) {
      throw invalidArtifact(
        "The Windows CUDA server failed its launch identity probe.",
      );
    }
    launchResults.push({
      id: serverArtifact.id,
      kind: serverArtifact.kind,
      versionMatched: true,
      exitCode: 0,
    });
  }
  const verification = {
    schemaVersion: 1,
    packId: manifest.packId,
    target: { ...manifest.target },
    manifestSha256: WINDOWS_CUDA_PACK_MANIFEST_SHA256,
    archiveSha256: manifest.sourceArchive.sha256,
    artifactCount: manifest.artifacts.length,
    expandedByteSize: manifest.sourceArchive.expandedByteSize,
    selectedArtifactByteSize: manifest.selection.selectedArtifactByteSize,
    serverArtifactId: serverArtifact.id,
    launchResults,
    targetSmokeStatus: "pending",
    backendVerified: false,
  };
  verificationSecrets.set(verification, {
    runtimeRoot,
    serverPath,
    manifestSha256: WINDOWS_CUDA_PACK_MANIFEST_SHA256,
  });
  return verification;
}

export function resolveWindowsCudaServer(verification) {
  const proof = verificationSecrets.get(verification);
  if (
    !proof ||
    verification?.manifestSha256 !== proof.manifestSha256 ||
    verification?.serverArtifactId !==
      getWindowsCudaPackArtifact("whisper-server.exe").id
  ) {
    throw invalidArtifact(
      "A verified Windows CUDA pack result is required to resolve the server.",
    );
  }
  return proof.serverPath;
}

export async function observeWindowsCudaArchive(archivePath) {
  const fileStat = await lstat(archivePath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.isSymbolicLink()) {
    throw new WindowsCudaPackError(
      "cuda_pack_archive_invalid",
      "The Windows CUDA source archive is not a regular file.",
    );
  }
  return {
    byteSize: fileStat.size,
    sha256: await sha256File(archivePath),
  };
}

export async function observeWindowsCudaArtifact(filePath) {
  const fileStat = await lstat(filePath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.isSymbolicLink()) {
    throw invalidArtifact("A selected Windows CUDA artifact is not a regular file.");
  }
  const inspection = await inspectNativeBinaryFile(filePath);
  return {
    byteSize: fileStat.size,
    sha256: await sha256File(filePath),
    format: inspection.format,
    architectures: inspection.architectures,
  };
}

export function serializeWindowsCudaPackContract(
  contract = WINDOWS_CUDA_PACK_CONTRACT,
) {
  validateWindowsCudaPackContract(contract);
  return Buffer.from(`${JSON.stringify(contract, null, 2)}\n`, "utf8");
}

async function assertExactPackTree(runtimeRoot) {
  const expectedFiles = new Set([
    WINDOWS_CUDA_PACK_MANIFEST_RELATIVE_PATH,
    ...WINDOWS_CUDA_PACK_CONTRACT.artifacts.map(
      (artifact) => artifact.relativePath,
    ),
  ]);
  const expectedDirectories = new Set();
  for (const file of expectedFiles) {
    let current = path.posix.dirname(file);
    while (current !== ".") {
      expectedDirectories.add(current);
      current = path.posix.dirname(current);
    }
  }
  const observedFiles = new Set();
  async function walk(directory, relativeDirectory = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) {
        throw invalidArtifact("The Windows CUDA pack cannot contain symbolic links.");
      }
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) {
          throw invalidArtifact("The Windows CUDA pack contains an unexpected directory.");
        }
        await walk(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        if (!expectedFiles.has(relativePath)) {
          throw invalidArtifact("The Windows CUDA pack contains an unexpected file.");
        }
        observedFiles.add(relativePath);
      } else {
        throw invalidArtifact("The Windows CUDA pack contains an invalid entry type.");
      }
    }
  }
  await walk(runtimeRoot);
  if (
    observedFiles.size !== expectedFiles.size ||
    [...expectedFiles].some((file) => !observedFiles.has(file))
  ) {
    throw invalidArtifact("The Windows CUDA pack is incomplete.");
  }
}

async function runServerIdentityProbe(command, args, options) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? ""),
    };
  }
}

function assertExactValue(actual, expected, label) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw invalidContract(`${label} does not match the pinned contract.`);
    }
    for (let index = 0; index < expected.length; index += 1) {
      assertExactValue(actual[index], expected[index], `${label}[${index}]`);
    }
    return;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      throw invalidContract(`${label} must be an object.`);
    }
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      throw invalidContract(`${label} has missing or unknown fields.`);
    }
    for (const key of expectedKeys) {
      assertExactValue(actual[key], expected[key], `${label}.${key}`);
    }
    return;
  }
  if (actual !== expected) {
    throw invalidContract(`${label} does not match the pinned contract.`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function pathsOverlap(left, right) {
  return (
    samePath(left, right) ||
    isContainedPath(left, right) ||
    isContainedPath(right, left)
  );
}

function isContainedPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function assertDirectoryAncestorChain(directoryPath, lstatImpl) {
  const resolved = path.resolve(directoryPath);
  const parsed = path.parse(resolved);
  const segments = path
    .relative(parsed.root, resolved)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let proof;
    try {
      proof = await lstatImpl(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (proof.isSymbolicLink() || !proof.isDirectory()) {
      throw boundaryError(
        "The Windows CUDA accelerator output has a linked or non-directory ancestor.",
      );
    }
  }
}

function requirePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidArtifact(`${label} is required.`);
  }
  return value;
}

function invalidContract(detail) {
  return new WindowsCudaPackError("cuda_pack_contract_invalid", detail);
}

function invalidArtifact(detail) {
  return new WindowsCudaPackError("cuda_pack_artifact_invalid", detail);
}

function boundaryError(detail) {
  return new WindowsCudaPackError("cuda_pack_output_boundary", detail);
}
