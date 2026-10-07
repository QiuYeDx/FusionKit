import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NameRenameItem } from "../../src/name-translation/contract";
import { applyRenames, undoJournal } from "../../electron/main/name-translation/executor";
import { identityOf, readEntry, type PlatformContext } from "../../electron/main/name-translation/fs-listing";
import { NameJournalStore, parseJournal } from "../../electron/main/name-translation/journal";
import { planRename } from "../../electron/main/name-translation/planner";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fk-name-"));
  roots.push(root);
  const data = path.join(root, "data");
  await fs.mkdir(data);
  const context: PlatformContext = {
    platform: process.platform,
    homeDir: path.join(root, "home"),
    tempDir: path.join(root, "unused-temp"),
    env: {},
  };
  const journals = new NameJournalStore(path.join(root, "journals"));
  return { data, context, journals };
}

async function item(target: string, newName: string): Promise<NameRenameItem> {
  const stat = await fs.lstat(target, { bigint: true });
  return {
    path: target,
    kind: stat.isDirectory() ? "directory" : "file",
    identity: identityOf(stat),
    newName,
  };
}

async function tree(directory: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (current: string, prefix: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result.push(`${relative}/`);
        await walk(path.join(current, entry.name), relative);
      } else {
        result.push(`${relative}=${await fs.readFile(path.join(current, entry.name), "utf8")}`);
      }
    }
  };
  await walk(directory, "");
  return result.sort();
}

describe("name translation executor", () => {
  it("renames a folder together with its nested files and folders", async () => {
    const { data, context, journals } = await workspace();
    const anime = path.join(data, "アニメ");
    const season = path.join(anime, "第1期");
    await fs.mkdir(season, { recursive: true });
    await fs.writeFile(path.join(season, "第1話.mp4"), "ep1");
    await fs.writeFile(path.join(anime, "表紙.jpg"), "cover");

    const items = [
      await item(path.join(season, "第1話.mp4"), "Episode 1.mp4"),
      await item(anime, "Anime"),
      await item(path.join(anime, "表紙.jpg"), "Cover.jpg"),
      await item(season, "Season 1"),
    ];
    const result = await applyRenames(items, { journals, context });

    expect(result.status).toBe("completed");
    expect(await tree(data)).toEqual([
      "Anime/",
      "Anime/Cover.jpg=cover",
      "Anime/Season 1/",
      "Anime/Season 1/Episode 1.mp4=ep1",
    ].sort());
    if (result.status !== "completed") return;
    const finals = Object.fromEntries(result.renamed.map((entry) => [entry.from, entry.to]));
    expect(finals[path.join(season, "第1話.mp4")]).toBe(path.join(data, "Anime", "Season 1", "Episode 1.mp4"));
    expect(finals[season]).toBe(path.join(data, "Anime", "Season 1"));

    const undo = await undoJournal(result.journalId, { journals, context });
    expect(undo).toMatchObject({ status: "completed", restoredCount: 4 });
    expect(await tree(data)).toEqual([
      "アニメ/",
      "アニメ/第1期/",
      "アニメ/第1期/第1話.mp4=ep1",
      "アニメ/表紙.jpg=cover",
    ].sort());
  });

  it("handles swaps, chains and case-only renames through temporary names", async () => {
    const { data, context, journals } = await workspace();
    for (const name of ["a.txt", "b.txt", "c.txt", "readme.md"]) {
      await fs.writeFile(path.join(data, name), name);
    }
    const result = await applyRenames(
      [
        await item(path.join(data, "a.txt"), "b.txt"),
        await item(path.join(data, "b.txt"), "a.txt"),
        await item(path.join(data, "c.txt"), "d.txt"),
        await item(path.join(data, "readme.md"), "README.md"),
      ],
      { journals, context },
    );
    expect(result.status).toBe("completed");
    expect(await tree(data)).toEqual(["a.txt=b.txt", "b.txt=a.txt", "d.txt=c.txt", "README.md=readme.md"].sort());
    const names = await fs.readdir(data);
    expect(names.some((name) => name.startsWith(".fk-rename-"))).toBe(false);
  });

  it("rejects conflicts with entries that stay in place and duplicate targets", async () => {
    const { data, context, journals } = await workspace();
    for (const name of ["one.txt", "two.txt", "keep.txt"]) {
      await fs.writeFile(path.join(data, name), name);
    }
    const plan = await planRename(
      [
        await item(path.join(data, "one.txt"), "keep.txt"),
        await item(path.join(data, "two.txt"), "same.txt"),
      ],
      { context },
    );
    expect(plan.preflight.items.map((entry) => entry.issue ?? entry.status)).toEqual(["target_exists", "ready"]);

    const duplicate = await applyRenames(
      [
        await item(path.join(data, "one.txt"), "same.txt"),
        await item(path.join(data, "two.txt"), "SAME.txt"),
      ],
      { journals, context },
    );
    if (context.platform === "win32" || context.platform === "darwin") {
      expect(duplicate.status).toBe("rejected");
    }
    expect(await fs.readdir(data)).toEqual(expect.arrayContaining(["one.txt", "two.txt", "keep.txt"]));
  });

  it("reports invalid names, replaced sources and protected paths", async () => {
    const { data, context } = await workspace();
    const files = ["x.txt", "y.txt", "z.txt"].map((name) => path.join(data, name));
    for (const file of files) await fs.writeFile(file, "x");
    const valid = await item(files[0]!, "ok.txt");
    const plan = await planRename(
      [
        { ...valid, newName: "bad:name.txt" },
        { ...valid, path: path.join(data, "missing.txt") },
        { ...(await item(files[1]!, "ok.txt")), identity: "0:1" },
        { ...valid, path: path.parse(data).root, kind: "directory" },
        { ...valid, newName: "CON.txt" },
        await item(files[2]!, "trailing. "),
      ],
      { context },
    );
    expect(plan.preflight.items.map((entry) => entry.issue ?? entry.status)).toEqual([
      "illegal_chars",
      "source_missing",
      "source_changed",
      "protected_path",
      "duplicate_source",
      "trailing_dot_space",
    ]);
    const reserved = await planRename([{ ...valid, newName: "CON.txt" }], { context });
    expect(reserved.preflight.items[0]?.issue).toBe("reserved_name");
    const unchanged = await planRename([{ ...valid, newName: "x.txt" }], { context });
    expect(unchanged.preflight.items[0]?.status).toBe("unchanged");
  });

  it("rolls back every completed step when a later rename fails", async () => {
    const { data, context, journals } = await workspace();
    const folder = path.join(data, "フォルダ");
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "一.txt"), "1");
    await fs.writeFile(path.join(folder, "二.txt"), "2");
    const items = [
      await item(path.join(folder, "一.txt"), "One.txt"),
      await item(path.join(folder, "二.txt"), "Two.txt"),
      await item(folder, "Folder"),
    ];
    let calls = 0;
    const result = await applyRenames(items, {
      journals,
      context,
      retryDelayMs: 1,
      rename: async (from, to) => {
        calls += 1;
        // Fail the folder rename, after both children were renamed.
        if (path.basename(to) === "Folder") {
          throw Object.assign(new Error("locked"), { code: "EBUSY" });
        }
        await fs.rename(from, to);
      },
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.rollback).toBe("complete");
    expect(result.failedPath).toBe(folder);
    expect(calls).toBeGreaterThan(3);
    expect(await tree(data)).toEqual(["フォルダ/", "フォルダ/一.txt=1", "フォルダ/二.txt=2"].sort());
    const record = await journals.read(result.journalId!);
    expect(record?.status).toBe("rolled_back");
  });

  it("never overwrites a target that appears after validation", async () => {
    const { data, context, journals } = await workspace();
    await fs.writeFile(path.join(data, "src.txt"), "source");
    const items = [await item(path.join(data, "src.txt"), "dst.txt")];
    let raced = false;
    const result = await applyRenames(items, {
      journals,
      context,
      exists: async (target) => {
        if (!raced && path.basename(target) === "dst.txt") {
          raced = true;
          await fs.writeFile(target, "someone else");
        }
        try {
          await fs.lstat(target);
          return true;
        } catch {
          return false;
        }
      },
    });
    expect(result.status).toBe("failed");
    expect(await fs.readFile(path.join(data, "dst.txt"), "utf8")).toBe("someone else");
    expect(await fs.readFile(path.join(data, "src.txt"), "utf8")).toBe("source");
  });

  it("resumes an interrupted undo and tolerates a truncated journal line", async () => {
    const { data, context, journals } = await workspace();
    await fs.writeFile(path.join(data, "a.txt"), "a");
    await fs.writeFile(path.join(data, "b.txt"), "b");
    const result = await applyRenames(
      [await item(path.join(data, "a.txt"), "A1.txt"), await item(path.join(data, "b.txt"), "B1.txt")],
      { journals, context },
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;

    // Block restoring b.txt once, then retry.
    await fs.writeFile(path.join(data, "b.txt"), "blocker");
    const partial = await undoJournal(result.journalId, { journals, context });
    expect(partial?.status).toBe("partial");
    await fs.rm(path.join(data, "b.txt"));
    const resumed = await undoJournal(result.journalId, { journals, context });
    expect(resumed?.status).toBe("completed");
    expect(await tree(data)).toEqual(["a.txt=a", "b.txt=b"].sort());

    const file = path.join(path.dirname(data), "journals", `${result.journalId}.jsonl`);
    const content = await fs.readFile(file, "utf8");
    const parsed = parseJournal(result.journalId, `${content}{"t":"step","seq":9,"fr`);
    expect(parsed?.status).toBe("undone");
    expect(parsed?.steps).toHaveLength(2);
  });

  it("reads entries with stable identities", async () => {
    const { data, context } = await workspace();
    await fs.writeFile(path.join(data, ".hidden"), "");
    const entry = await readEntry(path.join(data, ".hidden"), context);
    expect(entry).toMatchObject({ name: ".hidden", kind: "file", hidden: true, symlink: false });
    expect(entry?.identity).toMatch(/^\d+:\d+$/);
  });
});
