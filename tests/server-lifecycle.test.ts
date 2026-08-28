import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { insertAudit, openAudit } from "../src/db";
import { configure } from "../src/router-core";
import { readinessState, startServer } from "../src/server";
import type { Config } from "../src/types";

const dirs: string[] = [];

afterEach(() => {
  configure({});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("server lifecycle", () => {
  test("stop is idempotent and marks readiness as stopping", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-server-lifecycle-"));
    dirs.push(root);
    const vault = join(root, "vault");
    const skill = join(vault, "example-skill");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: Example\ndescription: Example routing skill.\n---\nbody");
    const config: Config = {
      vault_path: vault,
      local_vault_paths: [],
      state_dir: join(root, "state"),
      recall: { k_lexical: 20, k_vector: 20, k_rerank: 10 },
      output: { top_k: 10, max_top_k: 50 },
      inference: {
        mode: "local",
        bundle: "gte-small-v1",
        models_dir: join(root, "models"),
        embedding: { model: "Xenova/gte-small", dimension: 3 },
      },
    };
    const clients = { embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])) };
    const handle = await startServer({ transport: "http", port: 0, config, clients });
    await handle.stop();
    await handle.stop();

    expect(readinessState.get().status).toBe("stopping");
  });

  test("prunes stale audit rows once at startup without delaying readiness (AC14)", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-server-lifecycle-prune-"));
    dirs.push(root);
    const vault = join(root, "vault");
    const skill = join(vault, "example-skill");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: Example\ndescription: Example routing skill.\n---\nbody");

    const stateDir = join(root, "state");
    const seedDb = openAudit(stateDir);
    insertAudit(seedDb, {
      ts: "2020-01-01T00:00:00.000Z",
      query: "ancient",
      retrieval: "lexical",
      candidates: [],
      latency_ms: 1,
    });
    seedDb.close();

    const config: Config = {
      vault_path: vault,
      local_vault_paths: [],
      state_dir: stateDir,
      recall: { k_lexical: 20, k_vector: 20, k_rerank: 10 },
      output: { top_k: 10, max_top_k: 50 },
      inference: {
        mode: "local",
        bundle: "gte-small-v1",
        models_dir: join(root, "models"),
        embedding: { model: "Xenova/gte-small", dimension: 3 },
      },
      audit: { retention_days: 1 },
    };
    const clients = { embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])) };
    const handle = await startServer({ transport: "http", port: 0, config, clients });

    expect(readinessState.get().status).toBe("ready");

    // The startup prune trigger is fire-and-forget; give its write a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const checkDb = new Database(join(stateDir, "audit.sqlite3"), { readonly: true });
    const remaining = checkDb.query("SELECT count(*) AS n FROM audit").get() as { n: number };
    checkDb.close();
    expect(remaining.n).toBe(0);

    await handle.stop();
  });
});
