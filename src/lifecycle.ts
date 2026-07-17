import { expandHome } from "./config";
import type { ReadinessState } from "./readiness";
import { backfillEmbeddings, getRuntime, rebuildIndex } from "./router-core";
import { getVaultMaxMtime } from "./vault";

export async function initializeRuntime(state: ReadinessState): Promise<void> {
  try {
    const { config, db, clients } = await getRuntime();
    const vaultPath = expandHome(config.vault_path);
    const report = await rebuildIndex();
    let embedding: "ready" | "unavailable" = "ready";
    try {
      await backfillEmbeddings();
      await clients.embed(["skill router readiness probe"]);
    } catch {
      embedding = "unavailable";
    }

    let reranker: "not_configured" | "ready" | "unavailable" = "not_configured";
    if (clients.rerank) {
      try {
        await clients.rerank("skill router readiness probe", [
          { skill_id: "readiness", text: "Routes tasks to relevant skills." },
        ]);
        reranker = "ready";
      } catch {
        reranker = "unavailable";
      }
    }

    state.set({
      status: "ready",
      retrieval: reranker === "ready" ? "reranked" : embedding === "ready" ? "hybrid" : "lexical",
      skills: report.indexed,
      index_current: getVaultMaxMtime(vaultPath) >= 0 && db.query("SELECT COUNT(*) AS count FROM skills").get() !== null,
      embedding,
      reranker,
    });
  } catch (error) {
    state.set({
      status: "not_ready",
      retrieval: null,
      skills: 0,
      index_current: false,
      embedding: "unavailable",
      reranker: "not_configured",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
