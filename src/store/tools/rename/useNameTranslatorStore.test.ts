import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAllNameTranslationPlansForTest,
  summarizeNameTranslationPlan,
  rememberNameTranslationPlan,
} from "@/services/rename/namePlanStore";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  type NameTranslationPlan,
} from "@/services/rename/nameTypes";
import useNameTranslatorStore from "./useNameTranslatorStore";

const createNameTranslationPlanMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/rename/nameTranslationPlanner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/rename/nameTranslationPlanner")>();
  return {
    ...actual,
    createNameTranslationPlan: createNameTranslationPlanMock,
  };
});

vi.mock("@/utils/toast", () => ({
  showToast: vi.fn(),
}));

afterEach(() => {
  clearAllNameTranslationPlansForTest();
  useNameTranslatorStore.getState().reset();
  vi.unstubAllGlobals();
  createNameTranslationPlanMock.mockReset();
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

  it("uses batch target path checks during local revalidation", async () => {
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
      if (channel === "check-rename-target-paths") {
        return {
          existingPaths: ["/tmp/rename/Episode 01.srt"],
          errors: [],
        };
      }
      if (channel === "check-path-exists") {
        throw new Error("single-path fallback should not run");
      }
      return { valid: true, errors: [], warnings: [] };
    });
    vi.stubGlobal("window", { ipcRenderer: { invoke } });

    const plan = createPlan();
    rememberNameTranslationPlan(plan);

    await useNameTranslatorStore
      .getState()
      .loadPlanFromCache("rename_plan_from_agent");

    useNameTranslatorStore.getState().updateOptions({ collisionPolicy: "fail" });
    await flushAsyncWork();

    expect(invoke).toHaveBeenCalledWith("check-rename-target-paths", {
      paths: ["/tmp/rename/Episode 01.srt"],
    });
    expect(
      invoke.mock.calls.some((call) => call[0] === "check-path-exists")
    ).toBe(false);
    expect(useNameTranslatorStore.getState().currentPlan?.items[0]).toMatchObject({
      status: "blocked",
      reason: "target_exists",
    });
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

describe("useNameTranslatorStore planning progress", () => {
  it("stores planner progress and commits the generated plan", async () => {
    stubRenameIpc();
    const plan = createPlan("rename_plan_progress");
    createNameTranslationPlanMock.mockImplementation(async (_options, deps) => {
      deps.progress?.({
        phase: "scanning",
        totalTargets: 1,
        scannedTargets: 1,
      });
      deps.progress?.({
        phase: "translating",
        totalTargets: 1,
        translatableCount: 1,
        translatedCount: 1,
        completedBatchCount: 1,
        totalBatchCount: 1,
      });
      rememberNameTranslationPlan(plan);
      return summarizeNameTranslationPlan(plan);
    });

    await useNameTranslatorStore.getState().addPaths(["/tmp/rename/第01話.srt"]);
    await useNameTranslatorStore.getState().createPreview();

    const state = useNameTranslatorStore.getState();
    expect(state.isPlanning).toBe(false);
    expect(state.planningProgress).toBeNull();
    expect(state.currentPlan?.planId).toBe("rename_plan_progress");
    expect(state.history[0].planId).toBe("rename_plan_progress");
    expect(createNameTranslationPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ roots: ["/tmp/rename/第01話.srt"] }),
      expect.objectContaining({
        progress: expect.any(Function),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("cancels planning and ignores late planner results", async () => {
    stubRenameIpc();
    const plan = createPlan("rename_plan_late");
    let releasePlanner!: () => void;
    const plannerReleased = new Promise<void>((resolve) => {
      releasePlanner = resolve;
    });

    createNameTranslationPlanMock.mockImplementation(async (_options, deps) => {
      deps.progress?.({
        phase: "scanning",
        totalTargets: 1,
        scannedTargets: 1,
      });
      await plannerReleased;
      rememberNameTranslationPlan(plan);
      return summarizeNameTranslationPlan(plan);
    });

    await useNameTranslatorStore.getState().addPaths(["/tmp/rename/第01話.srt"]);
    const previewPromise = useNameTranslatorStore.getState().createPreview();

    expect(useNameTranslatorStore.getState().planningProgress?.phase).toBe(
      "scanning"
    );

    useNameTranslatorStore.getState().cancelPlanning();
    expect(useNameTranslatorStore.getState().isPlanning).toBe(false);
    expect(useNameTranslatorStore.getState().planningProgress?.phase).toBe(
      "cancelled"
    );

    releasePlanner();
    await previewPromise;

    const state = useNameTranslatorStore.getState();
    expect(state.currentPlan).toBeNull();
    expect(
      state.history.some((item) => item.planId === "rename_plan_late")
    ).toBe(false);
    expect(state.planningProgress?.phase).toBe("cancelled");
  });
});

describe("useNameTranslatorStore scope option normalization", () => {
  it("clears selected paths without resetting user options", async () => {
    const invoke = vi.fn(
      async (channel: string, payload: { paths: string[] }) => {
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
        return { valid: true, errors: [], warnings: [] };
      }
    );
    vi.stubGlobal("window", { ipcRenderer: { invoke } });

    await useNameTranslatorStore.getState().addPaths(["/tmp/rename/第01話.srt"]);
    useNameTranslatorStore.getState().updateOptions({
      outputMode: "bilingual_original_first",
      bilingualSeparator: "_",
      targetLang: "JA",
      collisionPolicy: "append_index",
    });

    useNameTranslatorStore.getState().clearSelection();

    const state = useNameTranslatorStore.getState();
    expect(state.selectedPaths).toEqual([]);
    expect(state.currentPlan).toBeNull();
    expect(state.options).toMatchObject({
      roots: [],
      outputMode: "bilingual_original_first",
      bilingualSeparator: "_",
      targetLang: "JA",
      collisionPolicy: "append_index",
    });
  });

  it("switches a selected folder from self to child files by default", async () => {
    const invoke = vi.fn(
      async (channel: string, payload: { paths: string[] }) => {
        if (channel === "inspect-rename-paths") {
          return {
            paths: payload.paths.map((path) => ({
              path,
              exists: true,
              kind: "directory",
              basename: "日剧",
              parentPath: "/tmp",
              directFileCount: 2,
              directDirectoryCount: 1,
              riskLevel: "normal",
              warnings: [],
            })),
          };
        }
        return { valid: true, errors: [], warnings: [] };
      }
    );
    vi.stubGlobal("window", { ipcRenderer: { invoke } });

    await useNameTranslatorStore.getState().addPaths(["/tmp/日剧"]);

    expect(useNameTranslatorStore.getState().options).toMatchObject({
      scope: "self",
      targetKind: "directories",
      maxDepth: 0,
    });

    useNameTranslatorStore.getState().updateOptions({ scope: "children" });
    expect(useNameTranslatorStore.getState().options).toMatchObject({
      scope: "children",
      targetKind: "files",
      recursive: false,
      maxDepth: 1,
      includeRoot: false,
    });

    useNameTranslatorStore.getState().updateOptions({ scope: "descendants" });
    expect(useNameTranslatorStore.getState().options).toMatchObject({
      scope: "descendants",
      targetKind: "files",
      recursive: true,
      maxDepth: 5,
      includeRoot: false,
    });

    useNameTranslatorStore
      .getState()
      .updateOptions({ targetKind: "directories" });
    useNameTranslatorStore.getState().updateOptions({ scope: "children" });
    expect(useNameTranslatorStore.getState().options.targetKind).toBe(
      "directories"
    );

    useNameTranslatorStore.getState().updateOptions({ scope: "self" });
    expect(useNameTranslatorStore.getState().options.targetKind).toBe(
      "directories"
    );
  });

  it("keeps self-scope target kinds in sync as mixed paths are added", async () => {
    const invoke = vi.fn(
      async (channel: string, payload: { paths: string[] }) => {
        if (channel === "inspect-rename-paths") {
          return {
            paths: payload.paths.map((path) => {
              const isDirectory = path.endsWith("/日剧");
              return {
                path,
                exists: true,
                kind: isDirectory ? "directory" : "file",
                basename: isDirectory ? "日剧" : "第01話.srt",
                parentPath: "/tmp",
                riskLevel: "normal",
                warnings: [],
              };
            }),
          };
        }
        return { valid: true, errors: [], warnings: [] };
      }
    );
    vi.stubGlobal("window", { ipcRenderer: { invoke } });

    await useNameTranslatorStore.getState().addPaths(["/tmp/日剧"]);
    await useNameTranslatorStore
      .getState()
      .addPaths(["/tmp/第01話.srt"]);

    expect(useNameTranslatorStore.getState().options.targetKind).toBe("both");
  });
});

describe("useNameTranslatorStore incomplete plan apply guard", () => {
  it("blocks apply when plan items are incomplete (itemsStored=false, items < totalTargets)", async () => {
    const { showToast } = await import("@/utils/toast");
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "inspect-rename-paths") {
        return {
          paths: [
            {
              path: "/tmp/rename/第01話.srt",
              exists: true,
              kind: "file",
              basename: "第01話.srt",
              parentPath: "/tmp/rename",
              riskLevel: "normal",
              warnings: [],
            },
          ],
        };
      }
      return { valid: true, errors: [], warnings: [] };
    });
    vi.stubGlobal("window", { ipcRenderer: { invoke } });

    const plan = createPlan();
    plan.totalTargets = 50;
    plan.itemsStored = false;
    rememberNameTranslationPlan(plan);

    await useNameTranslatorStore
      .getState()
      .loadPlanFromCache("rename_plan_from_agent");

    await useNameTranslatorStore.getState().applyCurrentPlan();

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("1"),
      "error"
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "validate-rename-plan",
      expect.anything()
    );
  });

  it("allows apply for small-batch fallback plan where items cover all targets", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "inspect-rename-paths") {
        return {
          paths: [
            {
              path: "/tmp/rename/第01話.srt",
              exists: true,
              kind: "file",
              basename: "第01話.srt",
              parentPath: "/tmp/rename",
              riskLevel: "normal",
              warnings: [],
            },
          ],
        };
      }
      return { valid: true, errors: [], warnings: [] };
    });
    vi.stubGlobal("window", { ipcRenderer: { invoke } });

    const plan = createPlan();
    plan.totalTargets = 1;
    plan.itemsStored = false;
    rememberNameTranslationPlan(plan);

    await useNameTranslatorStore
      .getState()
      .loadPlanFromCache("rename_plan_from_agent");

    await useNameTranslatorStore.getState().applyCurrentPlan();

    expect(
      invoke.mock.calls.some((call) => call[0] === "validate-rename-plan")
    ).toBe(true);
  });

  it("sets applyable=false for incomplete plans created from summary", async () => {
    stubRenameIpc();
    const plan = createPlan("rename_plan_summary_incomplete");
    plan.totalTargets = 100;
    plan.previewLimit = 30;

    const summary = summarizeNameTranslationPlan(plan);
    summary.totalTargets = 100;

    createNameTranslationPlanMock.mockResolvedValueOnce(summary);

    await useNameTranslatorStore
      .getState()
      .addPaths(["/tmp/rename/第01話.srt"]);
    await useNameTranslatorStore.getState().createPreview();

    const state = useNameTranslatorStore.getState();
    expect(state.currentPlan?.applyable).toBe(false);
    expect(state.currentPlan?.itemsStored).toBe(false);
  });
});

function stubRenameIpc() {
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
  return invoke;
}

function createPlan(planId = "rename_plan_from_agent"): NameTranslationPlan {
  const options = {
    ...DEFAULT_NAME_TRANSLATION_OPTIONS,
    roots: ["/tmp/rename/第01話.srt"],
    scope: "self" as const,
    targetKind: "files" as const,
    includeRoot: true,
    maxDepth: 0,
  };

  return {
    planId,
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

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
