import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { computeContextSavings, computeNativeBaseline, nativeListingLine } from "../src/context-savings";
import { insertAudit, insertFetch, openAudit } from "../src/db";
import { MetricsRegistry } from "../src/metrics";
import { renderStatsText, getStats } from "../src/stats";
import { estimateTokens } from "../src/token-estimate";
import { describeToolsForEstimate } from "../src/tool-defs";

const tmp = mkdtempSync(join(tmpdir(), "skillmux-savings-"));
const vaultDir = join(tmp, "vault");
const stateDir = join(tmp, "state");
const configPath = join(tmp, "config.toml");
const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

function writeSkill(id: string, description: string, body = "Body.") {
  mkdirSync(join(vaultDir, id), { recursive: true });
  writeFileSync(join(vaultDir, id, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n\n${body}\n`);
}

const DESCRIPTIONS = {
  "pinned-skill": "Always loaded natively, so it counts on neither side.",
  "mcp-one": "Reached only through the router and listed natively by a native-only client.",
  "mcp-two": "Another router-only skill with a description of ordinary length.",
};

beforeAll(() => {
  mkdirSync(stateDir, { recursive: true });
  for (const [id, description] of Object.entries(DESCRIPTIONS)) writeSkill(id, description, `${id} body `.repeat(40));
  writeFileSync(join(vaultDir, "skillmux.toml"), `[core]\nskills = ["pinned-skill"]\nlimit = 5\n`);
  writeFileSync(configPath, `vault_path = "${vaultDir}"\nstate_dir = "${stateDir}"\nagents = ["claude-code"]\n`);
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("estimateTokens", () => {
  test("counts ASCII at a quarter token and other characters at one", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("你好")).toBe(2);
    expect(estimateTokens("ab你")).toBe(2);
  });
});

describe("native baseline", () => {
  test("counts only the skills that are not pinned", async () => {
    const config = await loadConfig(configPath);
    const baseline = await computeNativeBaseline(config);
    const expected =
      estimateTokens(nativeListingLine("mcp-one", DESCRIPTIONS["mcp-one"])) +
      estimateTokens(nativeListingLine("mcp-two", DESCRIPTIONS["mcp-two"]));
    expect(baseline.unpinned_skill_count).toBe(2);
    expect(baseline.baseline_tokens).toBe(expected);
  });
});

describe("computeContextSavings", () => {
  test("separates session-start numbers, shortlists, and fetched bodies", async () => {
    const config = await loadConfig(configPath);
    const db = openAudit(stateDir);
    try {
      const ts = new Date().toISOString();
      for (const candidates of [[{ skill_id: "mcp-one", score: 0.9 }], []]) {
        insertAudit(db, {
          ts,
          request_id: crypto.randomUUID(),
          query: "q",
          retrieval: "lexical",
          candidates,
          latency_ms: 1,
        });
      }
      insertFetch(db, { ts, skill_id: "mcp-one", request_id: null, resolve_audit_id: null, rank_at_resolve: null });
      insertFetch(db, { ts, skill_id: "mcp-one", request_id: null, resolve_audit_id: null, rank_at_resolve: null });

      const savings = await computeContextSavings(config, db, "1d");
      const baseline = await computeNativeBaseline(config);
      const toolTokens = estimateTokens(describeToolsForEstimate());

      expect(savings.baseline_tokens).toBe(baseline.baseline_tokens);
      expect(savings.tool_definition_tokens).toBe(toolTokens);
      expect(savings.session_start_savings_tokens).toBe(baseline.baseline_tokens - toolTokens);
      expect(savings.resolve_calls).toBe(2);
      expect(savings.shortlist_tokens).toBeGreaterThan(0);
      expect(savings.average_shortlist_tokens).toBe(Math.round(savings.shortlist_tokens / 2));
      // Two fetches of the same body, counted once each and never as overhead.
      expect(savings.fetch_body_tokens).toBeGreaterThan(0);
      expect(savings.fetch_body_tokens % 2).toBe(0);
      expect(savings.method).toContain("30%");

      const text = renderStatsText({ ...getStats(db, "1d"), context_savings: savings });
      expect(text).toContain("context savings (estimated tokens):");
      expect(text).toContain(`saved at each session start: ${savings.session_start_savings_tokens}`);
    } finally {
      db.close();
    }
  });

  test("a window with no activity still reports the session-start numbers", async () => {
    const config = await loadConfig(configPath);
    const emptyState = join(tmp, "empty-state");
    mkdirSync(emptyState, { recursive: true });
    const db = openAudit(emptyState);
    try {
      const savings = await computeContextSavings(config, db, "1d");
      expect(savings.resolve_calls).toBe(0);
      expect(savings.shortlist_tokens).toBe(0);
      expect(savings.average_shortlist_tokens).toBe(0);
      expect(savings.fetch_body_tokens).toBe(0);
      expect(savings.baseline_tokens).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe("/metrics gauge", () => {
  test("exports the baseline only once it is known", () => {
    const registry = new MetricsRegistry();
    expect(registry.render()).not.toContain("skill_router_native_baseline_tokens");
    registry.setNativeBaselineTokens(1234);
    expect(registry.render()).toContain("skill_router_native_baseline_tokens 1234");
    registry.setNativeBaselineTokens(null);
    expect(registry.render()).not.toContain("skill_router_native_baseline_tokens");
  });
});

describe("skillmux report", () => {
  async function report(...args: string[]) {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: tmp, SKILLMUX_CONFIG: configPath };
    const proc = Bun.spawn(["bun", "run", cliPath, "report", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, exitCode };
  }

  test("includes context_savings in --json for the local state", async () => {
    const { stdout, exitCode } = await report("--since", "1d", "--json");
    expect(exitCode).toBe(0);
    const { data } = JSON.parse(stdout);
    expect(data.context_savings.unpinned_skill_count).toBe(2);
    expect(data.context_savings.baseline_tokens).toBeGreaterThan(0);
  });

  test("omits it for --db, which has no vault to measure", async () => {
    const { stdout, exitCode } = await report("--since", "1d", "--db", join(stateDir, "audit.sqlite3"), "--json");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).data.context_savings).toBeUndefined();
  });
});
