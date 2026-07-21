import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  addContext,
  getCurrentContext,
  listContexts,
  loadContextConfig,
  removeContext,
  resolveTarget,
  useContext,
  type ContextConfig,
} from "../src/context";

const TEST_DIR = join(process.cwd(), ".tmp-test-context-" + Math.random().toString(36).slice(2));
const CONTEXT_FILE = join(TEST_DIR, "contexts.toml");

describe("Context management & Target resolution (AC1 & AC2)", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    delete process.env.SKILLMUX_CONTEXT;
    delete process.env.SKILLMUX_SERVER;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    process.env = { ...origEnv };
  });

  it("loads default context config when file does not exist", async () => {
    const config = await loadContextConfig(CONTEXT_FILE);
    expect(config.default_context).toBe("local");
    expect(config.contexts.local).toEqual({ server: "local" });
  });

  it("lists contexts including built-in local", async () => {
    const contexts = await listContexts(CONTEXT_FILE);
    expect(contexts).toEqual([
      { name: "local", server: "local", isDefault: true },
    ]);
  });

  it("adds a remote context and sets optional token_env", async () => {
    await addContext("prod", { server: "https://skillmux.example.com", token_env: "PROD_TOKEN" }, CONTEXT_FILE);
    const contexts = await listContexts(CONTEXT_FILE);
    expect(contexts.find((c) => c.name === "prod")).toEqual({
      name: "prod",
      server: "https://skillmux.example.com",
      token_env: "PROD_TOKEN",
      isDefault: false,
    });
  });

  it("refuses to overwrite or remove the reserved local context", async () => {
    await expect(
      addContext("local", { server: "http://localhost:8080" }, CONTEXT_FILE)
    ).rejects.toThrow(/reserved/i);

    await expect(removeContext("local", CONTEXT_FILE)).rejects.toThrow(/reserved/i);
  });

  it("switches current default context with useContext", async () => {
    await addContext("staging", { server: "http://staging:3000" }, CONTEXT_FILE);
    await useContext("staging", CONTEXT_FILE);
    const current = await getCurrentContext(CONTEXT_FILE);
    expect(current.name).toBe("staging");
  });

  it("removes an existing remote context", async () => {
    await addContext("dev", { server: "http://dev:3000" }, CONTEXT_FILE);
    await removeContext("dev", CONTEXT_FILE);
    const contexts = await listContexts(CONTEXT_FILE);
    expect(contexts.find((c) => c.name === "dev")).toBeUndefined();
  });

  it("resolves target according to precedence (AC1)", async () => {
    await addContext("prod", { server: "https://prod:8080", token_env: "PROD_TOKEN" }, CONTEXT_FILE);
    await useContext("prod", CONTEXT_FILE);

    // Precedence 4: default context (prod)
    let target = await resolveTarget({}, CONTEXT_FILE);
    expect(target).toEqual({
      type: "remote",
      name: "prod",
      server: "https://prod:8080",
      token_env: "PROD_TOKEN",
    });

    // Precedence 2: ENV override
    process.env.SKILLMUX_CONTEXT = "local";
    target = await resolveTarget({}, CONTEXT_FILE);
    expect(target.type).toBe("local");

    process.env.SKILLMUX_SERVER = "http://env-server:3000";
    delete process.env.SKILLMUX_CONTEXT;
    target = await resolveTarget({}, CONTEXT_FILE);
    expect(target).toEqual({
      type: "remote",
      name: "custom",
      server: "http://env-server:3000",
    });

    // Precedence 1: Flag override over ENV and default
    target = await resolveTarget({ context: "local" }, CONTEXT_FILE);
    expect(target.type).toBe("local");

    target = await resolveTarget({ server: "http://flag-server:3000" }, CONTEXT_FILE);
    expect(target).toEqual({
      type: "remote",
      name: "custom",
      server: "http://flag-server:3000",
    });
  });

  it("throws error when both --context and --server are supplied at same precedence level", async () => {
    await expect(
      resolveTarget({ context: "local", server: "http://foo:3000" }, CONTEXT_FILE)
    ).rejects.toThrow(/both/i);

    process.env.SKILLMUX_CONTEXT = "local";
    process.env.SKILLMUX_SERVER = "http://foo:3000";
    await expect(resolveTarget({}, CONTEXT_FILE)).rejects.toThrow(/both/i);
  });
});
