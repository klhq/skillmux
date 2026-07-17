#!/usr/bin/env bun
import { createClients } from "./clients";
import { loadConfig } from "./config";
import { expandHome } from "./config";
import { diagnose } from "./doctor";
import { evalVault } from "./eval";
import { downloadLocalModels } from "./models";
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
  console.log(`lexical recall@3: ${report.lexical.recall_at_3.toFixed(3)}`);
  console.log(`lexical recall@5: ${report.lexical.recall_at_5.toFixed(3)}`);
  console.log(`lexical MRR:      ${report.lexical.mrr.toFixed(3)}`);
  console.log(`hybrid recall@3:  ${report.hybrid.recall_at_3.toFixed(3)}`);
  console.log(`hybrid recall@5:  ${report.hybrid.recall_at_5.toFixed(3)}`);
  console.log(`hybrid MRR:       ${report.hybrid.mrr.toFixed(3)}`);
}

async function runDoctor(): Promise<void> {
  const report = await diagnose(await loadConfig());
  console.log(`inference mode: ${report.mode}`);
  console.log(`routing capability: ${report.capability}`);
  for (const check of report.checks) console.log(`${check.ok ? "ok" : "fail"}: ${check.name} - ${check.detail}`);
  if (report.checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function showConfig(): Promise<void> {
  const config = await loadConfig();
  const inference = config.inference.mode === "local"
    ? { ...config.inference, models_dir: expandHome(config.inference.models_dir) }
    : config.inference;
  console.log(JSON.stringify({ ...config, vault_path: expandHome(config.vault_path), state_dir: expandHome(config.state_dir), inference }, null, 2));
}

async function runModelDownload(): Promise<void> {
  const cacheDir = await downloadLocalModels(await loadConfig());
  console.log(`models ready in ${cacheDir}`);
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
    const handle = await startServer({ transport, port });
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      const timeout = setTimeout(() => process.exit(1), 10_000);
      timeout.unref();
      await handle.stop();
      clearTimeout(timeout);
      process.exit(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    break;
  }
  case "index":
    await runIndex();
    break;
  case "eval":
    await runEval();
    break;
  case "doctor":
    await runDoctor();
    break;
  case "config":
    if (Bun.argv[3] !== "show") throw new Error("usage: skill-router config show");
    await showConfig();
    break;
  case "models":
    if (Bun.argv[3] !== "download") throw new Error("usage: skill-router models download");
    await runModelDownload();
    break;
  default:
    console.error("usage: skill-router <serve|index|eval|doctor|config show|models download> [--transport stdio|http] [--port N]");
    process.exit(2);
}
