import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

const scriptPath = join(import.meta.dir, "..", "scripts", "download-models.ts");
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function writeConfig(dir: string, content: string): string {
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, content);
  return configPath;
}

describe("download-models script (AC2)", () => {
  test("downloads the configured embedding and rerank models with configured device and dtype", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "skill-router-download-models-"));
    const configPath = writeConfig(
      tmp,
      [
        `[inference]`,
        `mode = "local"`,
        `bundle = "bge-m3-v1"`,
        `models_dir = "${join(tmp, "models")}"`,
        ``,
        `[inference.embedding]`,
        `model = "custom/embed-model"`,
        `dimension = 1536`,
        `device = "cuda"`,
        `dtype = "fp16"`,
        ``,
        `[inference.reranker]`,
        `model = "custom/rerank-model"`,
        `device = "webgpu"`,
        `dtype = "q4"`,
      ].join("\n"),
    );

    const logPath = join(tmp, "pipeline-log.jsonl");

    const proc = Bun.spawn(["bun", "run", scriptPath], {
      cwd: path.dirname(scriptPath),
      env: {
        ...(process.env as Record<string, string>),
        SKILL_ROUTER_CONFIG: configPath,
        MOCK_HF_DOWNLOAD: "true",
        MOCK_HF_LOG_PATH: logPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("custom/embed-model");
    expect(stdout).toContain("custom/rerank-model");

    const entries = (await Bun.file(logPath).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(entries).toEqual([
      {
        embed: { model: "custom/embed-model", device: "cuda", dtype: "fp16" },
        rerank: { model: "custom/rerank-model", device: "webgpu", dtype: "q4" },
      },
    ]);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("uses the versioned local bundle defaults", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "skill-router-download-models-env-"));
    const configPath = writeConfig(
      tmp,
      [
        `[inference]`,
        `mode = "local"`,
        `models_dir = "${join(tmp, "models")}"`,
      ].join("\n"),
    );

    const logPath = join(tmp, "pipeline-log.jsonl");

    const proc = Bun.spawn(["bun", "run", scriptPath], {
      cwd: path.dirname(scriptPath),
      env: {
        ...(process.env as Record<string, string>),
        SKILL_ROUTER_CONFIG: configPath,
        MOCK_HF_DOWNLOAD: "true",
        MOCK_HF_LOG_PATH: logPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Xenova/bge-m3");
    expect(stdout).toContain("onnx-community/bge-reranker-v2-m3-ONNX");

    const entries = (await Bun.file(logPath).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(entries).toEqual([
      {
        embed: { model: "Xenova/bge-m3", device: "cpu", dtype: "q8" },
        rerank: { model: "onnx-community/bge-reranker-v2-m3-ONNX", device: "cpu", dtype: "q8" },
      },
    ]);

    rmSync(tmp, { recursive: true, force: true });
  });
});
