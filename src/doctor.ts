import { mkdirSync } from "node:fs";
import { createClients } from "./clients";
import { embeddingDimension, expandHome } from "./config";
import type { Config } from "./types";

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
  const vault = Bun.file(expandHome(`${config.vault_path}/.`));
  checks.push({ name: "vault", ok: await vault.exists(), detail: expandHome(config.vault_path) });

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
    const scores = await clients.rerank("skill router diagnostic", [
      { skill_id: "doctor", text: "Routes a task to an appropriate skill." },
    ]);
    checks.push({ name: "reranker", ok: scores.length === 1 && Number.isFinite(scores[0]), detail: "one finite score" });
  } catch (error) {
    checks.push({ name: "inference", ok: false, detail: String(error) });
  }

  const inferenceReady = checks.some((check) => check.name === "embedding" && check.ok)
    && checks.some((check) => check.name === "reranker" && check.ok);
  const coreReady = checks.some((check) => check.name === "vault" && check.ok)
    && checks.some((check) => check.name === "state" && check.ok);
  return {
    mode: config.inference.mode,
    capability: !coreReady ? "unavailable" : inferenceReady ? "hybrid" : "lexical-only",
    checks,
  };
}
