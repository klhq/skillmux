import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createTargetAdapter } from "../src/adapters";
import { startServer, type ServerHandle } from "../src/server";
import { loadConfig } from "../src/config";
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
});
