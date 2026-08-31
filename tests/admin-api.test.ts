import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import packageJson from "../package.json" with { type: "json" };
import { startServer, type ServerHandle } from "../src/server";
import { loadConfig } from "../src/config";
import { insertAudit, insertFetch, openAudit } from "../src/db";
import type { Config } from "../src/types";

describe("Admin HTTP Control Plane (/admin/v1/*) (AC7, AC8, AC9, AC10)", () => {
  let serverHandle: ServerHandle | null = null;
  const adminToken = "test-admin-secret-token";
  const origEnv = { ...process.env };
  const TEST_DIR = join(process.cwd(), ".tmp-test-admin-" + Math.random().toString(36).slice(2));
  const TEST_VAULT = join(TEST_DIR, "vault");
  const TEST_STATE = join(TEST_DIR, "state");

  beforeEach(() => {
    mkdirSync(TEST_VAULT, { recursive: true });
    mkdirSync(TEST_STATE, { recursive: true });
    const testConfigPath = join(TEST_DIR, "config.toml");
    writeFileSync(testConfigPath, `vault_path = "${TEST_VAULT}"\nstate_dir = "${TEST_STATE}"\n`);
    process.env.SKILLMUX_CONFIG = testConfigPath;
    process.env.SKILLMUX_ADMIN_TOKEN = adminToken;
  });

  afterEach(async () => {
    if (serverHandle) {
      await serverHandle.stop();
      serverHandle = null;
    }
    rmSync(TEST_DIR, { recursive: true, force: true });
    process.env = { ...origEnv };
  });

  async function getTestConfig(adminEnabled = true): Promise<Config> {
    const base = await loadConfig();
    return {
      ...base,
      vault_path: TEST_VAULT,
      local_vault_paths: [],
      state_dir: TEST_STATE,
      server: {
        auth_enabled: false,
        auth_token_env: "SKILLMUX_AUTH_TOKEN",
        allowed_origins: [],
        hostname: "127.0.0.1",
        admin: { enabled: adminEnabled, token_env: "SKILLMUX_ADMIN_TOKEN" },
      },
    };
  }

  it("returns 404/403 when server.admin.enabled is false (AC10)", async () => {
    const config = await getTestConfig(false);
    serverHandle = await startServer({ transport: "http", port: 0, config });
    const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    const res = await fetch(`${baseUrl}/admin/v1/capabilities`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect([403, 404]).toContain(res.status);
  });

  it("requires Bearer token matching admin.token_env when admin is enabled (AC10)", async () => {
    const config = await getTestConfig(true);
    serverHandle = await startServer({ transport: "http", port: 0, config });
    const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    // Without header -> 401
    const resNoAuth = await fetch(`${baseUrl}/admin/v1/capabilities`);
    expect(resNoAuth.status).toBe(401);

    // Wrong token -> 401
    const resWrongAuth = await fetch(`${baseUrl}/admin/v1/capabilities`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(resWrongAuth.status).toBe(401);

    // Correct admin token -> 200
    const resOk = await fetch(`${baseUrl}/admin/v1/capabilities`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(resOk.status).toBe(200);
    const caps = await resOk.json();
    expect(caps.config_read).toBe(true);
    expect(caps.config_write).toBe(true);
    expect(caps.calibration).toBeUndefined();
  });

  it("returns 404 for removed calibration routes", async () => {
    const config = await getTestConfig(true);
    serverHandle = await startServer({ transport: "http", port: 0, config });
    const baseUrl = `http://127.0.0.1:${serverHandle.port}`;
    const headers = {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    };

    for (const request of [
      { path: "/admin/v1/calibrations", method: "GET" },
      { path: "/admin/v1/calibrations", method: "POST" },
      { path: "/admin/v1/calibrations/run_example", method: "GET" },
      { path: "/admin/v1/calibrations/run_example/apply", method: "POST" },
    ]) {
      const res = await fetch(`${baseUrl}${request.path}`, {
        method: request.method,
        headers,
      });
      expect(res.status).toBe(404);
    }
  });

  it("serves GET /admin/v1/config with ETag and sources (AC8)", async () => {
    const config = await getTestConfig(true);
    serverHandle = await startServer({ transport: "http", port: 0, config });
    const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    const res = await fetch(`${baseUrl}/admin/v1/config`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeTruthy();
    const data = await res.json();
    expect(data.effective).toBeDefined();
    expect(data.sources).toBeDefined();
    expect(data.active_revision).toBeDefined();
    expect(data.runtime).toMatchObject({
      version: packageJson.version,
      deployment_runtime: "host",
      image_variant: null,
    });
  });

  it("handles PATCH /admin/v1/config with If-Match (AC8)", async () => {
    const config = await getTestConfig(true);
    serverHandle = await startServer({ transport: "http", port: 0, config });
    const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    const getRes = await fetch(`${baseUrl}/admin/v1/config`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const etag = getRes.headers.get("ETag")!;

    // Stale revision -> 409
    const resConflict = await fetch(`${baseUrl}/admin/v1/config`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
        "If-Match": `"stale-etag"`,
      },
      body: JSON.stringify({ changes: { "recall.k_lexical": 25 } }),
    });
    expect(resConflict.status).toBe(409);
    const errData = await resConflict.json();
    expect(errData.error).toBe("CONFIG_REVISION_CONFLICT");

    // Valid revision -> 200
    const resPatch = await fetch(`${baseUrl}/admin/v1/config`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
        "If-Match": etag,
      },
      body: JSON.stringify({ changes: { "recall.k_lexical": 25 } }),
    });
    expect(resPatch.status).toBe(200);
    const patchData = await resPatch.json();
    expect(patchData.ok).toBe(true);
  });

  it("appends one admin_audit row with the changed key, old/new values, and resulting revision on a successful PATCH (AC7)", async () => {
    const config = await getTestConfig(true);
    serverHandle = await startServer({ transport: "http", port: 0, config });
    const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    const getRes = await fetch(`${baseUrl}/admin/v1/config`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const etag = getRes.headers.get("ETag")!;
    const before = (await getRes.json()).effective;

    const resPatch = await fetch(`${baseUrl}/admin/v1/config`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
        "If-Match": etag,
      },
      body: JSON.stringify({ changes: { "recall.k_lexical": 42 } }),
    });
    expect(resPatch.status).toBe(200);
    const patchData = await resPatch.json();

    const auditDb = openAudit(TEST_STATE);
    const rows = auditDb.query("SELECT * FROM admin_audit").all() as any[];
    auditDb.close();

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].changes)).toEqual([
      { key: "recall.k_lexical", old_value: before.recall.k_lexical, new_value: 42 },
    ]);
    expect(rows[0].resulting_revision).toBe(patchData.resulting_revision);
  });

  it("writes no admin_audit row when PATCH is rejected for a stale revision (AC9)", async () => {
    const config = await getTestConfig(true);
    serverHandle = await startServer({ transport: "http", port: 0, config });
    const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    const resConflict = await fetch(`${baseUrl}/admin/v1/config`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
        "If-Match": `"stale-etag"`,
      },
      body: JSON.stringify({ changes: { "recall.k_lexical": 99 } }),
    });
    expect(resConflict.status).toBe(409);

    const auditDb = openAudit(TEST_STATE);
    const rows = auditDb.query("SELECT * FROM admin_audit").all() as any[];
    auditDb.close();

    expect(rows).toHaveLength(0);
  });

  it("writes no admin_audit row when PATCH is rejected because config is externally managed (AC9)", async () => {
    process.env.SKILLMUX_CONFIG_READONLY = "true";
    const config = await getTestConfig(true);
    serverHandle = await startServer({ transport: "http", port: 0, config });
    const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    const res = await fetch(`${baseUrl}/admin/v1/config`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
        "If-Match": `"anything"`,
      },
      body: JSON.stringify({ changes: { "recall.k_lexical": 99 } }),
    });
    expect(res.status).toBe(409);

    const auditDb = openAudit(TEST_STATE);
    const rows = auditDb.query("SELECT * FROM admin_audit").all() as any[];
    auditDb.close();

    expect(rows).toHaveLength(0);
  });

  describe("Bucket B new admin endpoints (AC3-8, AC10)", () => {
    it("POST /admin/v1/audit/prune requires authentication (AC10)", async () => {
      const config = await getTestConfig(true);
      serverHandle = await startServer({ transport: "http", port: 0, config });
      const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

      const resNoAuth = await fetch(`${baseUrl}/admin/v1/audit/prune`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: true }),
      });
      expect(resNoAuth.status).toBe(401);

      const resBadAuth = await fetch(`${baseUrl}/admin/v1/audit/prune`, {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dry_run: true }),
      });
      expect(resBadAuth.status).toBe(401);
    });

    it("POST /admin/v1/audit/prune requires confirm: true when non-dry-run (AC5)", async () => {
      const config = await getTestConfig(true);
      serverHandle = await startServer({ transport: "http", port: 0, config });
      const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

      const res = await fetch(`${baseUrl}/admin/v1/audit/prune`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dry_run: false, confirm: false }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("CONFIRMATION_REQUIRED");
    });

    it("POST /admin/v1/audit/prune performs dry-run and confirmed prune (AC3, AC4)", async () => {
      const config = await getTestConfig(true);
      serverHandle = await startServer({ transport: "http", port: 0, config });
      const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

      const auditDb = openAudit(TEST_STATE);
      insertAudit(auditDb, {
        ts: "2020-01-01T00:00:00.000Z",
        query: "old query",
        retrieval: "lexical",
        candidates: [],
        latency_ms: 5,
      });
      insertAudit(auditDb, {
        ts: new Date().toISOString(),
        query: "fresh query",
        retrieval: "lexical",
        candidates: [],
        latency_ms: 5,
      });
      auditDb.close();

      // Dry run
      const resDry = await fetch(`${baseUrl}/admin/v1/audit/prune`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ older_than: "30d", dry_run: true }),
      });
      expect(resDry.status).toBe(200);
      const dryData = await resDry.json();
      expect(dryData.dry_run).toBe(true);
      expect(dryData.audit_deleted).toBe(1);

      // Verify nothing deleted yet
      const dbAfterDry = openAudit(TEST_STATE);
      expect(dbAfterDry.query("SELECT count(*) as c FROM audit").get()).toEqual({ c: 2 });
      dbAfterDry.close();

      // Confirmed prune
      const resPrune = await fetch(`${baseUrl}/admin/v1/audit/prune`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ older_than: "30d", dry_run: false, confirm: true }),
      });
      expect(resPrune.status).toBe(200);
      const pruneData = await resPrune.json();
      expect(pruneData.dry_run).toBe(false);
      expect(pruneData.audit_deleted).toBe(1);

      const dbAfterPrune = openAudit(TEST_STATE);
      expect(dbAfterPrune.query("SELECT count(*) as c FROM audit").get()).toEqual({ c: 1 });
      dbAfterPrune.close();
    });

    it("POST /admin/v1/eval runs evaluation and returns EvalReport (AC6, AC10)", async () => {
      const config = await getTestConfig(true);
      serverHandle = await startServer({ transport: "http", port: 0, config });
      const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

      const resNoAuth = await fetch(`${baseUrl}/admin/v1/eval`, { method: "POST" });
      expect(resNoAuth.status).toBe(401);

      const res = await fetch(`${baseUrl}/admin/v1/eval`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
      const report = await res.json();
      expect(typeof report.queries).toBe("number");
      expect(typeof report.judged_queries).toBe("number");
      expect(typeof report.unjudged_queries).toBe("number");
      expect(report.lexical).toBeDefined();
      expect(report.hybrid).toBeDefined();
    });

    it("POST /admin/v1/eval/promote returns candidate cases without mutating (AC7, AC10)", async () => {
      const config = await getTestConfig(true);
      const auditDb = openAudit(TEST_STATE);
      insertAudit(auditDb, {
        ts: new Date().toISOString(),
        query: "search data",
        retrieval: "lexical",
        candidates: [{ skill_id: "test-skill", score: 1 }],
        latency_ms: 2,
      });
      const resolveRow = auditDb.query("SELECT id FROM audit WHERE query = 'search data'").get() as { id: number };
      insertFetch(auditDb, {
        ts: new Date().toISOString(),
        skill_id: "test-skill",
        resolve_audit_id: resolveRow.id,
        rank_at_resolve: 1,
      });
      auditDb.close();

      serverHandle = await startServer({ transport: "http", port: 0, config });
      const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

      const resNoAuth = await fetch(`${baseUrl}/admin/v1/eval/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ since: "30d" }),
      });
      expect(resNoAuth.status).toBe(401);

      const resNoSince = await fetch(`${baseUrl}/admin/v1/eval/promote`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(resNoSince.status).toBe(400);

      const res = await fetch(`${baseUrl}/admin/v1/eval/promote`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ since: "30d" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.candidates)).toBe(true);
      expect(data.candidates).toHaveLength(1);
      expect(data.candidates[0]).toEqual({
        query: "search data",
        split: "observed",
        relevant_skill_ids: ["test-skill"],
      });
    });
  });
});
