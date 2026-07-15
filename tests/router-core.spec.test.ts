import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fetchSkill,
  resolveSkill,
  decideResolveOutcome,
  loadConfig,
  buildAuditRow,
  configure,
} from "../src/router-core";

// Deterministic harness: temp vault + temp config + mocked remote clients.
// The rerank mock keys on query substrings so each contract test lands on the
// intended outcome without a remote host. Assertions below are unchanged from the
// generated suite.
const tmp = mkdtempSync(join(tmpdir(), "skill-router-test-"));
const vaultDir = join(tmp, "vault");
const stateDir = join(tmp, "state");
const configPath = join(tmp, "config.toml");

function writeSkill(id: string, description: string, files: Record<string, string> = {}) {
  const dir = join(vaultDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nFixture body for ${id}.\n`,
  );
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

beforeAll(() => {
  writeSkill(
    "alpha-skill",
    "The one ideal skill for exact routing; covers skills with references and scripts.",
    { "references/notes.md": "notes\n", "scripts/run.sh": "#!/bin/sh\n" },
  );
  writeSkill("beta-skill", "Plausibly overlapping skills; multiple skills may serve this request.");
  writeSkill(
    "gamma-skill",
    "Fallback skills when the reranker endpoint is offline or remote models unavailable.",
  );
  writeSkill("router-core", "Fixture skill for fetch tests.", {
    "references/notes.md": "ref\n",
    "scripts/run.sh": "#!/bin/sh\n",
  });

  writeFileSync(
    configPath,
    [
      `vault_path = "${vaultDir}"`,
      `state_dir = "${stateDir}"`,
      `remote_timeout_ms = 2000`,
      ``,
      `[recall]`,
      `k_lexical = 15`,
      `k_vector = 15`,
      ``,
      `[thresholds]`,
      `match_score = 0.9`,
      `match_margin = 0.2`,
      `candidate_floor = 0.4`,
      ``,
      `[embedding]`,
      `base_url = "http://127.0.0.1:9"`,
      `api_key_env = "SKILL_ROUTER_EMBED_KEY"`,
      `model = "microsoft/harrier-oss-v1-0.6b"`,
      `dimension = 1024`,
      ``,
      `[rerank]`,
      `base_url = "http://127.0.0.1:9"`,
      `model = "BAAI/bge-reranker-v2-m3"`,
      ``,
    ].join("\n"),
  );
  process.env.SKILL_ROUTER_CONFIG = configPath;

  configure({
    clients: {
      embed: async (texts: string[]) => texts.map(() => new Float32Array(1024)),
      rerank: async (query: string, docs: { skill_id: string; text: string }[]) => {
        if (query.includes("exactly one ideal") || query.includes("references and scripts")) {
          return docs.map((d) => (d.skill_id === "alpha-skill" ? 0.95 : 0.1));
        }
        if (query.includes("multiple skills")) {
          return docs.map((_, i) => (i === 0 ? 0.92 : i === 1 ? 0.91 : 0.5));
        }
        return docs.map(() => 0.1);
      },
    },
  });
});

afterAll(() => {
  delete process.env.SKILL_ROUTER_CONFIG;
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveSkill contract", () => {
  test("accepts an object input with required query string", async () => {
    await expect(resolveSkill({ query: "route this task to a skill" })).resolves.toBeDefined();
  });

  test("returns only schema-defined outcome values", async () => {
    const result = await resolveSkill({ query: "find a matching skill" });

    expect(["matched", "ambiguous", "no_match"]).toContain(result.outcome);
  });

  test("matched result includes all required fields with degraded fixed to false", async () => {
    const result = await resolveSkill({ query: "exactly one ideal skill" });

    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") throw new Error("unreachable");
    expect(result.degraded).toBe(false);
    expect(result.skill_id).toMatch(/^[a-z0-9][a-z0-9-]{1,127}$/);
    expect(result.title).toEqual(expect.any(String));
    expect(result.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.score).toEqual(expect.any(Number));
    expect(result.margin).toEqual(expect.any(Number));
    expect(result.margin).toBeGreaterThanOrEqual(0);
    expect(result.body).toEqual(expect.any(String));
    expect(result.body.length).toBeGreaterThan(0);
    expect(Array.isArray(result.files)).toBe(true);
  });

  test("matched result includes supporting file paths only as relative paths", async () => {
    const result = await resolveSkill({ query: "skill with references and scripts" });

    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") throw new Error("unreachable");
    for (const file of result.files) {
      expect(file).toEqual(expect.any(String));
      expect(file.length).toBeGreaterThan(0);
      expect(file.startsWith("/")).toBe(false);
    }
  });

  test("short-circuits and matches exactly on skill_id, title, or alias (First Principles #1)", async () => {
    // 1. exact match on skill_id
    const resId = await resolveSkill({ query: "alpha-skill" });
    expect(resId.outcome).toBe("matched");
    if (resId.outcome !== "matched") throw new Error("unreachable");
    expect(resId.skill_id).toBe("alpha-skill");
    expect(resId.score).toBe(1.0);

    // 2. exact match on title
    const resTitle = await resolveSkill({ query: "router-core" });
    expect(resTitle.outcome).toBe("matched");
    if (resTitle.outcome !== "matched") throw new Error("unreachable");
    expect(resTitle.skill_id).toBe("router-core");
    expect(resTitle.score).toBe(1.0);

    // 3. exact match on alias
    const dir = join(vaultDir, "alias-test-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: Alias Test\ndescription: Test skill with aliases.\naliases:\n  - my-cool-alias\n  - another-alias\n---\n\n# Alias Test\nBody\n`,
    );
    
    const { openIndex, replaceSkills, toSkillRow } = await import("../src/db");
    const { scanVault } = await import("../src/vault");
    const db = openIndex(stateDir);
    const skills = await scanVault(vaultDir);
    replaceSkills(db, skills.map(toSkillRow));

    const resAlias = await resolveSkill({ query: "my-cool-alias" });
    expect(resAlias.outcome).toBe("matched");
    if (resAlias.outcome !== "matched") throw new Error("unreachable");
    expect(resAlias.skill_id).toBe("alias-test-skill");
    expect(resAlias.score).toBe(1.0);
  });


  test("ambiguous result includes 1 to 5 candidates and no body", async () => {
    const result = await resolveSkill({ query: "something plausibly served by multiple skills" });

    expect(result.outcome).toBe("ambiguous");
    if (result.outcome !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates.length).toBeLessThanOrEqual(5);
    expect(result).not.toHaveProperty("body");
    for (const candidate of result.candidates) {
      expect(candidate.skill_id).toMatch(/^[a-z0-9][a-z0-9-]{1,127}$/);
      expect(candidate.title).toEqual(expect.any(String));
      expect(candidate.title.length).toBeGreaterThan(0);
      expect(candidate.description).toEqual(expect.any(String));
      expect(candidate.description.length).toBeGreaterThan(0);
      expect(["number", "object"]).toContain(typeof candidate.rerank_score);
    }
  });

  test("degraded ambiguous result forces every candidate rerank_score to null", async () => {
    const result = await resolveSkill({ query: "fallback when reranker is offline", forceDegraded: true });

    expect(result.outcome).toBe("ambiguous");
    if (result.outcome !== "ambiguous") throw new Error("unreachable");
    expect(result.degraded).toBe(true);
    for (const candidate of result.candidates) {
      expect(candidate.rerank_score).toBeNull();
    }
  });

  test("no_match result includes guidance message and no candidates or body", async () => {
    const result = await resolveSkill({ query: "completely unrelated request with no skill match" });

    expect(result.outcome).toBe("no_match");
    if (result.outcome !== "no_match") throw new Error("unreachable");
    expect(result.message).toEqual(expect.any(String));
    expect(result.message.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("candidates");
  });

  test("degraded lane never returns matched", async () => {
    const result = await resolveSkill({ query: "best possible match but remote models are unavailable", forceDegraded: true });

    expect(result.degraded).toBe(true);
    expect(result.outcome).not.toBe("matched");
  });
});

describe("fetchSkill contract", () => {
  test("returns required fields for an indexed skill", async () => {
    const result = await fetchSkill({ skill_id: "router-core" });

    expect(result.skill_id).toBe("router-core");
    expect(result.title).toEqual(expect.any(String));
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.body).toEqual(expect.any(String));
    expect(result.body.length).toBeGreaterThan(0);
    expect(Array.isArray(result.files)).toBe(true);
  });

  test("fetchSkill files are unique relative paths", async () => {
    const result = await fetchSkill({ skill_id: "router-core" });

    expect(new Set(result.files).size).toBe(result.files.length);
    for (const file of result.files) {
      expect(file.startsWith("/")).toBe(false);
      expect(file.includes("..")).toBe(false);
    }
  });

  test("unknown skill_id rejects with schema-defined SKILL_NOT_FOUND code", async () => {
    await expect(fetchSkill({ skill_id: "missing-skill" })).rejects.toThrow(/SKILL_NOT_FOUND:/);
  });
});

describe("decision logic", () => {
  test("returns matched only when score and margin meet config thresholds", () => {
    const result = decideResolveOutcome({
      degraded: false,
      candidates: [
        { skill_id: "alpha-skill", title: "Alpha", description: "A", rerank_score: 0.92 },
        { skill_id: "beta-skill", title: "Beta", description: "B", rerank_score: 0.61 },
      ],
      thresholds: {
        match_score: 0.9,
        match_margin: 0.2,
        candidate_floor: 0.4,
        candidate_limit: 5,
      },
    });

    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") throw new Error("unreachable");
    expect(result.skill_id).toBe("alpha-skill");
    expect(result.score).toBe(0.92);
    expect(result.margin).toBeCloseTo(0.31);
  });

  test("returns ambiguous when top score passes match_score but margin is below match_margin", () => {
    const result = decideResolveOutcome({
      degraded: false,
      candidates: [
        { skill_id: "alpha-skill", title: "Alpha", description: "A", rerank_score: 0.92 },
        { skill_id: "beta-skill", title: "Beta", description: "B", rerank_score: 0.88 },
      ],
      thresholds: {
        match_score: 0.9,
        match_margin: 0.1,
        candidate_floor: 0.4,
        candidate_limit: 5,
      },
    });

    expect(result.outcome).toBe("ambiguous");
  });

  test("returns ambiguous when at least one candidate meets candidate_floor but matched thresholds are not met", () => {
    const result = decideResolveOutcome({
      degraded: false,
      candidates: [
        { skill_id: "alpha-skill", title: "Alpha", description: "A", rerank_score: 0.55 },
      ],
      thresholds: {
        match_score: 0.9,
        match_margin: 0.2,
        candidate_floor: 0.4,
        candidate_limit: 5,
      },
    });

    expect(result.outcome).toBe("ambiguous");
    if (result.outcome !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates).toHaveLength(1);
  });

  test("returns no_match when no candidate reaches candidate_floor", () => {
    const result = decideResolveOutcome({
      degraded: false,
      candidates: [
        { skill_id: "alpha-skill", title: "Alpha", description: "A", rerank_score: 0.19 },
      ],
      thresholds: {
        match_score: 0.9,
        match_margin: 0.2,
        candidate_floor: 0.4,
        candidate_limit: 5,
      },
    });

    expect(result.outcome).toBe("no_match");
  });

  test("single candidate matched uses margin equal to score", () => {
    const result = decideResolveOutcome({
      degraded: false,
      candidates: [
        { skill_id: "alpha-skill", title: "Alpha", description: "A", rerank_score: 0.93 },
      ],
      thresholds: {
        match_score: 0.9,
        match_margin: 0.9,
        candidate_floor: 0.4,
        candidate_limit: 5,
      },
    });

    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") throw new Error("unreachable");
    expect(result.margin).toBe(0.93);
  });

  test("degraded decision uses only ambiguous or no_match outcomes", () => {
    const result = decideResolveOutcome({
      degraded: true,
      candidates: [
        { skill_id: "alpha-skill", title: "Alpha", description: "A", rerank_score: null },
      ],
      thresholds: {
        match_score: 0.9,
        match_margin: 0.2,
        candidate_floor: 0.4,
        candidate_limit: 5,
      },
    });

    expect(["ambiguous", "no_match"]).toContain(result.outcome);
    expect(result.outcome).not.toBe("matched");
  });

  test("limits candidates to candidate_limit when outcome is ambiguous", () => {
    const result = decideResolveOutcome({
      degraded: false,
      candidates: [
        { skill_id: "a", title: "A", description: "A", rerank_score: 0.8 },
        { skill_id: "b", title: "B", description: "B", rerank_score: 0.7 },
        { skill_id: "c", title: "C", description: "C", rerank_score: 0.6 },
      ],
      thresholds: {
        match_score: 0.9,
        match_margin: 0.3,
        candidate_floor: 0.5,
        candidate_limit: 2,
      },
    });

    expect(result.outcome).toBe("ambiguous");
    if (result.outcome !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map(c => c.skill_id)).toEqual(["a", "b"]);
  });
});

describe("config contract", () => {
  test("reads all schema-required tuning parameters from config without hardcoding", async () => {
    const config = await loadConfig();

    expect(config.vault_path).toEqual(expect.any(String));
    expect(config.state_dir).toEqual(expect.any(String));
    expect(config.recall.k_lexical).toEqual(expect.any(Number));
    expect(config.recall.k_vector).toEqual(expect.any(Number));
    expect(config.thresholds.match_score).toEqual(expect.any(Number));
    expect(config.thresholds.match_margin).toEqual(expect.any(Number));
    expect(config.thresholds.candidate_floor).toEqual(expect.any(Number));
    expect(config.thresholds.candidate_limit).toEqual(expect.any(Number));
    expect(config.embedding.base_url).toMatch(/^https?:\/\//);
    expect(config.embedding.api_key_env).toEqual(expect.any(String));
    expect(config.embedding.model).toBe("microsoft/harrier-oss-v1-0.6b");
    expect(config.embedding.dimension).toBe(1024);
    expect(config.rerank.base_url).toMatch(/^https?:\/\//);
    expect(config.rerank.model).toBe("BAAI/bge-reranker-v2-m3");
    expect(config.remote_timeout_ms).toBeGreaterThanOrEqual(100);
    expect(config.remote_timeout_ms).toBeLessThanOrEqual(30000);
  });
});

describe("zero-loss delivery (AC2)", () => {
  test("re-indexes and delivers fresh bytes when the on-disk file changed after indexing", async () => {
    const before = await fetchSkill({ skill_id: "router-core" });
    const updated = `---\nname: router-core\ndescription: Fixture skill for fetch tests, updated.\n---\n\n# router-core\n\nUpdated body.\n`;
    writeFileSync(join(vaultDir, "router-core", "SKILL.md"), updated);

    const after = await fetchSkill({ skill_id: "router-core" });

    expect(after.body).toBe(updated);
    expect(after.content_sha256).not.toBe(before.content_sha256);
    expect(after.content_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("audit log contract", () => {
  test("builds an audit row with the schema-required fields", () => {
    const row = buildAuditRow({
      id: 1,
      ts: "2026-07-14T21:22:00.000Z",
      query: "find me the best skill",
      outcome: "ambiguous",
      degraded: true,
      candidates: [
        { skill_id: "alpha-skill", score: null },
        { skill_id: "beta-skill", score: null },
      ],
      selected_skill_id: null,
      latency_ms: 12,
    });

    expect(row).toEqual({
      id: 1,
      ts: "2026-07-14T21:22:00.000Z",
      query: "find me the best skill",
      outcome: "ambiguous",
      degraded: true,
      candidates: [
        { skill_id: "alpha-skill", score: null },
        { skill_id: "beta-skill", score: null },
      ],
      selected_skill_id: null,
      latency_ms: 12,
    });
  });
});

describe("on-demand lazy indexing (First Principles #2)", () => {
  test("synchronizes the index before query execution if files changed on disk", async () => {
    const dir = join(vaultDir, "lazy-test-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: Lazy Test Skill\ndescription: A skill created to test on-demand lazy indexing without watcher.\n---\n\n# Lazy Test Skill\nBody\n`,
    );

    // Set timestamps in the future to guarantee detection even on coarse filesystems
    const futureTime = new Date(Date.now() + 5000);
    utimesSync(join(dir, "SKILL.md"), futureTime, futureTime);
    utimesSync(dir, futureTime, futureTime);
    utimesSync(vaultDir, futureTime, futureTime);

    // Call resolveSkill and verify it automatically re-indexes and matches the new skill
    const res = await resolveSkill({ query: "Lazy Test Skill" });
    expect(res.outcome).toBe("matched");
    if (res.outcome !== "matched") throw new Error("unreachable");
    expect(res.skill_id).toBe("lazy-test-skill");
  });
});
