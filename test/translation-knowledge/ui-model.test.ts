import { describe, expect, it } from "vitest";
import type { LibrarySnapshot } from "../../src/translation-knowledge/ipc-contract";
import type { Collection, Entry } from "../../src/translation-knowledge/schemas";
import { validatePackage } from "../../src/translation-knowledge/validation";
import { acceptsKnowledgeDrop, defaultCollectionId, matchesQuery, moveTargets, newCollection, newNote, newTerm, notesOf, orderedCollections, presetsUsing, searchLibrary, termClash, termsOf } from "../../src/pages/TranslationKnowledge/model";
import { classifyPaste } from "../../src/pages/TranslationKnowledge/term-paste";
import { knowledgeFixture } from "./fixtures";

const ja = { source: "ja", target: "zh-Hans" };
function library(): LibrarySnapshot {
  const zzz = newCollection("绝区零", ja), streamer = newCollection("主播 A", ja), english = newCollection("Zenless", { source: "en", target: "zh-Hans" }), old = { ...newCollection("旧资料", ja), archived: true };
  const entries: Entry[] = [
    newTerm(zzz.id, "セーブポイント", "存档点", "required"), newTerm(zzz.id, "ホロウ", "空洞"),
    { ...newTerm(zzz.id, "ボス", "首领"), enabled: false },
    newNote(zzz.id, "rule", "称呼保留敬称\n不要意译人名", true), newNote(zzz.id, "context", "游戏中的存档会自动进行", false),
    newTerm(streamer.id, "存档", "存档"), newTerm(old.id, "セーブ", "存档"),
  ];
  const data = { ...knowledgeFixture(), collections: [zzz, streamer, english, old], entries,
    presets: [{ id: crypto.randomUUID(), revision: 1, name: "全套", languagePair: ja, collectionIds: [zzz.id, streamer.id], instructions: "", context: "" }] };
  return { generation: 3, data };
}

describe("translation materials page model", () => {
  it("creates records the library accepts, enabled and marked as typed by hand", () => {
    const snapshot = library();
    expect(validatePackage(snapshot.data).errors).toEqual([]);
    const [zzz] = snapshot.data.collections;
    expect(newTerm(zzz.id, " ホロウ ", " 空洞 ")).toMatchObject({ enabled: true, origin: { kind: "manual" }, payload: { source: "ホロウ", target: "空洞", strength: "preferred", aliases: [], note: "" } });
    expect(newTerm(zzz.id, "ZZZ", "", "keep_source").payload.target).toBe("ZZZ");
    expect(newNote(zzz.id, "rule", " 保留敬称 ", true)).toMatchObject({ kind: "rule", enabled: true, payload: { text: "保留敬称", required: true } });
  });

  it("lists a collection's terms and notes, narrowed by every word of the query", () => {
    const snapshot = library();
    const [zzz] = snapshot.data.collections;
    expect(termsOf(snapshot, zzz.id).map(entry => entry.payload.source)).toEqual(["セーブポイント", "ホロウ", "ボス"]);
    expect(termsOf(snapshot, zzz.id, "存档").map(entry => entry.payload.source)).toEqual(["セーブポイント"]);
    expect(notesOf(snapshot, zzz.id, "rule", "敬称 人名")).toHaveLength(1);
    expect(notesOf(snapshot, zzz.id, "rule", "敬称 背景")).toHaveLength(0);
    expect(matchesQuery("Save Point", "save  POINT")).toBe(true);
  });

  it("searches every collection and groups the matches by collection, live ones first", () => {
    const snapshot = library();
    const result = searchLibrary(snapshot, "存档");
    expect(result.total).toBe(4);
    const live = ["主播 A", "绝区零"].sort((a, b) => a.localeCompare(b));
    expect(result.groups.map(group => [group.collection.name, group.entries.length])).toEqual([...live.map(name => [name, name === "绝区零" ? 2 : 1]), ["旧资料", 1]]);
    expect(searchLibrary(snapshot, "存档", 2).groups.flatMap(group => group.entries)).toHaveLength(2);
    expect(searchLibrary(snapshot, "  ")).toEqual({ groups: [], total: 0 });
  });

  it("opens the requested collection, else the first live one, and knows where entries may move", () => {
    const snapshot = library();
    const [zzz, streamer, english, old] = snapshot.data.collections as Collection[];
    // Live collections by name in the interface locale, archived ones last.
    const live = ["Zenless", "主播 A", "绝区零"].sort((a, b) => a.localeCompare(b));
    expect(orderedCollections(snapshot).map(item => item.name)).toEqual([...live, "旧资料"]);
    const first = snapshot.data.collections.find(item => item.name === live[0])!;
    expect(defaultCollectionId(snapshot)).toBe(first.id);
    expect(defaultCollectionId(snapshot, old.id)).toBe(old.id);
    expect(defaultCollectionId(snapshot, "missing")).toBe(first.id);
    expect(defaultCollectionId({ ...snapshot, data: { ...snapshot.data, collections: [] } })).toBeUndefined();
    // Same direction and not archived.
    expect(moveTargets(snapshot, zzz).map(item => item.id)).toEqual([streamer.id]);
    expect(presetsUsing(snapshot, streamer.id)).toHaveLength(1);
    expect(presetsUsing(snapshot, english.id)).toHaveLength(0);
  });

  it("tells a repeated wording from another translation of the same source, aliases included", () => {
    const snapshot = library();
    const [zzz] = snapshot.data.collections;
    expect(termClash(snapshot, zzz.id, "ホロウ", "空洞")).toBe("same");
    expect(termClash(snapshot, zzz.id, " ホロウ ", "虚空")).toBe("different");
    expect(termClash(snapshot, zzz.id, "エーテル", "以太")).toBeNull();
    const hollow = termsOf(snapshot, zzz.id, "ホロウ")[0];
    expect(termClash(snapshot, zzz.id, "ホロウ", "虚空", hollow.id)).toBeNull();
  });

  it("classifies pasted rows before anything is written", () => {
    const snapshot = library();
    const [zzz] = snapshot.data.collections;
    const rows = [{ source: "ホロウ", target: "空洞", note: "" }, { source: "ボス", target: "BOSS", note: "" }, { source: "エーテル", target: "以太", note: "" },
      { source: "エーテル", target: "乙太", note: "" }, { source: "", target: "x", note: "" }];
    expect(classifyPaste(snapshot.data.entries, zzz.id, rows).map(item => item.status)).toEqual(["same", "conflict", "new", "repeated", "invalid"]);
    expect(classifyPaste(snapshot.data.entries, zzz.id, rows)[1].existing?.payload.target).toBe("首领");
  });

  it("accepts exactly one knowledge file dropped on the page", () => {
    expect(acceptsKnowledgeDrop([{ name: "pack.FKTK.json" }])).toBe(true);
    expect(acceptsKnowledgeDrop([{ name: "pack.json" }])).toBe(false);
    expect(acceptsKnowledgeDrop([{ name: "a.fktk.json" }, { name: "b.fktk.json" }])).toBe(false);
  });
});
