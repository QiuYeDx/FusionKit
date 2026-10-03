import { describe, expect, it } from "vitest";
import { readStudioNavigationView, studioNavigationPath } from "./navigation";

describe("Studio workspace navigation hints", () => {
  it.each(["documents", "transcription"] as const)("accepts only the %s workspace", view => {
    expect(readStudioNavigationView(studioNavigationPath(view).split("?")[1])).toBe(view);
  });
  it.each(["", "?view=task&taskId=123", "?view=documents&view=transcription", "?view=https://example.com", "?view=DOCUMENTS"])("ignores unknown or ambiguous hints: %s", search => {
    expect(readStudioNavigationView(search)).toBeNull();
  });
});
