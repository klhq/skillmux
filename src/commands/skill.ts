import { usageError, unknownOptionError } from "../arg-errors";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expandHome, loadConfig } from "../config";
import { emitSuccess, unknownSubcommandError } from "../output";
import { SKILL_PLACEMENTS, listSkills, type SkillPlacement } from "../skill-list";
import { vaultResolutionOrder } from "../vault";

export async function runSkill(
  subCommand: string,
  args: string[],
  options: { isJson?: boolean } = {},
): Promise<void> {
  const isJson = options.isJson ?? false;
  if (subCommand === "list") return runList(args, isJson);
  if (subCommand === "which") return runWhich(args, isJson);
  throw unknownSubcommandError("skill", subCommand, ["list", "which"]);
}

const LIST_USAGE = `usage: skillmux skill list [--placement ${SKILL_PLACEMENTS.join("|")}] [--json]`;

function parseListArgs(args: string[]): { placement?: SkillPlacement } {
  let placement: SkillPlacement | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") continue;
    if (arg === "--placement") {
      const value = args[++i];
      if (!SKILL_PLACEMENTS.includes(value as SkillPlacement)) {
        throw usageError(`--placement must be one of ${SKILL_PLACEMENTS.join(", ")}`, LIST_USAGE);
      }
      placement = value as SkillPlacement;
    } else {
      throw unknownOptionError("skill list", arg);
    }
  }
  return { placement };
}

async function runList(args: string[], isJson: boolean): Promise<void> {
  const { placement } = parseListArgs(args);
  const listing = await listSkills(await loadConfig(), { placement });
  emitSuccess({ isJson }, listing, () => {
    if (listing.skills.length === 0) {
      console.log(
        placement
          ? `no skills with placement ${placement} in ${listing.vault_path}`
          : `no skills found in ${listing.vault_path}`,
      );
    }
    for (const skill of listing.skills) {
      const where =
        skill.placement === "project" ? `project: ${skill.project_groups.join(", ")}` : skill.placement;
      console.log(`${skill.skill_id} [${where}]${skill.description ? ` ${skill.description}` : ""}`);
    }
    for (const skill of listing.invalid) console.log(`${skill.skill_id} [invalid] ${skill.error}`);
  });
}

async function runWhich(args: string[], isJson: boolean): Promise<void> {
  const skillId = args.find((arg) => !arg.startsWith("-"));
  if (!skillId) {
    throw usageError(
      "missing <skill_id> argument",
      "usage: skillmux skill which <skill_id> [--json] (local vault shadow resolution; unrelated to MCP routing)",
    );
  }
  const config = await loadConfig();
  const vaultPath = expandHome(config.vault_path);
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const roots = vaultResolutionOrder(vaultPath, localVaultPaths).filter(
    (root) => existsSync(join(root, skillId, "SKILL.md")),
  );
  // A skill that is not found is still a successful lookup: the envelope reports
  // found: false, and the exit code (1) keeps the old shell-visible signal.
  if (roots.length === 0) process.exitCode = 1;
  emitSuccess(
    { isJson },
    { skill_id: skillId, found: roots.length > 0, serving_from: roots[0] ?? null, shadows: roots.slice(1) },
    () => {
      if (roots.length === 0) {
        console.log(`${skillId}: not found in vault_path or local_vault_paths`);
        return;
      }
      console.log(`${skillId}: serving from ${roots[0]}`);
      for (const shadowedRoot of roots.slice(1)) console.log(`  shadows: ${shadowedRoot}`);
    },
  );
}
