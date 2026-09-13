import { expandHome } from "../config";
import { pinCore, unpinCore, validateManifest, writeManifestAtomic } from "../manifest";
import { emitSuccess, unknownSubcommandError } from "../output";
import { confirmIfNeeded, loadManifestContext, pendingSyncTargets } from "./shared";
export async function runCore(
  subCommand: string,
  args: string[],
  options: { isJson: boolean; dryRun: boolean },
): Promise<void> {
  if (subCommand !== "pin" && subCommand !== "unpin") {
    throw unknownSubcommandError("core", subCommand, ["pin", "unpin"]);
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
  // Pinning only records the intent; the symlinks in every target directory are still
  // whatever the last sync left behind. Say so rather than letting the manifest and the
  // directories quietly disagree until someone notices a skill is missing.
  const pending = pendingSyncTargets(
    vaultPath,
    updated,
    config.local_vault_paths.map(expandHome),
  );
  emitSuccess(
    { isJson: options.isJson },
    { subcommand: subCommand, skill_ids: skillIds, sync_pending_targets: pending },
    () => {
      console.log(`${subCommand}: [core] ${skillIds.join(", ")}`);
      if (pending > 0) {
        console.log(
          `next: skillmux sync — ${pending} target${pending === 1 ? "" : "s"} still out of date`,
        );
      }
    },
  );
}
