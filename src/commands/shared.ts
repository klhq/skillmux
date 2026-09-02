import { expandHome, loadConfig } from "../config";
import { parseManifest, resolveManifestPath } from "../manifest";
import { isInteractive } from "../output";
import { askQuestion, type PromptIO } from "../prompts";

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
