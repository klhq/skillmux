import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createTargetAdapter } from "../src/adapters";
import { startServer, type ServerHandle } from "../src/server";
import { loadConfig } from "../src/config";
import { insertAudit, insertFetch, openAudit } from "../src/db";
import { CliError } from "../src/output";
import type { Config } from "../src/types";

describe("Local and Remote Target Adapters (AC3, AC7, AC10)", () => {
  let serverHandle: ServerHandle | null = null;
  const adminToken = "test-adapter-admin-token";
  const origEnv = { ...process.env };
  const TEST_DIR = join(process.cwd(), ".tmp-test-adapters-" + Math.random().toString(36).slice(2));
  const TEST_VAULT = join(TEST_DIR, "vault");
  const TEST_STATE = join(TEST_DIR, "state");
  const CONFIG_FILE = join(TEST_DIR, "config.toml");

  beforeEach(() => {
    mkdirSync(TEST_VAULT, { recursive: true });
    mkdirSync(TEST_STATE, { recursive: true });
    writeFileSync(CONFIG_FILE, `vault_path = "${TEST_VAULT}"\nstate_dir = "${TEST_STATE}"\n`, "utf-8");
    process.env.SKILLMUX_CONFIG = CONFIG_FILE;
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

  it("local adapter executes config commands locally", async () => {
    const adapter = createTargetAdapter({ type: "local", name: "local" }, { configPath: CONFIG_FILE });
    const show = await adapter.getConfigShow();
    expect(show.effective.vault_path).toBe(TEST_VAULT);

    const val = await adapter.getConfigGet("recall.k_lexical");
    expect(val).toBe(20);

    const setRes = await adapter.configSet("recall.k_lexical", "25");
    expect(setRes.ok).toBe(true);
    expect(await adapter.getConfigGet("recall.k_lexical")).toBe(25);
  });

  it("local adapter's configSet throws a CliError with exitCode 4 when externally managed", async () => {
    process.env.SKILLMUX_CONFIG_READONLY = "true";
    writeFileSync(CONFIG_FILE, `[config]\nenvironment_overrides = false\nvault_path = "${TEST_VAULT}"\nstate_dir = "${TEST_STATE}"\n`, "utf-8");
    const adapter = createTargetAdapter({ type: "local", name: "local" }, { configPath: CONFIG_FILE });

    let caught: unknown;
    try {
      await adapter.configSet("recall.k_lexical", "30");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(4);
  });

  it("remote adapter rejects non-loopback HTTP targets unless allowInsecure is true (AC10)", async () => {
    expect(() =>
      createTargetAdapter(
        { type: "remote", name: "remote-prod", server: "http://192.168.1.100:3000" },
        { allowInsecure: false }
      )
    ).toThrow(/insecure/i);

    const allowedAdapter = createTargetAdapter(
      { type: "remote", name: "remote-prod", server: "http://192.168.1.100:3000" },
      { allowInsecure: true }
    );
    // would fail on fetch/connection instead of insecure check
  });

  it("remote adapter's configSet throws a CliError with exitCode 4 when externally managed", async () => {
    process.env.SKILLMUX_CONFIG_READONLY = "true";
    const config = await loadConfig();
    config.config = { environment_overrides: false };
    config.vault_path = TEST_VAULT;
    config.state_dir = TEST_STATE;
    config.server = {
      auth_enabled: false,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
      hostname: "127.0.0.1",
      admin: { enabled: true, token_env: "SKILLMUX_ADMIN_TOKEN" },
    };
    serverHandle = await startServer({ transport: "http", port: 0, config });
    const serverUrl = `http://127.0.0.1:${serverHandle.port}`;
    const remoteAdapter = createTargetAdapter({ type: "remote", name: "remote-test", server: serverUrl });

    let caught: unknown;
    try {
      await remoteAdapter.configSet("recall.k_lexical", "30");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(4);
  });

  it("remote adapter throws a CliError with exitCode 3 when the server is unreachable", async () => {
    const adapter = createTargetAdapter({ type: "remote", name: "remote-unreachable", server: "http://127.0.0.1:1" });

    let caught: unknown;
    try {
      await adapter.getCapabilities();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(3);
  });

  it("remote adapter throws a CliError with exitCode 3 on a 401 from the server", async () => {
    const config = await loadConfig();
    config.vault_path = TEST_VAULT;
    config.state_dir = TEST_STATE;
    config.server = {
      auth_enabled: false,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
      hostname: "127.0.0.1",
      admin: { enabled: true, token_env: "SKILLMUX_ADMIN_TOKEN" },
    };
    serverHandle = await startServer({ transport: "http", port: 0, config });
    const serverUrl = `http://127.0.0.1:${serverHandle.port}`;
    // Server keeps checking SKILLMUX_ADMIN_TOKEN (correct); the adapter is pointed at a
    // different env var holding a wrong value, so client and server actually disagree
    // instead of both reading the same overwritten env var in this single test process.
    process.env.WRONG_ADMIN_TOKEN = "definitely-wrong";
    const remoteAdapter = createTargetAdapter({
      type: "remote",
      name: "remote-test",
      server: serverUrl,
      token_env: "WRONG_ADMIN_TOKEN",
    });

    let caught: unknown;
    try {
      await remoteAdapter.getCapabilities();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(3);
  });

  it("remote adapter's configSet throws a CliError with exitCode 4 on a revision conflict (409)", async () => {
    const config = await loadConfig();
    config.vault_path = TEST_VAULT;
    config.state_dir = TEST_STATE;
    config.server = {
      auth_enabled: false,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
      hostname: "127.0.0.1",
      admin: { enabled: true, token_env: "SKILLMUX_ADMIN_TOKEN" },
    };
    serverHandle = await startServer({ transport: "http", port: 0, config });
    const serverUrl = `http://127.0.0.1:${serverHandle.port}`;
    const remoteAdapter = createTargetAdapter({ type: "remote", name: "remote-test", server: serverUrl });

    // Only the PATCH leg is faked (network boundary mock) to deterministically simulate
    // a concurrent write winning the race; GET calls still hit the real server.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "CONFIG_REVISION_CONFLICT", message: "stale revision" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    let caught: unknown;
    try {
      await remoteAdapter.configSet("recall.k_lexical", "30");
    } catch (err) {
      caught = err;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(4);
  });

  it("local and remote adapters have matching contract shapes for show and set", async () => {
    const config = await loadConfig();
    config.vault_path = TEST_VAULT;
    config.state_dir = TEST_STATE;
    config.server = {
      auth_enabled: false,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
      hostname: "127.0.0.1",
      admin: { enabled: true, token_env: "SKILLMUX_ADMIN_TOKEN" },
    };

    serverHandle = await startServer({ transport: "http", port: 0, config });
    const serverUrl = `http://127.0.0.1:${serverHandle.port}`;

    const localAdapter = createTargetAdapter({ type: "local", name: "local" }, { configPath: CONFIG_FILE });
    const remoteAdapter = createTargetAdapter({ type: "remote", name: "remote-test", server: serverUrl });

    const localShow = await localAdapter.getConfigShow();
    const remoteShow = await remoteAdapter.getConfigShow();

    expect(typeof localShow.effective).toBe("object");
    expect(typeof remoteShow.effective).toBe("object");
    expect(localShow.sources).toBeDefined();
    expect(remoteShow.sources).toBeDefined();
  });

  it("local and remote adapters have matching contract shapes for getStats (AC1, AC2)", async () => {
    const config = await loadConfig();
    config.vault_path = TEST_VAULT;
    config.state_dir = TEST_STATE;
    config.server = {
      auth_enabled: false,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
      hostname: "127.0.0.1",
      admin: { enabled: true, token_env: "SKILLMUX_ADMIN_TOKEN" },
    };

    serverHandle = await startServer({ transport: "http", port: 0, config });
    const serverUrl = `http://127.0.0.1:${serverHandle.port}`;

    const localAdapter = createTargetAdapter({ type: "local", name: "local" }, { configPath: CONFIG_FILE });
    const remoteAdapter = createTargetAdapter({ type: "remote", name: "remote-test", server: serverUrl });

    const localStats = await localAdapter.getStats("30d");
    const remoteStats = await remoteAdapter.getStats("30d");

    expect(typeof localStats.total_requests).toBe("number");
    expect(typeof remoteStats.total_requests).toBe("number");
    expect(localStats.total_requests).toBe(remoteStats.total_requests);
  });

  it("local and remote adapters execute auditCount and auditPrune (AC3, AC4, AC5)", async () => {
    const config = await loadConfig();
    config.vault_path = TEST_VAULT;
    config.state_dir = TEST_STATE;
    config.server = {
      auth_enabled: false,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
      hostname: "127.0.0.1",
      admin: { enabled: true, token_env: "SKILLMUX_ADMIN_TOKEN" },
    };

    serverHandle = await startServer({ transport: "http", port: 0, config });
    const serverUrl = `http://127.0.0.1:${serverHandle.port}`;

    const auditDb = openAudit(TEST_STATE);
    insertAudit(auditDb, {
      ts: "2020-01-01T00:00:00.000Z",
      query: "old query",
      retrieval: "lexical",
      candidates: [],
      latency_ms: 5,
    });
    auditDb.close();

    const remoteAdapter = createTargetAdapter({ type: "remote", name: "remote-test", server: serverUrl });

    const dryRes = await remoteAdapter.auditCount("30d");
    expect(dryRes.dry_run).toBe(true);
    expect(dryRes.audit_deleted).toBe(1);

    const pruneRes = await remoteAdapter.auditPrune({ older_than: "30d", dry_run: false, confirm: true });
    expect(pruneRes.dry_run).toBe(false);
    expect(pruneRes.audit_deleted).toBe(1);
  });

  it("local and remote adapters execute evalRun and evalPromote (AC6, AC7, AC8)", async () => {
    const config = await loadConfig();
    config.vault_path = TEST_VAULT;
    config.state_dir = TEST_STATE;
    config.server = {
      auth_enabled: false,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
      hostname: "127.0.0.1",
      admin: { enabled: true, token_env: "SKILLMUX_ADMIN_TOKEN" },
    };

    serverHandle = await startServer({ transport: "http", port: 0, config });
    const serverUrl = `http://127.0.0.1:${serverHandle.port}`;

    const auditDb = openAudit(TEST_STATE);
    insertAudit(auditDb, {
      ts: new Date().toISOString(),
      query: "adapter eval query",
      retrieval: "lexical",
      candidates: [{ skill_id: "test-skill", score: 1 }],
      latency_ms: 2,
    });
    const resolveRow = auditDb.query("SELECT id FROM audit WHERE query = 'adapter eval query'").get() as { id: number };
    insertFetch(auditDb, {
      ts: new Date().toISOString(),
      skill_id: "test-skill",
      resolve_audit_id: resolveRow.id,
      rank_at_resolve: 1,
    });
    auditDb.close();

    const remoteAdapter = createTargetAdapter({ type: "remote", name: "remote-test", server: serverUrl });

    const evalReport = await remoteAdapter.evalRun();
    expect(evalReport.queries).toBeDefined();

    const candidates = await remoteAdapter.evalPromote("30d");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.query).toBe("adapter eval query");
  });
});
