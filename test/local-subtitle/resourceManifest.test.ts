import { describe, expect, it } from "vitest";
import productionDecision from "../../docs/v0.2.11/local-subtitle-transcriber/poc/pre006-production-decision.json";
import {
  LOCAL_SUBTITLE_STAGING_CONTRACT,
  LocalSubtitleResourceError,
  assertSupportedLocalSubtitleRuntimeTarget,
  inspectLocalSubtitleNativeBinary,
  normalizeLocalSubtitleManifestRelativePath,
  parseLocalSubtitleRuntimeManifest,
  parseLocalSubtitleStagingContract,
} from "../../electron/main/local-subtitle/resource-manifest";
import {
  createMachO,
  createPe,
  createRuntimeManifest,
} from "./runtimeFixture";

describe("local subtitle staging contract", () => {
  it("freezes the exact production target matrix and artifact naming", () => {
    expect(LOCAL_SUBTITLE_STAGING_CONTRACT.artifactNamePattern).toBe(
      "${productName}_${version}_${arch}.${ext}",
    );
    expect(LOCAL_SUBTITLE_STAGING_CONTRACT.developmentRuntimeRoot).toBe(
      "build/local-subtitle-resources/local-subtitle",
    );
    expect(
      LOCAL_SUBTITLE_STAGING_CONTRACT.targets.map((target) => target.id),
    ).toEqual(["darwin-arm64", "win32-x64"]);
    expect(Object.isFrozen(LOCAL_SUBTITLE_STAGING_CONTRACT)).toBe(true);
    expect(
      Object.isFrozen(
        LOCAL_SUBTITLE_STAGING_CONTRACT.targets[0]!.requiredArtifacts,
      ),
    ).toBe(true);

    const windows = assertSupportedLocalSubtitleRuntimeTarget("win32", "x64");
    expect(windows.integrityProfile).toBe(
      "windows_unsigned_personal_final_bytes_sha256",
    );
    expect(windows.allowedSignatureKinds).toEqual(["unsigned"]);
    expect(
      windows.requiredArtifacts.filter(
        (artifact) => artifact.kind === "dynamic_library",
      ),
    ).toHaveLength(12);

    const frozenBaseRuntimeIds = productionDecision.decisions.platformSupport.profiles
      .filter((profile) => profile.support === "supported")
      .map((profile) => profile.baseRuntime)
      .sort();
    const contractServerIds = LOCAL_SUBTITLE_STAGING_CONTRACT.targets
      .flatMap((target) =>
        target.requiredArtifacts
          .filter((artifact) => artifact.kind === "server")
          .map((artifact) => artifact.id)
      )
      .sort();
    expect(contractServerIds).toEqual(frozenBaseRuntimeIds);
  });

  it("rejects unknown staging fields and unsupported target policy drift", () => {
    const unknown = structuredClone(LOCAL_SUBTITLE_STAGING_CONTRACT) as Record<
      string,
      unknown
    >;
    unknown.downloadRoot = "/tmp/injected";
    expectResourceCode(
      () => parseLocalSubtitleStagingContract(unknown),
      "media_runtime_invalid",
    );

    const drift = structuredClone(LOCAL_SUBTITLE_STAGING_CONTRACT);
    drift.targets[1]!.allowedSignatureKinds = ["authenticode"];
    expectResourceCode(
      () => parseLocalSubtitleStagingContract(drift),
      "media_runtime_invalid",
    );
  });

  it("rejects unsupported targets before any resource lookup", () => {
    expectResourceCode(
      () => assertSupportedLocalSubtitleRuntimeTarget("linux", "x64"),
      "unsupported_platform",
    );
    expectResourceCode(
      () => assertSupportedLocalSubtitleRuntimeTarget("darwin", "x64"),
      "unsupported_architecture",
    );
    expectResourceCode(
      () => assertSupportedLocalSubtitleRuntimeTarget("win32", "arm64"),
      "unsupported_architecture",
    );
  });
});

describe("local subtitle runtime manifest", () => {
  it("parses an exact manifest and deeply freezes the result", () => {
    const parsed = parseLocalSubtitleRuntimeManifest(createRuntimeManifest(), {
      platform: "darwin",
      arch: "arm64",
    });
    expect(parsed.integrityProfile).toBe(
      "macos_nested_signed_final_bytes_sha256",
    );
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.artifacts)).toBe(true);
    expect(Object.isFrozen(parsed.artifacts[0])).toBe(true);
    expect(Object.isFrozen(parsed.licenses[0]!.licenseFiles)).toBe(true);
  });

  it("rejects recursive unknown fields and executable injection fields", () => {
    const topLevel = createRuntimeManifest() as unknown as Record<string, unknown>;
    topLevel.executablePath = "/tmp/ffmpeg";
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(topLevel, target()),
      "media_runtime_invalid",
    );

    const artifact = createRuntimeManifest() as unknown as {
      artifacts: Array<Record<string, unknown>>;
    };
    artifact.artifacts[0]!.args = ["--listen", "0.0.0.0"];
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(artifact, target()),
      "media_runtime_invalid",
    );

    const evidence = createRuntimeManifest() as unknown as {
      licenses: Array<{ licenseFiles: Array<Record<string, unknown>> }>;
    };
    evidence.licenses[0]!.licenseFiles[0]!.path = "../../outside";
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(evidence, target()),
      "media_runtime_invalid",
    );
  });

  it("classifies protocol drift separately from an invalid manifest", () => {
    const protocol = createRuntimeManifest();
    protocol.runtimeContractVersion = 2 as 1;
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(protocol, target()),
      "runtime_protocol_mismatch",
    );

    const schema = createRuntimeManifest();
    schema.schemaVersion = 2 as 1;
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(schema, target()),
      "media_runtime_invalid",
    );
  });

  it("binds every artifact to the target profile, backend, path and evidence", () => {
    const missingDll = createRuntimeManifest("win32", "x64");
    missingDll.artifacts.splice(
      missingDll.artifacts.findIndex(
        (artifact) => artifact.kind === "dynamic_library",
      ),
      1,
    );
    expectResourceCode(
      () =>
        parseLocalSubtitleRuntimeManifest(missingDll, {
          platform: "win32",
          arch: "x64",
        }),
      "media_runtime_invalid",
    );

    const backend = createRuntimeManifest();
    backend.artifacts.find((artifact) => artifact.kind === "ffmpeg")!.backend =
      "cpu";
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(backend, target()),
      "media_runtime_invalid",
    );

    const license = createRuntimeManifest();
    license.artifacts.find((artifact) => artifact.kind === "server")!.licenseRef =
      "ffmpeg-lgpl-2.1-or-later";
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(license, target()),
      "media_runtime_invalid",
    );

    const falseUnsignedClaim = createRuntimeManifest("win32", "x64");
    falseUnsignedClaim.artifacts[0]!.signatureKind = "authenticode";
    expectResourceCode(
      () =>
        parseLocalSubtitleRuntimeManifest(falseUnsignedClaim, {
          platform: "win32",
          arch: "x64",
        }),
      "media_runtime_invalid",
    );
  });

  it("rejects missing, renamed and semantically false evidence", () => {
    const missing = createRuntimeManifest();
    missing.sources.pop();
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(missing, target()),
      "media_runtime_invalid",
    );

    const falseSpdx = createRuntimeManifest();
    falseSpdx.licenses.find(
      (license) => license.id === "whisper-cpp-mit",
    )!.spdxExpression = "GPL-3.0-only";
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(falseSpdx, target()),
      "media_runtime_invalid",
    );

    const falseSource = createRuntimeManifest();
    falseSource.sources.find(
      (source) => source.id === "whisper-cpp-v1.9.1",
    )!.version = "v2.0.0";
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(falseSource, target()),
      "media_runtime_invalid",
    );

    const missingNotice = createRuntimeManifest();
    missingNotice.licenses.find(
      (license) => license.id === "ffmpeg-lgpl-2.1-or-later",
    )!.noticeFiles.pop();
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(missingNotice, target()),
      "media_runtime_invalid",
    );

    const replacedLicense = createRuntimeManifest();
    replacedLicense.licenses[0]!.licenseFiles[0]!.sha256 = "f".repeat(64);
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(replacedLicense, target()),
      "media_runtime_invalid",
    );
  });

  it("pins runner and media artifact versions", () => {
    const runnerDrift = createRuntimeManifest();
    runnerDrift.artifacts.find(
      (artifact) => artifact.kind === "server",
    )!.version = "latest";
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(runnerDrift, target()),
      "media_runtime_invalid",
    );

    const mediaDrift = createRuntimeManifest("win32", "x64");
    mediaDrift.artifacts.find(
      (artifact) => artifact.kind === "ffmpeg",
    )!.version = "8.1.2";
    expectResourceCode(
      () =>
        parseLocalSubtitleRuntimeManifest(mediaDrift, {
          platform: "win32",
          arch: "x64",
        }),
      "media_runtime_invalid",
    );
  });

  it("rejects case-insensitive path collisions across manifest sections", () => {
    const manifest = createRuntimeManifest();
    manifest.sources[0]!.evidenceFile.relativePath =
      manifest.licenses[0]!.licenseFiles[0]!.relativePath.toUpperCase();
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(manifest, target()),
      "media_runtime_invalid",
    );
  });

  it.each([
    "",
    "/absolute/file",
    "../escape",
    "a/../escape",
    "a//file",
    "a\\file",
    "C:relative",
    "C:/absolute",
    "server.exe:stream",
    "CON/file",
    "a/NUL.txt",
    "a/trailing.",
    "a/trailing ",
    "a/\0/file",
  ])("rejects unsafe manifest path %j", (value) => {
    expectResourceCode(
      () => normalizeLocalSubtitleManifestRelativePath(value),
      "media_runtime_invalid",
    );
  });

  it("rejects oversized paths and artifact arrays", () => {
    expectResourceCode(
      () =>
        normalizeLocalSubtitleManifestRelativePath(
          `a/${"b".repeat(512)}`,
        ),
      "media_runtime_invalid",
    );

    const manifest = createRuntimeManifest();
    while (manifest.artifacts.length <= 256) {
      const copy = structuredClone(manifest.artifacts[0]!);
      copy.id = `extra-${manifest.artifacts.length}`;
      copy.relativePath = `mac-arm64/metal/extra-${manifest.artifacts.length}`;
      manifest.artifacts.push(copy);
    }
    expectResourceCode(
      () => parseLocalSubtitleRuntimeManifest(manifest, target()),
      "media_runtime_invalid",
    );
  });

  it("parses only thin target Mach-O and PE identities", () => {
    expect(inspectLocalSubtitleNativeBinary(createMachO("arm64"))).toMatchObject({
      format: "mach-o",
      architectures: ["arm64"],
    });
    expect(inspectLocalSubtitleNativeBinary(createPe("x64"))).toEqual({
      format: "pe",
      architectures: ["x64"],
      minimumOsVersion: null,
    });

    const fat = Buffer.alloc(48);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(0x0100000c, 8);
    fat.writeUInt32BE(0x01000007, 28);
    expect(inspectLocalSubtitleNativeBinary(fat)).toMatchObject({
      format: "mach-o-fat",
      architectures: ["arm64", "x64"],
    });
  });
});

function target() {
  return { platform: "darwin", arch: "arm64" } as const;
}

function expectResourceCode(
  operation: () => unknown,
  expectedCode: LocalSubtitleResourceError["code"],
): void {
  try {
    operation();
    throw new Error("Expected LocalSubtitleResourceError.");
  } catch (error) {
    expect(error).toBeInstanceOf(LocalSubtitleResourceError);
    expect((error as LocalSubtitleResourceError).code).toBe(expectedCode);
  }
}
