import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertAudit } from "../src/db";
import { configure, getRuntime } from "../src/router-core";
import { startServer } from "../src/server";
import type { Config } from "../src/types";

const dirs: string[] = [];

afterEach(() => {
  configure({});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeConfig(root: string, server?: Config["server"]): Config {
  const vault = join(root, "vault");
  const skill = join(vault, "example-skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: Example\ndescription: Example routing skill.\n---\nbody");
  return {
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
    ...(server ? { server } : {}),
  };
}

const clients = { embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])) };

describe("startServer --stats-port (stdio + read-only stats listener)", () => {
  test("refuses --stats-port combined with the http transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-stats-port-"));
    dirs.push(root);
    await expect(
      startServer({ transport: "http", port: 0, statsPort: 0, config: makeConfig(root), clients }),
    ).rejects.toThrow(/--stats-port is not supported with --transport http/);
  });

  test("serves /health and /stats over stdio transport without opening the MCP surface", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-stats-port-"));
    dirs.push(root);
    const config = makeConfig(root);
    const handle = await startServer({ transport: "stdio", statsPort: 0, config, clients });
    expect(handle.statsPort).toBeGreaterThan(0);

    const { auditDb: db } = await getRuntime();
    insertAudit(db, {
      ts: new Date().toISOString(),
      query: "in window",
      retrieval: "reranked",
      candidates: [{ skill_id: "example-skill", score: 0.9 }],
      latency_ms: 5,
    });

    const health = await fetch(`http://127.0.0.1:${handle.statsPort}/health`);
    expect(health.status).toBe(200);

    const stats = await fetch(`http://127.0.0.1:${handle.statsPort}/stats?since=30d`);
    const body = await stats.json();
    expect(stats.status).toBe(200);
    expect(body.total_requests).toBe(1);

    await handle.stop();
    await expect(fetch(`http://127.0.0.1:${handle.statsPort}/health`)).rejects.toThrow();
  });

  test("requires a bearer token on the stats port when server.auth_enabled is true", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-stats-port-"));
    dirs.push(root);
    process.env.TEST_STATS_PORT_TOKEN = "s3cret";
    const config = makeConfig(root, {
      hostname: "127.0.0.1",
      auth_enabled: true,
      auth_token_env: "TEST_STATS_PORT_TOKEN",
      allowed_origins: [],
    });
    const handle = await startServer({ transport: "stdio", statsPort: 0, config, clients });

    const unauthed = await fetch(`http://127.0.0.1:${handle.statsPort}/stats?since=30d`);
    expect(unauthed.status).toBe(401);

    const authed = await fetch(`http://127.0.0.1:${handle.statsPort}/stats?since=30d`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(authed.status).toBe(200);

    const health = await fetch(`http://127.0.0.1:${handle.statsPort}/health`);
    expect(health.status).toBe(200);

    await handle.stop();
    delete process.env.TEST_STATS_PORT_TOKEN;
  });

  test("refuses a non-loopback bind without auth, same as the http transport (SMX-91)", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-stats-port-"));
    dirs.push(root);
    const config = makeConfig(root, {
      hostname: "0.0.0.0",
      auth_enabled: false,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
    });
    await expect(
      startServer({ transport: "stdio", statsPort: 0, config, clients }),
    ).rejects.toThrow(/refusing to bind/);
  });
});
