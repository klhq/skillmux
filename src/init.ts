import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  parseManifest,
  resolveManifestPath,
  serializeManifest,
  type Manifest,
  MANIFEST_FILENAME,
} from "./manifest";
import {
  adoptTarget,
  preflightAdoptTarget,
  readSkillmuxMarker,
  SKILLMUX_MARKER_FILENAME,
} from "./sync";
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
  canonicalPath?: string;
  exists: boolean;
  isSymlink: boolean;
  skillCount: number;
  alreadyMarked: boolean;
  state: "missing" | "directory" | "broken-symlink" | "external-symlink" | "full-vault" | "unsupported";
  deliveryMode: "managed-pins" | "full-vault" | "external";
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

export function detectSurfaces(candidatePaths: string[], vaultPath?: string): SurfaceCandidate[] {
  const canonicalVaultPath = vaultPath ? realpathSync(vaultPath) : undefined;

  return candidatePaths.map((path): SurfaceCandidate => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        path,
        exists: false,
        isSymlink: false,
        skillCount: 0,
        alreadyMarked: false,
        state: "missing",
        deliveryMode: "managed-pins",
      };
    }

    if (stat.isSymbolicLink()) {
      let canonicalPath: string;
      try {
        canonicalPath = realpathSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return {
          path,
          exists: false,
          isSymlink: true,
          skillCount: 0,
          alreadyMarked: false,
          state: "broken-symlink",
          deliveryMode: "external",
        };
      }

      const isFullVault = canonicalVaultPath !== undefined && canonicalPath === canonicalVaultPath;
      return {
        path,
        canonicalPath,
        exists: true,
        isSymlink: true,
        skillCount: 0,
        alreadyMarked: false,
        state: isFullVault ? "full-vault" : "external-symlink",
        deliveryMode: isFullVault ? "full-vault" : "external",
      };
    }

    const canonicalPath = realpathSync(path);
    const isFullVault = canonicalVaultPath !== undefined && canonicalPath === canonicalVaultPath;
    if (isFullVault) {
      return {
        path,
        canonicalPath,
        exists: true,
        isSymlink: false,
        skillCount: 0,
        alreadyMarked: false,
        state: "full-vault",
        deliveryMode: "full-vault",
      };
    }

    if (!stat.isDirectory()) {
      return {
        path,
        canonicalPath,
        exists: true,
        isSymlink: false,
        skillCount: 0,
        alreadyMarked: false,
        state: "unsupported",
        deliveryMode: "external",
      };
    }

    return {
      path,
      canonicalPath,
      exists: true,
      isSymlink: false,
      skillCount: countSkillDirs(path),
      alreadyMarked: readSkillmuxMarker(path) !== null,
      state: "directory",
      deliveryMode: "managed-pins",
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

export interface InitTransactionParticipant {
  apply: () => void;
  rollback: () => void;
}

function preflightManagedTargets(vaultPath: string, targets: ConfirmedTarget[]): void {
  const canonicalVaultPath = realpathSync(vaultPath);

  for (const target of targets) {
    let stat;
    try {
      stat = lstatSync(target.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    if (stat.isSymbolicLink()) {
      throw new Error(
        `target "${target.name}" (${target.dir}) is a symbolic link; classify or migrate it before managed-pins adoption`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`target "${target.name}" (${target.dir}) is not a directory`);
    }
    if (realpathSync(target.dir) === canonicalVaultPath) {
      throw new Error(
        `target "${target.name}" (${target.dir}) is the full-vault surface; it cannot be adopted as managed-pins`,
      );
    }
    preflightAdoptTarget(target.dir, target.name, vaultPath);
  }
}

/**
 * Writes skillmux.toml with the conservative-default core/project and the
 * confirmed targets, then adopts each confirmed dir in place (creating it
 * first if it doesn't exist yet). Unconfirmed candidates are simply never
 * passed in — this function never discovers paths on its own.
 */
export function applyInit(
  vaultPath: string,
  confirmedTargets: ConfirmedTarget[],
  participant?: InitTransactionParticipant,
): Manifest {
  preflightManagedTargets(vaultPath, confirmedTargets);

  const existingManifestPath = resolveManifestPath(vaultPath);
  const existingManifest = existingManifestPath
    ? parseManifest(readFileSync(existingManifestPath, "utf-8"))
    : { ...proposeManifest([]), targets: {} };
  const manifest: Manifest = {
    ...existingManifest,
    targets: {
      ...existingManifest.targets,
      ...Object.fromEntries(
        confirmedTargets.map((target) => {
          const existingTarget = existingManifest.targets[target.name];
          return [
            target.name,
            existingTarget
              ? { ...existingTarget, dir: target.dir }
              : { dir: target.dir, host: hostname(), project_groups: [] },
          ];
        }),
      ),
    },
  };

  const manifestPath = join(vaultPath, MANIFEST_FILENAME);
  const serializedManifest = serializeManifest(manifest);
  const shouldWriteManifest =
    !existsSync(manifestPath) || readFileSync(manifestPath, "utf-8") !== serializedManifest;
  const createdDirs: string[] = [];
  const adoptedDirs: string[] = [];
  let participantApplied = false;

  try {
    for (const target of confirmedTargets) {
      if (!existsSync(target.dir)) {
        mkdirSync(target.dir, { recursive: true });
        createdDirs.push(target.dir);
      }
      if (adoptTarget(target.dir, target.name, vaultPath).adopted) {
        adoptedDirs.push(target.dir);
      }
    }

    if (participant) {
      participant.apply();
      participantApplied = true;
    }

    if (shouldWriteManifest) {
      const temporaryManifestPath = join(
        vaultPath,
        `.${MANIFEST_FILENAME}.${process.pid}-${Date.now()}.tmp`,
      );
      try {
        writeFileSync(temporaryManifestPath, serializedManifest);
        renameSync(temporaryManifestPath, manifestPath);
      } catch (error) {
        if (existsSync(temporaryManifestPath)) unlinkSync(temporaryManifestPath);
        throw error;
      }
    }
  } catch (error) {
    try {
      if (participantApplied) participant?.rollback();
    } finally {
      for (const dir of adoptedDirs.reverse()) {
        const markerPath = join(dir, SKILLMUX_MARKER_FILENAME);
        if (existsSync(markerPath)) unlinkSync(markerPath);
      }
      for (const dir of createdDirs.reverse()) {
        if (existsSync(dir)) rmdirSync(dir);
      }
    }
    throw error;
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
