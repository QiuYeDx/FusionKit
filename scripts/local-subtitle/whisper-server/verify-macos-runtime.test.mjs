import assert from "node:assert/strict";
import test from "node:test";
import {
  assessMacosRuntime,
  parseCodesignDetails,
  parseGatekeeperStatus,
  parseLipoArchitectures,
  summarizeMachODependencies,
} from "./verify-macos-runtime.mjs";

test("summarizes a thin arm64 runtime with system-only dependencies", () => {
  assert.deepEqual(parseLipoArchitectures("arm64\n"), ["arm64"]);
  assert.deepEqual(
    summarizeMachODependencies(
      "whisper-server:\n" +
        "\t/System/Library/Frameworks/Metal.framework/Metal (compatibility version 1.0.0)\n" +
        "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n",
    ),
    {
      dependencyCount: 2,
      systemDependencyCount: 2,
      nonSystemDependencyLabels: [],
      systemOnly: true,
    },
  );
});

test("keeps ad-hoc packaged-like evidence separate from release signing", () => {
  const report = assessMacosRuntime({
    contained: true,
    relativePath: "mac-arm64/metal/whisper-server",
    executable: true,
    byteSize: 123,
    sha256: "a".repeat(64),
    architectures: ["arm64"],
    x64ArtifactCount: 0,
    dependencySummary: {
      dependencyCount: 2,
      systemDependencyCount: 2,
      nonSystemDependencyLabels: [],
      systemOnly: true,
    },
    signature: {
      kind: "adhoc",
      teamIdentifierPresent: false,
      validationPassed: true,
    },
    gatekeeper: { status: "error", exitCode: 1 },
  });

  assert.equal(report.packagedLikeReady, true);
  assert.equal(report.releaseReady, false);
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.releaseBlockers, [
    "developer_id_signature_missing",
    "gatekeeper_not_accepted",
  ]);
  assert.equal(JSON.stringify(report).includes("/Users/"), false);
});

test("rejects x64, uncontrolled dylibs, and invalid signatures", () => {
  const dependencies = summarizeMachODependencies(
    "whisper-server:\n\t/private/tmp/libwhisper.dylib (compatibility version 0.0.0)\n",
  );
  const report = assessMacosRuntime({
    contained: true,
    relativePath: "mac-x64/whisper-server",
    executable: true,
    byteSize: 123,
    sha256: "b".repeat(64),
    architectures: ["x86_64"],
    x64ArtifactCount: 1,
    dependencySummary: dependencies,
    signature: {
      kind: "unsigned",
      teamIdentifierPresent: false,
      validationPassed: false,
    },
    gatekeeper: { status: "rejected", exitCode: 1 },
  });

  assert.equal(report.packagedLikeReady, false);
  assert.deepEqual(report.blockers, [
    "unsupported_architecture",
    "macos_x64_artifact_present",
    "uncontrolled_dynamic_dependency",
    "signature_invalid",
  ]);
  assert.deepEqual(dependencies.nonSystemDependencyLabels, [
    "libwhisper.dylib",
  ]);
});

test("parses redacted signature and Gatekeeper classifications", () => {
  assert.deepEqual(
    parseCodesignDetails("Signature=adhoc\nTeamIdentifier=not set\n"),
    { kind: "adhoc", teamIdentifierPresent: false },
  );
  assert.deepEqual(
    parseCodesignDetails(
      "Authority=Developer ID Application: Example (TEAM123)\n" +
        "TeamIdentifier=TEAM123\nSignature=Developer ID\n",
    ),
    { kind: "developer_id", teamIdentifierPresent: true },
  );
  assert.equal(parseGatekeeperStatus("source=Notarized Developer ID\naccepted"), "accepted");
  assert.equal(parseGatekeeperStatus("rejected\nsource=no usable signature"), "rejected");
  assert.equal(parseGatekeeperStatus("internal error in Code Signing subsystem"), "error");
});
