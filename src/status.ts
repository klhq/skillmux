import { existsSync } from "node:fs";
import { MANAGE_SKILL_ID, planManageSkill } from "./builtin-skills";
import { dirState } from "./commands/agent";
import { expandHome } from "./config";
import { checkVaultUrl, type DoctorCheck } from "./doctor";
import { getAgentDefinition, planAgentSurfaces, type AgentId } from "./init-agents";
import { CORE_SKILL_LIMIT } from "./manifest";
import { MCP_REGISTRABLE_AGENTS } from "./mcp-registration";
import { readManifestIfPresent } from "./skill-list";
import type { Config } from "./types";

export interface StatusReport {
  /** False when any check failed; the failing checks say what to fix. */
  ok: boolean;
  vault: { path: string; exists: boolean; manifest: boolean };
  core: { count: number; limit: number; skills: string[] };
  project_groups: { name: string; skills: number; agents: AgentId[] }[];
  agents: {
    agent: AgentId;
    dir: string;
    /** managed is healthy; missing and unmanaged mean sync has not set the directory up. */
    state: "managed" | "missing" | "unmanaged";
    /** Whether `skillmux init --register-mcp` can register the MCP server with this agent. */
    mcp_registration: boolean;
  }[];
  /** The built-in skillmux-manage skill in the vault: absent, current for this version, or stale. */
  manage_skill: "absent" | "current" | "stale";
  checks: DoctorCheck[];
}

/**
 * Read-only summary of this machine's skillmux setup. It shares doctor's checks
 * where they overlap (vault, vault_url) and leaves the slow ones, such as
 * embedding probes, to `skillmux doctor`.
 */
export function buildStatus(config: Config): StatusReport {
  const vaultPath = expandHome(config.vault_path);
  const vaultExists = existsSync(vaultPath);
  const manifest = vaultExists ? readManifestIfPresent(vaultPath) : null;

  const checks: DoctorCheck[] = [{ name: "vault", ok: vaultExists, detail: vaultPath }];
  if (config.vault_url !== undefined) checks.push(checkVaultUrl(vaultPath, config.vault_url));
  if (vaultExists && manifest === null) {
    checks.push({ name: "manifest", ok: false, detail: `no skillmux.toml in ${vaultPath}; run skillmux init` });
  }
  if (config.agents.length === 0) {
    checks.push({ name: "agents", ok: false, detail: "no agents configured; run skillmux agent add <agent>" });
  }

  const manageStatus = vaultExists ? planManageSkill(vaultPath) : "create";
  const manage_skill = manageStatus === "create" ? "absent" : manageStatus === "update" ? "stale" : "current";
  if (manage_skill === "stale") {
    checks.push({
      name: "manage_skill",
      ok: false,
      detail: `${MANAGE_SKILL_ID} was written by another skillmux version; run skillmux init --manage-skill --yes`,
    });
  }

  const agents = planAgentSurfaces(config.agents).surfaces.flatMap((surface) => {
    const state = dirState(surface.path);
    if (state !== "managed") {
      checks.push({
        name: `agent_dir:${surface.path}`,
        ok: false,
        detail: `${surface.path} is ${state}; run skillmux sync`,
      });
    }
    return surface.agents.map((agent) => ({
      agent,
      dir: surface.path,
      state,
      mcp_registration: MCP_REGISTRABLE_AGENTS.includes(agent) && getAgentDefinition(agent).mcpRegistration !== undefined,
    }));
  });

  return {
    ok: checks.every((check) => check.ok),
    vault: { path: vaultPath, exists: vaultExists, manifest: manifest !== null },
    core: {
      count: manifest?.core.skills.length ?? 0,
      limit: manifest?.core.limit ?? CORE_SKILL_LIMIT,
      skills: manifest?.core.skills ?? [],
    },
    project_groups: Object.entries(manifest?.project ?? {}).map(([name, group]) => ({
      name,
      skills: group.skills.length,
      agents: group.agents,
    })),
    agents,
    manage_skill,
    checks,
  };
}
