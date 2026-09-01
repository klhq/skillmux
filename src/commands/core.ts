import { expandHome } from "../config";
import { pinCore, unpinCore, validateManifest, writeManifestAtomic } from "../manifest";
import { emitSuccess } from "../output";
import { confirmIfNeeded, loadManifestContext } from "./shared";
export async function runCore(
  subCommand: string,
  args: string[],
  options: { isJson: boolean; dryRun: boolean },
): Promise<void> {
  if (subCommand !== "pin" && subCommand !== "unpin") {
    throw new Error("usage: skillmux core <pin|unpin>");
  }
  const skillIds = args.filter((arg) => !arg.startsWith("-"));
  if (skillIds.length === 0) {
    throw new Error(`usage: skillmux core ${subCommand} <skill_id>... --yes`);
  }
  const yes = args.includes("--yes");
  const { config, vaultPath, manifestPath, manifest } =
    await loadManifestContext();
  let updated = manifest;
  for (const skillId of skillIds) {
    updated =
      subCommand === "pin"
        ? pinCore(updated, skillId)
        : unpinCore(updated, skillId);
  }
  validateManifest(
    updated,
    vaultPath,
    config.local_vault_paths.map(expandHome),
  );
  if (options.dryRun) {
    emitSuccess(
      { isJson: options.isJson },
      { subcommand: subCommand, skill_ids: skillIds },
      () =>
        console.log(`${subCommand}: [core] ${skillIds.join(", ")} (dry-run)`),
    );
    return;
  }
  if (
    !(await confirmIfNeeded({
      confirmed: yes,
      isJson: options.isJson,
      prompt: `${subCommand} ${skillIds.join(", ")} in [core]?`,
      nonInteractiveError: `skillmux core ${subCommand} requires --yes when run non-interactively`,
    }))
  )
    return;
  writeManifestAtomic(manifestPath, updated);
  emitSuccess(
    { isJson: options.isJson },
    { subcommand: subCommand, skill_ids: skillIds },
    () => console.log(`${subCommand}: [core] ${skillIds.join(", ")}`),
  );
}
