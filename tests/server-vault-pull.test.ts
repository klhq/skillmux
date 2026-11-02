import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSkillRow } from "../src/db-index";
import { configure, getRuntime, resolveSkill } from "../src/router-core";
import { metricsRegistry, startServer } from "../src/server";
import type { Config } from "../src/types";
import { cleanupTempDirs, createRemote } from "./git-remote-fixture";

const roots: string[] = [];

afterEach(() => {
  configure({});
  cleanupTempDirs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function serverConfig(overrides: Partial<Config>): { config: Config; vault: string } {
  const root = mkdtempSync(join(tmpdir(), "skillmux-serve-pull-"));
  roots.push(root);
  const vault = join(root, "vault");
  return {
    vault,
    config: {
      vault_path: vault,
      local_vault_paths: [],
      agents: [],
      state_dir: join(root, "state"),
      recall: { k_lexical: 20, k_vector: 20, k_rerank: 10 },
      output: { top_k: 10, max_top_k: 50 },
      inference: {
        mode: "local",
        bundle: "gte-small-v1",
        models_dir: join(root, "models"),
        embedding: { model: "Xenova/gte-small", dimension: 3 },
      },
      ...overrides,
    },
  };
}

/** The registry is shared by every server in the process, so tests compare against a count taken before they start. */
function failedPulls(metrics: string): number {
  return Number(/skill_router_vault_pull_total\{result="failed"\} (\d+)/.exec(metrics)?.[1] ?? 0);
}

const clients = { embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])) };
const SKILL = "---\nname: Remote Skill\ndescription: Arrived from the vault remote.\n---\nbody\n";

describe("serve with vault_pull_interval", () => {
  test("clones the vault before it indexes, and reports the pull on /metrics", async () => {
    const remote = createRemote();
    remote.publish("remote-skill/SKILL.md", SKILL);
    const { config, vault } = serverConfig({ vault_url: remote.url, vault_pull_interval: "10m" });
    expect(existsSync(vault)).toBe(false);

    const handle = await startServer({ transport: "http", port: 0, config, clients });
    try {
      const { db } = await getRuntime();
      await resolveSkill({ query: "remote skill" });

      expect(getSkillRow(db, "remote-skill")).not.toBeNull();
      const metrics = await (await fetch(`http://127.0.0.1:${handle.port}/metrics`)).text();
      expect(metrics).toContain('skill_router_vault_pull_total{result="cloned"} 1');
      expect(metrics).toContain("skill_router_vault_last_pull_success_timestamp_seconds ");
    } finally {
      await handle.stop();
    }
  });

  test("an unreachable remote does not stop the server from starting", async () => {
    const { config, vault } = serverConfig({
      vault_url: `file://${join(tmpdir(), "skillmux-no-such-remote.git")}`,
      vault_pull_interval: "10m",
    });

    const failedBefore = failedPulls(metricsRegistry.render());

    const handle = await startServer({ transport: "http", port: 0, config, clients });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/metrics`);
      const metrics = await res.text();

      expect(res.status).toBe(200);
      expect(existsSync(vault)).toBe(false);
      expect(failedPulls(metrics)).toBe(failedBefore + 1);
    } finally {
      await handle.stop();
    }
  });
});
