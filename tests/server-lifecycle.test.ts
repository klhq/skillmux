import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const root = mkdtempSync(join(tmpdir(), "skill-router-server-lifecycle-"));
    dirs.push(root);
    const vault = join(root, "vault");
    const skill = join(vault, "example-skill");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: Example\ndescription: Example routing skill.\n---\nbody");
    const config: Config = {
      vault_path: vault,
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
    const clients = { embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])) };
    const handle = await startServer({ transport: "http", port: 0, config, clients });
    await handle.stop();
    await handle.stop();

    expect(readinessState.get().status).toBe("stopping");
  });
});
