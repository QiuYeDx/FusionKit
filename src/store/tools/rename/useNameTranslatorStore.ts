import { create } from "zustand";
import {
  getNameTranslationPlan,
  rememberNameTranslationPlan,
  summarizeNameTranslationPlan,
  updateNameTranslationPlan,
} from "@/services/rename/namePlanStore";
import {
  joinPath,
  pathBasename,
  pathDirname,
  pathStem,
  samePath,
} from "@/services/rename/namePath";
import {
  checkRenameTargetsExist,
  checkRenameTargetExists,
} from "@/services/rename/nameTargetResolver";
import { createNameTranslationPlan } from "@/services/rename/nameTranslationPlanner";
import { sanitizeTranslatedName } from "@/services/rename/nameSanitize";
import { validatePlanItems } from "@/services/rename/nameConflict";
import {
  applyNameTranslationPlan,
  rollbackNameTranslationJournal,
  validateNameTranslationPlan,
} from "@/services/rename/nameApplyService";
import i18n from "@/i18n";
import { showToast } from "@/utils/toast";
import type {
  ApplyProgress,
  InspectedRenamePath,
  NameTranslationApplyResult,
  NameTranslationOptions,
  NameTranslationPlanningProgress,
  NameTranslationPlan,
  NameTranslationPlanItem,
  NameTranslationPlanSummary,
  NameTranslationTarget,
  RollbackRenameJournalResult,
  SelectedPath,
  ValidateRenamePlanResult,
} from "@/services/rename/nameTypes";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  normalizeNameTranslationOptions,
} from "@/services/rename/nameTypes";

type OriginalSuggestion = Pick<
  NameTranslationPlanItem,
  "newName" | "targetPath" | "translatedStem"
>;

interface InspectRenamePathsResult {
  paths: InspectedRenamePath[];
}

interface NameTranslatorStore {
  selectedPaths: SelectedPath[];
  options: NameTranslationOptions;
  currentPlan: NameTranslationPlan | null;
  isPlanning: boolean;
  planningProgress: NameTranslationPlanningProgress | null;
  isApplying: boolean;
  applyProgress: ApplyProgress | null;
  lastApplyResult: NameTranslationApplyResult | null;
  lastRollbackResult: RollbackRenameJournalResult | null;
  lastValidation: ValidateRenamePlanResult | null;
  lastError: string | null;
  history: NameTranslationPlanSummary[];
  originalSuggestions: Record<string, OriginalSuggestion>;

  addPaths: (paths: string[]) => Promise<void>;
  removePath: (path: string) => void;
  updateOptions: (patch: Partial<NameTranslationOptions>) => void;
  loadPlanFromCache: (planId: string) => Promise<boolean>;
  createPreview: () => Promise<void>;
  cancelPlanning: () => void;
  updatePlanItem: (
    itemId: string,
    patch: Partial<NameTranslationPlanItem>
  ) => void;
  revalidateCurrentPlan: () => Promise<void>;
  applyCurrentPlan: () => Promise<void>;
  rollback: (journalId: string) => Promise<void>;
  reset: () => void;
}

const VALIDATION_WARNING_CODES = new Set([
  "auto_index_added",
  "case_only",
  "duplicate_target",
  "invalid_name",
  "path_too_long",
  "swap",
  "target_exists",
]);

const REVALIDATABLE_BLOCK_REASONS = new Set([
  "duplicate_target",
  "target_exists",
]);

const pendingPlanLoads = new Map<string, Promise<boolean>>();
let planningRequestSeq = 0;
let activePlanningController: AbortController | null = null;

const useNameTranslatorStore = create<NameTranslatorStore>((set, get) => ({
  selectedPaths: [],
  options: {
    ...DEFAULT_NAME_TRANSLATION_OPTIONS,
    roots: [],
  },
  currentPlan: null,
  isPlanning: false,
  planningProgress: null,
  isApplying: false,
  applyProgress: null,
  lastApplyResult: null,
  lastRollbackResult: null,
  lastValidation: null,
  lastError: null,
  history: [],
  originalSuggestions: {},

  addPaths: async (paths) => {
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (uniquePaths.length === 0) return;

    set({ isPlanning: true, lastError: null });
    try {
      const inspected = await inspectRenamePaths(uniquePaths);
      const existing = get().selectedPaths;
      const existingKeys = new Set(existing.map((item) => item.path));
      const nextSelected = [
        ...existing,
        ...inspected.filter((item) => !existingKeys.has(item.path)),
      ];
      const nextOptions = normalizeOptionsAfterPathChange(
        get().options,
        existing,
        nextSelected
      );

      set({
        selectedPaths: nextSelected,
        options: nextOptions,
        currentPlan: null,
        lastValidation: null,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      set({ lastError: message });
      showToast(message, "error");
    } finally {
      set({ isPlanning: false, planningProgress: null });
    }
  },

  removePath: (path) => {
    const previousSelected = get().selectedPaths;
    const nextSelected = previousSelected.filter((item) => item.path !== path);
    set({
      selectedPaths: nextSelected,
      options: normalizeOptionsAfterPathChange(
        get().options,
        previousSelected,
        nextSelected
      ),
      currentPlan: null,
      lastValidation: null,
    });
  },

  updateOptions: (patch) => {
    const state = get();
    const requestedScope = patch.scope ?? state.options.scope;
    const shouldInferTargetKind =
      patch.targetKind === undefined &&
      patch.scope !== undefined &&
      shouldInferTargetKindForScopeChange(state.options.scope, requestedScope);
    const options = normalizeNameTranslationOptions({
      ...state.options,
      ...patch,
      ...(shouldInferTargetKind
        ? {
            targetKind: inferTargetKindForScope(
              requestedScope,
              state.selectedPaths
            ),
          }
        : {}),
      roots: state.selectedPaths.map((item) => item.path),
    });

    if (state.currentPlan && isPlanLocalOptionPatch(patch)) {
      const mergedOptions = { ...state.currentPlan.options, ...patch };
      const needsNameRecomposition =
        patch.outputMode !== undefined || patch.bilingualSeparator !== undefined;
      const nextItems = needsNameRecomposition
        ? recomposeItemNames(state.currentPlan.items, mergedOptions)
        : state.currentPlan.items;
      const nextPlan = rebuildPlan(
        { ...state.currentPlan, options: mergedOptions },
        nextItems
      );
      commitPlan(set, nextPlan, { options, lastValidation: null });
      void get().revalidateCurrentPlan();
      return;
    }

    set({
      options,
      currentPlan: null,
      lastValidation: null,
    });
  },

  loadPlanFromCache: async (planId) => {
    const normalizedPlanId = planId.trim();
    if (!normalizedPlanId) return false;

    const current = get().currentPlan;
    if (
      current?.planId === normalizedPlanId &&
      hasSelectedRoots(get().selectedPaths, getPlanRoots(current))
    ) {
      set({ lastError: null });
      return true;
    }

    const pendingLoad = pendingPlanLoads.get(normalizedPlanId);
    if (pendingLoad) return pendingLoad;

    const loadPromise = (async () => {
      const plan = getNameTranslationPlan(normalizedPlanId);
      if (!plan) {
        const message = i18n.t("rename:messages.plan_not_found", {
          planId: shortPlanId(normalizedPlanId),
        });
        set({ lastError: message });
        showToast(message, "error");
        return false;
      }

      set({
        isPlanning: true,
        planningProgress: null,
        lastError: null,
        lastApplyResult: null,
        lastRollbackResult: null,
        lastValidation: null,
      });

      try {
        const roots = getPlanRoots(plan);
        const selectedPaths = await restoreSelectedPaths(plan, roots);
        const options = normalizeNameTranslationOptions({
          ...plan.options,
          roots,
        });
        const originalSuggestions = collectOriginalSuggestions(plan.items);
        const summary = summarizeNameTranslationPlan(plan);

        set((state) => ({
          selectedPaths,
          options,
          currentPlan: plan,
          originalSuggestions,
          history: [
            summary,
            ...state.history.filter((item) => item.planId !== plan.planId),
          ].slice(0, 10),
        }));

        showToast(i18n.t("rename:messages.plan_loaded_from_agent"), "success");
        return true;
      } catch (error) {
        const message = getErrorMessage(error);
        set({ lastError: message });
        showToast(message, "error");
        return false;
      } finally {
        set({ isPlanning: false, planningProgress: null });
      }
    })();

    pendingPlanLoads.set(normalizedPlanId, loadPromise);
    return loadPromise.finally(() => {
      pendingPlanLoads.delete(normalizedPlanId);
    });
  },

  createPreview: async () => {
    const roots = get().selectedPaths.map((item) => item.path);
    if (roots.length === 0) {
      showToast(i18n.t("rename:messages.select_paths_first"), "error");
      return;
    }

    const requestId = ++planningRequestSeq;
    const controller = new AbortController();
    activePlanningController?.abort();
    activePlanningController = controller;

    set({
      isPlanning: true,
      planningProgress: null,
      lastError: null,
      lastApplyResult: null,
      lastRollbackResult: null,
      lastValidation: null,
    });

    try {
      const options = normalizeNameTranslationOptions({
        ...get().options,
        roots,
      });
      const summary = await createNameTranslationPlan(options, {
        signal: controller.signal,
        progress: (progress) => {
          if (
            requestId !== planningRequestSeq ||
            controller.signal.aborted
          ) {
            return;
          }
          set({ planningProgress: progress });
        },
      });
      if (requestId !== planningRequestSeq || controller.signal.aborted) return;

      const fullPlan = getNameTranslationPlan(summary.planId);
      const plan = fullPlan ?? createPlanFromSummary(summary, options);
      const originalSuggestions = collectOriginalSuggestions(plan.items);
      if (requestId !== planningRequestSeq || controller.signal.aborted) return;

      set((state) => ({
        options,
        currentPlan: plan,
        planningProgress: null,
        originalSuggestions,
        history: [
          summarizeNameTranslationPlan(plan),
          ...state.history.filter((item) => item.planId !== plan.planId),
        ].slice(0, 10),
      }));

      if (plan.clarificationRequired) {
        showToast(plan.clarificationRequired.message, "error");
      } else if (plan.items.length === 0) {
        showToast(i18n.t("rename:messages.preview_empty"), "error");
      } else {
        showToast(i18n.t("rename:messages.preview_created"), "success");
      }
    } catch (error) {
      if (isPlanningCancelled(error) || controller.signal.aborted) {
        if (requestId === planningRequestSeq) {
          set({
            planningProgress: createCancelledPlanningProgress(),
            lastError: null,
          });
        }
        return;
      }
      const message = getErrorMessage(error);
      set({
        lastError: message,
        currentPlan: null,
        planningProgress: {
          phase: "failed",
          message,
        },
      });
      showToast(message, "error");
    } finally {
      if (requestId === planningRequestSeq) {
        activePlanningController = null;
        set({ isPlanning: false });
      }
    }
  },

  cancelPlanning: () => {
    if (!activePlanningController) return;
    activePlanningController.abort();
    activePlanningController = null;
    planningRequestSeq++;
    set({
      isPlanning: false,
      planningProgress: createCancelledPlanningProgress(),
      lastError: null,
    });
  },

  updatePlanItem: (itemId, patch) => {
    const plan = get().currentPlan;
    if (!plan) return;

    const nextItems = plan.items.map((item) =>
      item.id === itemId ? patchPlanItem(item, patch) : item
    );
    commitPlan(set, rebuildPlan(plan, nextItems), { lastValidation: null });
    void get().revalidateCurrentPlan();
  },

  revalidateCurrentPlan: async () => {
    const plan = get().currentPlan;
    if (!plan) return;

    set({ isPlanning: true, lastError: null });
    try {
      const locallyValidated = await revalidatePlanConflicts(plan);
      commitPlan(set, locallyValidated, { lastValidation: null });

      if (!locallyValidated.applyable) return;

      const validation = await validateNameTranslationPlan(locallyValidated.planId);
      const nextPlan = validation.valid
        ? locallyValidated
        : markValidationErrors(locallyValidated, validation);
      commitPlan(set, nextPlan, { lastValidation: validation });
    } catch (error) {
      const message = getErrorMessage(error);
      set({ lastError: message });
      showToast(message, "error");
    } finally {
      set({ isPlanning: false });
    }
  },

  applyCurrentPlan: async () => {
    const plan = get().currentPlan;
    if (!plan) {
      showToast(i18n.t("rename:messages.missing_plan"), "error");
      return;
    }

    if (isPlanIncomplete(plan)) {
      showToast(
        i18n.t("rename:messages.plan_items_incomplete", {
          count: plan.items.length,
          total: plan.totalTargets,
        }),
        "error"
      );
      return;
    }

    set({
      isApplying: true,
      applyProgress: {
        phase: "validating",
        message: i18n.t("rename:messages.validating"),
      },
      lastError: null,
      lastApplyResult: null,
      lastRollbackResult: null,
    });

    try {
      const validation = await validateNameTranslationPlan(plan.planId);
      if (!validation.valid) {
        const nextPlan = markValidationErrors(plan, validation);
        commitPlan(set, nextPlan, { lastValidation: validation });
        throw new Error(
          validation.errors[0]?.message ??
            i18n.t("rename:messages.validation_failed")
        );
      }

      set({
        lastValidation: validation,
        applyProgress: {
          phase: "applying",
          message: i18n.t("rename:messages.applying"),
        },
      });

      const result = await applyNameTranslationPlan(plan.planId);
      const latestPlan = get().currentPlan ?? plan;
      const nextPlan = markApplyResult(latestPlan, result);
      commitPlan(set, nextPlan, {
        lastApplyResult: result,
        applyProgress: {
          phase: "done",
          message: i18n.t("rename:messages.done"),
        },
      });
      showToast(
        i18n.t("rename:messages.rename_finished"),
        result.failedCount > 0 ? "error" : "success"
      );
    } catch (error) {
      const message = getErrorMessage(error);
      set({
        lastError: message,
        applyProgress: { phase: "failed", message },
      });
      showToast(message, "error");
    } finally {
      set({ isApplying: false });
    }
  },

  rollback: async (journalId) => {
    if (!journalId.trim()) return;

    set({
      isApplying: true,
      applyProgress: {
        phase: "rolling_back",
        message: i18n.t("rename:messages.rolling_back"),
      },
      lastError: null,
      lastRollbackResult: null,
    });

    try {
      const result = await rollbackNameTranslationJournal(journalId);
      set({
        lastRollbackResult: result,
        applyProgress: {
          phase: "done",
          message: i18n.t("rename:messages.rollback_done"),
        },
      });
      showToast(
        i18n.t("rename:messages.rollback_done"),
        result.failedCount > 0 ? "error" : "success"
      );
    } catch (error) {
      const message = getErrorMessage(error);
      set({
        lastError: message,
        applyProgress: { phase: "failed", message },
      });
      showToast(message, "error");
    } finally {
      set({ isApplying: false });
    }
  },

  reset: () => {
    activePlanningController?.abort();
    activePlanningController = null;
    planningRequestSeq++;
    set({
      selectedPaths: [],
      options: {
        ...DEFAULT_NAME_TRANSLATION_OPTIONS,
        roots: [],
      },
      currentPlan: null,
      isPlanning: false,
      planningProgress: null,
      isApplying: false,
      applyProgress: null,
      lastApplyResult: null,
      lastRollbackResult: null,
      lastValidation: null,
      lastError: null,
      originalSuggestions: {},
    });
  },
}));

async function inspectRenamePaths(
  paths: string[]
): Promise<InspectedRenamePath[]> {
  const result = (await getIpcRenderer().invoke("inspect-rename-paths", {
    paths,
  })) as InspectRenamePathsResult;
  return result.paths ?? [];
}

function normalizeOptionsAfterPathChange(
  options: NameTranslationOptions,
  previousSelectedPaths: SelectedPath[],
  selectedPaths: SelectedPath[]
): NameTranslationOptions {
  const previousInferredTargetKind = inferTargetKindForScope(
    options.scope,
    previousSelectedPaths
  );
  const shouldInferTargetKind =
    previousSelectedPaths.length === 0 ||
    options.targetKind === previousInferredTargetKind;
  const inferredTargetKind = shouldInferTargetKind
    ? inferTargetKindForScope(options.scope, selectedPaths)
    : options.targetKind;

  return normalizeNameTranslationOptions({
    ...options,
    targetKind: inferredTargetKind,
    roots: selectedPaths.map((item) => item.path),
  });
}

function inferTargetKindForScope(
  scope: NameTranslationOptions["scope"],
  selectedPaths: SelectedPath[]
): NameTranslationOptions["targetKind"] {
  if (scope === "children" || scope === "descendants") {
    return "files";
  }
  if (scope === "path_segments") {
    return "both";
  }

  const hasFiles = selectedPaths.some((item) => item.kind === "file");
  const hasDirectories = selectedPaths.some((item) => item.kind === "directory");

  if (hasFiles && hasDirectories) return "both";
  if (hasDirectories) return "directories";
  return "files";
}

function shouldInferTargetKindForScopeChange(
  previousScope: NameTranslationOptions["scope"],
  nextScope: NameTranslationOptions["scope"]
): boolean {
  if (previousScope === nextScope) return false;
  const previousIsCollectionScope =
    previousScope === "children" || previousScope === "descendants";
  const nextIsCollectionScope =
    nextScope === "children" || nextScope === "descendants";
  return !(previousIsCollectionScope && nextIsCollectionScope);
}

const LOCAL_REBUILD_KEYS = new Set([
  "collisionPolicy",
  "outputMode",
  "bilingualSeparator",
]);

function isPlanLocalOptionPatch(
  patch: Partial<NameTranslationOptions>
): boolean {
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((key) => LOCAL_REBUILD_KEYS.has(key));
}

function patchPlanItem(
  item: NameTranslationPlanItem,
  patch: Partial<NameTranslationPlanItem>
): NameTranslationPlanItem {
  const next: NameTranslationPlanItem = {
    ...item,
    ...patch,
    warnings: patch.warnings ?? stripValidationWarnings(item.warnings),
  };

  if (patch.status === "skipped") {
    return {
      ...next,
      status: "skipped",
      reason: patch.reason ?? "manual_skip",
    };
  }

  if (patch.newName !== undefined) {
    next.newName = patch.newName.trim();
    next.translatedStem = patch.translatedStem ?? pathStem(next.newName);
    next.targetPath = joinPath(next.sourceParentPath, next.newName);
    next.status = patch.status ?? "ready";
    next.reason = patch.reason;
  }

  if (patch.status === "ready") {
    next.reason = patch.reason;
  }

  return next;
}

function stripValidationWarnings(warnings: string[]): string[] {
  return warnings.filter((warning) => !VALIDATION_WARNING_CODES.has(warning));
}

async function revalidatePlanConflicts(
  plan: NameTranslationPlan
): Promise<NameTranslationPlan> {
  const itemsForValidation = prepareItemsForConflictValidation(plan.items);
  const existingTargetPaths = await collectExistingTargetPaths(itemsForValidation);
  const nextItems = validatePlanItems(itemsForValidation, plan.options, {
    existingTargetPaths,
  });
  return rebuildPlan(plan, nextItems);
}

function prepareItemsForConflictValidation(
  items: NameTranslationPlanItem[]
): NameTranslationPlanItem[] {
  return items.map((item) => {
    if (
      item.status !== "blocked" ||
      !item.reason ||
      !REVALIDATABLE_BLOCK_REASONS.has(item.reason)
    ) {
      return item;
    }

    return {
      ...item,
      status: "ready",
      reason: undefined,
      warnings: stripValidationWarnings(item.warnings),
    };
  });
}

async function collectExistingTargetPaths(
  items: NameTranslationPlanItem[]
): Promise<string[]> {
  const candidates = new Map<string, string>();
  for (const item of items) {
    if (item.status === "blocked" || item.status === "skipped") continue;
    if (item.sourcePath === item.targetPath) continue;
    candidates.set(item.targetPath, item.targetPath);
  }
  const targetPaths = [...candidates.values()];
  if (targetPaths.length === 0) return [];

  try {
    const batchResult = await checkRenameTargetsExist(targetPaths);
    return [...batchResult.existingPaths].filter((targetPath) =>
      candidates.has(targetPath)
    );
  } catch {
    // Older app shells may not have the batch IPC; keep the single-path fallback.
  }

  const existing: string[] = [];
  await Promise.all(
    targetPaths.map(async (targetPath) => {
      try {
        if (await checkRenameTargetExists(targetPath)) existing.push(targetPath);
      } catch {
        // Full filesystem validation is run through validate-rename-plan.
      }
    })
  );
  return existing;
}

function markValidationErrors(
  plan: NameTranslationPlan,
  validation: ValidateRenamePlanResult
): NameTranslationPlan {
  const errorsByItemId = new Map(
    validation.errors
      .filter((error) => error.itemId)
      .map((error) => [error.itemId as string, error])
  );

  const nextItems = plan.items.map((item) => {
    const error = errorsByItemId.get(item.id);
    if (!error) return item;
    return {
      ...item,
      status: "blocked" as const,
      reason: error.code,
      warnings: addUniqueWarning(item.warnings, error.code),
    };
  });

  return rebuildPlan(plan, nextItems);
}

function markApplyResult(
  plan: NameTranslationPlan,
  result: NameTranslationApplyResult
): NameTranslationPlan {
  const failures = new Map(result.failures.map((failure) => [failure.itemId, failure]));

  const nextItems = plan.items.map((item) => {
    if (item.status !== "ready") return item;
    const failure = failures.get(item.id);
    if (failure) {
      return {
        ...item,
        status: "failed" as const,
        reason: failure.error,
        warnings: addUniqueWarning(item.warnings, "apply_failed"),
      };
    }
    return {
      ...item,
      status: "applied" as const,
    };
  });

  return rebuildPlan(plan, nextItems, false);
}

function rebuildPlan(
  plan: NameTranslationPlan,
  items: NameTranslationPlanItem[],
  applyableOverride?: boolean
): NameTranslationPlan {
  const readyCount = items.filter((item) => item.status === "ready").length;
  const blockedCount = items.filter((item) => item.status === "blocked").length;
  const skippedCount = items.filter((item) => item.status === "skipped").length;
  const unchangedCount = items.filter((item) => item.status === "unchanged").length;
  const applyable =
    applyableOverride ??
    (!plan.clarificationRequired &&
      readyCount > 0 &&
      blockedCount === 0 &&
      items.length > 0);

  return {
    ...plan,
    items,
    itemsPreview: items.slice(0, plan.previewLimit),
    itemsStored: items.length > plan.previewLimit,
    totalTargets: Math.max(plan.totalTargets, items.length),
    readyCount,
    blockedCount,
    skippedCount,
    unchangedCount,
    applyable,
  };
}

function commitPlan(
  set: (partial: Partial<NameTranslatorStore>) => void,
  plan: NameTranslationPlan,
  extraState: Partial<NameTranslatorStore> = {}
) {
  if (getNameTranslationPlan(plan.planId)) {
    updateNameTranslationPlan(plan);
  } else {
    rememberNameTranslationPlan(plan);
  }
  set({
    currentPlan: plan,
    ...extraState,
  });
}

function createPlanFromSummary(
  summary: NameTranslationPlanSummary,
  options: NameTranslationOptions
): NameTranslationPlan {
  const incomplete = summary.itemsPreview.length < summary.totalTargets;
  return {
    ...summary,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    options,
    roots: options.roots,
    items: summary.itemsPreview,
    itemsStored: false,
    applyable: incomplete ? false : summary.applyable,
  };
}

function isPlanIncomplete(plan: NameTranslationPlan): boolean {
  return !plan.itemsStored && plan.items.length < plan.totalTargets;
}

function collectOriginalSuggestions(
  items: NameTranslationPlanItem[]
): Record<string, OriginalSuggestion> {
  return Object.fromEntries(
    items.map((item) => [
      item.id,
      {
        newName: item.newName,
        targetPath: item.targetPath,
        translatedStem: item.translatedStem,
      },
    ])
  );
}

async function restoreSelectedPaths(
  plan: NameTranslationPlan,
  roots: string[]
): Promise<SelectedPath[]> {
  if (roots.length === 0) return [];

  let inspected: InspectedRenamePath[] = [];
  try {
    inspected = await inspectRenamePaths(roots);
  } catch {
    inspected = [];
  }

  const inspectedByPath = new Map(
    inspected.map((item) => [item.path, item])
  );

  return roots.map(
    (root) => inspectedByPath.get(root) ?? createFallbackSelectedPath(plan, root)
  );
}

function createFallbackSelectedPath(
  plan: NameTranslationPlan,
  root: string
): SelectedPath {
  const matchingItem = plan.items.find((item) => samePath(item.sourcePath, root));
  return {
    path: root,
    exists: true,
    kind: matchingItem?.kind ?? "other",
    basename: pathBasename(root),
    parentPath: pathDirname(root),
    riskLevel: "warning",
    warnings: ["path_not_reinspected"],
  };
}

function getPlanRoots(plan: NameTranslationPlan): string[] {
  const roots = plan.roots.length > 0 ? plan.roots : plan.options.roots;
  return [...new Set(roots.filter(Boolean))];
}

function hasSelectedRoots(selectedPaths: SelectedPath[], roots: string[]): boolean {
  if (selectedPaths.length !== roots.length) return false;
  return roots.every((root) => selectedPaths.some((item) => samePath(item.path, root)));
}

function shortPlanId(planId: string): string {
  return planId.length > 18 ? `...${planId.slice(-12)}` : planId;
}

function addUniqueWarning(warnings: string[], warning: string): string[] {
  return warnings.includes(warning) ? warnings : [...warnings, warning];
}

function createCancelledPlanningProgress(): NameTranslationPlanningProgress {
  return {
    phase: "cancelled",
    message: i18n.t("rename:messages.planning_cancelled"),
  };
}

function isPlanningCancelled(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "planning_cancelled"
  );
}

function recomposeItemNames(
  items: NameTranslationPlanItem[],
  options: NameTranslationOptions
): NameTranslationPlanItem[] {
  return items.map((item) => {
    if (item.status === "skipped" || item.status === "blocked") return item;

    const originalStem = pathStem(item.originalName);
    const extension =
      item.kind === "file" ? item.originalName.slice(originalStem.length) : "";

    const fakeTarget: NameTranslationTarget = {
      id: item.targetId,
      kind: item.kind,
      absolutePath: item.sourcePath,
      parentPath: item.sourceParentPath,
      originalName: item.originalName,
      stem: originalStem,
      extension,
      depthFromRoot: 0,
      anchorRoot: "",
    };

    const sanitized = sanitizeTranslatedName(
      fakeTarget,
      item.translatedStem,
      options
    );
    if (!sanitized.valid) return item;

    const newTargetPath = joinPath(item.sourceParentPath, sanitized.newName);
    return {
      ...item,
      newName: sanitized.newName,
      targetPath: newTargetPath,
      status: samePath(item.sourcePath, newTargetPath) ? "unchanged" : "ready",
    };
  });
}

function getIpcRenderer(): Window["ipcRenderer"] {
  if (typeof window === "undefined" || !window.ipcRenderer) {
    throw new Error(i18n.t("rename:messages.ipc_unavailable"));
  }
  return window.ipcRenderer;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { isPlanIncomplete };
export default useNameTranslatorStore;
