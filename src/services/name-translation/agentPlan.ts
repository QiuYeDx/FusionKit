import type {
  NameDirectoryListing,
  NameEntry,
  NameEntryKind,
  NameIssueCode,
  NameLanguage,
  NameSourceLanguage,
} from "@/name-translation/contract";
import { legacyFormatTemplate, type NameFormat } from "@/name-translation/naming-rules";
import type { NameTranslatorConfig } from "@/store/tools/rename/nameTranslatorConfig";
import useModelStore from "@/store/useModelStore";
import { getNameTranslationApi, rendererPlatform, toRuntimeModel, unwrap } from "./api";
import { translateTargets } from "./translate";
import {
  computeRowStates,
  settingsKeyOf,
  type DirectoryState,
  type Proposal,
} from "./workspace";

/**
 * HomeAgent plans reuse exactly the same engine as the tool page: listing and
 * validation in the main process, the shared translation orchestration and
 * naming rules. Plans are kept in memory and applied only after the user
 * confirms; the main process re-validates every item before renaming.
 */

export type AgentNameScope = "self" | "children" | "descendants";
export type AgentNameTargetKind = "files" | "directories" | "both";

export interface CreateAgentNamePlanArgs {
  readonly roots: readonly string[];
  readonly scope: AgentNameScope;
  readonly targetKind: AgentNameTargetKind;
  readonly includeRoots?: boolean;
  readonly includeHidden: boolean;
  readonly sourceLang: NameSourceLanguage;
  readonly targetLang: NameLanguage;
  readonly nameFormat: NameFormat;
  readonly instructions?: string;
}

export type NameTranslationPlanItemStatus = "ready" | "unchanged" | "blocked" | "failed";

export interface NameTranslationPlanItem {
  readonly id: string;
  readonly kind: NameEntryKind;
  readonly sourcePath: string;
  readonly originalName: string;
  readonly newName: string;
  readonly status: NameTranslationPlanItemStatus;
  readonly reason?: NameIssueCode | "translation_failed";
}

export interface NameTranslationPlanSummary {
  readonly planId: string;
  readonly totalTargets: number;
  readonly previewLimit: number;
  readonly itemsPreview: readonly NameTranslationPlanItem[];
  readonly readyCount: number;
  readonly blockedCount: number;
  readonly skippedCount: number;
  readonly unchangedCount: number;
  readonly warnings: readonly string[];
  readonly applyable: boolean;
}

export interface NameTranslationApplyResult {
  readonly planId: string;
  readonly journalId: string;
  readonly totalCount: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly rolledBack: boolean;
  readonly message?: string;
}

interface StoredPlan {
  readonly summary: NameTranslationPlanSummary;
  readonly createdAt: number;
  readonly roots: readonly string[];
  readonly entries: readonly NameEntry[];
  readonly listings: readonly NameDirectoryListing[];
  readonly items: readonly NameTranslationPlanItem[];
  readonly identities: Readonly<Record<string, string>>;
  readonly proposals: Readonly<Record<string, Proposal>>;
  readonly settings: Partial<NameTranslatorConfig>;
}

const PLAN_TTL_MS = 30 * 60 * 1000;
const MAX_PLANS = 10;
const PREVIEW_LIMIT = 200;
const plans = new Map<string, StoredPlan>();

function prunePlans(now = Date.now()): void {
  for (const [planId, plan] of plans) {
    if (now - plan.createdAt > PLAN_TTL_MS) plans.delete(planId);
  }
  while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value!);
}

function matchesKind(entry: NameEntry, kind: AgentNameTargetKind): boolean {
  return kind === "both" || (kind === "files" ? entry.kind === "file" : entry.kind === "directory");
}

export async function createAgentNamePlan(
  args: CreateAgentNamePlanArgs,
  signal?: AbortSignal,
): Promise<NameTranslationPlanSummary> {
  const api = getNameTranslationApi();
  const model = toRuntimeModel(useModelStore.getState().getTaskProfile());
  if (!model) throw new Error("未配置任务执行模型，请在设置页面配置。");

  const inspected = await unwrap(api.inspectPaths({ paths: args.roots, source: "agent" }));
  const warnings = inspected.rejected.map((rejection) => `${rejection.reason}: ${rejection.path}`);
  const entries = new Map<string, NameEntry>();
  inspected.entries.forEach((entry) => entries.set(entry.path, entry));
  const listings: NameDirectoryListing[] = [];
  let targets: NameEntry[] = [];

  if (args.scope === "self") {
    targets = [...inspected.entries];
  } else {
    for (const root of inspected.entries) {
      signal?.throwIfAborted();
      if (root.kind !== "directory" || root.symlink) continue;
      if (args.scope === "children") {
        const listing = await unwrap(api.listDirectory({ path: root.path, includeHidden: args.includeHidden }));
        listings.push(listing);
      } else {
        const collected = await unwrap(api.collectDescendants({ path: root.path, includeHidden: args.includeHidden }));
        listings.push(...collected.directories);
        if (collected.truncated) warnings.push(`truncated: ${root.path}`);
      }
    }
    if (args.includeRoots) targets.push(...inspected.entries);
    for (const listing of listings) {
      for (const entry of listing.entries) {
        entries.set(entry.path, entry);
        if (matchesKind(entry, args.targetKind)) targets.push(entry);
      }
    }
  }
  signal?.throwIfAborted();

  const settingsKey = settingsKeyOf({
    sourceLang: args.sourceLang,
    targetLang: args.targetLang,
    instructions: args.instructions ?? "",
  });
  const proposals: Record<string, Proposal> = {};
  const requestId = `agent-${Date.now().toString(36)}`;
  const abort = () => void api.cancelTranslate({ requestId }).catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  let outcome;
  try {
    outcome = await translateTargets({
      targets: targets.map((entry) => ({ key: entry.path, name: entry.name, kind: entry.kind, parentPath: entry.parentPath })),
      settings: { model, sourceLang: args.sourceLang, targetLang: args.targetLang, instructions: args.instructions },
      requestId,
      translateBatch: (request) => api.translate(request),
      isCancelled: () => Boolean(signal?.aborted),
      onResult: (key, stem) => {
        proposals[key] = stem === null ? { failed: true } : { stem, settingsKey };
      },
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  signal?.throwIfAborted();
  if (outcome.fatal) throw new Error(outcome.fatal.message);

  const entryRecord = Object.fromEntries(entries);
  const dirs: Record<string, DirectoryState> = {};
  for (const listing of listings) {
    dirs[listing.path] = { status: "loaded", children: listing.entries.map((entry) => entry.path), truncated: listing.truncated };
  }
  const checked = Object.fromEntries(targets.map((entry) => [entry.path, true as const]));
  const states = computeRowStates(
    { roots: inspected.entries.map((entry) => entry.path), entries: entryRecord, dirs, checked, proposals, serverIssues: {} },
    { template: legacyFormatTemplate(args.nameFormat), settingsKey, platform: rendererPlatform() },
  );

  const readyPaths = targets.filter((entry) => states.get(entry.path)?.status === "ready").map((entry) => entry.path);
  const serverIssues = new Map<string, NameIssueCode>();
  if (readyPaths.length > 0) {
    const renameItems = readyPaths.map((path) => ({
      path,
      kind: entryRecord[path]!.kind,
      identity: entryRecord[path]!.identity,
      newName: states.get(path)!.proposedName!,
    }));
    const preflight = await unwrap(api.preflight({ items: renameItems }));
    preflight.items.forEach((item, index) => {
      if (item.status === "issue" && item.issue) serverIssues.set(renameItems[index]!.path, item.issue);
    });
  }

  const items: NameTranslationPlanItem[] = targets.map((entry, index) => {
    const state = states.get(entry.path);
    const serverIssue = serverIssues.get(entry.path);
    const base = {
      id: String(index + 1),
      kind: entry.kind,
      sourcePath: entry.path,
      originalName: entry.name,
      newName: state?.proposedName ?? entry.name,
    };
    if (state?.status === "failed" || state?.proposedName === undefined) {
      return { ...base, status: "failed", reason: "translation_failed" };
    }
    if (state.status === "unchanged") return { ...base, status: "unchanged" };
    if (state.status === "issue" || serverIssue) {
      return { ...base, status: "blocked", reason: serverIssue ?? state.issue };
    }
    return { ...base, status: "ready" };
  });

  const readyCount = items.filter((item) => item.status === "ready").length;
  const planId = `name_plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const summary: NameTranslationPlanSummary = {
    planId,
    totalTargets: items.length,
    previewLimit: PREVIEW_LIMIT,
    itemsPreview: items.slice(0, PREVIEW_LIMIT),
    readyCount,
    blockedCount: items.filter((item) => item.status === "blocked").length,
    skippedCount: items.filter((item) => item.status === "failed").length,
    unchangedCount: items.filter((item) => item.status === "unchanged").length,
    warnings,
    applyable: readyCount > 0,
  };
  prunePlans();
  plans.set(planId, {
    summary,
    createdAt: Date.now(),
    roots: inspected.entries.map((entry) => entry.path),
    entries: [...entries.values()],
    listings,
    items,
    identities: Object.fromEntries([...entries.values()].map((entry) => [entry.path, entry.identity])),
    proposals,
    settings: {
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      instructions: args.instructions ?? "",
      includeHidden: args.includeHidden,
      ...(args.nameFormat === "translated"
        ? { nameMode: "translated" as const }
        : {
            nameMode: "bilingual" as const,
            bilingualStyle: "paren" as const,
            bilingualOrder: args.nameFormat === "translated_original" ? ("translated_first" as const) : ("original_first" as const),
          }),
    },
  });
  return summary;
}

export function getAgentNamePlan(planId: string): StoredPlan | null {
  prunePlans();
  return plans.get(planId) ?? null;
}

export async function applyAgentNamePlan(planId: string): Promise<NameTranslationApplyResult> {
  const plan = getAgentNamePlan(planId);
  if (!plan) throw new Error("重命名计划已过期或不存在，请重新生成预览。");
  const ready = plan.items.filter((item) => item.status === "ready");
  if (ready.length === 0) throw new Error("当前计划没有可重命名的条目。");
  const result = await unwrap(
    getNameTranslationApi().apply({
      items: ready.map((item) => ({
        path: item.sourcePath,
        kind: item.kind,
        identity: plan.identities[item.sourcePath] ?? "",
        newName: item.newName,
      })),
    }),
  );
  plans.delete(planId);
  const skippedCount = plan.items.length - ready.length;
  if (result.status === "completed") {
    return {
      planId,
      journalId: result.journalId,
      totalCount: plan.items.length,
      successCount: result.renamed.length,
      failedCount: 0,
      skippedCount,
      rolledBack: false,
    };
  }
  if (result.status === "rejected") {
    throw new Error("部分条目在预览后已发生变化，请重新生成预览。");
  }
  return {
    planId,
    journalId: result.journalId ?? "",
    totalCount: plan.items.length,
    successCount: 0,
    failedCount: ready.length,
    skippedCount,
    rolledBack: result.rollback === "complete",
    message: result.message,
  };
}

/** Hands a plan to the tool page so the user can review and edit it there. */
export function toWorkspaceSession(planId: string) {
  const plan = getAgentNamePlan(planId);
  if (!plan) return null;
  return {
    roots: plan.roots,
    entries: plan.entries,
    listings: plan.listings,
    checked: plan.items.filter((item) => item.status !== "unchanged").map((item) => item.sourcePath),
    proposals: plan.proposals,
    settings: plan.settings,
  };
}

export function clearAgentNamePlansForTest(): void {
  plans.clear();
}
