#!/usr/bin/env node

import { execFile } from "node:child_process";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RUNTIME_MANIFEST_RELATIVE_PATH,
  buildSanitizedRuntimeEnvironment,
  getWindowsPowerShellPath,
  sha256File,
  verifyRuntimeBundle,
} from "./runtime-manifest.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SIGNING_SCRIPT = path.join(
  SCRIPT_DIRECTORY,
  "authenticode-sign-file.ps1",
);

export async function signPackagedSpikeWindows(options) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The packaged Windows signing spike requires win32/x64.");
  }
  const appExecutablePath = path.resolve(
    requirePath(options.appExecutablePath, "appExecutablePath"),
  );
  const certificateThumbprint = normalizeThumbprint(
    options.certificateThumbprint,
  );
  const runtimeRoot = resolvePackagedRuntimeRoot(appExecutablePath);
  const before = await collectRuntimeIntegrity(runtimeRoot);
  await runPowerShellFile(SIGNING_SCRIPT, [
    "-LiteralPath",
    appExecutablePath,
    "-CertificateThumbprint",
    certificateThumbprint,
  ], path.dirname(appExecutablePath));
  await verifyAuthenticodeSignature(appExecutablePath);
  const after = await collectRuntimeIntegrity(runtimeRoot);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      "Outer Windows signing changed the packaged runtime after its hashes were frozen.",
    );
  }
  return {
    schemaVersion: 1,
    target: { platform: "win32", arch: "x64" },
    appSignatureKind: "authenticode",
    appSignatureVerificationPassed: true,
    signingProfile: "ephemeral_trusted_test_certificate",
    runtimeIntegrityUnchangedByOuterSigning: true,
    runtimeManifestSha256: after.manifestSha256,
    runtimeArtifactHashes: after.artifactHashes,
    packagedLikeReady: true,
    releaseReady: false,
    releaseGateOwner: "QA-003",
    remainingReleaseRequirements: [
      "publicly_trusted_code_signing_identity",
      "trusted_timestamp",
      "signed_installer_validation",
    ],
    privacy: {
      absolutePathsRecorded: false,
      signingIdentityRecorded: false,
    },
  };
}

export function resolvePackagedRuntimeRoot(appExecutablePath) {
  return path.join(
    path.dirname(path.resolve(appExecutablePath)),
    "resources",
    "local-subtitle",
  );
}

async function collectRuntimeIntegrity(runtimeRoot) {
  const verification = await verifyRuntimeBundle({
    runtimeRoot,
    platform: "win32",
    arch: "x64",
    scope: "all",
    launch: true,
  });
  return {
    manifestSha256: await sha256File(
      path.join(runtimeRoot, ...RUNTIME_MANIFEST_RELATIVE_PATH.split("/")),
    ),
    artifactHashes: verification.artifactSummary.map((artifact) => ({
      id: artifact.id,
      sha256: artifact.sha256,
    })),
  };
}

async function verifyAuthenticodeSignature(filePath) {
  const environment = {
    ...buildSanitizedRuntimeEnvironment("win32"),
    FUSIONKIT_SIGNATURE_TARGET: filePath,
  };
  try {
    await execFileAsync(
      getWindowsPowerShellPath(environment),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$signature = Get-AuthenticodeSignature -LiteralPath $env:FUSIONKIT_SIGNATURE_TARGET; " +
          "if ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) " +
          "{ exit 0 } else { exit 1 }",
      ],
      {
        cwd: path.dirname(filePath),
        env: environment,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
  } catch {
    throw new Error("The packaged Windows executable has an invalid signature.");
  }
}

async function runPowerShellFile(scriptPath, args, cwd) {
  try {
    await execFileAsync(
      getWindowsPowerShellPath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        ...args,
      ],
      {
        cwd,
        env: buildSanitizedRuntimeEnvironment("win32"),
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
  } catch {
    throw new Error("The packaged Windows signing command failed.");
  }
}

function normalizeThumbprint(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new Error("certificateThumbprint must be a 40-character SHA-1 thumbprint.");
  }
  return value.toUpperCase();
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
      "certificate-thumbprint": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    appExecutablePath: values.app,
    certificateThumbprint: values["certificate-thumbprint"],
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node sign-packaged-spike-windows.mjs --app <FusionKit.exe> " +
        "--certificate-thumbprint <sha1>\n",
    );
    return;
  }
  const report = await signPackagedSpikeWindows(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`windows_packaged_spike_signing_failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
