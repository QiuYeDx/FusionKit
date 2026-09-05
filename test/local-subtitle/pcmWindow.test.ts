import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_SUBTITLE_LIMITS } from "../../src/type/localSubtitle";
import {
  LocalSubtitlePcmWindowError,
  createLocalSubtitlePcm16WavHeader,
  inspectLocalSubtitlePcm16Wav,
  writeLocalSubtitlePcmWindow,
} from "../../electron/main/local-subtitle/pcm-window";

const PCM_FORMAT = createPcmFormat();
const sparseRoots: string[] = [];
let fixtureRoot: string;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-pcm-window-test-"),
  );
  sparseRoots.push(fixtureRoot);
});

afterEach(async () => {
  const current = sparseRoots.splice(0);
  await Promise.all(current.map((root) => rm(root, { recursive: true, force: true })));
});

describe("local subtitle PCM16 WAV inspection", () => {
  it("conditions only the private window while preserving the source and frame range", async () => {
    const payload=Buffer.alloc(32000);
    for(let i=0;i<16000;i++)payload.writeInt16LE(i%2 ? 500 : -500,i*2);
    const sourcePath=path.join(fixtureRoot,"quiet.wav"),outputPath=path.join(fixtureRoot,"conditioned.wav");
    const original=Buffer.concat([createLocalSubtitlePcm16WavHeader(payload.length),payload]);
    await writeFile(sourcePath,original);
    const metadata=await inspectLocalSubtitlePcm16Wav(sourcePath);
    const result=await writeLocalSubtitlePcmWindow({sourcePath,sourceIdentity:metadata.fileIdentity,metadata,startFrame:0,endFrame:16000,outputPath,conditionQuietAudio:true});
    expect(result.quietAudioGainDb).toBe(12);
    expect(result.metadata.totalFrames).toBe(16000);
    expect((await readFile(sourcePath)).equals(original)).toBe(true);
    const output=await readFile(outputPath);
    expect(result.sha256).toBe(createHash("sha256").update(output).digest("hex"));
    expect(output.readInt16LE(44)).toBe(Math.round(-500*10**.6));
  });
  it("strictly inspects a canonical RIFF PCM16 file", async () => {
    const filePath = path.join(fixtureRoot, "source.wav");
    const payload = Buffer.alloc(16_000 * 2, 0x2a);
    await writeFile(
      filePath,
      Buffer.concat([createLocalSubtitlePcm16WavHeader(payload.length), payload]),
    );

    const metadata = await inspectLocalSubtitlePcm16Wav(filePath);

    expect(metadata).toMatchObject({
      container: "RIFF",
      fileSize: 44 + payload.length,
      audioFormat: 1,
      channels: 1,
      sampleRateHz: 16_000,
      byteRate: 32_000,
      blockAlign: 2,
      bitsPerSample: 16,
      dataOffset: 44,
      dataSize: payload.length,
      totalFrames: 16_000,
      durationMs: 1_000,
    });
    expect(metadata.fileIdentity.size).toBe(44 + payload.length);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.fileIdentity)).toBe(true);
  });

  it("keeps exact frame authority for sub-millisecond PCM", async () => {
    const filePath = path.join(fixtureRoot, "fractional.wav");
    const payload = Buffer.from([
      0x00, 0x01,
      0x02, 0x03,
      0x04, 0x05,
      0x06, 0x07,
      0x08, 0x09,
      0x0a, 0x0b,
      0x0c, 0x0d,
    ]);
    await writeFile(
      filePath,
      Buffer.concat([createLocalSubtitlePcm16WavHeader(payload.length), payload]),
    );

    const metadata = await inspectLocalSubtitlePcm16Wav(filePath);

    expect(metadata.totalFrames).toBe(7);
    expect(metadata.durationMs).toBe(0);
    expect(metadata.dataSize).toBe(14);
  });

  it("inspects a sparse RF64 file with a 64-bit data size and sample count", async () => {
    const filePath = path.join(fixtureRoot, "large.rf64.wav");
    const dataSize = 0x1_0000_0000;
    await writeSparseRf64(filePath, dataSize, dataSize / 2);

    const metadata = await inspectLocalSubtitlePcm16Wav(filePath);

    expect(metadata).toMatchObject({
      container: "RF64",
      fileSize: 80 + dataSize,
      dataOffset: 80,
      dataSize,
      totalFrames: dataSize / 2,
      durationMs: 134_217_728,
    });
  });

  it("accepts seven frames beyond the rounded 99:59:59.999 frame limit", async () => {
    const filePath = path.join(fixtureRoot, "duration-limit.rf64.wav");
    const roundedLimitFrames = Math.round(
      (LOCAL_SUBTITLE_LIMITS.maxDurationMs * 16_000) / 1_000,
    );
    const totalFrames = roundedLimitFrames + 7;
    const dataSize = totalFrames * 2;
    await writeSparseRf64(filePath, dataSize, totalFrames);

    const metadata = await inspectLocalSubtitlePcm16Wav(filePath);

    expect(metadata.totalFrames).toBe(totalFrames);
    expect(metadata.durationMs).toBe(LOCAL_SUBTITLE_LIMITS.maxDurationMs);
    expect(metadata.fileSize).toBeLessThan(
      LOCAL_SUBTITLE_LIMITS.maxNormalizedPcmBytes,
    );
  });

  it("rejects eight frames beyond the rounded 99:59:59.999 frame limit", async () => {
    const filePath = path.join(fixtureRoot, "duration-overflow.rf64.wav");
    const roundedLimitFrames = Math.round(
      (LOCAL_SUBTITLE_LIMITS.maxDurationMs * 16_000) / 1_000,
    );
    const totalFrames = roundedLimitFrames + 8;
    const dataSize = totalFrames * 2;
    await writeSparseRf64(filePath, dataSize, totalFrames);

    expect(80 + dataSize).toBeLessThan(
      LOCAL_SUBTITLE_LIMITS.maxNormalizedPcmBytes,
    );

    await expect(inspectLocalSubtitlePcm16Wav(filePath)).rejects.toMatchObject({
      reason: "limit_exceeded",
    });
  });

  it.each([
    ["missing ds64", () => makeRf64WithoutDs64(), "invalid_wav"],
    [
      "inconsistent ds64 sample count",
      () => makeSmallRf64(Buffer.alloc(32), 15),
      "invalid_wav",
    ],
    [
      "wrong channel format",
      () => {
        const wav = Buffer.concat([
          createLocalSubtitlePcm16WavHeader(2),
          Buffer.alloc(2),
        ]);
        wav.writeUInt16LE(2, 22);
        return wav;
      },
      "unsupported_wav",
    ],
    [
      "empty data",
      () => makeRiff([
        { id: "fmt ", payload: PCM_FORMAT },
        { id: "data", payload: Buffer.alloc(0) },
      ]),
      "invalid_wav",
    ],
    [
      "duplicate fmt",
      () => makeRiff([
        { id: "fmt ", payload: PCM_FORMAT },
        { id: "fmt ", payload: PCM_FORMAT },
        { id: "data", payload: Buffer.alloc(2) },
      ]),
      "invalid_wav",
    ],
    [
      "duplicate data",
      () => makeRiff([
        { id: "fmt ", payload: PCM_FORMAT },
        { id: "data", payload: Buffer.alloc(2) },
        { id: "data", payload: Buffer.alloc(2) },
      ]),
      "invalid_wav",
    ],
    ["truncated data", () => makeTruncatedRiff(), "invalid_wav"],
    ["non-zero chunk padding", () => makeInvalidPaddingRiff(), "invalid_wav"],
  ] as const)("rejects %s without exposing its path", async (_label, create, reason) => {
    const filePath = path.join(fixtureRoot, "private-media-name.wav");
    await writeFile(filePath, create());

    const error = await inspectLocalSubtitlePcm16Wav(filePath).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(LocalSubtitlePcmWindowError);
    expect(error).toMatchObject({ reason });
    expect((error as Error).message).not.toContain(filePath);
    expect((error as Error).message).not.toContain("private-media-name");
  });

  it("rejects a symbolic-link input at the no-follow boundary", async () => {
    if (process.platform === "win32") return;
    const target = path.join(fixtureRoot, "target.wav");
    const link = path.join(fixtureRoot, "link.wav");
    await writeFile(
      target,
      Buffer.concat([createLocalSubtitlePcm16WavHeader(2), Buffer.alloc(2)]),
    );
    await symlink(target, link, "file");

    await expect(inspectLocalSubtitlePcm16Wav(link)).rejects.toMatchObject({
      reason: "source_identity_mismatch",
    });
  });
});

describe("local subtitle PCM window writing", () => {
  it("writes the exact frame byte slice, hashes it, and parse-backs the window", async () => {
    const sourcePath = path.join(fixtureRoot, "source.wav");
    const outputPath = path.join(fixtureRoot, "window.wav");
    const payload = Buffer.from(Array.from({ length: 40 }, (_, index) => index));
    await writeFile(
      sourcePath,
      Buffer.concat([createLocalSubtitlePcm16WavHeader(payload.length), payload]),
    );
    const metadata = await inspectLocalSubtitlePcm16Wav(sourcePath);

    const result = await writeLocalSubtitlePcmWindow({
      sourcePath,
      sourceIdentity: metadata.fileIdentity,
      metadata,
      startFrame: 3,
      endFrame: 11,
      outputPath,
    });

    const output = await readFile(outputPath);
    expect(output.subarray(44)).toEqual(payload.subarray(6, 22));
    expect(result.metadata).toMatchObject({
      container: "RIFF",
      dataOffset: 44,
      dataSize: 16,
      totalFrames: 8,
      durationMs: 1,
    });
    expect(result.sha256).toBe(
      createHash("sha256").update(output).digest("hex"),
    );
    if (process.platform !== "win32") {
      expect((await lstat(outputPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves a seven-frame fractional-millisecond range exactly", async () => {
    const sourcePath = path.join(fixtureRoot, "source.wav");
    const outputPath = path.join(fixtureRoot, "short-window.wav");
    const payload = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    await writeFile(
      sourcePath,
      Buffer.concat([createLocalSubtitlePcm16WavHeader(payload.length), payload]),
    );
    const metadata = await inspectLocalSubtitlePcm16Wav(sourcePath);

    const result = await writeLocalSubtitlePcmWindow({
      sourcePath,
      sourceIdentity: metadata.fileIdentity,
      metadata,
      startFrame: 2,
      endFrame: 9,
      outputPath,
    });

    expect(result.metadata.totalFrames).toBe(7);
    expect(result.metadata.durationMs).toBe(0);
    expect((await readFile(outputPath)).subarray(44)).toEqual(
      payload.subarray(4, 18),
    );
  });

  it("deletes no output when already aborted", async () => {
    const { sourcePath, metadata } = await createSourceFixture();
    const outputPath = path.join(fixtureRoot, "cancelled.wav");
    const controller = new AbortController();
    controller.abort();

    await expect(
      writeLocalSubtitlePcmWindow({
        sourcePath,
        sourceIdentity: metadata.fileIdentity,
        metadata,
        startFrame: 0,
        endFrame: 8,
        outputPath,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "aborted" });
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a replacement source identity and removes no unrelated file", async () => {
    const { sourcePath, metadata } = await createSourceFixture();
    const originalPath = path.join(fixtureRoot, "original.wav");
    const outputPath = path.join(fixtureRoot, "identity-failed.wav");
    await rename(sourcePath, originalPath);
    await writeFile(
      sourcePath,
      Buffer.concat([
        createLocalSubtitlePcm16WavHeader(metadata.dataSize),
        Buffer.alloc(metadata.dataSize, 0xff),
      ]),
    );

    await expect(
      writeLocalSubtitlePcmWindow({
        sourcePath,
        sourceIdentity: metadata.fileIdentity,
        metadata,
        startFrame: 0,
        endFrame: 8,
        outputPath,
      }),
    ).rejects.toMatchObject({ reason: "source_identity_mismatch" });
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(originalPath)).resolves.toMatchObject({ size: metadata.fileSize });
  });

  it("re-parses the held source instead of trusting a copied metadata offset", async () => {
    const { sourcePath, metadata } = await createSourceFixture();
    const outputPath = path.join(fixtureRoot, "metadata-failed.wav");

    await expect(
      writeLocalSubtitlePcmWindow({
        sourcePath,
        sourceIdentity: metadata.fileIdentity,
        metadata: { ...metadata, dataOffset: metadata.dataOffset - 2 },
        startFrame: 0,
        endFrame: 8,
        outputPath,
      }),
    ).rejects.toMatchObject({ reason: "source_identity_mismatch" });
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses exclusive output creation and preserves an existing target", async () => {
    const { sourcePath, metadata } = await createSourceFixture();
    const outputPath = path.join(fixtureRoot, "existing.wav");
    await writeFile(outputPath, "keep-me");

    await expect(
      writeLocalSubtitlePcmWindow({
        sourcePath,
        sourceIdentity: metadata.fileIdentity,
        metadata,
        startFrame: 0,
        endFrame: 8,
        outputPath,
      }),
    ).rejects.toMatchObject({ reason: "output_exists" });
    await expect(readFile(outputPath, "utf8")).resolves.toBe("keep-me");
  });

  it("bounds canonical RIFF headers to a positive 30-second PCM window", () => {
    expect(createLocalSubtitlePcm16WavHeader(960_000)).toHaveLength(44);
    expect(() => createLocalSubtitlePcm16WavHeader(0)).toThrowError(
      LocalSubtitlePcmWindowError,
    );
    expect(() => createLocalSubtitlePcm16WavHeader(960_002)).toThrowError(
      LocalSubtitlePcmWindowError,
    );
  });
});

async function createSourceFixture() {
  const sourcePath = path.join(fixtureRoot, "source.wav");
  const payload = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  await writeFile(
    sourcePath,
    Buffer.concat([createLocalSubtitlePcm16WavHeader(payload.length), payload]),
  );
  return {
    sourcePath,
    metadata: await inspectLocalSubtitlePcm16Wav(sourcePath),
  };
}

function createPcmFormat(): Buffer {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(16_000, 4);
  format.writeUInt32LE(32_000, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  return format;
}

function makeRiff(chunks: readonly { readonly id: string; readonly payload: Buffer }[]) {
  const body = Buffer.concat(
    chunks.flatMap(({ id, payload }) => {
      const header = Buffer.alloc(8);
      header.write(id, 0, 4, "ascii");
      header.writeUInt32LE(payload.length, 4);
      return payload.length % 2 === 0
        ? [header, payload]
        : [header, payload, Buffer.alloc(1)];
    }),
  );
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, body]);
}

function makeSmallRf64(data: Buffer, sampleCount = data.length / 2): Buffer {
  const fileSize = 80 + data.length;
  const header = createRf64Prefix(fileSize, data.length, sampleCount);
  return Buffer.concat([header, data]);
}

function createRf64Prefix(
  fileSize: number,
  dataSize: number,
  sampleCount: number,
): Buffer {
  const header = Buffer.alloc(80);
  header.write("RF64", 0, "ascii");
  header.writeUInt32LE(0xffff_ffff, 4);
  header.write("WAVE", 8, "ascii");
  header.write("ds64", 12, "ascii");
  header.writeUInt32LE(28, 16);
  header.writeBigUInt64LE(BigInt(fileSize - 8), 20);
  header.writeBigUInt64LE(BigInt(dataSize), 28);
  header.writeBigUInt64LE(BigInt(sampleCount), 36);
  header.writeUInt32LE(0, 44);
  header.write("fmt ", 48, "ascii");
  header.writeUInt32LE(16, 52);
  PCM_FORMAT.copy(header, 56);
  header.write("data", 72, "ascii");
  header.writeUInt32LE(0xffff_ffff, 76);
  return header;
}

async function writeSparseRf64(
  filePath: string,
  dataSize: number,
  sampleCount: number,
): Promise<void> {
  const fileSize = 80 + dataSize;
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.write(createRf64Prefix(fileSize, dataSize, sampleCount), 0, 80, 0);
    await handle.truncate(fileSize);
  } finally {
    await handle.close();
  }
}

function makeRf64WithoutDs64(): Buffer {
  const riff = Buffer.concat([
    createLocalSubtitlePcm16WavHeader(2),
    Buffer.alloc(2),
  ]);
  riff.write("RF64", 0, "ascii");
  riff.writeUInt32LE(0xffff_ffff, 4);
  return riff;
}

function makeTruncatedRiff(): Buffer {
  const wav = Buffer.concat([
    createLocalSubtitlePcm16WavHeader(4),
    Buffer.alloc(2),
  ]);
  wav.writeUInt32LE(wav.length - 8, 4);
  return wav;
}

function makeInvalidPaddingRiff(): Buffer {
  const wav = makeRiff([
    { id: "JUNK", payload: Buffer.from([0x01]) },
    { id: "fmt ", payload: PCM_FORMAT },
    { id: "data", payload: Buffer.alloc(2) },
  ]);
  wav[21] = 0xff;
  return wav;
}
