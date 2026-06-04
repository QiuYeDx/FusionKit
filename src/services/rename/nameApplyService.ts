import { getNameTranslationPlan } from "./namePlanStore";
import type {
  NameTranslationApplyResult,
  RollbackRenameJournalResult,
  ValidateRenamePlanResult,
} from "./nameTypes";

export async function validateNameTranslationPlan(
  planId: string
): Promise<ValidateRenamePlanResult> {
  const plan = getRequiredPlan(planId);
  return getIpcRenderer().invoke("validate-rename-plan", {
    plan,
    items: plan.items,
  });
}

export async function applyNameTranslationPlan(
  planId: string
): Promise<NameTranslationApplyResult> {
  const plan = getRequiredPlan(planId);
  return getIpcRenderer().invoke("apply-rename-plan", {
    plan,
    items: plan.items,
  });
}

export async function rollbackNameTranslationJournal(
  journalId: string
): Promise<RollbackRenameJournalResult> {
  return getIpcRenderer().invoke("rollback-rename-journal", { journalId });
}

function getRequiredPlan(planId: string) {
  const plan = getNameTranslationPlan(planId);
  if (!plan) {
    throw new Error("重命名计划已过期或不存在，请重新生成预览。");
  }
  return plan;
}

function getIpcRenderer(): Window["ipcRenderer"] {
  if (typeof window === "undefined" || !window.ipcRenderer) {
    throw new Error("Electron IPC is not available in this environment.");
  }
  return window.ipcRenderer;
}
