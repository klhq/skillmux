import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SKILL_ID_PATTERN } from "./vault";

export interface DiscoveredSkill {
  skillId: string;
  /** Path of the skill directory inside the repository, "/"-separated. */
  path: string;
  dir: string;
}

export interface InvalidSkillDir {
  path: string;
  reason: string;
}

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const MAX_DEPTH = 8;

/**
 * Finds every directory in a clone that holds a SKILL.md. A skill directory is
 * a leaf of the search: what sits inside it is that skill's supporting files,
 * not more skills. Symlinked directories are never followed, so a repository
 * cannot point the walk at content outside the clone. A directory whose name
 * is not a valid skill id, or whose id an earlier directory already took, is
 * reported as invalid instead of being dropped without a word.
 */
export function discoverSkills(cloneDir: string): { skills: DiscoveredSkill[]; invalid: InvalidSkillDir[] } {
  const skills: DiscoveredSkill[] = [];
  const invalid: InvalidSkillDir[] = [];
  const claimed = new Map<string, string>();

  const walk = (dir: string, relative: string, depth: number) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = join(dir, entry.name);
      if (existsSync(join(absolute, "SKILL.md"))) {
        if (!SKILL_ID_PATTERN.test(entry.name)) {
          invalid.push({ path, reason: `"${entry.name}" is not a valid skill id` });
        } else if (claimed.has(entry.name)) {
          invalid.push({ path, reason: `skill id "${entry.name}" is already taken by ${claimed.get(entry.name)}` });
        } else {
          claimed.set(entry.name, path);
          skills.push({ skillId: entry.name, path, dir: absolute });
        }
        continue;
      }
      if (depth < MAX_DEPTH) walk(absolute, path, depth + 1);
    }
  };

  walk(cloneDir, "", 1);
  return { skills, invalid };
}
