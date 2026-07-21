import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const CLI_PATH = join(process.cwd(), "src/cli.ts");

describe("CLI Integration & Parity (AC1, AC2, AC3, AC11, AC12)", () => {
  const TEST_DIR = join(process.cwd(), ".tmp-test-cli-e2e-" + Math.random().toString(36).slice(2));

  it("context list displays built-in local context", async () => {
    const proc = Bun.spawn(["bun", CLI_PATH, "context", "list"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("local");
  });

  it("context list --json outputs standard JSON envelope", async () => {
    const proc = Bun.spawn(["bun", CLI_PATH, "context", "list", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(envelope.schema_version).toBe(1);
    expect(envelope.ok).toBe(true);
    expect(Array.isArray(envelope.data)).toBe(true);
  });

  it("config show --json outputs source-aware configuration", async () => {
    const proc = Bun.spawn(["bun", CLI_PATH, "config", "show", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(envelope.schema_version).toBe(1);
    expect(envelope.data.effective).toBeDefined();
    expect(envelope.data.sources).toBeDefined();
  });

  it("suggests corrections for mistyped subcommands and returns exit code 2", async () => {
    const proc = Bun.spawn(["bun", CLI_PATH, "conifg"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Did you mean");
  });

  it("completions outputs completion script for bash", async () => {
    const proc = Bun.spawn(["bun", CLI_PATH, "completions", "bash"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("_skillmux_completions");
  });
});
