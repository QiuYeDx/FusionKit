import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectRenamePaths,
  isBlockedPath,
  scanRenameTargets,
  splitNameParts,
} from "../../electron/main/rename/scanner";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  type NameTranslationOptions,
} from "../../electron/main/rename/types";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

describe("rename scanner helpers", () => {
  it("splits file stems and keeps extensions with the leading dot", () => {
    expect(splitNameParts("第01話.srt", "file")).toEqual({
      stem: "第01話",
      extension: ".srt",
    });
    expect(splitNameParts("Season.01", "directory")).toEqual({
      stem: "Season.01",
      extension: "",
    });
  });

  it("blocks protected roots without blocking normal home descendants", () => {
    expect(isBlockedPath("/tmp/home", "/tmp/home")).toBe(true);
    expect(isBlockedPath("/tmp/home/Downloads", "/tmp/home")).toBe(false);
    expect(isBlockedPath("/tmp/project/node_modules", "/tmp/home")).toBe(true);
  });
});

describe("inspectRenamePaths", () => {
  it("returns structured results for files, directories, and missing paths", async () => {
    const root = await createTempRoot();
    const filePath = path.join(root, "第01話.srt");
    const directoryPath = path.join(root, "Season 01");
    const missingPath = path.join(root, "missing.srt");

    await fs.writeFile(filePath, "subtitle");
    await fs.mkdir(directoryPath);

    const result = await inspectRenamePaths({
      paths: [filePath, directoryPath, missingPath],
    });

    expect(result.paths).toHaveLength(3);
    expect(result.paths[0]).toMatchObject({
      path: filePath,
      exists: true,
      kind: "file",
      riskLevel: "normal",
    });
    expect(result.paths[1]).toMatchObject({
      path: directoryPath,
      exists: true,
      kind: "directory",
      directFileCount: 0,
      directDirectoryCount: 0,
      riskLevel: "normal",
    });
    expect(result.paths[2]).toMatchObject({
      path: missingPath,
      exists: false,
      kind: "missing",
      riskLevel: "blocked",
    });
  });
});

describe("scanRenameTargets", () => {
  it("scans only the selected path for self scope", async () => {
    const root = await createTempRoot();
    const filePath = path.join(root, "第01話.srt");
    await fs.writeFile(filePath, "subtitle");

    const result = await scanRenameTargets({
      options: buildOptions({
        roots: [filePath],
        scope: "self",
        targetKind: "files",
      }),
    });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      kind: "file",
      absolutePath: filePath,
      parentPath: root,
      originalName: "第01話.srt",
      stem: "第01話",
      extension: ".srt",
      depthFromRoot: 0,
      anchorRoot: filePath,
    });
  });

  it("scans a selected directory for self scope", async () => {
    const root = await createTempRoot();
    const directoryPath = path.join(root, "第一季");
    await fs.mkdir(directoryPath);
    await fs.writeFile(path.join(directoryPath, "第01話.srt"), "subtitle");

    const result = await scanRenameTargets({
      options: buildOptions({
        roots: [directoryPath],
        scope: "self",
        targetKind: "directories",
      }),
    });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      kind: "directory",
      absolutePath: directoryPath,
      parentPath: root,
      originalName: "第一季",
      stem: "第一季",
      extension: "",
      depthFromRoot: 0,
      anchorRoot: directoryPath,
    });
  });

  it("scans direct children and skips hidden/protected entries by default", async () => {
    const root = await createRenameTree();

    const result = await scanRenameTargets({
      options: buildOptions({
        roots: [root],
        scope: "children",
        targetKind: "files",
      }),
    });

    expect(result.truncated).toBe(false);
    expect(result.targets.map((target) => target.originalName)).toEqual([
      "第01話.srt",
    ]);
    expect(result.warnings.some((warning) => warning.includes("Hidden"))).toBe(
      true
    );
    expect(
      result.warnings.some((warning) => warning.includes("Protected"))
    ).toBe(true);
  });

  it("scans direct child directories when targetKind is directories", async () => {
    const root = await createRenameTree();

    const result = await scanRenameTargets({
      options: buildOptions({
        roots: [root],
        scope: "children",
        targetKind: "directories",
      }),
    });

    expect(result.targets.map((target) => target.originalName)).toEqual([
      "Season 01",
    ]);
    expect(result.targets[0]).toMatchObject({
      kind: "directory",
      depthFromRoot: 1,
      anchorRoot: root,
    });
  });

  it("scans descendants within maxDepth and does not enter blocked directories", async () => {
    const root = await createRenameTree();
    const symlinkPath = path.join(root, "Linked Season");

    try {
      await fs.symlink(path.join(root, "Season 01"), symlinkPath, "dir");
    } catch {
      // Some environments disallow symlinks; the traversal behavior is still
      // covered by hidden and protected directory skips below.
    }

    const result = await scanRenameTargets({
      options: buildOptions({
        roots: [root],
        scope: "descendants",
        targetKind: "both",
        maxDepth: 2,
      }),
    });

    const names = result.targets.map((target) => target.originalName).sort();

    expect(names).toContain("第01話.srt");
    expect(names).toContain("Season 01");
    expect(names).toContain("第02話.srt");
    expect(names).toContain("Nested");
    expect(names).not.toContain("第03話.srt");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain(".hidden.srt");
    expect(names).not.toContain("Linked Season");
  });

  it("marks scans as truncated when maxTargets is reached", async () => {
    const root = await createTempRoot();
    await fs.writeFile(path.join(root, "a.srt"), "a");
    await fs.writeFile(path.join(root, "b.srt"), "b");

    const result = await scanRenameTargets({
      options: buildOptions({
        roots: [root],
        scope: "children",
        targetKind: "files",
      }),
      maxTargets: 1,
    });

    expect(result.targets).toHaveLength(1);
    expect(result.totalCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("returns a warning instead of expanding incomplete path segment scans", async () => {
    const root = await createTempRoot();

    const result = await scanRenameTargets({
      options: buildOptions({
        roots: [root],
        scope: "path_segments",
        targetKind: "both",
      }),
    });

    expect(result.targets).toHaveLength(0);
    expect(result.warnings[0]).toContain("path_segments scope requires");
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fusionkit-rename-"));
  tempRoots.push(root);
  return root;
}

async function createRenameTree(): Promise<string> {
  const root = await createTempRoot();

  await fs.writeFile(path.join(root, "第01話.srt"), "subtitle");
  await fs.writeFile(path.join(root, ".hidden.srt"), "hidden");
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, ".git", "config"), "config");
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules", "pkg.js"), "pkg");
  await fs.mkdir(path.join(root, "Season 01", "Nested"), {
    recursive: true,
  });
  await fs.writeFile(path.join(root, "Season 01", "第02話.srt"), "subtitle");
  await fs.writeFile(
    path.join(root, "Season 01", "Nested", "第03話.srt"),
    "subtitle"
  );

  return root;
}

function buildOptions(
  overrides: Partial<NameTranslationOptions> & { roots: string[] }
): NameTranslationOptions {
  return {
    ...DEFAULT_NAME_TRANSLATION_OPTIONS,
    roots: overrides.roots,
    ...overrides,
  };
}
