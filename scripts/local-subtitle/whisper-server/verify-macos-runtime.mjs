import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export async function verifyMacosRuntime(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      "bundle-root": { type: "string" },
      output: { type: "string" },
    },
    strict: true,
  });
  if (!values.server || !values["bundle-root"]) {
    throw new Error("Missing --server or --bundle-root.");
  }

  const serverPath = await realpath(path.resolve(values.server));
  const bundleRoot = await realpath(path.resolve(values["bundle-root"]));
  const serverStat = await stat(serverPath);
  const [lipo, dependencies, signatureValidation, signatureDetails, gatekeeper] =
    await Promise.all([
      runCommand("/usr/bin/lipo", ["-archs", serverPath]),
      runCommand("/usr/bin/otool", ["-L", serverPath]),
      runCommand("/usr/bin/codesign", [
        "--verify",
        "--strict",
        "--verbose=4",
        serverPath,
      ]),
      runCommand("/usr/bin/codesign", ["-dvvv", serverPath]),
      runCommand("/usr/sbin/spctl", [
        "--assess",
        "--type",
        "execute",
        "--verbose=4",
        serverPath,
      ]),
    ]);
  const relativePath = path.relative(bundleRoot, serverPath);
  const forbiddenX64Artifacts = await findForbiddenX64Artifacts(bundleRoot);
  const architectures = parseLipoArchitectures(lipo.output);
  const dependencySummary = summarizeMachODependencies(dependencies.output);
  const signature = parseCodesignDetails(signatureDetails.output);
  const gatekeeperStatus = parseGatekeeperStatus(gatekeeper.output);
  const report = assessMacosRuntime({
    contained:
      relativePath !== "" &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath),
    relativePath: relativePath.split(path.sep).join("/"),
    executable: serverStat.isFile() && (serverStat.mode & 0o111) !== 0,
    byteSize: serverStat.size,
    sha256: await sha256File(serverPath),
    architectures,
    x64ArtifactCount: forbiddenX64Artifacts.length,
    dependencySummary,
    signature: {
      ...signature,
      validationPassed: signatureValidation.ok,
    },
    gatekeeper: {
      status: gatekeeperStatus,
      exitCode: gatekeeper.exitCode,
    },
  });

  if (values.output) {
    await writeFile(
      path.resolve(values.output),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }
  return report;
}

export function assessMacosRuntime(evidence) {
  const blockers = [];
  if (!evidence.contained) blockers.push("resource_outside_bundle_root");
  if (!evidence.executable) blockers.push("runtime_not_executable");
  if (
    evidence.architectures.length !== 1 ||
    evidence.architectures[0] !== "arm64"
  ) {
    blockers.push("unsupported_architecture");
  }
  if (evidence.x64ArtifactCount > 0) {
    blockers.push("macos_x64_artifact_present");
  }
  if (!evidence.dependencySummary.systemOnly) {
    blockers.push("uncontrolled_dynamic_dependency");
  }
  if (!evidence.signature.validationPassed) {
    blockers.push("signature_invalid");
  }
  const packagedLikeReady = blockers.length === 0;
  const releaseBlockers = [...blockers];
  if (evidence.signature.kind !== "developer_id") {
    releaseBlockers.push("developer_id_signature_missing");
  }
  if (evidence.gatekeeper.status !== "accepted") {
    releaseBlockers.push("gatekeeper_not_accepted");
  }
  return {
    schemaVersion: 1,
    reportType: "macos_arm64_packaged_like_runtime",
    platform: "darwin",
    architecture: "arm64",
    runtimeFileName: "whisper-server",
    relativePath: evidence.relativePath,
    byteSize: evidence.byteSize,
    sha256: evidence.sha256,
    executable: evidence.executable,
    architectures: evidence.architectures,
    x64ArtifactCount: evidence.x64ArtifactCount,
    dependencySummary: evidence.dependencySummary,
    signature: evidence.signature,
    gatekeeper: evidence.gatekeeper,
    packagedLikeReady,
    releaseReady: releaseBlockers.length === 0,
    blockers,
    releaseBlockers,
    privacy: {
      absolutePathsRecorded: false,
      signingIdentityRecorded: false,
    },
  };
}

export function parseLipoArchitectures(value) {
  return [...new Set(String(value).trim().split(/\s+/u).filter(Boolean))];
}

export function summarizeMachODependencies(value) {
  const dependencies = String(value)
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(" (", 1)[0])
    .filter(Boolean);
  const nonSystemDependencies = dependencies.filter(
    (dependency) =>
      !dependency.startsWith("/System/Library/") &&
      !dependency.startsWith("/usr/lib/"),
  );
  return {
    dependencyCount: dependencies.length,
    systemDependencyCount: dependencies.length - nonSystemDependencies.length,
    nonSystemDependencyLabels: nonSystemDependencies.map((dependency) =>
      dependency.startsWith("@") ? dependency : path.basename(dependency)
    ),
    systemOnly: nonSystemDependencies.length === 0,
  };
}

export function parseCodesignDetails(value) {
  const signature = String(value).match(/^Signature=(.+)$/mu)?.[1]?.trim();
  const hasDeveloperId = /^Authority=Developer ID Application:/mu.test(
    String(value),
  );
  return {
    kind: signature === "adhoc"
      ? "adhoc"
      : hasDeveloperId
        ? "developer_id"
        : signature
          ? "other"
          : "unsigned",
    teamIdentifierPresent:
      /^TeamIdentifier=(?!not set$).+/mu.test(String(value)),
  };
}

export function parseGatekeeperStatus(value) {
  const text = String(value);
  if (/\baccepted\b/iu.test(text)) return "accepted";
  if (/\brejected\b/iu.test(text)) return "rejected";
  if (/internal error/iu.test(text)) return "error";
  return "unavailable";
}

async function findForbiddenX64Artifacts(rootDirectory) {
  const matches = [];
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (/(?:mac(?:os)?[-_]?x64|x86_64)/iu.test(
        path.relative(rootDirectory, entryPath),
      )) {
        matches.push(entryPath);
      }
    }
  }
  return matches;
}

async function runCommand(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, exitCode: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    return {
      ok: false,
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      output: `${error?.stdout ?? ""}${error?.stderr ?? ""}`,
    };
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyMacosRuntime()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.releaseReady) process.exitCode = 2;
    })
    .catch((error) => {
      process.stderr.write(`runtime_probe_failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
