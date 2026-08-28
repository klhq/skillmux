import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { z } from "zod";
import { configure, fetchSkill, getRuntime, pruneAuditIfDue, rebuildIndex, resolveSkill } from "../src/router-core";
import { createMcpServer } from "../src/server";
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
  recall: { k_lexical: 15, k_vector: 15, k_rerank: 10 },
  output: { top_k: 10, max_top_k: 50 },
  inference: {
    mode: "remote",
    timeout_ms: 200,
    embedding: {
      provider: "openai",
      endpoint: "http://127.0.0.1:9/v1/embeddings",
      model: "microsoft/harrier-oss-v1-0.6b",
      dimension: 3,
    },
    reranker: { adapter: "jina-v1", endpoint: "http://127.0.0.1:9", model: "BAAI/bge-reranker-v2-m3" },
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
  test("every resolve_skill call appends a canonical audit row with query, retrieval, candidates and latency without outcome", async () => {
    const { auditDb: db } = await getRuntime();
    const countBefore = (db.query("SELECT count(*) AS n FROM audit").get() as { n: number }).n;

    await resolveSkill({ query: "audit log persistence questions" });

    const rows = db
      .query("SELECT * FROM audit ORDER BY id DESC LIMIT 1")
      .all() as (Omit<AuditRow, "candidates"> & { candidates: string })[];
    const countAfter = (db.query("SELECT count(*) AS n FROM audit").get() as { n: number }).n;

    expect(countAfter).toBe(countBefore + 1);
    const row = rows[0]!;
    expect(row.query).toBe("audit log persistence questions");
    expect(row.retrieval).toBe("reranked");
    expect((row as any).outcome).toBeUndefined();
    expect((row as any).selected_skill_id).toBeUndefined();
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    const candidates = JSON.parse(row.candidates) as { skill_id: string; score: number | null }[];
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0]!.skill_id).toBe("audit-target");
    expect(candidates[0]!.score).toBe(0.97);
  });

  test("stores only delivered candidates after top_k limiting rather than pre-limit retrieval pool", async () => {
    const { auditDb: db } = await getRuntime();

    const result = await resolveSkill({ query: "audit bystander questions", top_k: 1 });
    expect(result.candidates).toHaveLength(1);

    const rows = db
      .query("SELECT * FROM audit ORDER BY id DESC LIMIT 1")
      .all() as (Omit<AuditRow, "candidates"> & { candidates: string })[];

    const row = rows[0]!;
    const auditCandidates = JSON.parse(row.candidates) as { skill_id: string; score: number | null }[];
    expect(auditCandidates).toHaveLength(1);
    expect(auditCandidates[0]!.skill_id).toBe(result.candidates[0]!.skill_id);
    expect((row as any).outcome).toBeUndefined();
    expect((row as any).selected_skill_id).toBeUndefined();
  });
});

describe("fetch outcome logging (AC5-AC8)", () => {
  test("fetch_skill without a request_id records an uncorrelated fetch (AC6)", async () => {
    const { auditDb: db } = await getRuntime();

    await fetchSkill({ skill_id: "audit-target" });

    const row = db.query("SELECT * FROM fetch ORDER BY id DESC LIMIT 1").get() as {
      ts: string;
      skill_id: string;
      request_id: string | null;
      resolve_audit_id: number | null;
      rank_at_resolve: number | null;
    };

    expect(row.skill_id).toBe("audit-target");
    expect(row.request_id).toBeNull();
    expect(row.resolve_audit_id).toBeNull();
    expect(row.rank_at_resolve).toBeNull();
  });

  test("fetch_skill with a known request_id links to that resolve and records the fetched skill's rank (AC5, AC8)", async () => {
    const { auditDb: db } = await getRuntime();

    const resolved = await resolveSkill({ query: "audit log persistence questions" });
    const resolveRow = db
      .query("SELECT id FROM audit WHERE request_id = ?")
      .get(resolved.request_id) as { id: number };

    await fetchSkill({ skill_id: "audit-target", request_id: resolved.request_id });

    const row = db.query("SELECT * FROM fetch ORDER BY id DESC LIMIT 1").get() as {
      request_id: string | null;
      resolve_audit_id: number | null;
      rank_at_resolve: number | null;
    };

    expect(row.request_id).toBe(resolved.request_id);
    expect(row.resolve_audit_id).toBe(resolveRow.id);
    expect(row.rank_at_resolve).toBe(
      resolved.candidates.find((c) => c.skill_id === "audit-target")!.rank,
    );
  });

  test("fetch_skill with an unknown or malformed request_id succeeds and records an uncorrelated fetch (AC7)", async () => {
    const { auditDb: db } = await getRuntime();

    await expect(
      fetchSkill({ skill_id: "audit-target", request_id: "not-a-real-request-id" }),
    ).resolves.toMatchObject({ skill_id: "audit-target" });

    const row = db.query("SELECT * FROM fetch ORDER BY id DESC LIMIT 1").get() as {
      request_id: string | null;
      resolve_audit_id: number | null;
      rank_at_resolve: number | null;
    };

    expect(row.request_id).toBe("not-a-real-request-id");
    expect(row.resolve_audit_id).toBeNull();
    expect(row.rank_at_resolve).toBeNull();
  });

  test("rank_at_resolve is null when the fetched skill is correlated but absent from the resolve's shortlist (AC8)", async () => {
    const { auditDb: db } = await getRuntime();

    const resolved = await resolveSkill({ query: "audit log persistence questions", top_k: 1 });
    expect(resolved.candidates.some((c) => c.skill_id === "bystander")).toBe(false);

    await fetchSkill({ skill_id: "bystander", request_id: resolved.request_id });

    const row = db.query("SELECT * FROM fetch ORDER BY id DESC LIMIT 1").get() as {
      resolve_audit_id: number | null;
      rank_at_resolve: number | null;
    };

    expect(row.resolve_audit_id).not.toBeNull();
    expect(row.rank_at_resolve).toBeNull();
  });
});

describe("correlation (AC3)", () => {
  test("resolve_skill mints a unique request_id shared with its audit row", async () => {
    const { auditDb: db } = await getRuntime();

    const first = await resolveSkill({ query: "audit log persistence questions" });
    const second = await resolveSkill({ query: "audit bystander questions" });

    expect(first.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second.request_id).not.toBe(first.request_id);

    const row = db
      .query("SELECT request_id FROM audit ORDER BY id DESC LIMIT 1")
      .get() as { request_id: string | null };
    expect(row.request_id).toBe(second.request_id);
  });
});

describe("audit prune scheduling (AC14)", () => {
  afterEach(() => {
    configure({
      config,
      clients: {
        embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])),
        rerank: async (_query, docs) =>
          docs.map((d) => (d.skill_id === "audit-target" ? 0.97 : 0.1)),
      },
    });
  });

  test("prunes on the first call, then skips repeats within 24 hours, then prunes again after 24 hours", async () => {
    configure({
      config: { ...config, audit: { retention_days: 30 } },
      clients: { embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])) },
    });
    const t0 = new Date("2026-08-28T00:00:00.000Z");

    expect(await pruneAuditIfDue(t0)).not.toBeNull();
    expect(await pruneAuditIfDue(new Date(t0.getTime() + 60_000))).toBeNull();
    expect(await pruneAuditIfDue(new Date(t0.getTime() + 24 * 60 * 60 * 1000 + 1))).not.toBeNull();
  });

  test("never prunes when retention_days is 0 (AC12)", async () => {
    configure({
      config: { ...config, audit: { retention_days: 0 } },
      clients: { embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])) },
    });

    expect(await pruneAuditIfDue(new Date())).toBeNull();
  });
});

// Tool inputSchemas are compiled into sampling grammars by constrained
// decoders. llama.cpp caps repetition expansion at MAX_REPETITION_THRESHOLD
// (2000, src/llama-grammar.cpp); a schema above it is rejected at sampler init
// with an opaque "failed to parse grammar", taking down every tool in the
// combined grammar, not just ours. 500 leaves deliberate headroom — other
// decoders (vLLM, Ollama) have their own, undocumented limits.
// See CONTRIBUTING.md, "MCP Tool Schemas (GBNF Safety)".
const SAFE_GBNF_BOUND = 500;
const BOUND_KEYS = ["maxLength", "maxItems", "maxProperties"];

/** The schema an MCP client actually receives — not the Zod object, which
 *  exposes a different, version-dependent shape. */
function wireSchemas(): [string, Record<string, unknown>][] {
  const server = createMcpServer();
  const registered = (server as any)._registeredTools as Record<string, any>;
  return Object.entries(registered).map(([name, tool]) => [
    name,
    z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<string, unknown>,
  ]);
}

/** Literal `{n}` / `{n,}` / `{n,m}` quantifiers in a regex `pattern`. These
 *  compile through the same repetition path as maxLength. Both bounds matter:
 *  llama.cpp checks min_times and max_times independently. */
function quantifierBounds(pattern: string): number[] {
  const out: number[] = [];
  for (const m of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
    out.push(Number(m[1]));
    if (m[2]) out.push(Number(m[2]));
  }
  return out;
}

describe("schema surface invariant (GBNF safety)", () => {
  test("no tool's wire schema carries a numeric bound or regex quantifier above the safe threshold", () => {
    const violations: string[] = [];

    const walk = (node: unknown, path: string, tool: string) => {
      if (node === null || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (BOUND_KEYS.includes(k) && typeof v === "number" && v > SAFE_GBNF_BOUND) {
          violations.push(`${tool}: ${path}.${k} = ${v}`);
        }
        if (k === "pattern" && typeof v === "string") {
          for (const n of quantifierBounds(v)) {
            if (n > SAFE_GBNF_BOUND) violations.push(`${tool}: ${path}.pattern {${n}} in /${v}/`);
          }
        }
        walk(v, `${path}.${k}`, tool);
      }
    };

    for (const [name, schema] of wireSchemas()) walk(schema, "inputSchema", name);

    expect(violations).toEqual([]);
  });

  // Without this, a change to how schemas serialize could leave the walker
  // inspecting an empty or unrecognisable object — passing forever while
  // checking nothing. A safety test that cannot fail is worse than none.
  test("the invariant above is actually inspecting JSON Schema", () => {
    const schemas = wireSchemas();
    expect(schemas.length).toBeGreaterThan(0);

    for (const [name, schema] of schemas) {
      expect(schema.type, `${name} is not an object schema`).toBe("object");
      expect(
        Object.keys((schema.properties ?? {}) as object).length,
        `${name} exposes no properties to inspect`,
      ).toBeGreaterThan(0);
    }

    // fetch_skill's SKILL_ID_PATTERN is the only quantifier we ship; if the
    // walker stops seeing it, pattern coverage has silently regressed.
    const fetchSkill = schemas.find(([n]) => n === "fetch_skill")?.[1];
    const pattern = (fetchSkill?.properties as any)?.skill_id?.pattern;
    expect(pattern, "fetch_skill.skill_id lost its pattern").toBeTypeOf("string");
    expect(quantifierBounds(pattern)).toEqual([1, 127]);
  });
});
