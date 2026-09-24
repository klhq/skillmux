import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { expandHome } from "./config";
import {
  planAgentSurfaces,
  SUPPORTED_AGENT_IDS,
  type AgentId,
  type SurfaceId,
} from "./init-agents";
import { resolveSkillRoot, SKILL_ID_PATTERN } from "./vault";

export const MANIFEST_FILENAME = "skillmux.toml";
export const LEGACY_MANIFEST_FILENAME = "skr.toml";

export function resolveManifestPath(vaultPath: string): string | null {
  const newPath = join(vaultPath, MANIFEST_FILENAME);
  if (existsSync(newPath)) return newPath;
  const legacyPath = join(vaultPath, LEGACY_MANIFEST_FILENAME);
  if (existsSync(legacyPath)) return legacyPath;
  return null;
}

const groupNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(64);
const skillIdSchema = z.string().regex(SKILL_ID_PATTERN);

const projectGroupSchema = z.object({
  paths: z.array(z.string().min(1)),
  skills: z.array(skillIdSchema),
  agents: z.array(z.enum(SUPPORTED_AGENT_IDS)).default([]),
}).strict();

const manifestSchema = z.object({
  core: z.object({
    skills: z.array(skillIdSchema),
    limit: z.number().int().positive().optional(),
  }).strict(),
  project: z.record(groupNameSchema, projectGroupSchema).optional(),
}).strict();

export type ProjectGroup = z.infer<typeof projectGroupSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

export const LEGACY_TARGETS_ERROR =
  "skillmux.toml: [targets] is no longer supported. Each machine now lists its agents in " +
  'config.toml (agents = ["claude-code", ...]) and each project lists its agents in ' +
  "[project.<group>].agents. Delete the [targets.*] tables from skillmux.toml; see " +
  "docs/configuration.md#migrating-from-targets.";

export interface SyncSurface {
  id: SurfaceId;
  dir: string;
  /** Configured agents on this machine that read this directory. */
  agents: AgentId[];
  /** Project groups whose agents share this directory. */
  projectGroups: Record<string, ProjectGroup>;
}

/**
 * Everything one machine syncs: a directory per distinct surface its
 * configured agents read, carrying the project groups that surface should
 * receive. A project reaches a surface when any of its agents reads that
 * directory. Matching goes by directory, not agent name, because the files land in
 * the same place whichever reader asked for them. Shared by sync and doctor's
 * drift check so the two can never disagree about what this machine owns.
 */
export function resolveSyncSurfaces(
  manifest: Manifest,
  agents: readonly string[],
  options: { home?: string; codexHome?: string } = {},
): SyncSurface[] {
  const groups = Object.entries(manifest.project ?? {}).map(([name, group]) => ({
    name,
    group,
    dirs: new Set(planAgentSurfaces(group.agents, options).surfaces.map((surface) => surface.path)),
  }));
  return planAgentSurfaces(agents, options).surfaces.map((surface) => ({
    id: surface.id,
    dir: surface.path,
    agents: surface.agents,
    projectGroups: Object.fromEntries(
      groups.filter(({ dirs }) => dirs.has(surface.path)).map(({ name, group }) => [name, group]),
    ),
  }));
}

export function parseManifest(toml: string): Manifest {
  const parsed = Bun.TOML.parse(toml) as Record<string, unknown>;
  if ("targets" in parsed) throw new Error(LEGACY_TARGETS_ERROR);
  try {
    return manifestSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) {
        if (
          issue.code === "unrecognized_keys" &&
          issue.path[0] === "project" &&
          issue.keys.includes("repos")
        ) {
          throw new Error(
            `[project.${String(issue.path[1])}] uses the removed field "repos" — replace it with "paths".`,
          );
        }
      }
    }
    throw error;
  }
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

/** Purpose-built serializer for this manifest's fixed shape — not a general TOML writer. */
export function serializeManifest(manifest: Manifest): string {
  // An absent limit is left out rather than written as the default, so the file keeps saying
  // "unset" and a future change to CORE_SKILL_LIMIT still reaches manifests that never opted in.
  const coreLimit = manifest.core.limit === undefined ? "" : `\nlimit = ${manifest.core.limit}`;
  const sections: string[] = [`[core]\nskills = ${tomlStringArray(manifest.core.skills)}${coreLimit}`];

  for (const [name, group] of Object.entries(manifest.project ?? {})) {
    sections.push(
      `[project.${name}]\npaths = ${tomlStringArray(group.paths)}\nskills = ${tomlStringArray(group.skills)}\nagents = ${tomlStringArray(group.agents)}`,
    );
  }

  return `${sections.join("\n\n")}\n`;
}

export function writeManifestAtomic(path: string, manifest: Manifest): void {
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, serializeManifest(manifest), "utf8");
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function findExistingPin(manifest: Manifest, skillId: string): string | null {
  if (manifest.core.skills.includes(skillId)) return "[core]";
  for (const [groupName, group] of Object.entries(manifest.project ?? {})) {
    if (group.skills.includes(skillId)) return `[project.${groupName}]`;
  }
  return null;
}

export function pinCore(manifest: Manifest, skillId: string): Manifest {
  const existing = findExistingPin(manifest, skillId);
  if (existing) {
    throw new Error(`skill "${skillId}" already pinned in ${existing}`);
  }
  return { ...manifest, core: { ...manifest.core, skills: [...manifest.core.skills, skillId] } };
}

export function unpinCore(manifest: Manifest, skillId: string): Manifest {
  if (!manifest.core.skills.includes(skillId)) {
    throw new Error(`skill "${skillId}" is not pinned in [core]`);
  }
  return { ...manifest, core: { ...manifest.core, skills: manifest.core.skills.filter((id) => id !== skillId) } };
}

export function pinProject(manifest: Manifest, skillId: string, group: string, paths?: string[]): Manifest {
  if (!groupNameSchema.safeParse(group).success) {
    throw new Error(`invalid group name "${group}" — must match /^[a-z][a-z0-9_-]*$/ (max 64 chars)`);
  }
  const existingGroup = manifest.project?.[group];

  if (!existingGroup) {
    if (!paths || paths.length === 0) {
      throw new Error(`group "${group}" does not exist — pass --path <path> at least once to create it`);
    }
    const existing = findExistingPin(manifest, skillId);
    if (existing) {
      throw new Error(`skill "${skillId}" already pinned in ${existing}`);
    }
    return {
      ...manifest,
      project: { ...manifest.project, [group]: { paths, skills: [skillId], agents: [] } },
    };
  }

  if (paths && paths.length > 0) {
    throw new Error(`group "${group}" already exists — --path is only used when creating a new group`);
  }
  const existing = findExistingPin(manifest, skillId);
  if (existing) {
    throw new Error(`skill "${skillId}" already pinned in ${existing}`);
  }
  return {
    ...manifest,
    project: { ...manifest.project, [group]: { ...existingGroup, skills: [...existingGroup.skills, skillId] } },
  };
}

export function unpinProject(manifest: Manifest, skillId: string, group: string): Manifest {
  const existingGroup = manifest.project?.[group];
  if (!existingGroup) {
    throw new Error(`[project.${group}] does not exist`);
  }
  if (!existingGroup.skills.includes(skillId)) {
    throw new Error(`skill "${skillId}" is not pinned in [project.${group}]`);
  }
  return {
    ...manifest,
    project: {
      ...manifest.project,
      [group]: { ...existingGroup, skills: existingGroup.skills.filter((id) => id !== skillId) },
    },
  };
}

export interface UpsertProjectOptions {
  name: string;
  paths: string[];
  skills: string[];
  agents: AgentId[];
}

export function upsertProject(manifest: Manifest, options: UpsertProjectOptions): Manifest {
  if (!groupNameSchema.safeParse(options.name).success) {
    throw new Error(
      `invalid group name "${options.name}" — must match /^[a-z][a-z0-9_-]*$/ (max 64 chars)`,
    );
  }

  const existingGroup = manifest.project?.[options.name] ?? { paths: [], skills: [], agents: [] };
  for (const skillId of options.skills) {
    if (!skillIdSchema.safeParse(skillId).success) {
      throw new Error(`invalid skill ID "${skillId}"`);
    }
    if (existingGroup.skills.includes(skillId)) continue;
    const existing = findExistingPin(manifest, skillId);
    if (existing) throw new Error(`skill "${skillId}" already pinned in ${existing}`);
  }

  return {
    ...manifest,
    project: {
      ...manifest.project,
      [options.name]: {
        paths: [...new Set([...existingGroup.paths, ...options.paths])],
        skills: [...new Set([...existingGroup.skills, ...options.skills])],
        agents: [...new Set([...existingGroup.agents, ...options.agents])],
      },
    },
  };
}

export function updateProjectPaths(
  manifest: Manifest,
  group: string,
  changes: { add?: string[]; remove?: string[] },
): Manifest {
  const existingGroup = manifest.project?.[group];
  if (!existingGroup) throw new Error(`[project.${group}] does not exist`);
  const removed = new Set(changes.remove ?? []);
  const paths = [...new Set([...existingGroup.paths, ...(changes.add ?? [])])]
    .filter((path) => !removed.has(path));
  return {
    ...manifest,
    project: {
      ...manifest.project,
      [group]: { ...existingGroup, paths },
    },
  };
}

export function updateProjectAgents(
  manifest: Manifest,
  group: string,
  changes: { attach?: AgentId[]; detach?: AgentId[] },
): Manifest {
  const existingGroup = manifest.project?.[group];
  if (!existingGroup) throw new Error(`[project.${group}] does not exist`);
  const detach = new Set(changes.detach ?? []);
  const agents = [...new Set([...existingGroup.agents, ...(changes.attach ?? [])])]
    .filter((agent) => !detach.has(agent));
  return {
    ...manifest,
    project: { ...manifest.project, [group]: { ...existingGroup, agents } },
  };
}

export interface ManifestValidationResult {
  notes: string[];
}

export const CORE_SKILL_LIMIT = 25;

/**
 * The limit is a budget on how much skill frontmatter every agent carries in its system
 * prompt, not a structural constraint, so whoever hits it needs to know the number is
 * theirs to move. Naming the key beats making them go read the schema. Shared by
 * validateManifest and planInitManifest so the two paths cannot drift apart.
 */
export function coreLimitExceeded(count: number, explicitLimit: number | undefined): Error {
  const effectiveLimit = explicitLimit ?? CORE_SKILL_LIMIT;
  const remedy =
    explicitLimit === undefined
      ? `unpin a skill, or set "limit" under [core] to raise the default`
      : `unpin a skill, or raise "limit" under [core]`;
  return new Error(
    `[core] has ${count} skills, exceeding the limit of ${effectiveLimit} — ${remedy}`,
  );
}

function requireCoreVaultRoot(skillId: string, vaultPath: string, localVaultPaths: string[], location: string): void {
  const root = resolveSkillRoot(skillId, vaultPath, localVaultPaths);
  if (root === null) {
    throw new Error(`${location} skill "${skillId}" does not exist in the vault`);
  }
  if (root !== vaultPath) {
    throw new Error(
      `${location} skill "${skillId}" only exists in a local vault path (${root}) — pins in the shared ` +
        `manifest must be backed by the canonical vault_path (${vaultPath}) to stay portable across machines`,
    );
  }
}

export function validateManifest(
  manifest: Manifest,
  vaultPath: string,
  localVaultPaths: string[] = [],
): ManifestValidationResult {
  const effectiveLimit = manifest.core.limit ?? CORE_SKILL_LIMIT;
  if (manifest.core.skills.length > effectiveLimit) {
    throw coreLimitExceeded(manifest.core.skills.length, manifest.core.limit);
  }

  const coreSet = new Set(manifest.core.skills);
  for (const skillId of manifest.core.skills) {
    requireCoreVaultRoot(skillId, vaultPath, localVaultPaths, "[core]");
  }

  const notes: string[] = [];
  for (const [groupName, group] of Object.entries(manifest.project ?? {})) {
    for (const skillId of group.skills) {
      requireCoreVaultRoot(skillId, vaultPath, localVaultPaths, `[project.${groupName}]`);
      if (coreSet.has(skillId)) {
        throw new Error(`skill "${skillId}" appears in both [core] and [project.${groupName}]`);
      }
    }
    for (const path of group.paths) {
      if (!existsSync(expandHome(path))) {
        notes.push(`[project.${groupName}] paths entry not found locally, skipped: ${path}`);
      }
    }
  }

  return { notes };
}
