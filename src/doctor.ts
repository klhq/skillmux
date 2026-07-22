import { existsSync, mkdirSync } from "node:fs";
import { createClients } from "./clients";
import { embeddingDimension, expandHome } from "./config";
import { resolveManifestPath } from "./manifest";
import { readSkillmuxMarker } from "./sync";
import type { Config } from "./types";
import { findShadowedSkills } from "./vault";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  mode: Config["inference"]["mode"];
  capability: "hybrid" | "lexical-only" | "unavailable";
  checks: DoctorCheck[];
}

export async function diagnose(config: Config): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push({ name: "vault", ok: existsSync(expandHome(config.vault_path)), detail: expandHome(config.vault_path) });

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

  try {
    const clients = createClients(config);
    const vectors = await clients.embed(["skill router diagnostic"]);
    const actualDimension = vectors[0]?.length ?? 0;
    checks.push({
      name: "embedding",
      ok: actualDimension === embeddingDimension(config),
      detail: `dimension ${actualDimension}`,
    });
    if (clients.rerank) {
      const scores = await clients.rerank("skill router diagnostic", [
        { skill_id: "doctor", text: "Routes a task to an appropriate skill." },
      ]);
      checks.push({ name: "reranker", ok: scores.length === 1 && Number.isFinite(scores[0]), detail: "one finite score" });
    }
  } catch (error) {
    checks.push({ name: "inference", ok: false, detail: String(error) });
  }

  const inferenceReady = checks.some((check) => check.name === "embedding" && check.ok);
  const coreReady = checks.some((check) => check.name === "vault" && check.ok)
    && checks.some((check) => check.name === "state" && check.ok);
  return {
    mode: config.inference.mode,
    capability: !coreReady ? "unavailable" : inferenceReady ? "hybrid" : "lexical-only",
    checks,
  };
}
