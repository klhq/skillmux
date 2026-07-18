import { z } from "zod";
import { SKILL_ID_PATTERN } from "./vault";

const groupNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(64);
const skillIdSchema = z.string().regex(SKILL_ID_PATTERN);

const projectGroupSchema = z.object({
  repos: z.array(z.string().min(1)),
  skills: z.array(skillIdSchema),
}).strict();

const targetSchema = z.object({
  dir: z.string().min(1),
  project: z.boolean().default(false),
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
  return manifestSchema.parse(parsed);
}

export interface ManifestValidationResult {
  notes: string[];
}

export function validateManifest(manifest: Manifest, vaultSkillIds: Set<string>): ManifestValidationResult {
  const coreSet = new Set(manifest.core.skills);
  for (const skillId of manifest.core.skills) {
    if (!vaultSkillIds.has(skillId)) {
      throw new Error(`[core] skill "${skillId}" does not exist in the vault`);
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
  }

  return { notes };
}
