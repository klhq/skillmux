import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { serializeManifest, type Manifest, MANIFEST_FILENAME } from "./manifest";
import { adoptTarget, readSkillmuxMarker } from "./sync";
import { SKILL_ID_PATTERN } from "./vault";

export const DEFAULT_SURFACE_CANDIDATES = ["~/.claude/skills", "~/.agents/skills"];

/**
 * Test/ops escape hatch: comma-separated absolute paths overriding
 * DEFAULT_SURFACE_CANDIDATES. Not part of config.toml — "others as
 * configured" (spec.md) is deliberately left as an implementation-time
 * choice, same as the proposal heuristic. Exists primarily so tests never
 * probe the real $HOME's ~/.claude/skills or ~/.agents/skills.
 */
export function surfaceCandidates(): string[] {
  const override = process.env.SKILLMUX_INIT_SURFACES;
  return override ? override.split(",").filter((p) => p.length > 0) : DEFAULT_SURFACE_CANDIDATES;
}

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
      alreadyMarked: readSkillmuxMarker(path) !== null,
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

  writeFileSync(join(vaultPath, MANIFEST_FILENAME), serializeManifest(manifest));

  for (const target of confirmedTargets) {
    if (!existsSync(target.dir)) mkdirSync(target.dir, { recursive: true });
    adoptTarget(target.dir, target.name);
  }

  return manifest;
}

/** Verbatim from docs/sdd/skr-cli/think.md §3.3 — the shared instruction-stack paragraph. */
export const DISCOVERY_PARAGRAPH =
  "Skills: only a curated core is loaded statically. Before improvising a " +
  "multi-step workflow, or when a task smells like a domain you have no loaded " +
  "skill for (career/resume, trading, SEO, i18n, design, one-off tooling), " +
  "call `resolve_skill` with a one-line task description. `matched` → follow " +
  "the returned SKILL.md. `ambiguous` → pick from the candidates and " +
  "`fetch_skill`. `no_match` → proceed normally; don't force an unrelated " +
  "skill.";

export const MCP_REGISTRATION_SNIPPET = JSON.stringify(
  { mcpServers: { "skillmux": { command: "skillmux", args: ["serve"] } } },
  null,
  2,
);

/** §3.4 step 4: "print the last mile" — MCP registration command + discovery paragraph. */
export function printLastMile(): string {
  return [
    "Register with your MCP client:",
    MCP_REGISTRATION_SNIPPET,
    "",
    "Add this paragraph to your shared agent instructions (~80 tokens, the entire T3 discovery mechanism):",
    DISCOVERY_PARAGRAPH,
  ].join("\n");
}
