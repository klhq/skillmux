import packageJson from "../package.json" with { type: "json" };
import { expandHome } from "./config";
import type { Config } from "./types";

export interface DeploymentIdentity {
  version: string;
  runtime: "host" | "docker";
  image_variant: "full" | "slim" | null;
  vault_path: string;
  state_dir: string;
  inference_mode: Config["inference"]["mode"];
  local_embedding_bundle: string | null;
  remote_embedding_configured: boolean;
  remote_reranker_configured: boolean;
}

export function describeDeployment(
  config: Config,
  environment: Record<string, string | undefined> = process.env,
): DeploymentIdentity {
  const runtime = environment.RUNNING_IN_DOCKER === "true" ? "docker" : "host";
  const variant = environment.SKILLMUX_IMAGE_VARIANT;
  const imageVariant = runtime === "docker" && (variant === "full" || variant === "slim")
    ? variant
    : null;

  return {
    version: packageJson.version,
    runtime,
    image_variant: imageVariant,
    vault_path: expandHome(config.vault_path),
    state_dir: expandHome(config.state_dir),
    inference_mode: config.inference.mode,
    local_embedding_bundle: config.inference.mode === "local" ? config.inference.bundle : null,
    remote_embedding_configured: config.inference.mode === "remote",
    remote_reranker_configured:
      config.inference.mode === "remote" && !!config.inference.reranker,
  };
}
