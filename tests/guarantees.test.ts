import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { configure, fetchSkill, getRuntime, rebuildIndex, resolveSkill } from "../src/router-core";
import type { AuditRow, Config } from "../src/types";
import { sha256Hex } from "../src/vault";

const tmp = mkdtempSync(join(tmpdir(), "skillmux-guarantees-"));
const vaultDir = join(tmp, "vault");

function writeSkill(id: string, description: string, files: Record<string, string> = {}) {
  const dir = join(vaultDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nBody of ${id}.\n`,
  );
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
}

async function vaultSnapshot(): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else {
        const stat = statSync(abs);
        const hash = sha256Hex(await Bun.file(abs).bytes());
        snapshot.set(relative(vaultDir, abs), `${stat.mtimeMs}:${hash}`);
      }
    }
  };
  await walk(vaultDir);
  return snapshot;
}

const config: Config = {
  vault_path: vaultDir,
  local_vault_paths: [],
  state_dir: join(tmp, "state"),
  recall: { k_lexical: 15, k_vector: 15 },
  thresholds: { match_score: 0.9, match_margin: 0.2, candidate_floor: 0.4, candidate_limit: 5 },
  inference: {
    mode: "remote",
    timeout_ms: 200,
    embedding: {
      provider: "openai",
      base_url: "http://127.0.0.1:9",
      model: "microsoft/harrier-oss-v1-0.6b",
      dimension: 3,
    },
    reranker: { provider: "infinity", base_url: "http://127.0.0.1:9", model: "BAAI/bge-reranker-v2-m3" },
      thresholds: { match_score: 0.9, match_margin: 0.2, candidate_floor: 0.4 },
  },
};

beforeAll(() => {
  writeSkill("audit-target", "Answers audit log persistence questions.", {
    "references/notes.md": "notes\n",
  });
  writeSkill("bystander", "Completely different topic entirely.");
  configure({
    config,
    clients: {
      embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])),
      rerank: async (_query, docs) =>
        docs.map((d) => (d.skill_id === "audit-target" ? 0.97 : 0.1)),
    },
  });
});

afterAll(() => {
  configure({});
  rmSync(tmp, { recursive: true, force: true });
});

describe("read-only guarantee (AC9)", () => {
  test("index + resolve + fetch leave every vault file's mtime and hash unchanged", async () => {
    const before = await vaultSnapshot();

    await rebuildIndex();
    await resolveSkill({ query: "audit log persistence questions" });
    await resolveSkill({ query: "nothing remotely relevant", forceLexical: true });
    await fetchSkill({ skill_id: "audit-target" });

    const after = await vaultSnapshot();
    expect(after).toEqual(before);
  });
});

describe("stale index entries", () => {
  test("fetch of a deleted-on-disk skill maps to SKILL_NOT_FOUND and drops the stale row", async () => {
    writeSkill("ghost-skill", "Indexed, then deleted from disk before the watcher notices.");
    await rebuildIndex();
    rmSync(join(vaultDir, "ghost-skill"), { recursive: true, force: true });

    await expect(fetchSkill({ skill_id: "ghost-skill" })).rejects.toThrow(/SKILL_NOT_FOUND:/);

    const { db } = await getRuntime();
    const row = db.query("SELECT * FROM skills WHERE skill_id = ?").get("ghost-skill");
    expect(row).toBeNull();
  });
});

describe("sqlite concurrency", () => {
  test("busy_timeout is configured so concurrent writers back off instead of erroring", async () => {
    const { db } = await getRuntime();

    const pragma = db.query("PRAGMA busy_timeout").get() as { timeout: number };

    expect(pragma.timeout).toBeGreaterThanOrEqual(1000);
  });
});

describe("audit log persistence (AC10)", () => {
  test("every resolve_skill call appends a row with query, outcome, candidates and latency", async () => {
    const { db } = await getRuntime();
    const countBefore = (db.query("SELECT count(*) AS n FROM audit").get() as { n: number }).n;

    await resolveSkill({ query: "audit log persistence questions" });

    const rows = db
      .query("SELECT * FROM audit ORDER BY id DESC LIMIT 1")
      .all() as (Omit<AuditRow, "candidates"> & { candidates: string })[];
    const countAfter = (db.query("SELECT count(*) AS n FROM audit").get() as { n: number }).n;

    expect(countAfter).toBe(countBefore + 1);
    const row = rows[0]!;
    expect(row.query).toBe("audit log persistence questions");
    expect(row.outcome).toBe("matched");
    expect(row.retrieval).toBe("reranked");
    expect(row.selected_skill_id).toBe("audit-target");
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    const candidates = JSON.parse(row.candidates) as { skill_id: string; score: number | null }[];
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0]!.skill_id).toBe("audit-target");
    expect(candidates[0]!.score).toBe(0.97);
  });
});
