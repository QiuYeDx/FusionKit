import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_MODEL_MANIFEST,
  LocalSubtitleModelError,
} from "../../electron/main/local-subtitle/model-manifest";
import {
  LOCAL_SUBTITLE_GGML_HEADER_BYTE_SIZE,
  parseLocalSubtitleGgmlModelHeader,
  verifyLocalSubtitleGgmlModelFile,
  verifyLocalSubtitleGgmlModelHeader,
  type LocalSubtitleGgmlModelExpectation,
} from "../../electron/main/local-subtitle/ggml-model";

const PINNED_MODEL = LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!;

describe("local subtitle GGML model verification", () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "fusionkit-ggml-model-"),
    );
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("parses the exact bounded large-v3-q5_0 header", () => {
    const header = parseLocalSubtitleGgmlModelHeader(createPinnedHeader());
    expect(header).toMatchObject({
      magicHex: "6c6d6767",
      nVocab: 51_866,
      nAudioContext: 1_500,
      nAudioState: 1_280,
      nAudioHeads: 20,
      nAudioLayers: 32,
      nTextContext: 448,
      nTextState: 1_280,
      nTextHeads: 20,
      nTextLayers: 32,
      nMels: 128,
      fileType: 2_008,
    });
    expect(Object.isFrozen(header)).toBe(true);
    expect(Object.isFrozen(header.headerInt32Le)).toBe(true);
  });

  it("rejects truncated, wrong-magic and unknown GGML headers", () => {
    expectModelFailure(
      () =>
        parseLocalSubtitleGgmlModelHeader(
          Buffer.alloc(LOCAL_SUBTITLE_GGML_HEADER_BYTE_SIZE - 1),
        ),
      "model_corrupt",
      "header",
    );

    const wrongMagic = createPinnedHeader();
    wrongMagic.writeUInt32LE(0x12345678, 0);
    expectModelFailure(
      () => parseLocalSubtitleGgmlModelHeader(wrongMagic),
      "model_incompatible",
      "header",
    );

    const unknown = createPinnedHeader();
    unknown.writeInt32LE(8, 44);
    expectModelFailure(
      () => verifyLocalSubtitleGgmlModelHeader(unknown, PINNED_MODEL.ggml),
      "model_incompatible",
      "header",
    );
  });

  it("verifies size, allowlisted header and SHA-256 through one no-follow handle", async () => {
    const bytes = Buffer.concat([
      createPinnedHeader(),
      Buffer.from("bounded-test-tensor-payload", "utf8"),
    ]);
    const filePath = path.join(fixtureRoot, "model.bin");
    await writeFile(filePath, bytes, { mode: 0o600 });
    const expected = createExpectation(bytes);

    const result = await verifyLocalSubtitleGgmlModelFile(filePath, expected);

    expect(result).toMatchObject({
      modelId: PINNED_MODEL.id,
      absolutePath: filePath,
      byteSize: bytes.length,
      sha256: expected.sha256,
      header: { fileType: 2_008, nAudioState: 1_280 },
      fileIdentity: {
        size: bytes.length,
        dev: expect.any(Number),
        ino: expect.any(Number),
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.header)).toBe(true);
    expect(Object.isFrozen(result.fileIdentity)).toBe(true);
  });

  it("rejects directories and CTranslate2 model directories", async () => {
    const ordinaryDirectory = path.join(fixtureRoot, "ordinary-model");
    await mkdir(ordinaryDirectory);
    await expectModelFailureAsync(
      verifyLocalSubtitleGgmlModelFile(
        ordinaryDirectory,
        createExpectation(createPinnedHeader()),
      ),
      "model_incompatible",
      "path",
    );

    const ctranslateDirectory = path.join(fixtureRoot, "ctranslate2-large-v3");
    await mkdir(ctranslateDirectory);
    await writeFile(path.join(ctranslateDirectory, "config.json"), "{}");
    await writeFile(path.join(ctranslateDirectory, "model.bin"), "foreign");
    await expectModelFailureAsync(
      verifyLocalSubtitleGgmlModelFile(
        ctranslateDirectory,
        createExpectation(createPinnedHeader()),
      ),
      "model_incompatible",
      "path",
    );
  });

  it("rejects a model symlink even when its target matches every pin", async () => {
    const bytes = createPinnedHeader();
    const target = path.join(fixtureRoot, "target.bin");
    const link = path.join(fixtureRoot, "linked.bin");
    await writeFile(target, bytes, { mode: 0o600 });
    await symlink(target, link, "file");

    await expectModelFailureAsync(
      verifyLocalSubtitleGgmlModelFile(link, createExpectation(bytes)),
      "model_incompatible",
      "path",
    );
  });

  it("rejects exact-size files with the wrong header or hash", async () => {
    const wrongHeader = createPinnedHeader();
    wrongHeader.writeInt32LE(8, 44);
    const headerPath = path.join(fixtureRoot, "wrong-header.bin");
    await writeFile(headerPath, wrongHeader);
    await expectModelFailureAsync(
      verifyLocalSubtitleGgmlModelFile(
        headerPath,
        createExpectation(wrongHeader),
      ),
      "model_incompatible",
      "header",
    );

    const bytes = createPinnedHeader();
    const hashPath = path.join(fixtureRoot, "wrong-hash.bin");
    await writeFile(hashPath, bytes);
    const expected = createExpectation(bytes);
    await expectModelFailureAsync(
      verifyLocalSubtitleGgmlModelFile(hashPath, {
        ...expected,
        sha256: "a".repeat(64),
      }),
      "model_corrupt",
      "integrity",
    );
  });

  it("rejects truncated and unexpected-size model files", async () => {
    const truncated = Buffer.alloc(LOCAL_SUBTITLE_GGML_HEADER_BYTE_SIZE - 1);
    const truncatedPath = path.join(fixtureRoot, "truncated.bin");
    await writeFile(truncatedPath, truncated);
    await expectModelFailureAsync(
      verifyLocalSubtitleGgmlModelFile(
        truncatedPath,
        {
          ...createExpectation(createPinnedHeader()),
          sha256: createHash("sha256").update(truncated).digest("hex"),
        },
      ),
      "model_corrupt",
      "integrity",
    );

    const bytes = createPinnedHeader();
    const wrongSizePath = path.join(fixtureRoot, "wrong-size.bin");
    await writeFile(wrongSizePath, bytes);
    const expected = createExpectation(bytes);
    await expectModelFailureAsync(
      verifyLocalSubtitleGgmlModelFile(wrongSizePath, {
        ...expected,
        byteSize: expected.byteSize + 1,
      }),
      "model_corrupt",
      "integrity",
    );
  });

  it("checks cancellation between bounded hash chunks without remapping the reason", async () => {
    const bytes = Buffer.concat([
      createPinnedHeader(),
      Buffer.alloc(3 * 1024 * 1024, 0x5a),
    ]);
    const filePath = path.join(fixtureRoot, "cancelled-model.bin");
    await writeFile(filePath, bytes, { mode: 0o600 });
    const reason = new Error("verification cancelled");
    let abortChecks = 0;
    const signal = {
      get aborted() {
        abortChecks += 1;
        return abortChecks >= 8;
      },
      reason,
    } as unknown as AbortSignal;

    await expect(
      verifyLocalSubtitleGgmlModelFile(
        filePath,
        createExpectation(bytes),
        signal,
      ),
    ).rejects.toBe(reason);
    expect(abortChecks).toBeGreaterThanOrEqual(8);
  });

  it("requires a host-absolute path and a canonical expectation", async () => {
    const bytes = createPinnedHeader();
    await expect(
      verifyLocalSubtitleGgmlModelFile(
        "relative/model.bin",
        createExpectation(bytes),
      ),
    ).rejects.toThrowError(TypeError);

    const filePath = path.join(fixtureRoot, "model.bin");
    await writeFile(filePath, bytes);
    await expect(
      verifyLocalSubtitleGgmlModelFile(filePath, {
        ...createExpectation(bytes),
        sha256: "not-a-sha",
      }),
    ).rejects.toThrowError(TypeError);
  });
});

function createPinnedHeader(): Buffer {
  const header = Buffer.alloc(LOCAL_SUBTITLE_GGML_HEADER_BYTE_SIZE);
  Buffer.from(PINNED_MODEL.ggml.magicHex, "hex").copy(header, 0);
  PINNED_MODEL.ggml.headerInt32Le.forEach((value, index) => {
    header.writeInt32LE(value, 4 + index * 4);
  });
  return header;
}

function createExpectation(bytes: Buffer): LocalSubtitleGgmlModelExpectation {
  return {
    modelId: PINNED_MODEL.id,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ggml: PINNED_MODEL.ggml,
  };
}

function expectModelFailure(
  operation: () => unknown,
  code: "model_incompatible" | "model_corrupt",
  stage: "path" | "header" | "integrity",
): void {
  try {
    operation();
    throw new Error("Expected the GGML model to be rejected.");
  } catch (error) {
    expect(error).toBeInstanceOf(LocalSubtitleModelError);
    expect(error).toMatchObject({ code, stage });
  }
}

async function expectModelFailureAsync(
  operation: Promise<unknown>,
  code: "model_incompatible" | "model_corrupt",
  stage: "path" | "header" | "integrity",
): Promise<void> {
  await expect(operation).rejects.toBeInstanceOf(LocalSubtitleModelError);
  await expect(operation).rejects.toMatchObject({ code, stage });
}
