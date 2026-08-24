#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { verifyStagedOverwriteNativeAddon } from "../overwrite-native/overwrite-native-staging.mjs";
import {
  RUNTIME_MANIFEST_RELATIVE_PATH,
  buildSanitizedRuntimeEnvironment,
  sha256File,
  verifyRuntimeBundle,
} from "./runtime-manifest.mjs";

const require = createRequire(import.meta.url);
const { signAsync } = require("@electron/osx-sign");
const execFileAsync = promisify(execFile);

export async function signPackagedSpike(options) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The packaged signing spike requires darwin/arm64.");
  }
  const appPath = path.resolve(requirePath(options.appPath, "appPath"));
  const runtimeRoot = path.join(
    appPath,
    "Contents",
    "Resources",
    "local-subtitle",
  );
  const before = await collectRuntimeIntegrity(runtimeRoot);
  await signAsync({
    app: appPath,
    identity: options.identity ?? "-",
    identityValidation: false,
    // osx-sign 1.0.5 emits the invalid `codesign --strict=true` on macOS 26.
    // The system codesign strict verification below remains the authority.
    strictVerify: false,
    ignore: (filePath) => isPathInside(runtimeRoot, filePath),
  });
  const after = await collectRuntimeIntegrity(runtimeRoot);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      "Electron signing changed a nested runtime after its manifest hashes were frozen.",
    );
  }
  await execFileAsync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=4", appPath],
    {
      cwd: path.dirname(appPath),
      env: buildSanitizedRuntimeEnvironment("darwin"),
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const signature = await execFileAsync("/usr/bin/codesign", ["-dvvv", appPath], {
    cwd: path.dirname(appPath),
    env: buildSanitizedRuntimeEnvironment("darwin"),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const signatureOutput = `${signature.stdout}${signature.stderr}`;
  const signatureKind = /^Signature=adhoc$/mu.test(signatureOutput)
    ? "adhoc"
    : /^Authority=Developer ID Application:/mu.test(signatureOutput)
      ? "developer_id"
      : "other";
  const gatekeeper = await assessGatekeeper(appPath);
  return {
    schemaVersion: 1,
    target: { platform: "darwin", arch: "arm64" },
    appSignatureKind: signatureKind,
    deepStrictVerificationPassed: true,
    runtimeIntegrityUnchangedByOuterSigning: true,
    runtimeManifestSha256: after.manifestSha256,
    runtimeArtifactHashes: after.artifactHashes,
    overwriteNativeIntegrityUnchangedByOuterSigning: true,
    overwriteNativeGeneration: after.overwriteNative.generation,
    overwriteNativeArtifactSha256: after.overwriteNative.artifactSha256,
    overwriteNativeBuildReceiptSha256:
      after.overwriteNative.buildReceiptSha256,
    overwriteNativeModuleExportsVerified:
      after.overwriteNative.moduleExportsVerified,
    gatekeeper,
    packagedLikeReady: true,
    releaseReady: signatureKind === "developer_id" && gatekeeper.status === "accepted",
    releaseGateOwner: "QA-004",
    privacy: {
      absolutePathsRecorded: false,
      signingIdentityRecorded: false,
    },
  };
}

export function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function collectRuntimeIntegrity(runtimeRoot) {
  const [verification, overwriteVerification, manifestSha256] =
    await Promise.all([
      verifyRuntimeBundle({
        runtimeRoot,
        platform: "darwin",
        arch: "arm64",
        scope: "all",
        launch: true,
      }),
      verifyStagedOverwriteNativeAddon({
        root: runtimeRoot,
        platform: "darwin",
        arch: "arm64",
      }),
      sha256File(
        path.join(runtimeRoot, ...RUNTIME_MANIFEST_RELATIVE_PATH.split("/")),
      ),
    ]);
  return createPackagedIntegritySnapshot(
    verification,
    overwriteVerification,
    manifestSha256,
  );
}

export function createPackagedIntegritySnapshot(
  runtimeVerification,
  overwriteVerification,
  manifestSha256,
) {
  if (
    runtimeVerification?.ready !== true ||
    overwriteVerification?.ready !== true ||
    overwriteVerification.moduleExportsVerified !== true
  ) {
    throw new Error("The packaged local-subtitle integrity snapshot is incomplete.");
  }
  return {
    manifestSha256,
    artifactHashes: runtimeVerification.artifactSummary.map((artifact) => ({
      id: artifact.id,
      sha256: artifact.sha256,
    })),
    overwriteNative: {
      generation: overwriteVerification.generation,
      artifactSha256: overwriteVerification.artifact.sha256,
      buildReceiptSha256: overwriteVerification.buildReceiptSha256,
      moduleExportsVerified: true,
    },
  };
}

async function assessGatekeeper(appPath) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "/usr/sbin/spctl",
      ["--assess", "--type", "execute", "--verbose=4", appPath],
      {
        cwd: path.dirname(appPath),
        env: buildSanitizedRuntimeEnvironment("darwin"),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const output = `${stdout}${stderr}`;
    return {
      status: /\baccepted\b/iu.test(output) ? "accepted" : "unavailable",
      exitCode: 0,
      pre005Gate: false,
    };
  } catch (error) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
    return {
      status: /\brejected\b/iu.test(output) ? "rejected" : "unavailable",
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      pre005Gate: false,
    };
  }
}

function requirePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function parseCliArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: "string" },
      identity: { type: "string", default: "-" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return { appPath: values.app, identity: values.identity };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node sign-packaged-spike.mjs --app <FusionKit.app> " +
        "[--identity <identity-or-dash>]\n",
    );
    return;
  }
  const report = await signPackagedSpike(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`packaged_spike_signing_failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
