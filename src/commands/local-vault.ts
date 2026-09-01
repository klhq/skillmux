import { existsSync } from "node:fs";
import { join } from "node:path";
import { expandHome, loadConfig } from "../config";
import { emitSuccess } from "../output";
import { writeLocalVaultMarker } from "../sync";
import { confirmIfNeeded } from "./shared";

export async function runLocalVaultInit(
  args: string[],
  options: { isJson: boolean; dryRun: boolean },
): Promise<void> {
  const path = args[0];
  if (!path) throw new Error("usage: skillmux local-vault init <path> --yes");
  const expanded = expandHome(path);
  const config = await loadConfig();
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  if (!localVaultPaths.includes(expanded)) {
    throw new Error(
      `"${path}" is not one of the configured local_vault_paths — add it to config.toml first`,
    );
  }
  if (!existsSync(expanded)) throw new Error(`"${path}" does not exist`);
  const markerPath = join(expanded, ".skillmux");
  if (options.dryRun) {
    emitSuccess(
      { isJson: options.isJson },
      {
        marker_path: markerPath,
        vault_path: expandHome(config.vault_path),
      },
      () =>
        console.log(
          `local-vault init: ${markerPath} (role: local_vault, vault_path: ${expandHome(config.vault_path)}) (dry-run)`,
        ),
    );
    return;
  }
  if (
    !(await confirmIfNeeded({
      confirmed: args.includes("--yes"),
      isJson: options.isJson,
      prompt: `mark ${expanded} as a local_vault (role: local_vault, vault_path: ${expandHome(config.vault_path)})?`,
      nonInteractiveError:
        "skillmux local-vault init requires --yes when run non-interactively",
    }))
  )
    return;
  writeLocalVaultMarker(expanded, expandHome(config.vault_path));
  emitSuccess(
    { isJson: options.isJson },
    {
      marker_path: markerPath,
      vault_path: expandHome(config.vault_path),
    },
    () =>
      console.log(
        `wrote ${markerPath} (role: local_vault, vault_path: ${expandHome(config.vault_path)})`,
      ),
  );
}
