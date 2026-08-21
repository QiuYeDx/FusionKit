import { describe, expect, it } from "vitest";
import { TaskStatus } from "@/type/subtitle";
import { calculateSubtitleUsageStats } from "./subtitleUsageStats";

const estimate = {
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  estimatedCost: 1,
  fragmentCount: 2,
};

describe("calculateSubtitleUsageStats", () => {
  it("separates actual usage from remaining estimates", () => {
    expect(calculateSubtitleUsageStats([
      {
        status: TaskStatus.PENDING,
        costEstimate: estimate,
        actualUsage: {
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          reasoningTokens: 2,
          cachedInputTokens: 4,
          requestCount: 1,
          reportedRequestCount: 1,
          calculatedCost: 0.25,
        },
      },
      { status: TaskStatus.WAITING, costEstimate: estimate },
      {
        status: TaskStatus.RESOLVED,
        costEstimate: estimate,
        actualUsage: {
          inputTokens: 40,
          outputTokens: 20,
          totalTokens: 60,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          requestCount: 2,
          reportedRequestCount: 1,
          calculatedCost: 0.5,
        },
      },
    ])).toEqual({
      actualTokens: 90,
      calculatedCost: 0.75,
      remainingEstimatedCost: 1.75,
      hasPartialUsage: true,
      taskCount: 3,
      hasLoading: false,
    });
  });

  it("does not display a misleading zero when actual usage is unpriced", () => {
    const stats = calculateSubtitleUsageStats([{
      status: TaskStatus.RESOLVED,
      actualUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        requestCount: 1,
        reportedRequestCount: 1,
      },
    }]);

    expect(stats.actualTokens).toBe(15);
    expect(stats.calculatedCost).toBeUndefined();
  });
});
