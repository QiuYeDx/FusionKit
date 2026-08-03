import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadLocalSubtitleResource,
  LocalSubtitleResourceDownloadError,
  type LocalSubtitleDownloadResponse,
  type OpenLocalSubtitleDownloadResponse,
} from "../../electron/main/local-subtitle/resource-download";

const roots: string[] = [];
const SOURCE_URL = "https://models.example.test/model.bin";
const ALLOWED_HOSTS = ["models.example.test", "*.cdn.example.test"];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      })
    ),
  );
});

describe("local subtitle resource download", () => {
  it("downloads exact bytes and atomically adopts the completed part", async () => {
    const fixture = await createFixture();
    const bytes = Buffer.from("fusionkit-model");
    const ensureCapacity = vi.fn(async () => undefined);
    const progress = vi.fn();

    const result = await downloadLocalSubtitleResource({
      ...fixture.options(bytes.length),
      ensureCapacity,
      onProgress: progress,
      openResponse: async () => response(200, {
        "content-length": String(bytes.length),
        etag: '"model-v1"',
      }, [bytes.subarray(0, 5), bytes.subarray(5)]),
      metadataSyncBytes: 4,
    });

    expect(await readFile(fixture.destinationPath)).toEqual(bytes);
    await expect(readFile(fixture.partPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.metadataPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result).toMatchObject({
      byteSize: bytes.length,
      resumedBytes: 0,
      effectiveUrl: SOURCE_URL,
      etag: '"model-v1"',
    });
    expect(ensureCapacity).toHaveBeenCalledWith(bytes.length);
    expect(progress).toHaveBeenLastCalledWith(bytes.length, bytes.length);
  });

  it("resumes a failed download with Range and If-Range", async () => {
    const fixture = await createFixture();
    const bytes = Buffer.from("0123456789");
    const firstTransport: OpenLocalSubtitleDownloadResponse = async () =>
      response(200, {
        "content-length": String(bytes.length),
        etag: '"resume-v1"',
      }, [bytes.subarray(0, 4), new Error("connection reset")]);

    await expect(
      downloadLocalSubtitleResource({
        ...fixture.options(bytes.length),
        openResponse: firstTransport,
        metadataSyncBytes: 2,
      }),
    ).rejects.toBeInstanceOf(LocalSubtitleResourceDownloadError);

    const headers: Array<Readonly<Record<string, string>>> = [];
    const result = await downloadLocalSubtitleResource({
      ...fixture.options(bytes.length),
      openResponse: async (request) => {
        headers.push(request.headers);
        return response(206, {
          "content-length": String(bytes.length - 4),
          "content-range": `bytes 4-${bytes.length - 1}/${bytes.length}`,
          etag: '"resume-v1"',
        }, [bytes.subarray(4)]);
      },
      metadataSyncBytes: 2,
    });

    expect(headers).toEqual([
      expect.objectContaining({
        range: "bytes=4-",
        "if-range": '"resume-v1"',
      }),
    ]);
    expect(result.resumedBytes).toBe(4);
    expect(await readFile(fixture.destinationPath)).toEqual(bytes);
  });

  it("restarts safely when a resumed server ignores Range", async () => {
    const fixture = await createFixture();
    const bytes = Buffer.from("abcdefghij");
    await seedPartialDownload(fixture, bytes, 3, '"range-v1"');
    const requests: Array<Readonly<Record<string, string>>> = [];

    await downloadLocalSubtitleResource({
      ...fixture.options(bytes.length),
      openResponse: async (request) => {
        requests.push(request.headers);
        return response(200, {
          "content-length": String(bytes.length),
          etag: '"range-v2"',
        }, [bytes]);
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ range: "bytes=3-" });
    expect(requests[1]).not.toHaveProperty("range");
    expect(await readFile(fixture.destinationPath)).toEqual(bytes);
  });

  it("restarts when the validator changes during resume", async () => {
    const fixture = await createFixture();
    const bytes = Buffer.from("validator-change");
    await seedPartialDownload(fixture, bytes, 4, '"validator-v1"');
    let requestCount = 0;

    await downloadLocalSubtitleResource({
      ...fixture.options(bytes.length),
      openResponse: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return response(206, {
            "content-length": String(bytes.length - 4),
            "content-range": `bytes 4-${bytes.length - 1}/${bytes.length}`,
            etag: '"validator-v2"',
          }, [bytes.subarray(4)]);
        }
        return response(200, {
          "content-length": String(bytes.length),
          etag: '"validator-v2"',
        }, [bytes]);
      },
    });

    expect(requestCount).toBe(2);
    expect(await readFile(fixture.destinationPath)).toEqual(bytes);
  });

  it("rejects redirects outside the manifest host allowlist", async () => {
    const fixture = await createFixture();
    const redirect = response(302, {
      location: "https://evil.example.net/model.bin",
    }, []);

    await expect(
      downloadLocalSubtitleResource({
        ...fixture.options(4),
        openResponse: async () => redirect,
      }),
    ).rejects.toMatchObject({ code: "resource_not_allowed" });
    expect(redirect.discard).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect loop without opening the body", async () => {
    const fixture = await createFixture();
    const openResponse = vi.fn(async () =>
      response(302, { location: SOURCE_URL }, []));

    await expect(
      downloadLocalSubtitleResource({
        ...fixture.options(4),
        openResponse,
      }),
    ).rejects.toMatchObject({ code: "model_download_failed" });
    expect(openResponse).toHaveBeenCalledOnce();
  });

  it("cleans resumable state when cancellation is observed", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const bytes = Buffer.from("cancel-me");
    const openResponse: OpenLocalSubtitleDownloadResponse = async () =>
      response(200, {
        "content-length": String(bytes.length),
        etag: '"cancel-v1"',
      }, cancellingChunks(bytes, controller));

    await expect(
      downloadLocalSubtitleResource({
        ...fixture.options(bytes.length),
        signal: controller.signal,
        openResponse,
        metadataSyncBytes: 1,
      }),
    ).rejects.toThrow("cancelled by test");
    await expect(readFile(fixture.partPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.metadataPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-resource-download-"));
  roots.push(root);
  const downloads = path.join(root, "downloads");
  const staging = path.join(root, "staging");
  await Promise.all([
    mkdir(downloads, { mode: 0o700 }),
    mkdir(staging, { mode: 0o700 }),
  ]);
  const destinationPath = path.join(staging, "model.bin");
  const partPath = path.join(downloads, "model.part");
  const metadataPath = path.join(downloads, "model.part.json");
  return {
    root,
    destinationPath,
    partPath,
    metadataPath,
    options: (expectedBytes: number) => ({
      sourceUrl: SOURCE_URL,
      allowedHosts: ALLOWED_HOSTS,
      expectedBytes,
      downloadDirectory: downloads,
      partFileName: "model.part",
      metadataFileName: "model.part.json",
      destinationPath,
      signal: new AbortController().signal,
      ensureCapacity: async () => undefined,
    }),
  };
}

async function seedPartialDownload(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  bytes: Buffer,
  completedBytes: number,
  etag: string,
): Promise<void> {
  await expect(
    downloadLocalSubtitleResource({
      ...fixture.options(bytes.length),
      openResponse: async () => response(200, {
        "content-length": String(bytes.length),
        etag,
      }, [bytes.subarray(0, completedBytes), new Error("seed failure")]),
      metadataSyncBytes: 1,
    }),
  ).rejects.toBeInstanceOf(LocalSubtitleResourceDownloadError);
}

function response(
  statusCode: number,
  headers: Readonly<Record<string, string | undefined>>,
  values: readonly (Uint8Array | Error)[] | AsyncIterable<Uint8Array>,
): LocalSubtitleDownloadResponse & { readonly discard: ReturnType<typeof vi.fn> } {
  return {
    statusCode,
    headers,
    body: Symbol.asyncIterator in Object(values)
      ? values as AsyncIterable<Uint8Array>
      : chunkStream(values as readonly (Uint8Array | Error)[]),
    discard: vi.fn(),
  };
}

async function* chunkStream(
  values: readonly (Uint8Array | Error)[],
): AsyncGenerator<Uint8Array> {
  for (const value of values) {
    if (value instanceof Error) throw value;
    yield value;
  }
}

async function* cancellingChunks(
  bytes: Buffer,
  controller: AbortController,
): AsyncGenerator<Uint8Array> {
  yield bytes.subarray(0, 3);
  controller.abort(new Error("cancelled by test"));
  yield bytes.subarray(3);
}
