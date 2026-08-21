import { describe, expect, it } from "vitest";
import rawModelManifest from "../../resources/local-subtitle/manifests/local-subtitle-models.v1.json";
import {
  LOCAL_SUBTITLE_MODEL_MANIFEST,
  LocalSubtitleModelError,
  parseLocalSubtitleModelCatalog,
  parseLocalSubtitleModelManifest,
  resolveLocalSubtitleModelManifestEntry,
} from "../../electron/main/local-subtitle/model-manifest";

describe("local subtitle model manifest", () => {
  it("loads the exact frozen production model allowlist", () => {
    expect(LOCAL_SUBTITLE_MODEL_MANIFEST).toEqual(rawModelManifest);
    expect(Object.isFrozen(LOCAL_SUBTITLE_MODEL_MANIFEST)).toBe(true);
    expect(Object.isFrozen(LOCAL_SUBTITLE_MODEL_MANIFEST.engine)).toBe(true);
    expect(Object.isFrozen(LOCAL_SUBTITLE_MODEL_MANIFEST.models)).toBe(true);
    expect(
      Object.isFrozen(
        LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!.allowedDownloadHosts,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!.ggml.headerInt32Le),
    ).toBe(true);
    expect(LOCAL_SUBTITLE_MODEL_MANIFEST.models).toHaveLength(2);
    expect(LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]).toMatchObject({
      id: "large-v3-q5_0",
      byteSize: 1_081_140_203,
      sha256:
        "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
      sourceRevision: "c521a4b02f422512d734391fdf08bb08c0862f68",
      allowedDownloadHosts: ["huggingface.co", "*.hf.co"],
      ggml: {
        magicHex: "6c6d6767",
        headerInt32Le: [
          51_866,
          1_500,
          1_280,
          20,
          32,
          448,
          1_280,
          20,
          32,
          128,
          2_008,
        ],
      },
    });
    expect(LOCAL_SUBTITLE_MODEL_MANIFEST.models[1]).toMatchObject({
      id: "large-v3",
      byteSize: 3_095_033_483,
      sha256:
        "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
      sourceRevision: "c521a4b02f422512d734391fdf08bb08c0862f68",
      quantization: "f16",
      defaultRecommended: false,
      ggml: {
        magicHex: "6c6d6767",
        headerInt32Le: [
          51_866,
          1_500,
          1_280,
          20,
          32,
          448,
          1_280,
          20,
          32,
          128,
          1,
        ],
      },
    });
  });

  it("rejects unknown fields at every manifest level", () => {
    const topLevel = createManifest();
    (topLevel as Record<string, unknown>).unexpected = true;
    expectManifestFailure(() => parseLocalSubtitleModelManifest(topLevel));

    const engine = createManifest();
    (engine.engine as Record<string, unknown>).unexpected = true;
    expectManifestFailure(() => parseLocalSubtitleModelManifest(engine));

    const model = createManifest();
    (model.models[0] as Record<string, unknown>).unexpected = true;
    expectManifestFailure(() => parseLocalSubtitleModelManifest(model));

    const header = createManifest();
    (header.models[0]!.ggml as Record<string, unknown>).unexpected = true;
    expectManifestFailure(() => parseLocalSubtitleModelManifest(header));
  });

  it("rejects duplicate and case-colliding model identities", () => {
    const duplicate = createManifest();
    duplicate.models.push(structuredClone(duplicate.models[0]!));
    expectManifestFailure(() => parseLocalSubtitleModelManifest(duplicate));

    const caseCollision = createManifest();
    const colliding = structuredClone(caseCollision.models[0]!);
    colliding.id = colliding.id.toUpperCase();
    colliding.fileName = colliding.fileName.toUpperCase();
    caseCollision.models.push(colliding);
    expectManifestFailure(() => parseLocalSubtitleModelManifest(caseCollision));
  });

  it("deep-clones and freezes a validated injected catalog", () => {
    const source = structuredClone(rawModelManifest.models);
    const catalog = parseLocalSubtitleModelCatalog(source);

    expect(catalog).not.toBe(source);
    expect(catalog[0]).not.toBe(source[0]);
    expect(catalog[0]!.ggml).not.toBe(source[0]!.ggml);
    expect(catalog[0]!.ggml.headerInt32Le).not.toBe(
      source[0]!.ggml.headerInt32Le,
    );
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[0])).toBe(true);
    expect(Object.isFrozen(catalog[0]!.ggml.headerInt32Le)).toBe(true);

    source[0]!.id = "mutated-model";
    source[0]!.ggml.headerInt32Le[0] = 1;
    expect(catalog[0]!.id).toBe("large-v3-q5_0");
    expect(catalog[0]!.ggml.headerInt32Le[0]).toBe(51_866);
  });

  it("rejects case-colliding ids and file names in injected catalogs", () => {
    const duplicateId = structuredClone(rawModelManifest.models);
    duplicateId.push({
      ...structuredClone(duplicateId[0]!),
      id: duplicateId[0]!.id.toUpperCase(),
      fileName: "ggml-distinct-model.bin",
    });
    expectManifestFailure(() => parseLocalSubtitleModelCatalog(duplicateId));

    const duplicateFileName = structuredClone(rawModelManifest.models);
    duplicateFileName.push({
      ...structuredClone(duplicateFileName[0]!),
      id: "distinct-model",
      fileName: duplicateFileName[0]!.fileName.toUpperCase(),
    });
    expectManifestFailure(() =>
      parseLocalSubtitleModelCatalog(duplicateFileName),
    );
  });

  it("rejects PRE-006 engine, artifact, source and GGML header drift", () => {
    const mutations: Array<(manifest: ReturnType<typeof createManifest>) => void> = [
      (manifest) => {
        manifest.engine.commit = "a".repeat(40);
      },
      (manifest) => {
        manifest.models[0]!.byteSize += 1;
      },
      (manifest) => {
        manifest.models[0]!.sha256 = "a".repeat(64);
      },
      (manifest) => {
        manifest.models[0]!.sourceRevision = "a".repeat(40);
      },
      (manifest) => {
        manifest.models[0]!.allowedDownloadHosts = ["example.com"];
      },
      (manifest) => {
        manifest.models[0]!.ggml.magicHex = "67676d6c";
      },
      (manifest) => {
        manifest.models[0]!.ggml.headerInt32Le[10] = 8;
      },
    ];
    for (const mutate of mutations) {
      const manifest = createManifest();
      mutate(manifest);
      expectManifestFailure(() => parseLocalSubtitleModelManifest(manifest));
    }
  });

  it("rejects unknown model leakage into the production allowlist", () => {
    const manifest = createManifest();
    const deferred = structuredClone(manifest.models[0]!);
    deferred.id = "large-v3-turbo";
    deferred.fileName = "ggml-large-v3-turbo.bin";
    manifest.models.push(deferred);
    expectManifestFailure(() => parseLocalSubtitleModelManifest(manifest));
  });

  it("resolves only the exact allowlisted model id", () => {
    expect(resolveLocalSubtitleModelManifestEntry("large-v3-q5_0")).toBe(
      LOCAL_SUBTITLE_MODEL_MANIFEST.models[0],
    );
    expect(resolveLocalSubtitleModelManifestEntry("large-v3")).toBe(
      LOCAL_SUBTITLE_MODEL_MANIFEST.models[1],
    );
    expect(() => resolveLocalSubtitleModelManifestEntry("LARGE-V3-Q5_0")).toThrowError(
      LocalSubtitleModelError,
    );
  });
});

function createManifest(): typeof rawModelManifest {
  return structuredClone(rawModelManifest);
}

function expectManifestFailure(operation: () => unknown): void {
  try {
    operation();
    throw new Error("Expected the model manifest to be rejected.");
  } catch (error) {
    expect(error).toBeInstanceOf(LocalSubtitleModelError);
    expect(error).toMatchObject({
      code: "model_incompatible",
      stage: "manifest",
    });
  }
}
