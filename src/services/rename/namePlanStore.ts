import type {
  NameTranslationPlan,
  NameTranslationPlanSummary,
} from "./nameTypes";

const MAX_STORED_PLANS = 10;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const plans = new Map<string, NameTranslationPlan>();

export function rememberNameTranslationPlan(plan: NameTranslationPlan): string {
  clearExpiredNameTranslationPlans();
  plans.set(plan.planId, plan);
  trimStoredPlans();
  return plan.planId;
}

export function getNameTranslationPlan(
  planId: string
): NameTranslationPlan | null {
  clearExpiredNameTranslationPlans();
  return plans.get(planId) ?? null;
}

export function updateNameTranslationPlan(plan: NameTranslationPlan): void {
  clearExpiredNameTranslationPlans();
  if (!plans.has(plan.planId)) return;
  plans.set(plan.planId, plan);
}

export function clearExpiredNameTranslationPlans(now = Date.now()): void {
  for (const [planId, plan] of plans) {
    if (plan.expiresAt <= now) {
      plans.delete(planId);
    }
  }
}

export function summarizeNameTranslationPlan(
  plan: NameTranslationPlan
): NameTranslationPlanSummary {
  return {
    planId: plan.planId,
    totalTargets: plan.totalTargets,
    previewLimit: plan.previewLimit,
    itemsPreview: plan.itemsPreview,
    readyCount: plan.readyCount,
    blockedCount: plan.blockedCount,
    skippedCount: plan.skippedCount,
    unchangedCount: plan.unchangedCount,
    warnings: plan.warnings,
    clarificationRequired: plan.clarificationRequired,
    applyable: plan.applyable,
  };
}

export function createPlanExpiry(createdAt: number): number {
  return createdAt + DEFAULT_TTL_MS;
}

export function clearAllNameTranslationPlansForTest(): void {
  plans.clear();
}

function trimStoredPlans(): void {
  if (plans.size <= MAX_STORED_PLANS) return;

  const sortedPlans = [...plans.values()].sort(
    (a, b) => a.createdAt - b.createdAt
  );
  for (const plan of sortedPlans.slice(0, plans.size - MAX_STORED_PLANS)) {
    plans.delete(plan.planId);
  }
}
