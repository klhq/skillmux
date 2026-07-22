import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { expandHome } from "./config";
import { SKILL_ID_PATTERN } from "./vault";

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
  repos: z.array(z.string().min(1)),
  skills: z.array(skillIdSchema),
}).strict();

const targetSchema = z.object({
  dir: z.string().min(1),
  project_groups: z.array(groupNameSchema).default([]),
}).strict();

const manifestSchema = z.object({
  core: z.object({ skills: z.array(skillIdSchema) }).strict(),
  project: z.record(groupNameSchema, projectGroupSchema).optional(),
  targets: z.record(groupNameSchema, targetSchema),
}).strict();

export type ProjectGroup = z.infer<typeof projectGroupSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

export function parseManifest(toml: string): Manifest {
  const parsed = Bun.TOML.parse(toml) as Record<string, unknown>;
  try {
    return manifestSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) {
        if (
          issue.code === "unrecognized_keys" &&
          issue.path[0] === "targets" &&
          issue.keys.includes("project")
        ) {
          throw new Error(
            `[targets.${String(issue.path[1])}] uses the removed field "project" (boolean) — replace it with "project_groups" (an array of [project.<group>] names).`,
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
  const sections: string[] = [`[core]\nskills = ${tomlStringArray(manifest.core.skills)}`];

  for (const [name, group] of Object.entries(manifest.project ?? {})) {
    sections.push(
      `[project.${name}]\nrepos = ${tomlStringArray(group.repos)}\nskills = ${tomlStringArray(group.skills)}`,
    );
  }

  for (const [name, target] of Object.entries(manifest.targets)) {
    sections.push(
      `[targets.${name}]\ndir = ${JSON.stringify(target.dir)}\nproject_groups = ${tomlStringArray(target.project_groups)}`,
    );
  }

  return `${sections.join("\n\n")}\n`;
}

export interface ManifestValidationResult {
  notes: string[];
}

const CORE_SKILL_LIMIT = 25;

export function validateManifest(manifest: Manifest, vaultSkillIds: Set<string>): ManifestValidationResult {
  if (manifest.core.skills.length > CORE_SKILL_LIMIT) {
    throw new Error(
      `[core] has ${manifest.core.skills.length} skills, exceeding the limit of ${CORE_SKILL_LIMIT}`,
    );
  }

  const coreSet = new Set(manifest.core.skills);
  for (const skillId of manifest.core.skills) {
    if (!vaultSkillIds.has(skillId)) {
      throw new Error(`[core] skill "${skillId}" does not exist in the vault`);
    }
  }

  const groupNames = new Set(Object.keys(manifest.project ?? {}));
  for (const [targetName, target] of Object.entries(manifest.targets)) {
    for (const groupName of target.project_groups) {
      if (!groupNames.has(groupName)) {
        throw new Error(`[targets.${targetName}] project_groups references undefined group "${groupName}"`);
      }
    }
  }

  const notes: string[] = [];
  for (const [groupName, group] of Object.entries(manifest.project ?? {})) {
    for (const skillId of group.skills) {
      if (!vaultSkillIds.has(skillId)) {
        throw new Error(`[project.${groupName}] skill "${skillId}" does not exist in the vault`);
      }
      if (coreSet.has(skillId)) {
        throw new Error(`skill "${skillId}" appears in both [core] and [project.${groupName}]`);
      }
    }
    for (const repo of group.repos) {
      if (!existsSync(expandHome(repo))) {
        notes.push(`[project.${groupName}] repos path not found locally, skipped: ${repo}`);
      }
    }
  }

  return { notes };
}
