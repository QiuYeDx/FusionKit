import { TaskStatus, type SubtitleTranslatorTask } from "@/type/subtitle";

export interface SubtitleUsageStats {
  readonly actualTokens: number;
  readonly calculatedCost?: number;
  readonly remainingEstimatedCost: number;
  readonly hasPartialUsage: boolean;
  readonly taskCount: number;
  readonly hasLoading: boolean;
}

type UsageStatsTask = Pick<
  SubtitleTranslatorTask,
  "status" | "actualUsage" | "costEstimate"
>;

export function calculateSubtitleUsageStats(
  tasks: readonly UsageStatsTask[],
): SubtitleUsageStats {
  let actualTokens = 0;
  let calculatedCost = 0;
  let remainingEstimatedCost = 0;
  let hasPartialUsage = false;
  let hasUnpricedActualUsage = false;

  for (const task of tasks) {
    const usage = task.actualUsage;
    if (usage && usage.requestCount > 0) {
      actualTokens += usage.totalTokens;
      hasPartialUsage ||= usage.reportedRequestCount < usage.requestCount;
      if (usage.calculatedCost === undefined) {
        hasUnpricedActualUsage = true;
      } else {
        calculatedCost += usage.calculatedCost;
      }
    }

    if (!task.costEstimate) continue;
    if (
      task.status === TaskStatus.NOT_STARTED ||
      task.status === TaskStatus.WAITING
    ) {
      remainingEstimatedCost += task.costEstimate.estimatedCost || 0;
    } else if (task.status === TaskStatus.PENDING) {
      remainingEstimatedCost += Math.max(
        (task.costEstimate.estimatedCost || 0) -
          (usage?.calculatedCost ?? 0),
        0,
      );
    }
  }

  return {
    actualTokens,
    calculatedCost: hasUnpricedActualUsage ? undefined : calculatedCost,
    remainingEstimatedCost,
    hasPartialUsage,
    taskCount: tasks.length,
    hasLoading: tasks.some((task) => task.costEstimate?.loading),
  };
}
