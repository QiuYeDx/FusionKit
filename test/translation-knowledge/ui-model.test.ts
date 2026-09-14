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

describe("maintenance and file exchange controls", () => {
  it("accepts one knowledge file and rejects ambiguous drops", async () => {
    const { acceptsKnowledgeDrop } = await import(
      "../../src/pages/TranslationKnowledge/model"
    );
    expect(acceptsKnowledgeDrop([{ name: "作品.fktk.json" }])).toBe(true);
    expect(acceptsKnowledgeDrop([{ name: "PACKAGE.FKTK.JSON" }])).toBe(true);
    expect(acceptsKnowledgeDrop([])).toBe(false);
    expect(
      acceptsKnowledgeDrop([{ name: "a.fktk.json" }, { name: "b.fktk.json" }]),
    ).toBe(false);
    expect(acceptsKnowledgeDrop([{ name: "subtitles.srt" }])).toBe(false);
  });
  it("keeps both direct and derived evidence out of the unused source list", async () => {
    const { isSourceUnreferenced } = await import(
      "../../src/pages/TranslationKnowledge/model"
    );
    const data = knowledgeFixture();
    const entry = data.entries[0];
    const sourceId = entry.evidence[0].sourceId;
    expect(isSourceUnreferenced(sourceId, data)).toBe(false);
    data.entries = [
      {
        ...entry,
        evidence: [],
        derivedFrom: [
          {
            entryId: entry.id,
            revision: 1,
            digest: "0".repeat(64),
            evidenceSourceId: sourceId,
          },
        ],
      },
    ];
    expect(isSourceUnreferenced(sourceId, data)).toBe(false);
    data.entries = [];
    expect(isSourceUnreferenced(sourceId, data)).toBe(true);
  });
  it("requires an export preview at the current library generation", async () => {
    const { exportPreviewCurrent } = await import(
      "../../src/pages/TranslationKnowledge/model"
    );
    expect(exportPreviewCurrent(null, 3)).toBe(false);
    expect(exportPreviewCurrent({ generation: 2 }, 3)).toBe(false);
    expect(exportPreviewCurrent({ generation: 3 }, 3)).toBe(true);
  });
});

it('omits history consent entirely for archive, restore and import undo commits', async () => {
  const { maintenanceCommitFor } = await import('../../src/pages/TranslationKnowledge/model');
  const history = {snapshots:4,importsLosingUndo:2,scope:'all' as const};
  for (const action of ['archive','restore','undo_import'] as const) {
    for (const confirmed of [false,true]) {
      const request=maintenanceCommitFor({planId:'plan',action,history},confirmed);
      expect(request).toEqual({planId:'plan'});
      expect(Object.hasOwn(request,'confirmHistoryRemoval')).toBe(false);
    }
  }
  expect(maintenanceCommitFor({planId:'purge',action:'purge',history},true)).toEqual({planId:'purge',confirmHistoryRemoval:true});
  expect(maintenanceCommitFor({planId:'purge',action:'purge',history},false)).toEqual({planId:'purge',confirmHistoryRemoval:false});
});
