import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAllNameTranslationPlansForTest,
  rememberNameTranslationPlan,
} from "@/services/rename/namePlanStore";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  type NameTranslationPlan,
} from "@/services/rename/nameTypes";
import useNameTranslatorStore from "./useNameTranslatorStore";

vi.mock("@/utils/toast", () => ({
  showToast: vi.fn(),
}));

afterEach(() => {
  clearAllNameTranslationPlansForTest();
  useNameTranslatorStore.getState().reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useNameTranslatorStore outputMode local rebuild", () => {
  it("recomposes item names in-place when outputMode changes without re-calling LLM", async () => {
    const invoke = vi.fn(async (channel: string, payload: { paths: string[] }) => {
      if (channel === "inspect-rename-paths") {
        return {
          paths: payload.paths.map((path) => ({
            path,
            exists: true,
            kind: "file",
            basename: "第01話.srt",
            parentPath: "/tmp/rename",
            riskLevel: "normal",
            warnings: [],
          })),
        };
      }
      if (channel === "check-path-exists") return false;
      return { valid: true, errors: [], warnings: [] };
    });
    vi.stubGlobal("window", { ipcRenderer: { invoke } });

    const plan = createPlan();
    rememberNameTranslationPlan(plan);

    await useNameTranslatorStore
      .getState()
      .loadPlanFromCache("rename_plan_from_agent");

    useNameTranslatorStore
      .getState()
      .updateOptions({ outputMode: "bilingual_target_first" });

    const state = useNameTranslatorStore.getState();
    expect(state.currentPlan).not.toBeNull();
    expect(state.currentPlan!.items[0].newName).toBe("Episode 01 - 第01話.srt");
    expect(state.currentPlan!.items[0].translatedStem).toBe("Episode 01");
  });

  it("recomposes item names when bilingualSeparator changes", async () => {
    const invoke = vi.fn(async (channel: string, payload: { paths: string[] }) => {
      if (channel === "inspect-rename-paths") {
        return {
          paths: payload.paths.map((path) => ({
            path,
            exists: true,
            kind: "file",
            basename: "第01話.srt",
            parentPath: "/tmp/rename",
            riskLevel: "normal",
            warnings: [],
          })),
        };
      }
      if (channel === "check-path-exists") return false;
      return { valid: true, errors: [], warnings: [] };
    });
    vi.stubGlobal("window", { ipcRenderer: { invoke } });

    const plan = createPlan();
    rememberNameTranslationPlan(plan);

    await useNameTranslatorStore
      .getState()
      .loadPlanFromCache("rename_plan_from_agent");

    useNameTranslatorStore
      .getState()
      .updateOptions({ outputMode: "bilingual_original_first", bilingualSeparator: "_" });

    const state = useNameTranslatorStore.getState();
    expect(state.currentPlan).not.toBeNull();
    expect(state.currentPlan!.items[0].newName).toBe("第01話_Episode 01.srt");
  });
});

describe("useNameTranslatorStore plan hydration", () => {
  it("loads a HomeAgent-created plan from memory by planId", async () => {
    const invoke = vi.fn(async (channel: string, payload: { paths: string[] }) => {
      expect(channel).toBe("inspect-rename-paths");
      return {
        paths: payload.paths.map((path) => ({
          path,
          exists: true,
          kind: "file",
          basename: "第01話.srt",
          parentPath: "/tmp/rename",
          riskLevel: "normal",
          warnings: [],
        })),
      };
    });
    vi.stubGlobal("window", { ipcRenderer: { invoke } });

    const plan = createPlan();
    rememberNameTranslationPlan(plan);

    await expect(
      useNameTranslatorStore
        .getState()
        .loadPlanFromCache("rename_plan_from_agent")
    ).resolves.toBe(true);

    const state = useNameTranslatorStore.getState();
    expect(state.currentPlan?.planId).toBe("rename_plan_from_agent");
    expect(state.selectedPaths).toHaveLength(1);
    expect(state.selectedPaths[0].path).toBe("/tmp/rename/第01話.srt");
    expect(state.options.roots).toEqual(["/tmp/rename/第01話.srt"]);
    expect(state.originalSuggestions.rename_item_a).toMatchObject({
      newName: "Episode 01.srt",
      targetPath: "/tmp/rename/Episode 01.srt",
    });
    expect(state.history[0].planId).toBe("rename_plan_from_agent");
  });

  it("reports a missing or expired plan instead of leaving a silent empty page", async () => {
    await expect(
      useNameTranslatorStore.getState().loadPlanFromCache("missing_plan")
    ).resolves.toBe(false);

    expect(useNameTranslatorStore.getState().currentPlan).toBeNull();
    expect(useNameTranslatorStore.getState().lastError).toContain(
      "missing_plan"
    );
  });
});

function createPlan(): NameTranslationPlan {
  const options = {
    ...DEFAULT_NAME_TRANSLATION_OPTIONS,
    roots: ["/tmp/rename/第01話.srt"],
    scope: "self" as const,
    targetKind: "files" as const,
    includeRoot: true,
    maxDepth: 0,
  };

  return {
    planId: "rename_plan_from_agent",
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    options,
    roots: options.roots,
    totalTargets: 1,
    previewLimit: 30,
    items: [
      {
        id: "rename_item_a",
        targetId: "rename_target_a",
        kind: "file",
        sourcePath: "/tmp/rename/第01話.srt",
        sourceParentPath: "/tmp/rename",
        originalName: "第01話.srt",
        translatedStem: "Episode 01",
        newName: "Episode 01.srt",
        targetPath: "/tmp/rename/Episode 01.srt",
        status: "ready",
        warnings: [],
      },
    ],
    itemsPreview: [
      {
        id: "rename_item_a",
        targetId: "rename_target_a",
        kind: "file",
        sourcePath: "/tmp/rename/第01話.srt",
        sourceParentPath: "/tmp/rename",
        originalName: "第01話.srt",
        translatedStem: "Episode 01",
        newName: "Episode 01.srt",
        targetPath: "/tmp/rename/Episode 01.srt",
        status: "ready",
        warnings: [],
      },
    ],
    itemsStored: false,
    readyCount: 1,
    blockedCount: 0,
    skippedCount: 0,
    unchangedCount: 0,
    warnings: [],
    applyable: true,
  };
}
