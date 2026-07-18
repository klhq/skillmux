import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { serializeManifest, type Manifest } from "./manifest";
import { adoptTarget, readSkrMarker } from "./sync";
import { SKILL_ID_PATTERN } from "./vault";

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

/**
 * Conservative default: no slash-command/workflow-router detection heuristic
 * at TDD time (spec.md, "skr init" AC) — evidence-only, nothing proposed
 * until a concrete heuristic is agreed.
 */
export function proposeManifest(_candidates: SurfaceCandidate[]): Pick<Manifest, "core" | "project"> {
  return { core: { skills: [] }, project: {} };
}

/** e.g. ~/.claude/skills -> "claude"; ~/.agents/skills -> "agents". */
export function deriveTargetName(path: string): string {
  return basename(dirname(path)).replace(/^\./, "").toLowerCase();
}

export interface ConfirmedTarget {
  name: string;
  dir: string;
}

/**
 * Writes skr.toml with the conservative-default core/project and the
 * confirmed targets, then adopts each confirmed dir in place (creating it
 * first if it doesn't exist yet). Unconfirmed candidates are simply never
 * passed in — this function never discovers paths on its own.
 */
export function applyInit(vaultPath: string, confirmedTargets: ConfirmedTarget[]): Manifest {
  const manifest: Manifest = {
    ...proposeManifest([]),
    targets: Object.fromEntries(
      confirmedTargets.map((target) => [target.name, { dir: target.dir, project: false }]),
    ),
  };

  writeFileSync(join(vaultPath, "skr.toml"), serializeManifest(manifest));

  for (const target of confirmedTargets) {
    if (!existsSync(target.dir)) mkdirSync(target.dir, { recursive: true });
    adoptTarget(target.dir, target.name);
  }

  return manifest;
}
