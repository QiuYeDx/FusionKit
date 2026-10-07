import { describe, expect, it, vi } from "vitest";
import type { NameEntry } from "@/name-translation/contract";
import {
  cleanTranslatedStem,
  composeName,
  bilingualTemplate,
  getNameIssue,
  getTemplateError,
  legacyFormatTemplate,
  numberName,
  splitName,
  translatableStem,
} from "@/name-translation/naming-rules";
import { createBatches, translateTargets } from "./translate";
import {
  EMPTY_SELECTION,
  actionTargets,
  clickSelection,
  marqueeSelection,
  moveSelection,
  pruneSelection,
  rangeKeys,
  rowsInBand,
} from "./selection";
import {
  computeRowStates,
  computeVisibleRows,
  remapPath,
  suggestNumberedNames,
  type WorkspaceData,
} from "./workspace";
import {
  migrateNameTranslatorConfig,
  resolveNameTemplate,
  sanitizeNameTranslatorConfig,
} from "@/store/tools/rename/nameTranslatorConfig";

function entry(path: string, kind: NameEntry["kind"] = "file"): NameEntry {
  const index = path.lastIndexOf("/");
  return {
    path,
    name: path.slice(index + 1),
    parentPath: path.slice(0, index),
    kind,
    hidden: false,
    symlink: false,
    identity: `1:${path.length}`,
  };
}

describe("naming rules", () => {
  it("splits extensions without treating sentence dots as extensions", () => {
    expect(splitName("第1話.mp4", "file")).toEqual({ stem: "第1話", extension: ".mp4" });
    expect(splitName("backup.tar.gz", "file")).toEqual({ stem: "backup", extension: ".tar.gz" });
    expect(splitName("Mr. Smith notes", "file")).toEqual({ stem: "Mr. Smith notes", extension: "" });
    expect(splitName(".env", "file")).toEqual({ stem: ".env", extension: "" });
    expect(splitName("v1.2 资料", "directory")).toEqual({ stem: "v1.2 资料", extension: "" });
    expect(translatableStem(".設定.json", "file")).toBe("設定");
  });

  it("composes templates, keeps extensions and never duplicates identical names", () => {
    const base = { originalName: "第1話.mp4", kind: "file" as const, translatedStem: "第1集" };
    expect(composeName({ ...base, template: "{translated}" })).toBe("第1集.mp4");
    expect(composeName({ ...base, template: bilingualTemplate("paren", "translated_first") })).toBe("第1集 (第1話).mp4");
    expect(composeName({ ...base, template: bilingualTemplate("dash", "original_first") })).toBe("第1話 - 第1集.mp4");
    expect(composeName({ ...base, template: bilingualTemplate("underscore", "translated_first") })).toBe("第1集_第1話.mp4");
    expect(composeName({ ...base, template: "[{original}] {translated} - 字幕组" })).toBe("[第1話] 第1集 - 字幕组.mp4");
    expect(composeName({ ...base, translatedStem: "第1話", template: "{translated} ({original})" })).toBe("第1話.mp4");
    // An invalid template never produces a name without the translation.
    expect(composeName({ ...base, template: "{original}" })).toBe("第1集.mp4");
    expect(composeName({ originalName: ".設定", kind: "file", translatedStem: "settings", template: "{translated}" })).toBe(".settings");
  });

  it("validates custom templates and maps legacy presets", () => {
    expect(getTemplateError("{original} x")).toBe("missing_translated");
    expect(getTemplateError("{translated}: {original}")).toBe("illegal_chars");
    expect(getTemplateError(`{translated}${"x".repeat(200)}`)).toBe("too_long");
    expect(getTemplateError("【{original}】{translated}")).toBeNull();
    expect(legacyFormatTemplate("original_translated")).toBe("{original} ({translated})");
  });

  it("maps illegal characters naturally for the target language", () => {
    expect(cleanTranslatedStem("Part 1: Intro?", "EN")).toBe("Part 1 - Intro");
    expect(cleanTranslatedStem("第一部：序章？", "ZH")).toBe("第一部：序章？");
    expect(cleanTranslatedStem("A/B: C", "JA")).toBe("A／B： C");
    expect(cleanTranslatedStem("  name.\n", "EN")).toBe("name");
  });

  it("reports invalid names", () => {
    expect(getNameIssue("")).toBe("empty_name");
    expect(getNameIssue("a:b")).toBe("illegal_chars");
    expect(getNameIssue("nul.txt")).toBe("reserved_name");
    expect(getNameIssue("end.")).toBe("trailing_dot_space");
    expect(getNameIssue("字".repeat(90))).toBe("too_long");
    expect(getNameIssue("ok.txt")).toBeNull();
  });

  it("numbers duplicates before the extension", () => {
    const taken = new Set(["a.txt"]);
    expect(numberName("A.txt", "file", taken, "win32")).toBe("A (2).txt");
    expect(numberName("A.txt", "file", taken, "win32")).toBe("A (3).txt");
  });
});

describe("workspace derivations", () => {
  const settings = { template: "{translated}", settingsKey: "k", platform: "win32" };

  function workspace(): WorkspaceData {
    const root = entry("C:/data/アニメ", "directory");
    const children = [entry("C:/data/アニメ/第1話.mp4"), entry("C:/data/アニメ/第１話.mp4"), entry("C:/data/アニメ/表紙.jpg"), entry("C:/data/アニメ/Cover.jpg")];
    return {
      roots: [root.path],
      entries: Object.fromEntries([root, ...children].map((item) => [item.path, item])),
      dirs: { [root.path]: { status: "loaded", children: children.map((item) => item.path), truncated: false } },
      checked: Object.fromEntries([root.path, children[0]!.path, children[1]!.path, children[2]!.path].map((key) => [key, true as const])),
      proposals: {
        [root.path]: { stem: "Anime", settingsKey: "k" },
        [children[0]!.path]: { stem: "Episode 1", settingsKey: "k" },
        [children[1]!.path]: { stem: "Episode 1", settingsKey: "k" },
        [children[2]!.path]: { stem: "cover", settingsKey: "k" },
      },
      serverIssues: {},
    };
  }

  it("detects duplicate targets and collisions with entries that stay", () => {
    const data = workspace();
    const states = computeRowStates(data, settings);
    expect(states.get("C:/data/アニメ")?.status).toBe("ready");
    expect(states.get("C:/data/アニメ/第1話.mp4")?.issue).toBe("duplicate_target");
    expect(states.get("C:/data/アニメ/第１話.mp4")?.issue).toBe("duplicate_target");
    // "cover.jpg" collides case-insensitively with the unselected "Cover.jpg".
    expect(states.get("C:/data/アニメ/表紙.jpg")?.issue).toBe("target_exists");

    const numbered = suggestNumberedNames(data, states, "win32");
    expect([...numbered.values()]).toEqual(["Episode 1.mp4", "Episode 1 (2).mp4"]);
  });

  it("marks stale, pending, failed and edited rows", () => {
    const data = workspace();
    const states = computeRowStates(
      {
        ...data,
        proposals: {
          ...data.proposals,
          "C:/data/アニメ": { stem: "Anime", settingsKey: "old" },
          "C:/data/アニメ/第1話.mp4": { failed: true },
          "C:/data/アニメ/表紙.jpg": { edited: "Cover art.jpg" },
          "C:/data/アニメ/第１話.mp4": {},
        },
      },
      settings,
    );
    expect(states.get("C:/data/アニメ")?.status).toBe("stale");
    expect(states.get("C:/data/アニメ/第1話.mp4")?.status).toBe("failed");
    expect(states.get("C:/data/アニメ/第１話.mp4")?.status).toBe("pending");
    expect(states.get("C:/data/アニメ/表紙.jpg")).toMatchObject({ status: "ready", edited: true, proposedName: "Cover art.jpg" });
  });

  it("lists rows through expanded folders and filters with ancestors", () => {
    const data = workspace();
    const states = computeRowStates(data, settings);
    const all = computeVisibleRows(data, { "C:/data/アニメ": true }, states, "all");
    expect(all.map((row) => row.depth)).toEqual([0, 1, 1, 1, 1]);
    expect(all[0]).toMatchObject({ expandable: true, checkedInside: 3, loadedInside: 4 });
    const issues = computeVisibleRows(data, { "C:/data/アニメ": true }, states, "issues");
    expect(issues.map((row) => row.key)).toEqual([
      "C:/data/アニメ",
      "C:/data/アニメ/第1話.mp4",
      "C:/data/アニメ/第１話.mp4",
      "C:/data/アニメ/表紙.jpg",
    ]);
  });

  it("remaps paths through the deepest renamed ancestor", () => {
    const renamed = [
      { from: "C:\\data\\アニメ", to: "C:\\data\\Anime" },
      { from: "C:\\data\\アニメ\\第1期", to: "C:\\data\\Anime\\Season 1" },
    ];
    expect(remapPath("C:\\data\\アニメ\\第1期\\x.mp4", renamed, "win32")).toBe("C:\\data\\Anime\\Season 1\\x.mp4");
    expect(remapPath("C:\\data\\アニメ\\表紙.jpg", renamed, "win32")).toBe("C:\\data\\Anime\\表紙.jpg");
    expect(remapPath("C:\\data\\アニメ2", renamed, "win32")).toBe("C:\\data\\アニメ2");
  });
});

describe("translation orchestration", () => {
  const model = { apiKey: "k", modelKey: "m", endpoint: "https://example.invalid" };

  it("groups siblings into bounded batches", () => {
    const targets = ["a", "b", "c"].map((name) => ({ key: `/x/${name}`, name, kind: "file" as const, parentPath: "/x" }));
    targets.push({ key: "/y/d", name: "d", kind: "file", parentPath: "/y" });
    expect(createBatches(targets, 2, 100).map((batch) => batch.map((item) => item.name))).toEqual([["a", "b"], ["c"], ["d"]]);
  });

  it("skips names without letters, retries missing ids in smaller batches and reports failures", async () => {
    const results = new Map<string, string | null>();
    const errors: string[] = [];
    const translateBatch = vi.fn(async (request: { items: { id: string; name: string }[] }) => ({
      ok: true as const,
      data: {
        items: request.items.filter((item) => item.name !== "壊れた").map((item) => ({ id: item.id, name: `T_${item.name}` })),
        failedIds: [],
      },
    }));
    const outcome = await translateTargets({
      targets: [
        { key: "1", name: "2024-01-01.txt", kind: "file", parentPath: "/a" },
        { key: "2", name: "名前.txt", kind: "file", parentPath: "/a" },
        { key: "3", name: "壊れた.txt", kind: "file", parentPath: "/a" },
      ],
      settings: { model, sourceLang: "auto", targetLang: "EN" },
      requestId: "r",
      translateBatch,
      isCancelled: () => false,
      onResult: (key, stem) => results.set(key, stem),
      onBatchError: (error) => errors.push(error.code),
    });
    expect(outcome).toEqual({ cancelled: false });
    expect(results.get("1")).toBe("2024-01-01");
    expect(results.get("2")).toBe("T_名前");
    expect(results.get("3")).toBeNull();
    // Full batch, then a smaller batch, then the name alone: three attempts before giving up.
    expect(translateBatch).toHaveBeenCalledTimes(3);
    expect(errors).toEqual(["model_incomplete"]);
  });

  it("shrinks batches on retry so a name the model drops succeeds alone", async () => {
    const results = new Map<string, string | null>();
    const errors: string[] = [];
    const translateBatch = vi.fn(async (request: { items: { id: string; name: string }[] }) => ({
      ok: true as const,
      data: {
        // The model drops "気まぐれ" unless it is the only name in the request.
        items: request.items
          .filter((item) => item.name !== "気まぐれ" || request.items.length === 1)
          .map((item) => ({ id: item.id, name: `T_${item.name}` })),
        failedIds: [],
      },
    }));
    await translateTargets({
      targets: ["一", "二", "気まぐれ"].map((name) => ({ key: name, name, kind: "file" as const, parentPath: "/a" })),
      settings: { model, sourceLang: "auto", targetLang: "EN" },
      requestId: "r",
      translateBatch,
      isCancelled: () => false,
      onResult: (key, stem) => results.set(key, stem),
      onBatchError: (error) => errors.push(error.code),
    });
    expect(results.get("気まぐれ")).toBe("T_気まぐれ");
    expect(errors).toEqual([]);
    expect(translateBatch.mock.calls.map((call) => call[0].items.length)).toEqual([3, 1]);
  });

  it("retries a batch that failed with a non-fatal error and reports the reason", async () => {
    const results = new Map<string, string | null>();
    const errors: string[] = [];
    const translateBatch = vi.fn(async () => ({
      ok: false as const,
      error: { code: "model_failed" as const, message: "HTTP 500" },
    }));
    await translateTargets({
      targets: [{ key: "1", name: "名前", kind: "file", parentPath: "/a" }],
      settings: { model, sourceLang: "auto", targetLang: "EN" },
      requestId: "r",
      translateBatch,
      isCancelled: () => false,
      onResult: (key, stem) => results.set(key, stem),
      onBatchError: (error) => errors.push(error.message),
    });
    expect(results.get("1")).toBeNull();
    expect(translateBatch).toHaveBeenCalledTimes(3);
    expect(errors).toEqual(["HTTP 500"]);
  });

  it("stops on fatal model errors", async () => {
    const outcome = await translateTargets({
      targets: [{ key: "1", name: "名前", kind: "file", parentPath: "/a" }],
      settings: { model, sourceLang: "auto", targetLang: "EN" },
      requestId: "r",
      translateBatch: async () => ({ ok: false as const, error: { code: "model_auth" as const, message: "401" } }),
      isCancelled: () => false,
      onResult: () => undefined,
    });
    expect(outcome.fatal?.code).toBe("model_auth");
  });
});

describe("name translator config", () => {
  it("migrates v1 options and v2 formats and sanitizes values", () => {
    expect(
      migrateNameTranslatorConfig(
        { options: { targetLang: "EN", sourceLang: "JA", outputMode: "bilingual_target_first", includeHidden: true, scope: "children" } },
        1,
      ),
    ).toMatchObject({ sourceLang: "JA", targetLang: "EN", nameMode: "bilingual", bilingualOrder: "translated_first", bilingualStyle: "paren", includeHidden: true });
    const v2 = migrateNameTranslatorConfig({ config: { targetLang: "KO", format: "original_translated", instructions: "x" } }, 2);
    expect(v2).toMatchObject({ targetLang: "KO", nameMode: "bilingual", bilingualOrder: "original_first", instructions: "x" });
    expect(resolveNameTemplate(v2)).toBe("{original} ({translated})");
    expect(sanitizeNameTranslatorConfig({ targetLang: "XX", nameMode: "nope", instructions: 3 })).toMatchObject({
      targetLang: "ZH",
      nameMode: "translated",
      instructions: "",
    });
  });
});

describe("row selection", () => {
  const order = ["a", "b", "c", "d", "e"];
  const keys = (selection: { keys: ReadonlySet<string> }) => [...selection.keys].sort();

  it("selects one row, toggles with Ctrl and extends ranges with Shift", () => {
    const one = clickSelection(EMPTY_SELECTION, order, "b", { toggle: false, range: false });
    expect(keys(one)).toEqual(["b"]);
    const toggled = clickSelection(one, order, "d", { toggle: true, range: false });
    expect(keys(toggled)).toEqual(["b", "d"]);
    expect(keys(clickSelection(toggled, order, "b", { toggle: true, range: false }))).toEqual(["d"]);
    // The range starts at the last clicked row and replaces the selection.
    const range = clickSelection(toggled, order, "a", { toggle: false, range: true });
    expect(keys(range)).toEqual(["a", "b", "c", "d"]);
    expect(range.anchor).toBe("d");
    // Ctrl+Shift adds the range to the existing selection.
    const added = clickSelection(clickSelection(one, order, "e", { toggle: true, range: false }), order, "d", { toggle: true, range: true });
    expect(keys(added)).toEqual(["b", "d", "e"]);
    expect(rangeKeys(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeKeys(order, "x", "b")).toEqual([]);
  });

  it("maps a marquee band to rows, including rows outside the rendered window", () => {
    expect(rowsInBand(40, 10, 34, 5)).toEqual([0, 1]);
    expect(rowsInBand(-50, 500, 34, 5)).toEqual([0, 4]);
    expect(rowsInBand(200, 260, 34, 5)).toBeNull();
    const base = new Set(["a", "c"]);
    expect(keys(marqueeSelection(base, order, [1, 2], "replace"))).toEqual(["b", "c"]);
    expect(keys(marqueeSelection(base, order, [1, 2], "add"))).toEqual(["a", "b", "c"]);
    expect(keys(marqueeSelection(base, order, [1, 2], "toggle"))).toEqual(["a", "b"]);
    expect(keys(marqueeSelection(base, order, null, "replace"))).toEqual([]);
  });

  it("moves with the keyboard, prunes hidden rows and resolves action targets", () => {
    const start = moveSelection(EMPTY_SELECTION, order, 1, false);
    expect(keys(start)).toEqual(["a"]);
    const extended = moveSelection(moveSelection(start, order, 1, true), order, 1, true);
    expect(keys(extended)).toEqual(["a", "b", "c"]);
    expect(moveSelection(extended, order, "last", false).lead).toBe("e");
    expect(moveSelection(extended, order, 99, false).lead).toBe("e");

    const pruned = pruneSelection(extended, ["a", "c", "d"]);
    expect(keys(pruned)).toEqual(["a", "c"]);
    expect(pruned.lead).toBe("c");
    expect(pruneSelection(pruned, ["a", "c", "d"])).toBe(pruned);

    expect(actionTargets(extended, order, "b")).toEqual(["a", "b", "c"]);
    expect(actionTargets(extended, order, "e")).toEqual(["e"]);
  });
});
