import { describe, expect, it } from "vitest";
import { queueTranslateSchema } from "./tool-schemas";

describe("queue translate schema", () => {
  it("accepts custom translation slice length", () => {
    const parsed = queueTranslateSchema.parse({
      scanId: "scan_abc",
      sliceType: "CUSTOM",
      customSliceLength: 1200,
    });

    expect(parsed.sliceType).toBe("CUSTOM");
    expect(parsed.customSliceLength).toBe(1200);
  });

  it("keeps queue defaults when custom slicing is not requested", () => {
    const parsed = queueTranslateSchema.parse({
      scanId: "scan_abc",
    });

    expect(parsed.sliceType).toBe("NORMAL");
    expect(parsed.customSliceLength).toBeUndefined();
  });
});
