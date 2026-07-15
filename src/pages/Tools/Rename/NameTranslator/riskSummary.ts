import type {
  NameTranslationPlan,
  NameTranslationPlanItem,
} from "@/services/rename/nameTypes";

export type RenameRiskReason =
  | "directories"
  | "descendants"
  | "path_segments"
  | "large_batch"
  | "warnings";

export interface RenameWarningDetail {
  source: "plan" | "item";
  message: string;
  itemId?: string;
  itemKind?: NameTranslationPlanItem["kind"];
  itemName?: string;
}

export interface RenameRiskSummary {
  hasRisk: boolean;
  reasons: RenameRiskReason[];
  readyCount: number;
  fileCount: number;
  directoryCount: number;
  warningCount: number;
  warningDetails: RenameWarningDetail[];
}

export function getRenameWarningDetails(
  plan: NameTranslationPlan | null
): RenameWarningDetail[] {
  if (!plan) return [];

  const planWarnings = plan.warnings.map((message) => ({
    source: "plan" as const,
    message,
  }));
  const itemWarnings = plan.items
    .filter((item) => item.status === "ready")
    .flatMap((item) =>
      item.warnings.map((message) => ({
        source: "item" as const,
        message,
        itemId: item.id,
        itemKind: item.kind,
        itemName: formatItemName(item),
      }))
    );

  return [...planWarnings, ...itemWarnings];
}

export function getRiskSummary(
  plan: NameTranslationPlan | null
): RenameRiskSummary {
  if (!plan) {
    return {
      hasRisk: false,
      reasons: [],
      readyCount: 0,
      fileCount: 0,
      directoryCount: 0,
      warningCount: 0,
      warningDetails: [],
    };
  }

  const readyItems = plan.items.filter((item) => item.status === "ready");
  const directoryCount = readyItems.filter(
    (item) => item.kind === "directory"
  ).length;
  const fileCount = readyItems.filter((item) => item.kind === "file").length;
  const warningDetails = getRenameWarningDetails(plan);
  const reasons: RenameRiskReason[] = [];

  if (directoryCount > 0) reasons.push("directories");
  if (plan.options.scope === "descendants") reasons.push("descendants");
  if (plan.options.scope === "path_segments") reasons.push("path_segments");
  if (readyItems.length > 100) reasons.push("large_batch");
  if (warningDetails.length > 0) reasons.push("warnings");

  return {
    hasRisk: reasons.length > 0,
    reasons,
    readyCount: readyItems.length,
    fileCount,
    directoryCount,
    warningCount: warningDetails.length,
    warningDetails,
  };
}

function formatItemName(item: NameTranslationPlanItem): string {
  if (!item.newName || item.originalName === item.newName) {
    return item.originalName;
  }
  return `${item.originalName} → ${item.newName}`;
}
