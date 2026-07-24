import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntime } from "../src/router-core";
import { startServer, type ServerHandle } from "../src/server";
import type { Config } from "../src/types";

const dirs: string[] = [];
const ADMIN_TOKEN_ENV = "SKILLMUX_SERVER_WATCHER_ADMIN_TOKEN";
let handle: ServerHandle | undefined;

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(25);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function writeToml(path: string, content: string): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, content);
  renameSync(temporaryPath, path);
}

function configToml(root: string, kLexical: number): string {
  return `vault_path = "${join(root, "vault")}"
state_dir = "${join(root, "state")}"

[recall]
k_lexical = ${kLexical}
k_vector = 20

[thresholds]
candidate_limit = 5

[inference]
mode = "local"
bundle = "gte-small-v1"
models_dir = "${join(root, "models")}"

[inference.embedding]
model = "Xenova/gte-small"
dimension = 3

[server]
auth_enabled = false
auth_token_env = "SKILLMUX_AUTH_TOKEN"
allowed_origins = []

[server.admin]
enabled = true
token_env = "SKILLMUX_SERVER_WATCHER_ADMIN_TOKEN"
`;
}

function configFor(root: string): Config {
  return {
    vault_path: join(root, "vault"),
    local_vault_paths: [],
    state_dir: join(root, "state"),
    recall: { k_lexical: 20, k_vector: 20 },
    thresholds: { candidate_limit: 5 },
    inference: {
      mode: "local",
      bundle: "gte-small-v1",
      models_dir: join(root, "models"),
      embedding: { model: "Xenova/gte-small", dimension: 3 },
    },
    server: {
      auth_enabled: false,
      auth_token_env: "SKILLMUX_AUTH_TOKEN",
      allowed_origins: [],
      hostname: "127.0.0.1",
      admin: { enabled: true, token_env: ADMIN_TOKEN_ENV },
    },
  };
}

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  delete process.env[ADMIN_TOKEN_ENV];
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("server config watcher lifecycle", () => {
  test("applies allowlisted config changes to the active runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-server-config-"));
    dirs.push(root);
    mkdirSync(join(root, "vault"), { recursive: true });
    const configPath = join(root, "config.toml");
    writeToml(configPath, configToml(root, 20));

    handle = await startServer({
      transport: "http",
      port: 0,
      config: configFor(root),
      configPath,
      clients: {
        embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])),
      },
    });

    writeToml(configPath, configToml(root, 10));
    await waitFor(
      async () => (await getRuntime()).config.recall.k_lexical === 10,
    );

    expect((await getRuntime()).config.recall.k_lexical).toBe(10);
    process.env[ADMIN_TOKEN_ENV] = "test-admin-token";
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/admin/v1/config`,
      {
        headers: { Authorization: "Bearer test-admin-token" },
      },
    );
    const status = (await response.json()).runtime;
    expect(status.last_successful_reload_at).toBeString();
    expect(status.last_reload_error).toBeNull();
    expect(status.restart_required_keys).toEqual([]);
  });

  test("keeps the last-known-good runtime for restart-required and invalid changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-server-config-"));
    dirs.push(root);
    mkdirSync(join(root, "vault"), { recursive: true });
    const configPath = join(root, "config.toml");
    writeToml(configPath, configToml(root, 20));

    handle = await startServer({
      transport: "http",
      port: 0,
      config: configFor(root),
      configPath,
      clients: {
        embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])),
      },
    });

    writeToml(
      configPath,
      configToml(root, 20).replace(
        join(root, "vault"),
        join(root, "other-vault"),
      ),
    );
    await waitFor(
      () => handle!.reloadStatus().restart_required_keys.length > 0,
    );
    expect((await getRuntime()).config.vault_path).toBe(join(root, "vault"));
    expect(handle.reloadStatus().restart_required_keys).toEqual(["vault_path"]);

    writeToml(configPath, "this is [not valid toml = {{{");
    await waitFor(() => handle!.reloadStatus().last_reload_error !== null);
    expect((await getRuntime()).config.vault_path).toBe(join(root, "vault"));
    expect(handle.reloadStatus().last_successful_reload_at).toBeNull();
  });

  test("stops the watcher during server shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-server-config-"));
    dirs.push(root);
    mkdirSync(join(root, "vault"), { recursive: true });
    const configPath = join(root, "config.toml");
    writeToml(configPath, configToml(root, 20));

    handle = await startServer({
      transport: "http",
      port: 0,
      config: configFor(root),
      configPath,
      clients: {
        embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])),
      },
    });

    await handle.stop();
    const statusAfterStop = handle.reloadStatus();
    writeToml(configPath, configToml(root, 10));
    await Bun.sleep(500);

    expect(handle.reloadStatus()).toEqual(statusAfterStop);
  });
});
