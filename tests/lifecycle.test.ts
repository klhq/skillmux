import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeRuntime } from "../src/lifecycle";
import { ReadinessState } from "../src/readiness";
import { closeRuntime, configure } from "../src/router-core";
import type { Config } from "../src/types";

const dirs: string[] = [];

afterEach(() => {
  closeRuntime();
  configure({});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(root: string): Config {
  return {
    vault_path: join(root, "vault"),
    state_dir: join(root, "state"),
    recall: { k_lexical: 20, k_vector: 20 },
    thresholds: { candidate_limit: 10 },
    inference: {
      mode: "local",
      bundle: "gte-small-v1",
      models_dir: join(root, "models"),
      embedding: { model: "Xenova/gte-small", dimension: 3 },
    },
  };
}

describe("runtime initialization", () => {
  test("reports hybrid readiness after indexing and embedding", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-router-ready-"));
    dirs.push(root);
    const skillDir = join(root, "vault", "example-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: Example\ndescription: Example routing skill.\n---\nbody");
    configure({ config: config(root), clients: { embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])) } });
    const state = new ReadinessState();

    await initializeRuntime(state);

    expect(state.get()).toMatchObject({ status: "ready", retrieval: "hybrid", skills: 1, index_current: true, embedding: "ready" });
  });

  test("reports lexical readiness when embedding is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-router-lexical-ready-"));
    dirs.push(root);
    const skillDir = join(root, "vault", "example-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: Example\ndescription: Example routing skill.\n---\nbody");
    configure({ config: config(root), clients: { embed: async () => { throw new Error("offline"); } } });
    const state = new ReadinessState();

    await initializeRuntime(state);

    expect(state.get()).toMatchObject({ status: "ready", retrieval: "lexical", embedding: "unavailable" });
  });
});
