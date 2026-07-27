const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ARTIFACT_NAME_PATTERN = "${productName}_${version}_${arch}.${ext}";
const CANONICAL_RUNTIME_FROM = "build/local-subtitle-resources/local-subtitle";
const CANONICAL_RUNTIME_TO = "local-subtitle";
const CANONICAL_RUNTIME_FILTER = "**/*";

function createBeforePackHook(dependencies = {}) {
  return async function localSubtitleBeforePack(context) {
    try {
      const target = resolveBuildTarget(context, {
        processPlatform: dependencies.processPlatform ?? process.platform,
        processArch: dependencies.processArch ?? process.arch,
      });
      const projectRoot = resolveProjectRoot(context);
      const config = context.packager.config;
      const contract = dependencies.assertBuilderConsumptionContract ??
        await loadBuilderContract();
      contract(config, ARTIFACT_NAME_PATTERN);
      const runtimeRoot = findRuntimeRoot(config.extraResources, projectRoot);
      if (!runtimeRoot) {
        throw stagingError("The canonical local-subtitle resource mapping is missing.");
      }

      const verifiers = await resolveVerifiers(dependencies);
      const runtimeVerification = await verifiers.verifyRuntimeBundle({
        runtimeRoot,
        platform: target.platform,
        arch: target.arch,
        scope: "all",
        launch: false,
      });
      if (runtimeVerification?.ready !== true) {
        throw stagingError("The canonical local-subtitle runtime is not ready.");
      }
      const overwriteVerification = await verifiers.verifyStagedOverwriteNativeAddon({
        root: runtimeRoot,
        platform: target.platform,
        arch: target.arch,
        signatureVerifier: dependencies.overwriteSignatureVerifier,
      });
      if (overwriteVerification?.ready !== true) {
        throw stagingError("The staged overwrite native addon is not ready.");
      }
    } catch (cause) {
      const code = typeof cause?.code === "string"
        ? cause.code
        : "runtime_staging_invalid";
      const error = new Error(
        `Local subtitle runtime preflight failed (${code}).`,
        { cause },
      );
      error.code = code;
      throw error;
    }
  };
}

async function resolveVerifiers(dependencies) {
  let verifyRuntimeBundle = dependencies.verifyRuntimeBundle;
  if (typeof verifyRuntimeBundle !== "function") {
    const moduleUrl = pathToFileURL(
      path.join(__dirname, "runtime-manifest.mjs"),
    ).href;
    ({ verifyRuntimeBundle } = await import(moduleUrl));
  }
  let verifyStagedOverwriteNativeAddon =
    dependencies.verifyStagedOverwriteNativeAddon;
  if (typeof verifyStagedOverwriteNativeAddon !== "function") {
    const moduleUrl = pathToFileURL(
      path.join(
        __dirname,
        "../overwrite-native/overwrite-native-staging.mjs",
      ),
    ).href;
    ({ verifyStagedOverwriteNativeAddon } = await import(moduleUrl));
  }
  if (
    typeof verifyRuntimeBundle !== "function" ||
    typeof verifyStagedOverwriteNativeAddon !== "function"
  ) {
    throw stagingError("A local-subtitle staging verifier is unavailable.");
  }
  return { verifyRuntimeBundle, verifyStagedOverwriteNativeAddon };
}

async function loadBuilderContract() {
  const moduleUrl = pathToFileURL(
    path.join(__dirname, "validate-runtime-staging.mjs"),
  ).href;
  const module = await import(moduleUrl);
  if (typeof module.assertBuilderConsumptionContract !== "function") {
    throw stagingError("The electron-builder consumption contract is unavailable.");
  }
  return module.assertBuilderConsumptionContract;
}

function resolveBuildTarget(context, processTarget) {
  const platform = context?.electronPlatformName;
  const arch = normalizeBuilderArch(context?.arch);
  const packagerPlatform = context?.packager?.platform?.nodeName;
  const supported =
    (platform === "darwin" && arch === "arm64") ||
    (platform === "win32" && arch === "x64");
  if (
    !supported ||
    (packagerPlatform !== undefined && packagerPlatform !== platform) ||
    processTarget.processPlatform !== platform ||
    processTarget.processArch !== arch
  ) {
    throw stagingError(
      "The builder, packager, and current process targets must match exactly.",
    );
  }
  return { platform, arch };
}

function normalizeBuilderArch(value) {
  if (value === "x64" || value === 1) return "x64";
  if (value === "arm64" || value === 3) return "arm64";
  return null;
}

function resolveProjectRoot(context) {
  const projectDir = context?.packager?.info?.projectDir;
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir)) {
    throw stagingError("The electron-builder project root is invalid.");
  }
  return path.resolve(projectDir);
}

function findRuntimeRoot(extraResources, projectRoot = process.cwd()) {
  if (!Array.isArray(extraResources) || extraResources.length !== 1) return null;
  const entry = extraResources[0];
  if (
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    Object.keys(entry).length !== 3 ||
    entry.from !== CANONICAL_RUNTIME_FROM ||
    entry.to !== CANONICAL_RUNTIME_TO ||
    !Array.isArray(entry.filter) ||
    entry.filter.length !== 1 ||
    entry.filter[0] !== CANONICAL_RUNTIME_FILTER
  ) {
    return null;
  }
  return path.resolve(projectRoot, CANONICAL_RUNTIME_FROM);
}

function stagingError(message) {
  const error = new Error(message);
  error.code = "runtime_staging_invalid";
  return error;
}

const beforePack = createBeforePackHook();

module.exports = beforePack;
module.exports.createBeforePackHook = createBeforePackHook;
module.exports.findRuntimeRoot = findRuntimeRoot;
module.exports.resolveBuildTarget = resolveBuildTarget;
