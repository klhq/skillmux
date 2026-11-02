import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import manageSkillTemplate from "./builtin-skills/skillmux-manage/SKILL.md" with { type: "text" };

/** The skill that teaches an agent how to run skillmux; shipped inside the package. */
export const MANAGE_SKILL_ID = "skillmux-manage";

/**
 * The skill text for the installed version. The version is stamped into the
 * text so that a vault copy can be told apart from the one this binary ships.
 */
export function renderManageSkill(version: string = packageJson.version): string {
  return manageSkillTemplate.replaceAll("{{version}}", version);
}

/** What installing the skill into a vault would do. */
export type ManageSkillStatus = "create" | "update" | "unchanged";

export function planManageSkill(vaultPath: string): ManageSkillStatus {
  const path = join(vaultPath, MANAGE_SKILL_ID, "SKILL.md");
  if (!existsSync(path)) return "create";
  return readFileSync(path, "utf-8") === renderManageSkill() ? "unchanged" : "update";
}

/**
 * Writes the skill into the vault and returns a function that puts back what
 * was there, so a failed init leaves the vault as it found it.
 */
export function installManageSkill(vaultPath: string): () => void {
  const dir = join(vaultPath, MANAGE_SKILL_ID);
  const path = join(dir, "SKILL.md");
  const previous = existsSync(path) ? readFileSync(path, "utf-8") : null;
  const createdDir = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderManageSkill());
  return () => {
    if (previous !== null) writeFileSync(path, previous);
    else {
      rmSync(path, { force: true });
      if (createdDir) rmSync(dir, { recursive: true, force: true });
    }
  };
}
