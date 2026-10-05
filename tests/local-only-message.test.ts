import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextSource } from "../src/context";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

async function run(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "skillmux-home-"));
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH!,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".state"),
      ...env,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr, home };
}

function homeWithDefaultContext(): string {
  const home = mkdtempSync(join(tmpdir(), "skillmux-home-"));
  mkdirSync(join(home, ".config", "skillmux"), { recursive: true });
  writeFileSync(
    join(home, ".config", "skillmux", "contexts.toml"),
    'default_context = "prod"\n\n[contexts.local]\nserver = "local"\n\n[contexts.prod]\nserver = "https://prod.example.com"\n',
  );
  return home;
}

describe("contextSource", () => {
  test("flags win over the environment", () => {
    const env = { SKILLMUX_SERVER: "https://e.test" };
    expect(contextSource({ context: "prod" }, env)).toEqual({ kind: "flag", flag: "--context" });
    expect(contextSource({ server: "https://x.test" }, env)).toEqual({ kind: "flag", flag: "--server" });
  });

  test("the environment wins over the default", () => {
    expect(contextSource({}, { SKILLMUX_CONTEXT: "prod" })).toEqual({
      kind: "env",
      variable: "SKILLMUX_CONTEXT",
    });
    expect(contextSource({}, { SKILLMUX_SERVER: "https://e.test" })).toEqual({
      kind: "env",
      variable: "SKILLMUX_SERVER",
    });
  });

  test("with no flag or variable the target is the default context", () => {
    expect(contextSource({}, {})).toEqual({ kind: "default" });
  });
});

describe("local-only rejection names where the target came from", () => {
  test("a --server flag", async () => {
    const { code, stderr } = await run(["install", "x", "--server", "https://example.test:3000"]);
    expect(code).toBe(2);
    const lines = stderr.trim().split("\n");
    expect(lines[0]).toBe(
      "error: `install` operates on the local vault only; --context/--server isn't supported here.",
    );
    expect(lines[1]).toBe("The target https://example.test:3000 came from the --server flag.");
    expect(lines[2]).toBe("To run it on this machine, drop --server or pass --context local.");
  });

  test("an environment variable", async () => {
    const { stderr } = await run(["sync"], { SKILLMUX_SERVER: "https://e.test" });
    expect(stderr).toContain("The target https://e.test came from the SKILLMUX_SERVER environment variable.");
    expect(stderr).toContain("unset SKILLMUX_SERVER or pass --context local");
  });

  test("a default context the user never typed", async () => {
    const home = homeWithDefaultContext();
    const proc = Bun.spawn(["bun", CLI, "sync"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH!, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stderr).toContain(
      'The target "prod" (https://prod.example.com) came from the default context in ~/.config/skillmux/contexts.toml.',
    );
    expect(stderr).toContain('"skillmux context use local"');
  });

  test("--json carries the target and its source", async () => {
    const { code, stdout } = await run(["skill", "which", "a", "--server", "https://x.test", "--json"]);
    expect(code).toBe(2);
    const { error } = JSON.parse(stdout);
    expect(error.code).toBe("REMOTE_CONTEXT_UNSUPPORTED");
    expect(error.details).toMatchObject({
      rejected_command: "skill which",
      target: { name: "custom", server: "https://x.test" },
      source: { kind: "flag", flag: "--server" },
    });
  });

  test("--context local really is an escape hatch", async () => {
    const home = homeWithDefaultContext();
    const proc = Bun.spawn(["bun", CLI, "sync", "--context", "local", "--dry-run"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH!, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    });
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    expect(stderr).not.toContain("operates on the local vault only");
  });
});
