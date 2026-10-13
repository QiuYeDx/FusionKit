import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import skill from "../../../.agents/skills/fusionkit-app/SKILL.md?raw";
import type { ExternalSkillStatus, ExternalSkillTarget } from "../../../src/agent/external/contract";

export const SKILL_NAME = "fusionkit-app";
/** The bundled skill, with the line endings it is distributed with. */
export const SKILL_TEXT = skill.replace(/\r\n/g, "\n");

/**
 * Where agents read user skills from: Claude Code from ~/.claude/skills, Codex, Cursor
 * and other agents from the shared ~/.agents/skills. Tests point HOME elsewhere.
 */
export function skillPath(target: ExternalSkillTarget, home = process.env.FUSIONKIT_EXTERNAL_AGENT_HOME || os.homedir()): string {
  return path.join(home, target === "claude" ? ".claude" : ".agents", "skills", SKILL_NAME, "SKILL.md");
}

export async function skillStatus(target: ExternalSkillTarget, home?: string): Promise<ExternalSkillStatus> {
  const file = skillPath(target, home);
  try {
    const text = await readFile(file, "utf8");
    return { target, path: file, installed: true, current: text.replace(/\r\n/g, "\n") === SKILL_TEXT };
  } catch {
    return { target, path: file, installed: false, current: false };
  }
}

/** Writes the bundled skill for one agent, replacing an older copy whole. */
export async function installSkill(target: ExternalSkillTarget, home?: string): Promise<ExternalSkillStatus> {
  if (target !== "claude" && target !== "agents") throw new Error("invalid_skill_target");
  const file = skillPath(target, home);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, SKILL_TEXT, "utf8");
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return skillStatus(target, home);
}
