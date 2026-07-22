import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { startServer, type ServerHandle } from "../src/server";
import { loadConfig } from "../src/config";
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
    expect(caps.calibration).toBe(true);
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
});
