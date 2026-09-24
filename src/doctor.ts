import { existsSync, mkdirSync } from "node:fs";
import { createClients, RemoteInferenceError } from "./clients";
import { embeddingDimension, expandHome, isLoopbackBindHost } from "./config";
import { describeDeployment, type DeploymentIdentity } from "./deployment";
import {
  parseManifest,
  resolveManifestPath,
  resolveSyncSurfaces,
  validateManifest,
  type Manifest,
} from "./manifest";
import { planSyncDrift, readSkillmuxMarker } from "./sync";
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
  // An operator who has already set that env var has made an informed choice, so
  // doctor treats it the same way the server does (ok, not a standing failure) —
  // it doesn't re-litigate a decision the server itself already accepted.
  if (config.server) {
    const hostname = config.server.hostname ?? "127.0.0.1";
    const insecureBindAcknowledged = environment.SKILLMUX_ALLOW_INSECURE_BIND === "true";
    const bindIsSafe = isLoopbackBindHost(hostname) || config.server.auth_enabled || insecureBindAcknowledged;
    checks.push({
      name: "server_bind_posture",
      ok: bindIsSafe,
      detail: !bindIsSafe
        ? `${hostname} is reachable beyond this machine with auth_enabled=false — ` +
          "MCP tools and /stats would be open to anyone who can reach this port; " +
          "set server.auth_enabled=true, bind a loopback hostname, or set SKILLMUX_ALLOW_INSECURE_BIND=true"
        : insecureBindAcknowledged && !isLoopbackBindHost(hostname) && !config.server.auth_enabled
          ? `${hostname}, auth_enabled=false, acknowledged via SKILLMUX_ALLOW_INSECURE_BIND`
          : `${hostname}, auth_enabled=${config.server.auth_enabled}`,
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

  const deployment = describeDeployment(config, environment);
  const vaultPath = expandHome(config.vault_path);
  const manifestPath = resolveManifestPath(vaultPath);
  if (!manifestPath) {
    checks.push({ name: "manifest", ok: true, detail: "not yet initialized" });
  } else {
    try {
      const manifest = parseManifest(await Bun.file(manifestPath).text());
      const localVaultPaths = config.local_vault_paths.map(expandHome);
      validateManifest(manifest, vaultPath, localVaultPaths);
      checks.push({ name: "manifest", ok: true, detail: manifestPath });

      // Agent directories are a local delivery concern: they say which directories on
      // this machine get symlinks. A container serving the MCP surface reads the vault and
      // returns skills; it syncs nothing and owns no agent directory, so planning one there
      // would report drift nobody in that deployment can or should act on.
      if (deployment.runtime === "host") {
        checks.push(...syncDriftChecks(vaultPath, manifest, config.agents, localVaultPaths, environment));
      }
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

/**
 * A valid manifest still says nothing about whether the target directories match it.
 * `skillmux core pin` and `skillmux agent add` now sync on their own, but a manifest
 * pulled in from another machine, a `--no-sync` pin, or a hand-edit can all still leave
 * the two out of step, and nothing else reports that (`outdated` covers a different axis:
 * skills whose upstream moved on).
 */
function syncDriftChecks(
  vaultPath: string,
  manifest: Manifest,
  agents: Config["agents"],
  localVaultPaths: string[],
  environment: Record<string, string | undefined>,
): DoctorCheck[] {
  if (agents.length === 0) {
    return [{
      name: "agents",
      ok: true,
      detail: 'none configured in config.toml, so sync has nothing to do (set agents = [...] if that is not intended)',
    }];
  }
  const drift = planSyncDrift({
    vaultPath,
    targets: resolveSyncSurfaces(manifest, agents, {
      home: environment.HOME,
      codexHome: environment.CODEX_HOME,
    }).map((surface) => ({
      name: surface.id,
      dir: surface.dir,
      projectGroups: surface.projectGroups,
    })),
    localVaultPaths,
    coreSkillIds: manifest.core.skills,
  });
  const checks: DoctorCheck[] = drift.unplannable.map((entry) => ({
    name: `sync_drift:${entry.targetDir}`,
    ok: false,
    detail: `cannot plan a sync for ${entry.targetDir} — ${entry.reason}`,
    failure_kind: "configuration" as const,
  }));
  checks.push({
    name: "sync_drift",
    ok: drift.drifted.length === 0,
    detail:
      drift.drifted.length === 0
        ? "agent directories match the manifest"
        : `${drift.drifted
            .map(
              (entry) =>
                `${entry.targetDir}${entry.group ? ` [project.${entry.group}]` : ""} +${entry.added.length} -${entry.removed.length}`,
            )
            .join("; ")} — run: skillmux sync`,
    failure_kind: drift.drifted.length === 0 ? undefined : "configuration",
  });
  return checks;
}
