import { existsSync } from "node:fs";
import { join } from "node:path";
import { expandHome, loadConfig } from "../config";
import { unknownSubcommandError } from "../output";
import { vaultResolutionOrder } from "../vault";

export async function runSkill(subCommand: string, args: string[]): Promise<void> {
  if (subCommand !== "which") throw unknownSubcommandError("skill", subCommand, ["which"]);
  await runWhich(args);
}

async function runWhich(args: string[]): Promise<void> {
  const skillId = args[0];
  if (!skillId) {
    throw new Error(
      "usage: skillmux skill which <skill_id> (local vault shadow resolution; unrelated to MCP routing)",
    );
  }
  const config = await loadConfig();
  const vaultPath = expandHome(config.vault_path);
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  const roots = vaultResolutionOrder(vaultPath, localVaultPaths).filter(
    (root) => existsSync(join(root, skillId, "SKILL.md")),
  );
  if (roots.length === 0) {
    console.log(`${skillId}: not found in vault_path or local_vault_paths`);
    process.exitCode = 1;
    return;
  }
  console.log(`${skillId}: serving from ${roots[0]}`);
  for (const shadowedRoot of roots.slice(1))
    console.log(`  shadows: ${shadowedRoot}`);
}
