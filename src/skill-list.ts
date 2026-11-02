import { existsSync, readFileSync } from "node:fs";
import { expandHome } from "./config";
import { parseManifest, resolveManifestPath, type Manifest } from "./manifest";
import type { Config } from "./types";
import { resolveSkillRoot, scanVaults } from "./vault";

export const SKILL_PLACEMENTS = ["mcp-only", "core", "project"] as const;
export type SkillPlacement = (typeof SKILL_PLACEMENTS)[number];

export interface SkillListEntry {
  skill_id: string;
  description: string;
  /**
   * Where agents see the skill: "core" skills are synced into every agent's
   * native directory, "project" skills into the directories of the groups
   * named in `project_groups`, and "mcp-only" skills are reached only through
   * resolve_skill and fetch_skill.
   */
  placement: SkillPlacement;
  project_groups: string[];
  /** The vault root that actually serves the skill, after local-overrides-first shadowing. */
  root: string | null;
}

export interface SkillListing {
  vault_path: string;
  skills: SkillListEntry[];
  /** Skills that exist on disk but could not be read, so a missing entry is explained. */
  invalid: { skill_id: string; error: string }[];
}

/** The vault's manifest, or null when none has been created yet (nothing is pinned). */
export function readManifestIfPresent(vaultPath: string): Manifest | null {
  const path = resolveManifestPath(vaultPath);
  return path ? parseManifest(readFileSync(path, "utf-8")) : null;
}

export function placementOf(manifest: Manifest | null, skillId: string): Pick<SkillListEntry, "placement" | "project_groups"> {
  if (manifest?.core.skills.includes(skillId)) return { placement: "core", project_groups: [] };
  const groups = Object.entries(manifest?.project ?? {})
    .filter(([, group]) => group.skills.includes(skillId))
    .map(([name]) => name);
  return groups.length > 0
    ? { placement: "project", project_groups: groups }
    : { placement: "mcp-only", project_groups: [] };
}

export async function listSkills(
  config: Config,
  options: { placement?: SkillPlacement } = {},
): Promise<SkillListing> {
  const vaultPath = expandHome(config.vault_path);
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const manifest = existsSync(vaultPath) ? readManifestIfPresent(vaultPath) : null;
  const invalid: SkillListing["invalid"] = [];
  const found = await scanVaults(vaultPath, localVaultPaths, (skillId, error) =>
    invalid.push({ skill_id: skillId, error: error instanceof Error ? error.message : String(error) }),
  );
  const skills = found
    .map((skill): SkillListEntry => ({
      skill_id: skill.skill_id,
      description: skill.description,
      ...placementOf(manifest, skill.skill_id),
      root: resolveSkillRoot(skill.skill_id, vaultPath, localVaultPaths),
    }))
    .filter((skill) => options.placement === undefined || skill.placement === options.placement)
    .sort((a, b) => a.skill_id.localeCompare(b.skill_id));
  return { vault_path: vaultPath, skills, invalid };
}
