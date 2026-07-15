#!/usr/bin/env bun
import { createClients } from "./clients";
import { loadConfig } from "./config";
import { evalVault } from "./eval";
import { backfillEmbeddings, configure, rebuildIndex } from "./router-core";

const [command] = Bun.argv.slice(2);

async function runIndex(): Promise<void> {
  const config = await loadConfig();
  configure({ config, clients: createClients(config) });

  const report = await rebuildIndex((skillId, error) => {
    console.error(`warning: keeping previous index entry for ${skillId}: ${error}`);
  });
  const retainedNote =
    report.retained.length > 0 ? ` (${report.retained.length} retained after parse errors)` : "";
  console.log(`indexed ${report.indexed} skills${retainedNote}`);

  try {
    const backfilled = await backfillEmbeddings();
    console.log(`embeddings: ${backfilled} backfilled`);
  } catch {
    console.log("embeddings: skipped (endpoint unreachable; lexical-only recall until next index)");
  }
}

async function runEval(): Promise<void> {
  const config = await loadConfig();
  configure({ config, clients: createClients(config) });

  let report;
  try {
    report = await evalVault();
  } catch (error) {
    console.error(`eval needs the embedding and rerank endpoints reachable: ${error}`);
    process.exit(1);
  }
  console.log(`holdout queries: ${report.queries}`);
  console.log(`recall@5 lexical-only: ${report.lexical_recall_at_5.toFixed(3)}`);
  console.log(`recall@5 hybrid:       ${report.hybrid_recall_at_5.toFixed(3)}`);
  const s = report.suggested_thresholds;
  console.log(`suggested config.toml [thresholds]:`);
  console.log(`match_score = ${s.match_score.toFixed(3)}`);
  console.log(`match_margin = ${s.match_margin.toFixed(3)}`);
  console.log(`candidate_floor = ${s.candidate_floor.toFixed(3)}`);
}

switch (command) {
  case "serve": {
    const { startServer } = await import("./server");
    const args = Bun.argv.slice(3);
    let transport: "stdio" | "http" = "stdio";
    let port: number | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--transport" && args[i + 1]) {
        transport = args[i + 1] as "stdio" | "http";
        i++;
      } else if (args[i] === "--port" && args[i + 1]) {
        port = parseInt(args[i + 1]!, 10);
        i++;
      }
    }
    await startServer({ transport, port });
    break;
  }
  case "index":
    await runIndex();
    break;
  case "eval":
    await runEval();
    break;
  default:
    console.error("usage: skill-router <serve|index|eval> [--transport stdio|http] [--port N]");
    process.exit(2);
}
