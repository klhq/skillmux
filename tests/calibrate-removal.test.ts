import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { startServer, type ServerHandle } from "../src/server";
import { diagnose } from "../src/doctor";
import { evalVault } from "../src/eval";
import { generateCompletions } from "../src/completions";
import { configure } from "../src/router-core";

describe("PR3 calibration removal public interface", () => {
  let tmp: string;
  let serverHandle: ServerHandle | null = null;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skillmux-cal-rm-test-"));
  });

  afterEach(async () => {
    configure({});
    if (serverHandle) {
      await serverHandle.stop();
      serverHandle = null;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fails with an actionable migration error when [inference.calibration] is in TOML", async () => {
    const configPath = join(tmp, "skillmux.toml");
    const vaultPath = join(tmp, "vault");
    const stateDir = join(tmp, "state");
    writeFileSync(
      configPath,
      `
vault_path = "${vaultPath}"
state_dir = "${stateDir}"

[inference]
mode = "remote"
timeout_ms = 1500

[inference.embedding]
provider = "openai"
endpoint = "http://127.0.0.1:8080/v1/embeddings"
model = "text-embedding-3-small"
dimension = 1536

[inference.calibration]
run_id = "cal_legacy_123"
`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      /inference\.calibration is obsolete in 2.0 and should be deleted/,
    );
  });

  it("does not expose calibration in admin capabilities and returns 404 for old routes", async () => {
    const vaultPath = join(tmp, "vault");
    const stateDir = join(tmp, "state");
    const configPath = join(tmp, "skillmux.toml");
    writeFileSync(
      configPath,
      `
vault_path = "${vaultPath}"
state_dir = "${stateDir}"

[server]
auth_enabled = false
auth_token_env = "SKILLMUX_TOKEN"
allowed_origins = ["*"]

[server.admin]
enabled = true
token_env = "ADMIN_TOKEN"
`,
    );
    process.env.ADMIN_TOKEN = "test-admin-token";
    const config = await loadConfig(configPath);
    serverHandle = await startServer({ transport: "http", port: 0, config });
    const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

    const capsRes = await fetch(`${baseUrl}/admin/v1/capabilities`, {
      headers: { Authorization: "Bearer test-admin-token" },
    });
    expect(capsRes.status).toBe(200);
    const caps = (await capsRes.json()) as any;
    expect("calibration" in caps).toBe(false);

    // Old calibration routes return 404
    for (const path of [
      "/admin/v1/calibrations",
      "/admin/v1/calibrations/run_123",
      "/admin/v1/calibrations/run_123/apply",
    ]) {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: "Bearer test-admin-token" },
      });
      expect(res.status).toBe(404);
    }
  });

  it("does not include calibrate in shell completions", () => {
    for (const shell of ["bash", "zsh", "fish"] as const) {
      const completion = generateCompletions(shell);
      expect(completion).not.toMatch(/\bcalibrate\b/);
    }
  });

  it("leaves a sentinel calibrate.sqlite3 database byte-for-byte unchanged across server startup, doctor, and eval", async () => {
    const vaultPath = join(tmp, "vault");
    const stateDir = join(tmp, "state");
    const skillDir = join(vaultPath, "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: demo-skill
description: Demo skill description
---
# Demo
`,
    );

    // Place sentinel calibrate.sqlite3 with known bytes
    const sentinelPath = join(stateDir, "calibrate.sqlite3");
    const sentinelBytes = Buffer.from("SENTINEL_CALIBRATE_SQLITE3_DATA_DO_NOT_TOUCH_1234567890\n");
    writeFileSync(sentinelPath, sentinelBytes);

    const configPath = join(tmp, "skillmux.toml");
    writeFileSync(
      configPath,
      `
vault_path = "${vaultPath}"
state_dir = "${stateDir}"

[inference]
mode = "local"
bundle = "test"
models_dir = "${join(tmp, "models")}"

[inference.embedding]
model = "embedding.onnx"
dimension = 4

[output]
top_k = 5
max_top_k = 10
`,
    );

    const config = await loadConfig(configPath);

    // 1. Run doctor diagnose
    await diagnose(config);
    expect(readFileSync(sentinelPath)).toEqual(sentinelBytes);

    // 2. Start and stop server
    const sHandle = await startServer({ transport: "http", port: 0, config });
    await sHandle.stop();
    expect(readFileSync(sentinelPath)).toEqual(sentinelBytes);

    // 3. Explicitly configure runtime with deterministic embedding vectors and run eval suite
    configure({
      config,
      clients: {
        embed: async (texts) => texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4])),
      },
    });

    const evalReport = await evalVault([
      {
        query: "demo query",
        relevant_skill_ids: ["demo-skill"],
      },
    ]);
    expect(evalReport.queries).toBe(1);
    expect(evalReport.judged_queries).toBe(1);
    expect(evalReport.unjudged_queries).toBe(0);
    expect(readFileSync(sentinelPath)).toEqual(sentinelBytes);
  });

  it("fails non-zero with a 2.0 migration message when 'skillmux calibrate' is invoked", async () => {
    const proc = Bun.spawn(["bun", "run", "./src/cli.ts", "calibrate", "run"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const combined = `${stdout}\n${stderr}`;
    expect(combined).toMatch(/skillmux eval/);
    expect(combined).toMatch(/threshold calibration/i);
  });
});
