import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose } from "../src/doctor";
import { assertSafeBindPosture } from "../src/server";
import { configure } from "../src/router-core";
import { startServer } from "../src/server";
import type { Config } from "../src/types";

describe("assertSafeBindPosture (SMX-91)", () => {
  test("allows a loopback bind with auth disabled", () => {
    expect(() => assertSafeBindPosture("127.0.0.1", false, {})).not.toThrow();
    expect(() => assertSafeBindPosture("localhost", false, {})).not.toThrow();
  });

  test("allows a non-loopback bind when auth is enabled", () => {
    expect(() => assertSafeBindPosture("0.0.0.0", true, {})).not.toThrow();
  });

  test("refuses a non-loopback bind with auth disabled", () => {
    expect(() => assertSafeBindPosture("0.0.0.0", false, {})).toThrow(/refusing to bind/);
  });

  test("SKILLMUX_ALLOW_INSECURE_BIND=true is an explicit escape hatch", () => {
    expect(() =>
      assertSafeBindPosture("0.0.0.0", false, { SKILLMUX_ALLOW_INSECURE_BIND: "true" }),
    ).not.toThrow();
  });
});

describe("startServer bind posture (SMX-91)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    configure({});
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(root: string, server: Config["server"]): Config {
    const vault = join(root, "vault");
    const skill = join(vault, "example-skill");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: Example\ndescription: Example routing skill.\n---\nbody");
    return {
      vault_path: vault,
      local_vault_paths: [],
      state_dir: join(root, "state"),
      recall: { k_lexical: 20, k_vector: 20, k_rerank: 10 },
      output: { top_k: 10, max_top_k: 50 },
      inference: {
        mode: "local",
        bundle: "gte-small-v1",
        models_dir: join(root, "models"),
        embedding: { model: "Xenova/gte-small", dimension: 3 },
      },
      server,
    };
  }

  test("refuses to start over HTTP with a non-loopback hostname and auth disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-bind-posture-"));
    dirs.push(root);
    const config = makeConfig(root, {
      auth_enabled: false,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
      hostname: "0.0.0.0",
    });
    const clients = { embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])) };

    await expect(startServer({ transport: "http", port: 0, config, clients })).rejects.toThrow(
      /refusing to bind/,
    );
  });

  test("starts over HTTP with a non-loopback hostname when auth is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-bind-posture-authed-"));
    dirs.push(root);
    const config = makeConfig(root, {
      auth_enabled: true,
      auth_token_env: "SKILLMUX_AUTH_TOKEN_BIND_POSTURE_TEST",
      allowed_origins: [],
      hostname: "0.0.0.0",
    });
    const clients = { embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])) };

    const handle = await startServer({ transport: "http", port: 0, config, clients });
    await handle.stop();
  });
});

describe("skillmux doctor server_bind_posture check (SMX-91)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(root: string, server: Config["server"]): Config {
    const vault = join(root, "vault");
    mkdirSync(vault, { recursive: true });
    return {
      vault_path: vault,
      local_vault_paths: [],
      state_dir: join(root, "state"),
      recall: { k_lexical: 20, k_vector: 20, k_rerank: 10 },
      output: { top_k: 10, max_top_k: 50 },
      inference: {
        mode: "local",
        bundle: "gte-small-v1",
        models_dir: join(root, "models"),
        embedding: { model: "Xenova/gte-small", dimension: 3 },
      },
      server,
    };
  }

  test("flags a non-loopback hostname with auth disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-doctor-bind-posture-"));
    dirs.push(root);
    const config = makeConfig(root, {
      auth_enabled: false,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
      hostname: "0.0.0.0",
    });

    const report = await diagnose(config, { RUNNING_IN_DOCKER: "true", SKILLMUX_IMAGE_VARIANT: "slim" });

    expect(report.checks.find((check) => check.name === "server_bind_posture")).toMatchObject({
      ok: false,
      failure_kind: "configuration",
    });
  });

  test("passes when auth is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-doctor-bind-posture-ok-"));
    dirs.push(root);
    const config = makeConfig(root, {
      auth_enabled: true,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
      hostname: "0.0.0.0",
    });

    const report = await diagnose(config, { RUNNING_IN_DOCKER: "true", SKILLMUX_IMAGE_VARIANT: "slim" });

    expect(report.checks.find((check) => check.name === "server_bind_posture")).toMatchObject({ ok: true });
  });

  test("passes when the hostname is loopback", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-doctor-bind-posture-loopback-"));
    dirs.push(root);
    const config = makeConfig(root, {
      auth_enabled: false,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
      hostname: "127.0.0.1",
    });

    const report = await diagnose(config, { RUNNING_IN_DOCKER: "true", SKILLMUX_IMAGE_VARIANT: "slim" });

    expect(report.checks.find((check) => check.name === "server_bind_posture")).toMatchObject({ ok: true });
  });
});
