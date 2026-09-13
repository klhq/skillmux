import { expandHome } from "../config";
import { pinCore, unpinCore, validateManifest, writeManifestAtomic } from "../manifest";
import { emitSuccess, unknownSubcommandError } from "../output";
import { confirmIfNeeded, loadManifestContext } from "./shared";
import { executeSync } from "./sync";
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
    throw new Error(
      `usage: skillmux core ${subCommand} <skill_id>... --yes [--no-sync]`,
    );
  }
  const yes = args.includes("--yes");
  const sync = !args.includes("--no-sync");
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
  if (!options.isJson) console.log(`${subCommand}: [core] ${skillIds.join(", ")}`);

  // Writing the manifest is only half the job: until the symlinks move, the pin is
  // invisible to every agent. `init` already syncs for exactly this reason, so a pin that
  // stopped at the file was the odd one out. `--no-sync` keeps the old behaviour for
  // anyone batching several pins before a single sync.
  //
  // The pin's own --yes is deliberately not forwarded. It answers "pin this skill", not
  // "create a directory this host has never synced", so executeSync's new-target gate
  // still stands on its own.
  const synced = sync
    ? await executeSync({
        config,
        log: options.isJson ? undefined : (line: string) => console.log(line),
      })
    : undefined;

  emitSuccess(
    { isJson: options.isJson },
    {
      subcommand: subCommand,
      skill_ids: skillIds,
      synced: synced !== undefined,
      targets: synced?.targets ?? [],
    },
    () => {},
  );
}
