import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
  type LocalSubtitleBackend,
} from "@/type/localSubtitle";
import {
  isLocalSubtitleVerifiedRuntimeBundle,
  type LocalSubtitleVerifiedRuntimeArtifact,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "./resource-path";
import {
  LOCAL_SUBTITLE_SERVER_HTTP_POLICY,
  invalidLocalSubtitleServerConfiguration,
} from "./server-contract";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const PRIVATE_PATH_PATTERN = /^\/fusionkit-[a-f0-9]{48}$/u;
const SENSITIVE_ENVIRONMENT_KEY_PATTERN =
  /(?:key|token|secret|authorization|credential|password|proxy|cookie|session|electron|node_options)/iu;

export const LOCAL_SUBTITLE_SERVER_PROCESS_POLICY = deepFreeze({
  minPort: 1,
  maxPort: 65_535,
  minThreads: 1,
  maxThreads: 8,
  processors: 1,
  expectedArtifactVersion:
    `${LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version}+${LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit.slice(0, 7)}`,
  shell: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"] as const,
  allowConvert: false,
  allowLoadEndpoint: false,
  allowProgressParsing: false,
} as const);

export type LocalSubtitleServerRandomBytes = (size: number) => Uint8Array;
export type LocalSubtitleServerProcessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export const LOCAL_SUBTITLE_SERVER_PURPOSES = Object.freeze([
  "inference",
  "model_load_smoke",
] as const);
export type LocalSubtitleServerPurpose =
  (typeof LOCAL_SUBTITLE_SERVER_PURPOSES)[number];

export const LOCAL_SUBTITLE_SERVER_MANAGED_RESOURCE_STORAGES = Object.freeze([
  "managed",
  "managed_staging",
] as const);
export type LocalSubtitleServerManagedResourceStorage =
  (typeof LOCAL_SUBTITLE_SERVER_MANAGED_RESOURCE_STORAGES)[number];

export interface LocalSubtitleServerEndpoint {
  readonly host: typeof LOCAL_SUBTITLE_SERVER_HTTP_POLICY.host;
  readonly port: number;
  readonly privatePath: string;
}

export interface LocalSubtitleServerManagedResourceIdentity<
  Storage extends LocalSubtitleServerManagedResourceStorage =
    LocalSubtitleServerManagedResourceStorage,
> {
  readonly storage: Storage;
  readonly id: string;
  readonly absolutePath: string;
  readonly byteSize: number;
  readonly sha256: string;
}

interface LocalSubtitleServerLoadIdentityBase {
  readonly contractVersion: typeof LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION;
  readonly engineVersion: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version;
  readonly engineCommit: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit;
  readonly runtimeRoot: string;
  readonly runtimeGeneration: string;
  readonly target: LocalSubtitleVerifiedRuntimeBundle["target"];
  readonly serverArtifact: Readonly<{
    id: string;
    kind: "server";
    backend: LocalSubtitleVerifiedRuntimeArtifact["backend"];
    absolutePath: string;
    byteSize: number;
    sha256: string;
    version: string;
    signatureKind: LocalSubtitleVerifiedRuntimeArtifact["signatureKind"];
  }>;
  readonly managedResourceRoot: string;
  readonly process: Readonly<{
    threads: number;
    processors: 1;
    noGpu: boolean;
  }>;
}

export type LocalSubtitleServerLoadIdentity =
  | (LocalSubtitleServerLoadIdentityBase & {
      readonly purpose: "inference";
      readonly backend: LocalSubtitleBackend;
      readonly model: LocalSubtitleServerManagedResourceIdentity<"managed">;
      readonly vadModel: LocalSubtitleServerManagedResourceIdentity<"managed">;
    })
  | (LocalSubtitleServerLoadIdentityBase & {
      readonly purpose: "model_load_smoke";
      readonly backend: "cpu";
      readonly model: LocalSubtitleServerManagedResourceIdentity<"managed_staging">;
      readonly process: Readonly<{
        threads: number;
        processors: 1;
        noGpu: true;
      }>;
    });

interface CreateLocalSubtitleServerLoadIdentityOptionsBase {
  readonly verifiedRuntime: LocalSubtitleVerifiedRuntimeBundle;
  readonly serverArtifactId: string;
  readonly managedResourceRoot: string;
  readonly threads: number;
}

export type CreateLocalSubtitleServerLoadIdentityOptions =
  | (CreateLocalSubtitleServerLoadIdentityOptionsBase & {
      readonly purpose: "inference";
      readonly backend: LocalSubtitleBackend;
      readonly model: LocalSubtitleServerManagedResourceIdentity<"managed">;
      readonly vadModel: LocalSubtitleServerManagedResourceIdentity<"managed">;
    })
  | (CreateLocalSubtitleServerLoadIdentityOptionsBase & {
      readonly purpose: "model_load_smoke";
      readonly backend: "cpu";
      readonly model: LocalSubtitleServerManagedResourceIdentity<"managed_staging">;
      readonly vadModel?: never;
    });

export type CreateLocalSubtitleServerProcessDescriptorOptions =
  CreateLocalSubtitleServerLoadIdentityOptions & {
  readonly endpoint: LocalSubtitleServerEndpoint;
  readonly sessionRoot: string;
  readonly emptyPublicDirectory: string;
  readonly temporaryDirectory: string;
  readonly sourceEnvironment?: Readonly<Record<string, string | undefined>>;
};

export interface LocalSubtitleServerProcessDescriptor {
  readonly contractVersion: typeof LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION;
  readonly endpoint: LocalSubtitleServerEndpoint;
  readonly loadIdentity: LocalSubtitleServerLoadIdentity;
  readonly command: string;
  readonly args: readonly string[];
  readonly spawnOptions: Readonly<{
    cwd: string;
    env: LocalSubtitleServerProcessEnvironment;
    shell: false;
    windowsHide: true;
    stdio: readonly ["ignore", "pipe", "pipe"];
  }>;
}

const endpointSchema = z
  .object({
    host: z.literal(LOCAL_SUBTITLE_SERVER_HTTP_POLICY.host),
    port: z
      .number()
      .int()
      .min(LOCAL_SUBTITLE_SERVER_PROCESS_POLICY.minPort)
      .max(LOCAL_SUBTITLE_SERVER_PROCESS_POLICY.maxPort),
    privatePath: z.string().regex(PRIVATE_PATH_PATTERN),
  })
  .strict();

export function createLocalSubtitleServerPrivatePath(
  randomBytesImpl: LocalSubtitleServerRandomBytes = randomBytes,
): string {
  const bytes = randomBytesImpl(
    LOCAL_SUBTITLE_SERVER_HTTP_POLICY.privatePathEntropyBytes,
  );
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !==
      LOCAL_SUBTITLE_SERVER_HTTP_POLICY.privatePathEntropyBytes
  ) {
    throw invalidConfiguration(
      "The local inference private path entropy source is invalid.",
    );
  }
  return `${LOCAL_SUBTITLE_SERVER_HTTP_POLICY.privatePathPrefix}${Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString("hex")}`;
}

export function createLocalSubtitleServerEndpoint(options: {
  readonly port: number;
  readonly randomBytes?: LocalSubtitleServerRandomBytes;
}): LocalSubtitleServerEndpoint {
  const requestPath = createLocalSubtitleServerPrivatePath(
    options.randomBytes,
  );
  return parseLocalSubtitleServerEndpoint({
    host: LOCAL_SUBTITLE_SERVER_HTTP_POLICY.host,
    port: options.port,
    privatePath: requestPath,
  });
}

export function parseLocalSubtitleServerEndpoint(
  input: unknown,
): LocalSubtitleServerEndpoint {
  const parsed = endpointSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidConfiguration("The local inference endpoint is invalid.");
  }
  return deepFreeze({ ...parsed.data });
}

export function createLocalSubtitleServerLoadIdentity(
  options: CreateLocalSubtitleServerLoadIdentityOptions,
): LocalSubtitleServerLoadIdentity {
  const artifact = validateLoadOptions(options);
  const common = {
    contractVersion: LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
    engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
    engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
    runtimeRoot: options.verifiedRuntime.root,
    runtimeGeneration: options.verifiedRuntime.runtimeGeneration,
    target: { ...options.verifiedRuntime.target },
    serverArtifact: {
      id: artifact.id,
      kind: "server" as const,
      backend: artifact.backend,
      absolutePath: artifact.absolutePath,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      version: artifact.version,
      signatureKind: artifact.signatureKind,
    },
    managedResourceRoot: options.managedResourceRoot,
    process: {
      threads: options.threads,
      processors: LOCAL_SUBTITLE_SERVER_PROCESS_POLICY.processors,
      noGpu: options.backend === "cpu",
    },
  };
  if (options.purpose === "inference") {
    return deepFreeze({
      ...common,
      purpose: options.purpose,
      backend: options.backend,
      model: { ...options.model },
      vadModel: { ...options.vadModel },
    });
  }
  return deepFreeze({
    ...common,
    purpose: options.purpose,
    backend: options.backend,
    model: { ...options.model },
    process: {
      ...common.process,
      noGpu: true,
    },
  });
}

export function canReuseLocalSubtitleServerLoadIdentity(
  current: LocalSubtitleServerLoadIdentity,
  requested: LocalSubtitleServerLoadIdentity,
): boolean {
  return loadIdentityKey(current) === loadIdentityKey(requested);
}

export function createLocalSubtitleServerProcessDescriptor(
  options: CreateLocalSubtitleServerProcessDescriptorOptions,
): LocalSubtitleServerProcessDescriptor {
  const endpoint = parseLocalSubtitleServerEndpoint(options.endpoint);
  const loadIdentity = createLocalSubtitleServerLoadIdentity(options);
  validateSessionPaths(options, loadIdentity);

  const args = [
    "--host",
    endpoint.host,
    "--port",
    String(endpoint.port),
    "--request-path",
    endpoint.privatePath,
    "--inference-path",
    LOCAL_SUBTITLE_SERVER_HTTP_POLICY.inferencePath,
    "--public",
    options.emptyPublicDirectory,
    "--tmp-dir",
    options.temporaryDirectory,
    "--model",
    loadIdentity.model.absolutePath,
    "--threads",
    String(loadIdentity.process.threads),
    "--processors",
    String(loadIdentity.process.processors),
    ...(loadIdentity.purpose === "inference"
      ? ["--vad-model", loadIdentity.vadModel.absolutePath]
      : []),
    ...(loadIdentity.process.noGpu ? ["--no-gpu"] : []),
  ];
  const command = loadIdentity.serverArtifact.absolutePath;
  const environment = buildLocalSubtitleServerEnvironment({
    platform: loadIdentity.target.platform,
    serverDirectory: path.dirname(command),
    temporaryDirectory: options.temporaryDirectory,
    sourceEnvironment: options.sourceEnvironment,
  });

  return deepFreeze({
    contractVersion: LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
    endpoint,
    loadIdentity,
    command,
    args,
    spawnOptions: {
      cwd: path.dirname(command),
      env: environment,
      shell: LOCAL_SUBTITLE_SERVER_PROCESS_POLICY.shell,
      windowsHide: LOCAL_SUBTITLE_SERVER_PROCESS_POLICY.windowsHide,
      stdio: [...LOCAL_SUBTITLE_SERVER_PROCESS_POLICY.stdio] as const,
    },
  });
}

export function buildLocalSubtitleServerEnvironment(options: {
  readonly platform: LocalSubtitleVerifiedRuntimeBundle["target"]["platform"];
  readonly serverDirectory: string;
  readonly temporaryDirectory: string;
  readonly sourceEnvironment?: Readonly<Record<string, string | undefined>>;
}): LocalSubtitleServerProcessEnvironment {
  assertAbsoluteNormalizedPath(
    options.serverDirectory,
    "The local inference server directory",
  );
  assertAbsoluteNormalizedPath(
    options.temporaryDirectory,
    "The local inference temporary directory",
  );
  if (options.platform !== "darwin" && options.platform !== "win32") {
    throw invalidConfiguration("The local inference target platform is invalid.");
  }

  const source = options.sourceEnvironment ?? process.env;
  const pathDelimiter = options.platform === "win32" ? ";" : ":";
  const executableDirectories = [options.serverDirectory];
  const environment: Record<string, string | undefined> = {
    PATH: executableDirectories.join(pathDelimiter),
    LANG: "C",
    LC_ALL: "C",
    TEMP: options.temporaryDirectory,
    TMP: options.temporaryDirectory,
    ...(options.platform === "darwin"
      ? { TMPDIR: options.temporaryDirectory }
      : {}),
  };

  if (options.platform === "win32") {
    for (const key of [
      "SystemRoot",
      "WINDIR",
      "ProgramFiles",
      "ProgramW6432",
    ] as const) {
      const value = source[key];
      if (isSafeEnvironmentValue(key, value)) {
        environment[key] = value;
      }
    }
    const systemRoot = environment.SystemRoot ?? environment.WINDIR;
    if (systemRoot) {
      executableDirectories.push(path.join(systemRoot, "System32"));
      environment.PATH = [...new Set(executableDirectories)].join(
        pathDelimiter,
      );
    }
  }

  return deepFreeze(environment);
}

export function isLocalSubtitleServerBackendCompatible(
  artifactBackend: LocalSubtitleVerifiedRuntimeArtifact["backend"],
  backend: LocalSubtitleBackend,
): boolean {
  if (artifactBackend === "metal_cpu") {
    return backend === "metal" || backend === "cpu";
  }
  return artifactBackend === backend;
}

function validateLoadOptions(
  options: CreateLocalSubtitleServerLoadIdentityOptions,
): LocalSubtitleVerifiedRuntimeArtifact {
  if (
    !(LOCAL_SUBTITLE_SERVER_PURPOSES as readonly string[]).includes(options.purpose)
  ) {
    throw invalidConfiguration("The local inference server purpose is invalid.");
  }
  const runtime = options.verifiedRuntime;
  if (
    !isLocalSubtitleVerifiedRuntimeBundle(runtime) ||
    runtime.schemaVersion !== 1 ||
    runtime.ready !== true ||
    runtime.noPathFallback !== true
  ) {
    throw invalidConfiguration(
      "The local inference runtime bundle is not a verified ready bundle.",
    );
  }
  assertAbsoluteNormalizedPath(runtime.root, "The verified runtime root");
  assertNotFilesystemRoot(runtime.root, "The verified runtime root");
  assertAbsoluteNormalizedPath(
    runtime.manifestPath,
    "The verified runtime manifest path",
  );
  assertContainedPath(
    runtime.root,
    runtime.manifestPath,
    "The verified runtime manifest",
  );
  assertSha256(runtime.manifestSha256, "The runtime manifest hash");
  assertSha256(runtime.runtimeGeneration, "The runtime generation");
  if (runtime.runtimeGeneration !== runtime.manifestSha256) {
    throw invalidConfiguration(
      "The local inference runtime generation is not the verified manifest generation.",
    );
  }
  if (runtime.scope !== "all" && runtime.scope !== "server") {
    throw invalidConfiguration(
      "The verified runtime does not include the local inference server.",
    );
  }
  if (
    (runtime.target.platform === "darwin" &&
      runtime.target.arch !== "arm64") ||
    (runtime.target.platform === "win32" && runtime.target.arch !== "x64") ||
    (runtime.target.platform !== "darwin" &&
      runtime.target.platform !== "win32")
  ) {
    throw invalidConfiguration("The local inference runtime target is invalid.");
  }
  const expectedIntegrityProfile = runtime.target.platform === "darwin"
    ? "macos_nested_signed_final_bytes_sha256"
    : "windows_unsigned_personal_final_bytes_sha256";
  if (
    runtime.integrityProfile !== expectedIntegrityProfile ||
    !Number.isSafeInteger(runtime.evidenceFileCount) ||
    runtime.evidenceFileCount < 1 ||
    typeof runtime.artifactPaths !== "object" ||
    runtime.artifactPaths === null
  ) {
    throw invalidConfiguration(
      "The local inference runtime verification evidence is invalid.",
    );
  }

  assertIdentifier(options.serverArtifactId, "The server artifact id");
  const artifact = Object.prototype.hasOwnProperty.call(
    runtime.artifactPaths,
    options.serverArtifactId,
  )
    ? runtime.artifactPaths[options.serverArtifactId]
    : undefined;
  if (!artifact || artifact.id !== options.serverArtifactId) {
    throw invalidConfiguration(
      "The requested server artifact is not part of the verified runtime bundle.",
    );
  }
  assertIdentifier(artifact.id, "The server artifact id");
  if (!artifact.id.startsWith("whisper-server-")) {
    throw invalidConfiguration("The verified artifact is not a pinned server.");
  }
  if (artifact.kind !== "server") {
    throw invalidConfiguration("The verified artifact is not a server binary.");
  }
  assertAbsoluteNormalizedPath(
    artifact.absolutePath,
    "The verified server artifact path",
  );
  assertContainedPath(
    runtime.root,
    artifact.absolutePath,
    "The verified server artifact",
  );
  const expectedLeaf =
    runtime.target.platform === "win32"
      ? "whisper-server.exe"
      : "whisper-server";
  if (path.basename(artifact.absolutePath) !== expectedLeaf) {
    throw invalidConfiguration("The verified server artifact leaf is invalid.");
  }
  assertPositiveByteSize(artifact.byteSize, "The server artifact byte size");
  assertSha256(artifact.sha256, "The server artifact hash");
  if (
    artifact.version !==
    LOCAL_SUBTITLE_SERVER_PROCESS_POLICY.expectedArtifactVersion
  ) {
    throw invalidConfiguration("The verified server artifact version is invalid.");
  }
  if (
    (runtime.target.platform === "darwin" &&
      artifact.backend !== "metal_cpu") ||
    (runtime.target.platform === "win32" &&
      artifact.backend !== "cpu" &&
      artifact.backend !== "cuda")
  ) {
    throw invalidConfiguration(
      "The verified server artifact does not match the runtime target.",
    );
  }
  if (!isLocalSubtitleServerBackendCompatible(artifact.backend, options.backend)) {
    throw invalidConfiguration(
      "The verified server artifact does not support the selected backend.",
    );
  }

  assertAbsoluteNormalizedPath(
    options.managedResourceRoot,
    "The managed resource root",
  );
  assertNotFilesystemRoot(options.managedResourceRoot, "The managed resource root");
  if (options.purpose === "model_load_smoke") {
    if (options.backend !== "cpu") {
      throw invalidConfiguration(
        "The local model load smoke must use the CPU backend.",
      );
    }
    if (Object.prototype.hasOwnProperty.call(options, "vadModel")) {
      throw invalidConfiguration(
        "The local model load smoke cannot load a VAD model.",
      );
    }
    validateManagedResource(
      options.model,
      options.managedResourceRoot,
      "model",
      "managed_staging",
    );
  } else {
    validateManagedResource(
      options.model,
      options.managedResourceRoot,
      "model",
      "managed",
    );
    validateManagedResource(
      options.vadModel,
      options.managedResourceRoot,
      "VAD model",
      "managed",
    );
    if (
      options.vadModel.id !== LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id ||
      options.vadModel.sha256 !== LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256
    ) {
      throw invalidConfiguration("The local inference VAD model is not pinned.");
    }
    if (options.model.absolutePath === options.vadModel.absolutePath) {
      throw invalidConfiguration("The model and VAD model paths must be distinct.");
    }
  }
  if (
    !Number.isSafeInteger(options.threads) ||
    options.threads < LOCAL_SUBTITLE_SERVER_PROCESS_POLICY.minThreads ||
    options.threads > LOCAL_SUBTITLE_SERVER_PROCESS_POLICY.maxThreads
  ) {
    throw invalidConfiguration("The local inference thread count is invalid.");
  }
  return artifact;
}

function validateSessionPaths(
  options: CreateLocalSubtitleServerProcessDescriptorOptions,
  loadIdentity: LocalSubtitleServerLoadIdentity,
): void {
  assertAbsoluteNormalizedPath(options.sessionRoot, "The server session root");
  assertNotFilesystemRoot(options.sessionRoot, "The server session root");
  assertAbsoluteNormalizedPath(
    options.emptyPublicDirectory,
    "The empty server public directory",
  );
  assertAbsoluteNormalizedPath(
    options.temporaryDirectory,
    "The server temporary directory",
  );
  assertContainedPath(
    options.sessionRoot,
    options.emptyPublicDirectory,
    "The empty server public directory",
  );
  assertContainedPath(
    options.sessionRoot,
    options.temporaryDirectory,
    "The server temporary directory",
  );
  if (
    pathsOverlap(options.emptyPublicDirectory, options.temporaryDirectory)
  ) {
    throw invalidConfiguration(
      "The server public and temporary directories must be disjoint.",
    );
  }
  if (
    pathsOverlap(options.sessionRoot, loadIdentity.runtimeRoot)
  ) {
    throw invalidConfiguration(
      "The server session root must be disjoint from the bundled runtime.",
    );
  }
  const privateFiles = [
    loadIdentity.serverArtifact.absolutePath,
    loadIdentity.model.absolutePath,
    ...(loadIdentity.purpose === "inference"
      ? [loadIdentity.vadModel.absolutePath]
      : []),
  ];
  for (const privateFile of privateFiles) {
    if (
      isPathWithin(options.emptyPublicDirectory, privateFile) ||
      isPathWithin(options.temporaryDirectory, privateFile)
    ) {
      throw invalidConfiguration(
        "A private runtime file cannot be inside a server session directory.",
      );
    }
  }
}

function validateManagedResource(
  resource: LocalSubtitleServerManagedResourceIdentity,
  root: string,
  label: string,
  expectedStorage: LocalSubtitleServerManagedResourceStorage,
): void {
  if (
    typeof resource !== "object" ||
    resource === null ||
    resource.storage !== expectedStorage
  ) {
    throw invalidConfiguration(`The ${label} storage is invalid.`);
  }
  assertIdentifier(resource.id, `The ${label} id`);
  assertAbsoluteNormalizedPath(resource.absolutePath, `The ${label} path`);
  assertContainedPath(root, resource.absolutePath, `The ${label}`);
  assertPositiveByteSize(resource.byteSize, `The ${label} byte size`);
  assertSha256(resource.sha256, `The ${label} hash`);
}

function loadIdentityKey(identity: LocalSubtitleServerLoadIdentity): string {
  return JSON.stringify([
    identity.contractVersion,
    identity.purpose,
    identity.engineVersion,
    identity.engineCommit,
    identity.runtimeRoot,
    identity.runtimeGeneration,
    identity.target.platform,
    identity.target.arch,
    identity.serverArtifact.id,
    identity.serverArtifact.kind,
    identity.serverArtifact.backend,
    identity.serverArtifact.absolutePath,
    identity.serverArtifact.byteSize,
    identity.serverArtifact.sha256,
    identity.serverArtifact.version,
    identity.serverArtifact.signatureKind,
    identity.backend,
    identity.managedResourceRoot,
    identity.model.storage,
    identity.model.id,
    identity.model.absolutePath,
    identity.model.byteSize,
    identity.model.sha256,
    ...(identity.purpose === "inference"
      ? [
          identity.vadModel.storage,
          identity.vadModel.id,
          identity.vadModel.absolutePath,
          identity.vadModel.byteSize,
          identity.vadModel.sha256,
        ]
      : []),
    identity.process.threads,
    identity.process.processors,
    identity.process.noGpu,
  ]);
}

function assertIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw invalidConfiguration(`${label} is invalid.`);
  }
}

function assertSha256(value: string, label: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalidConfiguration(`${label} is invalid.`);
  }
}

function assertPositiveByteSize(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > LOCAL_SUBTITLE_LIMITS.maxMediaFileBytes
  ) {
    throw invalidConfiguration(`${label} is invalid.`);
  }
}

function assertAbsoluteNormalizedPath(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw invalidConfiguration(`${label} is invalid.`);
  }
}

function assertNotFilesystemRoot(value: string, label: string): void {
  if (path.parse(value).root === value) {
    throw invalidConfiguration(`${label} cannot be a filesystem root.`);
  }
}

function assertContainedPath(root: string, candidate: string, label: string): void {
  if (!isStrictlyWithin(root, candidate)) {
    throw invalidConfiguration(`${label} is outside its controlled root.`);
  }
}

function isStrictlyWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isPathWithin(root: string, candidate: string): boolean {
  return root === candidate || isStrictlyWithin(root, candidate);
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function isSafeEnvironmentValue(
  key: string,
  value: string | undefined,
): value is string {
  return (
    !SENSITIVE_ENVIRONMENT_KEY_PATTERN.test(key) &&
    typeof value === "string" &&
    value.length > 0 &&
    !/[\u0000\r\n]/u.test(value)
  );
}

function invalidConfiguration(message: string) {
  return invalidLocalSubtitleServerConfiguration(message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
