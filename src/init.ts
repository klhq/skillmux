import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  parseManifest,
  resolveManifestPath,
  serializeManifest,
  type Manifest,
  CORE_SKILL_LIMIT,
  coreLimitExceeded,
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
export function proposeManifest(_candidates: SurfaceCandidate[]): Manifest {
  return { core: { skills: [] }, project: {} };
}

/** e.g. ~/.claude/skills -> "claude"; ~/.agents/skills -> "agents". */
export function deriveTargetName(path: string): string {
  return basename(dirname(path)).replace(/^\./, "").toLowerCase();
}

/** An agent directory init/agent add will create or adopt; `name` is its surface id. */
export interface ConfirmedTarget {
  name: string;
  dir: string;
  migrateFullVault?: boolean;
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
      const canonicalTargetPath = realpathSync(target.dir);
      if (target.migrateFullVault && canonicalTargetPath === canonicalVaultPath) {
        continue;
      }
      throw new Error(
        `${target.dir} is a symbolic link; classify or migrate it before skillmux can manage it`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`${target.dir} is not a directory`);
    }
    if (realpathSync(target.dir) === canonicalVaultPath) {
      throw new Error(
        `${target.dir} is the vault itself; it cannot be managed as an agent directory`,
      );
    }
    preflightAdoptTarget(target.dir, target.name, vaultPath);
  }
}

/**
 * The manifest init would leave behind: the existing one (or an empty one)
 * with `coreSkillIds` added to [core]. Agent selection lives in config.toml,
 * not here, so this only ever touches the shared vault's skill curation.
 */
export function planInitManifest(vaultPath: string, coreSkillIds: string[] = []): Manifest {
  const existingManifestPath = resolveManifestPath(vaultPath);
  const existingManifest: Manifest = existingManifestPath
    ? parseManifest(readFileSync(existingManifestPath, "utf-8"))
    : proposeManifest([]);
  const manifest: Manifest = {
    ...existingManifest,
    core: {
      ...existingManifest.core,
      skills: [...new Set([...existingManifest.core.skills, ...coreSkillIds])],
    },
  };
  if (manifest.core.skills.length > (manifest.core.limit ?? CORE_SKILL_LIMIT)) {
    throw coreLimitExceeded(manifest.core.skills.length, manifest.core.limit);
  }
  for (const skillId of coreSkillIds) {
    if (!SKILL_ID_PATTERN.test(skillId) || !existsSync(join(vaultPath, skillId, "SKILL.md"))) {
      throw new Error(`[core] skill "${skillId}" does not exist in the vault`);
    }
    for (const [groupName, group] of Object.entries(existingManifest.project ?? {})) {
      if (group.skills.includes(skillId)) {
        throw new Error(`skill "${skillId}" appears in both [core] and [project.${groupName}]`);
      }
    }
  }
  return manifest;
}

/**
 * Creates or adopts each confirmed agent directory in place, then runs the
 * participant (config.toml, instruction files, …), rolling every step back if
 * anything fails. Callers pass only confirmed candidates; this function
 * never discovers paths on its own.
 */
export function adoptSurfaces(
  vaultPath: string,
  confirmedTargets: ConfirmedTarget[],
  participant?: InitTransactionParticipant,
): void {
  preflightManagedTargets(vaultPath, confirmedTargets);
  const createdDirs: string[] = [];
  const adoptedDirs: string[] = [];
  const migratedFullVaultDirs: Array<{ dir: string; linkTarget: string }> = [];

  try {
    for (const target of confirmedTargets) {
      let targetStat;
      try {
        targetStat = lstatSync(target.dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (targetStat?.isSymbolicLink()) {
        if (!target.migrateFullVault || realpathSync(target.dir) !== realpathSync(vaultPath)) {
          throw new Error(
            `${target.dir} changed to an unsafe symbolic link after preflight`,
          );
        }
        const linkTarget = readlinkSync(target.dir);
        unlinkSync(target.dir);
        mkdirSync(target.dir, { recursive: true });
        migratedFullVaultDirs.push({ dir: target.dir, linkTarget });
      } else if (targetStat && !targetStat.isDirectory()) {
        throw new Error(`${target.dir} changed to a non-directory after preflight`);
      }
      if (!existsSync(target.dir)) {
        mkdirSync(target.dir, { recursive: true });
        createdDirs.push(target.dir);
      }
      if (adoptTarget(target.dir, target.name, vaultPath).adopted) {
        adoptedDirs.push(target.dir);
      }
    }
    participant?.apply();
  } catch (error) {
    for (const dir of adoptedDirs.reverse()) {
      const markerPath = join(dir, SKILLMUX_MARKER_FILENAME);
      if (existsSync(markerPath)) unlinkSync(markerPath);
    }
    for (const migration of migratedFullVaultDirs.reverse()) {
      if (existsSync(migration.dir)) rmdirSync(migration.dir);
      symlinkSync(migration.linkTarget, migration.dir);
    }
    for (const dir of createdDirs.reverse()) {
      if (existsSync(dir)) rmdirSync(dir);
    }
    throw error;
  }
}

/**
 * `init`'s whole write: adopt the agent directories, run the participant, and
 * write skillmux.toml. The manifest write happens only when the file is
 * missing or [core] gained skills, so selecting agents never rewrites the
 * shared manifest.
 */
export function applyInit(
  vaultPath: string,
  confirmedTargets: ConfirmedTarget[],
  participant?: InitTransactionParticipant,
  coreSkillIds: string[] = [],
): Manifest {
  const manifest = planInitManifest(vaultPath, coreSkillIds);
  const manifestPath = resolveManifestPath(vaultPath) ?? join(vaultPath, MANIFEST_FILENAME);
  const existingCore = existsSync(manifestPath)
    ? parseManifest(readFileSync(manifestPath, "utf-8")).core.skills.length
    : -1;
  const shouldWriteManifest = existingCore !== manifest.core.skills.length;
  let participantApplied = false;

  adoptSurfaces(vaultPath, confirmedTargets, {
    apply: () => {
      participant?.apply();
      participantApplied = true;
      if (!shouldWriteManifest) return;
      const temporaryManifestPath = join(
        vaultPath,
        `.${MANIFEST_FILENAME}.${process.pid}-${Date.now()}.tmp`,
      );
      try {
        writeFileSync(temporaryManifestPath, serializeManifest(manifest));
        renameSync(temporaryManifestPath, join(vaultPath, MANIFEST_FILENAME));
      } catch (error) {
        if (existsSync(temporaryManifestPath)) unlinkSync(temporaryManifestPath);
        if (participantApplied) participant?.rollback();
        throw error;
      }
    },
    rollback: () => {},
  });

  return manifest;
}

export const DISCOVERY_PARAGRAPH =
  "Skills: only a curated core is loaded statically. Before improvising a " +
  "multi-step workflow, or when a task smells like a domain you have no loaded " +
  "skill for (career/resume, trading, SEO, i18n, design, one-off tooling), " +
  "call `resolve_skill` with a one-line task description. `resolve_skill` " +
  "returns a ranked shortlist; inspect candidates, fetch one or more " +
  "relevant skills with `fetch_skill`, or ignore all and proceed normally " +
  "when none are useful.";

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
