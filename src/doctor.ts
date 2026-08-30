import { existsSync, mkdirSync } from "node:fs";
import { createClients, RemoteInferenceError } from "./clients";
import { embeddingDimension, expandHome, isLoopbackBindHost } from "./config";
import { describeDeployment, type DeploymentIdentity } from "./deployment";
import { parseManifest, resolveManifestPath, validateManifest } from "./manifest";
import { readSkillmuxMarker } from "./sync";
import type { Config } from "./types";
import { findShadowedSkills } from "./vault";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  failure_kind?: "configuration" | "availability" | "protocol" | "unexpected";
}

export interface DoctorReport {
  mode: Config["inference"]["mode"];
  capability: "hybrid" | "lexical-only" | "unavailable";
  retrieval_capability: "lexical" | "hybrid" | "reranked";
  version: DeploymentIdentity["version"];
  runtime: DeploymentIdentity["runtime"];
  image_variant: DeploymentIdentity["image_variant"];
  vault_path: DeploymentIdentity["vault_path"];
  state_dir: DeploymentIdentity["state_dir"];
  inference_mode: DeploymentIdentity["inference_mode"];
  local_embedding_bundle: DeploymentIdentity["local_embedding_bundle"];
  remote_embedding_configured: DeploymentIdentity["remote_embedding_configured"];
  remote_reranker_configured: DeploymentIdentity["remote_reranker_configured"];
  checks: DoctorCheck[];
}

export { describeDeployment };

export async function diagnose(
  config: Config,
  environment: Record<string, string | undefined> = process.env,
  sources: Record<string, "default" | "toml" | "environment" | "admin"> = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const envOverrides = config.config?.environment_overrides !== false;
  checks.push({
    name: "config_authority",
    ok: true,
    detail: envOverrides
      ? "environment overrides enabled"
      : "TOML authoritative (environment overrides disabled)",
  });
  for (const [key, source] of Object.entries(sources)) {
    checks.push({ name: `config_source:${key}`, ok: true, detail: source });
  }
  checks.push({ name: "vault", ok: existsSync(expandHome(config.vault_path)), detail: expandHome(config.vault_path) });

  // SMX-91: `serve --transport http` itself refuses to start over this combination
  // (assertSafeBindPosture in server.ts) unless SKILLMUX_ALLOW_INSECURE_BIND is set —
  // surface it here too so it's visible without having to start the HTTP server first.
  if (config.server) {
    const hostname = config.server.hostname ?? "127.0.0.1";
    const bindIsSafe = isLoopbackBindHost(hostname) || config.server.auth_enabled;
    checks.push({
      name: "server_bind_posture",
      ok: bindIsSafe,
      detail: bindIsSafe
        ? `${hostname}, auth_enabled=${config.server.auth_enabled}`
        : `${hostname} is reachable beyond this machine with auth_enabled=false — ` +
          "MCP tools and /stats would be open to anyone who can reach this port; " +
          "set server.auth_enabled=true or bind a loopback hostname",
      failure_kind: bindIsSafe ? undefined : "configuration",
    });
  }

  for (const localPath of config.local_vault_paths) {
    const expanded = expandHome(localPath);
    checks.push({ name: `local_vault:${localPath}`, ok: existsSync(expanded), detail: expanded });

    const strayManifest = resolveManifestPath(expanded);
    if (strayManifest) {
      checks.push({
        name: `local_vault_manifest:${localPath}`,
        ok: false,
        detail: `stray manifest at ${strayManifest} — skillmux.toml only ever lives in vault_path, never in local_vault_paths`,
      });
    }

    const marker = readSkillmuxMarker(expanded);
    const currentVaultPath = expandHome(config.vault_path);
    if (!marker || marker.role !== "local_vault") {
      checks.push({
        name: `local_vault_marker:${localPath}`,
        ok: false,
        detail: `no marker — run: skillmux local-vault init "${expanded}"`,
      });
    } else if (marker.vault_path !== currentVaultPath) {
      checks.push({
        name: `local_vault_marker:${localPath}`,
        ok: false,
        detail: `marker recorded vault_path ${marker.vault_path}, currently configured vault_path is ${currentVaultPath} — drift, re-run skillmux local-vault init`,
      });
    } else {
      checks.push({ name: `local_vault_marker:${localPath}`, ok: true, detail: expanded });
    }
  }

  for (const shadow of findShadowedSkills(expandHome(config.vault_path), config.local_vault_paths.map(expandHome))) {
    checks.push({
      name: `shadowed:${shadow.skill_id}`,
      ok: true,
      detail: `served from ${shadow.winner}; shadows ${shadow.shadowed.join(", ")}`,
    });
  }

  const vaultPath = expandHome(config.vault_path);
  const manifestPath = resolveManifestPath(vaultPath);
  if (!manifestPath) {
    checks.push({ name: "manifest", ok: true, detail: "not yet initialized" });
  } else {
    try {
      const manifest = parseManifest(await Bun.file(manifestPath).text());
      validateManifest(manifest, vaultPath, config.local_vault_paths.map(expandHome));
      checks.push({ name: "manifest", ok: true, detail: manifestPath });
    } catch (error) {
      checks.push({
        name: `manifest:${manifestPath}`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    mkdirSync(expandHome(config.state_dir), { recursive: true });
    const probe = Bun.file(expandHome(`${config.state_dir}/.doctor`));
    await probe.write("");
    await probe.delete();
    checks.push({ name: "state", ok: true, detail: expandHome(config.state_dir) });
  } catch (error) {
    checks.push({ name: "state", ok: false, detail: String(error) });
  }

  if (config.inference.mode === "local") {
    try {
      mkdirSync(expandHome(config.inference.models_dir), { recursive: true });
      checks.push({ name: "models", ok: true, detail: expandHome(config.inference.models_dir) });
    } catch (error) {
      checks.push({ name: "models", ok: false, detail: String(error) });
    }
  }

  const inferenceFailure = (error: unknown): Pick<DoctorCheck, "detail" | "failure_kind"> =>
    error instanceof RemoteInferenceError
      ? { detail: error.message, failure_kind: error.kind }
      : { detail: "unexpected inference failure", failure_kind: "unexpected" };

  const deployment = describeDeployment(config, environment);
  const lexicalOnlySlim = deployment.image_variant === "slim" && config.inference.mode === "local";
  if (lexicalOnlySlim) {
    checks.push({
      name: "retrieval",
      ok: true,
      detail: "lexical retrieval; Configure remote embeddings for hybrid retrieval",
    });
  } else {
    const clients = createClients(config);
    try {
      const vectors = await clients.embed(["skill router diagnostic"]);
      const actualDimension = vectors[0]?.length ?? 0;
      checks.push({
        name: "embedding",
        ok: actualDimension === embeddingDimension(config),
        detail: `dimension ${actualDimension}`,
      });
    } catch (error) {
      checks.push({ name: "embedding", ok: false, ...inferenceFailure(error) });
    }

    if (clients.rerank) {
      try {
        const scores = await clients.rerank("skill router diagnostic", [
          { skill_id: "doctor", text: "Routes a task to an appropriate skill." },
        ]);
        checks.push({ name: "reranker", ok: scores.length === 1 && Number.isFinite(scores[0]), detail: "one finite score" });
      } catch (error) {
        checks.push({ name: "reranker", ok: false, ...inferenceFailure(error) });
      }
    }
  }

  const inferenceReady = checks.some((check) => check.name === "embedding" && check.ok);
  const rerankerReady = checks.some((check) => check.name === "reranker" && check.ok);
  const coreReady = checks.some((check) => check.name === "vault" && check.ok)
    && checks.some((check) => check.name === "state" && check.ok);
  return {
    ...deployment,
    mode: config.inference.mode,
    capability: !coreReady ? "unavailable" : inferenceReady ? "hybrid" : "lexical-only",
    retrieval_capability: rerankerReady ? "reranked" : inferenceReady ? "hybrid" : "lexical",
    checks,
  };
}
