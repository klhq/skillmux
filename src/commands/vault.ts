import { unknownOptionError, usageError } from "../arg-errors";
import type { ContextAdapter } from "../adapters";
import type { ResolvedContext } from "../context";
import { isGlobalFlag, isGlobalFlagWithValue } from "../global-flags";
import { dryRunTag, emitSuccess } from "../output";
import { packEntries, readVaultForPush } from "../vault-pack";
import { confirmIfNeeded } from "./shared";

const USAGE = "usage: skillmux vault push --context <name> [--vault <path>] [--dry-run] [--yes] [--json]";

export interface VaultCommandOptions {
  isJson: boolean;
  dryRun: boolean;
  context: ResolvedContext;
  adapter: ContextAdapter;
  /** The local vault to push, taken from config.toml unless --vault says otherwise. */
  resolveVaultPath: () => Promise<string>;
}

function kib(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

export async function runVault(subCommand: string, args: string[], options: VaultCommandOptions): Promise<void> {
  if (subCommand !== "push") {
    throw usageError(subCommand ? `unknown vault subcommand "${subCommand}"` : "missing subcommand", USAGE);
  }

  let dryRun = options.dryRun;
  let yes = false;
  let vaultOverride: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--vault") {
      vaultOverride = args[++i];
      if (!vaultOverride) throw usageError("--vault needs a path", USAGE);
    } else if (isGlobalFlag(arg, "--json", "--allow-insecure", "--verbose")) {
      // handled globally
    } else if (isGlobalFlagWithValue(arg)) {
      i++;
    } else if (arg?.startsWith("--")) {
      throw unknownOptionError("vault push", arg);
    }
  }

  if (options.context.type !== "remote") {
    throw usageError(
      "vault push uploads a vault to a server, and the target here is this machine",
      `${USAGE}\nPass --context <name> or --server <url>.`,
    );
  }
  const target = options.context;

  const vaultPath = vaultOverride ?? (await options.resolveVaultPath());
  const { entries, skipped } = readVaultForPush(vaultPath);
  const body = packEntries(entries);
  const skillCount = new Set(entries.filter((e) => e.path !== "skillmux.toml").map((e) => e.path.split("/")[0])).size;

  if (!options.isJson) {
    console.log(`vault push: ${skillCount} skills, ${entries.length} files, ${kib(body.length)} from ${vaultPath}`);
    if (skipped.length > 0) console.log(`  not pushed (not a skill directory): ${skipped.join(", ")}`);
  }

  if (!dryRun) {
    const confirmed = await confirmIfNeeded({
      confirmed: yes,
      isJson: options.isJson,
      prompt: `replace the vault on ${target.server} with these ${skillCount} skills? Skills there that are not in this vault will be deleted.`,
      nonInteractiveError: "skillmux vault push replaces the server's vault and requires --yes when run non-interactively",
    });
    if (!confirmed) return;
  }

  const result = await options.adapter.vaultPush(body, { dryRun });
  emitSuccess({ isJson: options.isJson, context: options.context }, result, () => {
    const verb = result.status === "dry-run" ? `would replace ${target.server}` : `replaced the vault on ${target.server}`;
    console.log(
      `vault push: ${verb} with ${result.skills.length} skills, ${result.files} files (sha256 ${result.content_sha256.slice(0, 12)}) ${result.status === "dry-run" ? dryRunTag() : ""}`.trimEnd(),
    );
    for (const f of result.findings) {
      console.log(`  accepted [${f.severity}] ${f.skill_id}/${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`);
    }
  });
}
