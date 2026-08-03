import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  extractLocalSubtitleAcceleratorArchive,
} from "../../electron/main/local-subtitle/accelerator-archive";
import {
  parseLocalSubtitleAcceleratorArchiveContract,
  type LocalSubtitleAcceleratorArchiveContract,
} from "../../electron/main/local-subtitle/accelerator-manifest";

interface ZipFixtureEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly compressionMethod?: 0 | 8;
  readonly versionMadeBy?: number;
  readonly externalFileAttributes?: number;
}

describe("local subtitle accelerator archive", () => {
  it("extracts only exact selected leaves after archive and entry verification", async () => {
    const fixture = await createFixture([
      { name: "server.exe", data: Buffer.from("server") },
      { name: "unused.exe", data: Buffer.from("unused") },
    ]);
    try {
      const result = await extractLocalSubtitleAcceleratorArchive({
        archivePath: fixture.archivePath,
        destinationDirectory: fixture.destination,
        contract: fixture.contract,
      });

      expect(result).toEqual({
        archiveSha256: sha256(fixture.archive),
        archiveByteSize: fixture.archive.length,
        extractedFileCount: 1,
        extractedByteSize: 6,
      });
      await expect(
        readFile(path.join(fixture.destination, "payload", "server.exe"), "utf8"),
      ).resolves.toBe("server");
      await expect(
        readFile(path.join(fixture.destination, "payload", "unused.exe")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanupFixture(fixture.root);
    }
  });

  it.each([
    {
      title: "traversal",
      entries: [
        { name: "../server.exe", data: Buffer.from("server") },
        { name: "unused.exe", data: Buffer.from("unused") },
      ],
    },
    {
      title: "unknown leaf",
      entries: [
        { name: "server.exe", data: Buffer.from("server") },
        { name: "surprise.exe", data: Buffer.from("unused") },
      ],
    },
    {
      title: "case-insensitive duplicate",
      entries: [
        { name: "server.exe", data: Buffer.from("server") },
        { name: "SERVER.EXE", data: Buffer.from("unused") },
      ],
    },
    {
      title: "Unix symlink",
      entries: [
        {
          name: "server.exe",
          data: Buffer.from("server"),
          versionMadeBy: (3 << 8) | 20,
          externalFileAttributes: (0o120777 << 16) >>> 0,
        },
        { name: "unused.exe", data: Buffer.from("unused") },
      ],
    },
    {
      title: "Windows reparse point",
      entries: [
        {
          name: "server.exe",
          data: Buffer.from("server"),
          versionMadeBy: 20,
          externalFileAttributes: 0x400,
        },
        { name: "unused.exe", data: Buffer.from("unused") },
      ],
    },
  ])("rejects $title before publishing staging", async ({ entries }) => {
    const fixture = await createFixture(entries);
    try {
      await expect(extractLocalSubtitleAcceleratorArchive({
        archivePath: fixture.archivePath,
        destinationDirectory: fixture.destination,
        contract: fixture.contract,
      })).rejects.toMatchObject({ code: "accelerator_archive_invalid" });
      await expect(readFile(fixture.destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await cleanupFixture(fixture.root);
    }
  });

  it("removes staging when a selected artifact hash fails", async () => {
    const fixture = await createFixture([
      { name: "server.exe", data: Buffer.from("server") },
      { name: "unused.exe", data: Buffer.from("unused") },
    ], { selectedSha256: "0".repeat(64) });
    try {
      await expect(extractLocalSubtitleAcceleratorArchive({
        archivePath: fixture.archivePath,
        destinationDirectory: fixture.destination,
        contract: fixture.contract,
      })).rejects.toMatchObject({ code: "accelerator_archive_invalid" });
      await expect(readFile(fixture.destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await cleanupFixture(fixture.root);
    }
  });

  it("rejects an entry whose compression ratio exceeds the zip-bomb bound", async () => {
    const fixture = await createFixture([
      {
        name: "server.exe",
        data: Buffer.alloc(64 * 1024),
        compressionMethod: 8,
      },
      { name: "unused.exe", data: Buffer.from("unused") },
    ]);
    try {
      await expect(extractLocalSubtitleAcceleratorArchive({
        archivePath: fixture.archivePath,
        destinationDirectory: fixture.destination,
        contract: fixture.contract,
      })).rejects.toMatchObject({ code: "accelerator_archive_invalid" });
      await expect(readFile(fixture.destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await cleanupFixture(fixture.root);
    }
  });

  it("is no-clobber and preserves an existing destination", async () => {
    const fixture = await createFixture([
      { name: "server.exe", data: Buffer.from("server") },
      { name: "unused.exe", data: Buffer.from("unused") },
    ]);
    try {
      await mkdir(fixture.destination);
      const sentinel = path.join(fixture.destination, "sentinel.txt");
      await writeFile(sentinel, "keep", "utf8");
      await expect(extractLocalSubtitleAcceleratorArchive({
        archivePath: fixture.archivePath,
        destinationDirectory: fixture.destination,
        contract: fixture.contract,
      })).rejects.toMatchObject({ code: "accelerator_archive_invalid" });
      await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
    } finally {
      await cleanupFixture(fixture.root);
    }
  });

  it("cancels extraction and confirms staging cleanup", async () => {
    const payload = Buffer.alloc(2 * 1024 * 1024, 7);
    const fixture = await createFixture([
      { name: "server.exe", data: payload },
      { name: "unused.exe", data: Buffer.from("unused") },
    ]);
    const controller = new AbortController();
    try {
      await expect(extractLocalSubtitleAcceleratorArchive({
        archivePath: fixture.archivePath,
        destinationDirectory: fixture.destination,
        contract: fixture.contract,
        signal: controller.signal,
        onProgress(completedBytes) {
          if (completedBytes > fixture.archive.length) controller.abort();
        },
      })).rejects.toMatchObject({ code: "accelerator_archive_cancelled" });
      await expect(readFile(fixture.destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await cleanupFixture(fixture.root);
    }
  });

  it("surfaces cancellation cleanup failure", async () => {
    const payload = Buffer.alloc(256 * 1024, 9);
    const fixture = await createFixture([
      { name: "server.exe", data: payload },
      { name: "unused.exe", data: Buffer.from("unused") },
    ]);
    const controller = new AbortController();
    try {
      await expect(extractLocalSubtitleAcceleratorArchive({
        archivePath: fixture.archivePath,
        destinationDirectory: fixture.destination,
        contract: fixture.contract,
        signal: controller.signal,
        onProgress(completedBytes) {
          if (completedBytes > fixture.archive.length) controller.abort();
        },
        removeDirectory: async () => {
          throw new Error("busy");
        },
      })).rejects.toMatchObject({
        code: "accelerator_archive_cleanup_failed",
      });
    } finally {
      await cleanupFixture(fixture.root);
    }
  });
});

async function createFixture(
  entries: readonly ZipFixtureEntry[],
  overrides: { readonly selectedSha256?: string } = {},
): Promise<{
  readonly root: string;
  readonly archivePath: string;
  readonly destination: string;
  readonly archive: Buffer;
  readonly contract: LocalSubtitleAcceleratorArchiveContract;
}> {
  const tempRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(tempRoot, "fusionkit-accelerator-"));
  const archive = createStoredZip(entries);
  const archivePath = path.join(root, "accelerator.zip");
  await writeFile(archivePath, archive);
  const server = entries.find((entry) => entry.name.toLowerCase() === "server.exe") ??
    entries[0]!;
  const contract = parseLocalSubtitleAcceleratorArchiveContract({
    archive: {
      byteSize: archive.length,
      sha256: sha256(archive),
      expandedFileCount: entries.length,
      expandedByteSize: entries.reduce(
        (total, entry) => total + entry.data.length,
        0,
      ),
    },
    selectedEntries: [
      {
        archiveName: "server.exe",
        outputRelativePath: "payload/server.exe",
        byteSize: server.data.length,
        sha256: overrides.selectedSha256 ?? sha256(server.data),
      },
    ],
    excludedEntries: ["unused.exe"],
    maxEntryBytes: Math.max(1, server.data.length),
    maxCompressionRatio: 200,
  });
  return {
    root,
    archivePath,
    destination: path.join(root, "staging"),
    archive,
    contract,
  };
}

function createStoredZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const compressionMethod = entry.compressionMethod ?? 0;
    const compressedData = compressionMethod === 8
      ? deflateRawSync(entry.data)
      : entry.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(compressionMethod, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedData.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressedData);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMadeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(compressionMethod, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedData.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalFileAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressedData.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function cleanupFixture(root: string): Promise<void> {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
