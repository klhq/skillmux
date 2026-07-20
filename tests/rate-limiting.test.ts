import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, metricsRegistry } from "../src/server";
import { configure } from "../src/router-core";
import { loadConfig } from "../src/config";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "skillmux-rate-limit-test-"));
const vaultDir = join(tmp, "vault");
const configPath = join(tmp, "config.toml");
let port: number;

function writeSkill(id: string, description: string) {
  const dir = join(vaultDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nBody of ${id}.\n`,
  );
}

beforeAll(async () => {
  writeSkill("limiter-test-skill", "Matches limiter test queries.");
  writeFileSync(
    configPath,
    [
      `vault_path = "${vaultDir}"`,
      `state_dir = "${join(tmp, "state")}"`,
      `[recall]`,
      `k_lexical = 15`,
      `k_vector = 15`,
      ``,
      `[thresholds]`,
      `match_score = 0.9`,
      `match_margin = 0.2`,
      `candidate_floor = 0.4`,
      `candidate_limit = 5`,
      ``,
      `[inference]`,
      `mode = "remote"`,
      `timeout_ms = 200`,
      ``,
      `[inference.embedding]`,
      `provider = "openai"`,
      `base_url = "http://127.0.0.1:9"`,
      `model = "microsoft/harrier-oss-v1-0.6b"`,
      `dimension = 1024`,
      ``,
      `[inference.reranker]`,
      `provider = "infinity"`,
      `base_url = "http://127.0.0.1:9"`,
      `model = "BAAI/bge-reranker-v2-m3"`,
      ``,
      `[inference.thresholds]`,
      `match_score = 0.9`,
      `match_margin = 0.2`,
      `candidate_floor = 0.4`,
      ``,
      `[server]`,
      `auth_enabled = false`,
      `allowed_origins = ["*"]`,
      ``,
      `[server.rate_limit]`,
      `enabled = true`,
      `requests_per_minute = 2`,
    ].join("\n"),
  );

  process.env.SKILL_ROUTER_CONFIG = configPath;

  const origServe = Bun.serve;
  let capturedPort = 0;
  // @ts-ignore
  Bun.serve = (options: any) => {
    const s = origServe(options);
    capturedPort = s.port!;
    return s;
  };

  configure({});
  await startServer({ transport: "http", port: 0 });

  // @ts-ignore
  Bun.serve = origServe;
  port = capturedPort;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.SKILL_ROUTER_CONFIG;
  configure({});
});

describe("HTTP Rate Limiting Integration (AC3, AC4)", () => {
  test("returns 429 Too Many Requests and rate limit headers", async () => {
    // Request 1: Allowed
    const res1 = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(res1.headers.get("X-RateLimit-Remaining")).toBe("1");
    expect(res1.headers.get("X-RateLimit-Reset")).not.toBeNull();

    // Request 2: Allowed
    const res2 = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("X-RateLimit-Remaining")).toBe("0");

    // Request 3: Rejected
    const res3 = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res3.status).toBe(429);
    expect(res3.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res3.headers.get("Retry-After")).not.toBeNull();
    const retryAfter = Number(res3.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);

    // Verify metrics
    const metricsBody = metricsRegistry.render();
    expect(metricsBody).toContain("skill_router_rate_limits_exceeded_total");
  });
});
