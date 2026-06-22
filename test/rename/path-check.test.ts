import { describe, expect, it } from "vitest";
import { checkRenameTargetPaths } from "../../electron/main/rename/path-check";

describe("checkRenameTargetPaths", () => {
  it("returns existing paths, ignores missing paths, and reports per-path errors", async () => {
    const result = await checkRenameTargetPaths(
      {
        paths: ["/tmp/a.srt", "/tmp/missing.srt", "/tmp/a.srt", "/tmp/denied.srt"],
      },
      {
        stat: async (targetPath) => {
          if (targetPath.includes("missing")) {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          if (targetPath.includes("denied")) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          return {};
        },
      }
    );

    expect(result.existingPaths).toEqual(["/tmp/a.srt"]);
    expect(result.errors).toEqual([
      {
        path: "/tmp/denied.srt",
        message: "permission denied",
      },
    ]);
  });

  it("limits filesystem check concurrency", async () => {
    let active = 0;
    let peak = 0;

    await checkRenameTargetPaths(
      {
        paths: ["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d", "/tmp/e"],
        concurrency: 2,
      },
      {
        stat: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          return {};
        },
      }
    );

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });
});
