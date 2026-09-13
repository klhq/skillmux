import { hostname } from "node:os";
import { expandHome, loadConfig } from "../config";
import {
  parseManifest,
  resolveManifestPath,
  resolveSyncTargets,
  type Manifest,
} from "../manifest";
import { isInteractive } from "../output";
import { askQuestion, type PromptIO } from "../prompts";
import { planSyncDrift } from "../sync";

export async function confirmAction(
  prompt: string,
  io: PromptIO = {},
): Promise<boolean> {
  const answer = (await askQuestion(`${prompt} [y/N] `, io)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

export async function loadManifestContext() {
  const config = await loadConfig();
  const vaultPath = expandHome(config.vault_path);
  const manifestPath = resolveManifestPath(vaultPath);
  if (!manifestPath) {
    throw new Error(
      `no skillmux.toml found at ${vaultPath}; run skillmux init first`,
    );
  }
  const manifest = parseManifest(await Bun.file(manifestPath).text());
  return { config, vaultPath, manifestPath, manifest };
}

/**
 * How many target directories a `skillmux sync` would still have to touch.
 *
 * Commands that write the manifest and stop — `core pin`, `core unpin`, `target add` —
 * use this to tell the user the write is only half the job. Returning 0 means the
 * manifest and every directory this host owns already agree, so there is nothing to say.
 * An unplannable target counts too: `sync` is where its error surfaces, so it is still
 * the next thing to run.
 */
export function pendingSyncTargets(
  vaultPath: string,
  manifest: Manifest,
  localVaultPaths: string[],
): number {
  const drift = planSyncDrift({
    vaultPath,
    targets: resolveSyncTargets(manifest),
    localVaultPaths,
    coreSkillIds: manifest.core.skills,
    currentHost: hostname(),
  });
  return drift.drifted.length + drift.unplannable.length;
}

export async function confirmIfNeeded(opts: {
  confirmed: boolean;
  isJson: boolean;
  prompt: string;
  nonInteractiveError: string;
}): Promise<boolean> {
  if (opts.confirmed) return true;
  if (opts.isJson || !isInteractive()) {
    throw new Error(opts.nonInteractiveError);
  }
  return confirmAction(opts.prompt);
}
