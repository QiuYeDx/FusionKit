import { describe, expect, it } from "vitest";
import type {
  ImportItem,
  LibrarySnapshot,
} from "../../src/translation-knowledge/ipc-contract";
import {
  defaultImportDecisions,
  entryStatus,
  filterEntries,
  importActions,
  initialQuery,
  needsReview,
  recordFields,
} from "../../src/pages/TranslationKnowledge/model";
import { knowledgeFixture } from "./fixtures";
const snapshot = (): LibrarySnapshot => ({
  generation: 1,
  data: knowledgeFixture(),
  approvals: {},
  imports: [],
});

describe("translation material interaction model", () => {
  it("keeps external ready entries in review until the current revision is approved", () => {
    const state = snapshot();
    const entry = state.data.entries[0];
    entry.state = "ready";
    expect(entryStatus(entry, state)).toBe("unconfirmed");
    expect(needsReview(entry, state)).toBe(true);
    state.approvals[entry.id] = {
      revision: entry.revision,
      digest: "0".repeat(64),
      approvedAt: new Date().toISOString(),
      method: "human",
    };
    expect(entryStatus(entry, state)).toBe("ready");
    entry.revision++;
    expect(entryStatus(entry, state)).toBe("unconfirmed");
    entry.state = "archived";
    expect(needsReview(entry, state)).toBe(false);
  });
  it("browses entry and collection associations without inventing speaker scope", () => {
    const state = snapshot();
    const entry = state.data.entries[0];
    const subject = state.data.subjects[0];
    state.data.entries = [entry];
    entry.aboutSubjectIds = [];
    state.data.collections.find(
      (item) => item.id === entry.collectionId,
    )!.aboutSubjectIds = [subject.id];
    const scope = structuredClone(entry.scope);
    expect(
      filterEntries(state, { ...initialQuery, subject: subject.id }, false),
    ).toEqual([entry]);
    expect(
      filterEntries(state, { ...initialQuery, subject: "none" }, false),
    ).toEqual([]);
    expect(entry.scope).toEqual(scope);
  });
  it("combines content search with status filtering and the review view", () => {
    const state = snapshot();
    const entry = state.data.entries.find((item) => item.kind === "term")!;
    state.data.entries = [entry];
    entry.state = "ready";
    entry.title = "資料 café";
    expect(
      filterEntries(
        state,
        { ...initialQuery, search: " CAFE\u0301 ", status: "unconfirmed" },
        true,
      ),
    ).toEqual([entry]);
    expect(
      filterEntries(state, { ...initialQuery, status: "ready" }, false),
    ).toEqual([]);
    expect(
      filterEntries(state, { ...initialQuery, kind: "context" }, true),
    ).toEqual([]);
  });
  it("imports new identities while preserving conflicts and forbidding same-revision replacement", () => {
    const entry = snapshot().data.entries[0];
    const item: ImportItem = {
      id: entry.id,
      title: entry.title,
      group: "entries",
      incoming: entry,
      status: "new",
      sameRevision: false,
    };
    expect(defaultImportDecisions([item])[0].action).toBe("replace");
    expect(importActions(item)).toEqual(["replace", "skip"]);
    const conflict = {
      ...item,
      status: "conflict" as const,
      sameRevision: true,
      local: entry,
    };
    expect(defaultImportDecisions([conflict])[0].action).toBe("keep");
    expect(importActions(conflict)).not.toContain("replace");
    expect(importActions({ ...conflict, sameRevision: false })).toContain(
      "replace",
    );
  });
  it("keeps missing, added and nested fields visible for conflict comparison", () => {
    expect(
      recordFields({
        scope: { requiredSubjects: [{ role: "topic" }] },
        aliases: [],
        title: "abc",
      }),
    ).toEqual({
      "scope.requiredSubjects.1.role": "topic",
      aliases: "—",
      title: "abc",
    });
  });
});

describe("new entry defaults", () => {
  it("materializes collection language and subjects while keeping person scope unconfirmed", async () => {
    const { newEntry } = await import(
      "../../src/pages/TranslationKnowledge/model"
    );
    const state = snapshot();
    const person = state.data.subjects.find((item) => item.kind === "person")!;
    const work = state.data.subjects.find((item) => item.kind === "work")!;
    const collection = {
      ...state.data.collections[0],
      aboutSubjectIds: [work.id, person.id],
      defaultLanguagePair: { source: "en", target: "zh-Hans" },
    };
    const entry = newEntry(collection, undefined, state.data.subjects);
    expect(entry.scope.languagePair).toEqual({
      source: "en",
      target: "zh-Hans",
    });
    expect(entry.scope.requiredSubjects).toEqual([
      { subjectId: work.id, role: "topic" },
      { subjectId: person.id, role: "present" },
    ]);
    expect(entry.aboutSubjectIds).toEqual([work.id, person.id]);
    expect(entry.state).toBe("candidate");
    collection.defaultLanguagePair = { source: "ja", target: "zh-Hant" };
    expect(entry.scope.languagePair.target).toBe("zh-Hans");
  });
});
