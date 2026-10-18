import { describe, expect, it } from "vitest";
import { readStudioNavigationResources, readStudioNavigationView, studioNavigationPath, studioResourcesPath } from "./navigation";

describe("Studio workspace navigation hints", () => {
  it.each(["documents", "transcription"] as const)("accepts only the %s workspace", view => {
    expect(readStudioNavigationView(studioNavigationPath(view).split("?")[1])).toBe(view);
  });
  it.each(["", "?view=task&taskId=123", "?view=documents&view=transcription", "?view=https://example.com", "?view=DOCUMENTS"])("ignores unknown or ambiguous hints: %s", search => {
    expect(readStudioNavigationView(search)).toBeNull();
  });
  it("opens the transcription workspace with its resource manager", () => {
    const search = studioResourcesPath().split("?")[1];
    expect(readStudioNavigationView(search)).toBe("transcription");
    expect(readStudioNavigationResources(search)).toBe(true);
    expect(readStudioNavigationResources("view=transcription")).toBe(false);
    expect(readStudioNavigationResources("resources=open&resources=open")).toBe(false);
    expect(readStudioNavigationResources("resources=1")).toBe(false);
  });
});
