import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SKILL_ID_PATTERN } from "./vault";
import { readSkrMarker } from "./sync";

export const DEFAULT_SURFACE_CANDIDATES = ["~/.claude/skills", "~/.agents/skills"];

export interface SurfaceCandidate {
  path: string;
  exists: boolean;
  isSymlink: boolean;
  skillCount: number;
  alreadyMarked: boolean;
}

function countSkillDirs(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKILL_ID_PATTERN.test(entry.name) && existsSync(join(dir, entry.name, "SKILL.md"))) {
      count++;
    }
  }
  return count;
}

export function detectSurfaces(candidatePaths: string[]): SurfaceCandidate[] {
  return candidatePaths.map((path) => {
    if (!existsSync(path)) {
      return { path, exists: false, isSymlink: false, skillCount: 0, alreadyMarked: false };
    }
    return {
      path,
      exists: true,
      isSymlink: lstatSync(path).isSymbolicLink(),
      skillCount: countSkillDirs(path),
      alreadyMarked: readSkrMarker(path) !== null,
    };
  });
}
