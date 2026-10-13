import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSkill, SKILL_TEXT, skillPath, skillStatus } from "../../electron/main/external-agent/skill";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const home = async () => { const root = await mkdtemp(path.join(os.tmpdir(), "fk-skill-")); roots.push(root); return root; };

describe("bundled skill", () => {
  it("is the repository's SKILL.md with a name and description", async () => {
    const repository = (await readFile(path.resolve(".agents/skills/fusionkit-app/SKILL.md"), "utf8")).replace(/\r\n/g, "\n");
    expect(SKILL_TEXT).toBe(repository);
    expect(SKILL_TEXT).toMatch(/^---\nname: fusionkit-app\ndescription: .+\n/);
    expect(SKILL_TEXT).toContain("Settings → External Agent");
    expect(SKILL_TEXT).toContain("get_confirmation_result");
  });

  it("installs for Claude Code and Codex, replacing an older copy", async () => {
    const root = await home();
    expect(await skillStatus("claude", root)).toEqual({ target: "claude", path: path.join(root, ".claude", "skills", "fusionkit-app", "SKILL.md"), installed: false, current: false });
    await mkdir(path.dirname(skillPath("codex", root)), { recursive: true });
    await writeFile(skillPath("codex", root), "old version");
    expect(await skillStatus("codex", root)).toMatchObject({ installed: true, current: false });
    for (const target of ["claude", "codex"] as const) {
      expect(await installSkill(target, root)).toMatchObject({ target, installed: true, current: true });
      expect(await readFile(skillPath(target, root), "utf8")).toBe(SKILL_TEXT);
    }
    expect(skillPath("codex", root)).toBe(path.join(root, ".codex", "skills", "fusionkit-app", "SKILL.md"));
    await expect(installSkill("other" as never, root)).rejects.toThrow("invalid_skill_target");
  });
});
