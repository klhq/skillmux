import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "skillmux-init-e2e-"));
const home = join(root, "home");
const vault = join(root, "vault");
const configPath = join(root, "config.toml");
const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      SKILLMUX_CONFIG: configPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("skillmux init end-to-end", () => {
  test("bootstraps, adopts, seeds, syncs, and reapplies without drift", async () => {
    mkdirSync(join(vault, "review-code"), { recursive: true });
    writeFileSync(
      join(vault, "review-code", "SKILL.md"),
      "---\nname: review-code\ndescription: Reviews code.\n---\n",
    );

    const first = await run([
      "init",
      "--vault", vault,
      "--agent", "claude-code",
      "--core", "review-code",
      "--show-mcp-setup",
      "--yes",
    ]);
    expect(first.exitCode).toBe(0);

    const target = join(home, ".claude", "skills");
    const instructions = join(home, ".claude", "CLAUDE.md");
    const manifest = join(vault, "skillmux.toml");
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(target, ".skillmux"))).toBe(true);
    expect(readFileSync(instructions, "utf8")).toContain("skillmux:discovery:start");
    expect(readFileSync(manifest, "utf8")).toContain('skills = ["review-code"]');
    expect(lstatSync(join(target, "review-code")).isSymbolicLink()).toBe(true);
    expect(first.stdout).not.toContain("next: skillmux sync");

    const sync = await run(["sync"]);
    expect(sync.exitCode).toBe(0);
    expect(lstatSync(join(target, "review-code")).isSymbolicLink()).toBe(true);

    const before = {
      config: readFileSync(configPath, "utf8"),
      manifest: readFileSync(manifest, "utf8"),
      instructions: readFileSync(instructions, "utf8"),
      marker: readFileSync(join(target, ".skillmux"), "utf8"),
    };
    const second = await run([
      "init",
      "--vault", vault,
      "--agent", "claude-code",
      "--core", "review-code",
      "--show-mcp-setup",
      "--yes",
    ]);

    expect(second.exitCode).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(before.config);
    expect(readFileSync(manifest, "utf8")).toBe(before.manifest);
    expect(readFileSync(instructions, "utf8")).toBe(before.instructions);
    expect(readFileSync(join(target, ".skillmux"), "utf8")).toBe(before.marker);
  });

  test("can skip managed instruction files even with MCP setup requested", async () => {
    const result = await run([
      "init",
      "--agent", "codex",
      "--show-mcp-setup",
      "--no-instructions",
      "--yes",
    ]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(false);
  });

  test("writes no instruction files by default without any MCP flag", async () => {
    const result = await run([
      "init",
      "--agent", "antigravity",
      "--yes",
    ]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, ".gemini", "GEMINI.md"))).toBe(false);
  });

  test("suppresses skill materialization and prints next: skillmux sync when --no-sync is passed", async () => {
    const noSyncRoot = mkdtempSync(join(tmpdir(), "skillmux-init-nosync-"));
    const noSyncHome = join(noSyncRoot, "home");
    const noSyncVault = join(noSyncRoot, "vault");
    const noSyncConfig = join(noSyncRoot, "config.toml");

    mkdirSync(join(noSyncVault, "suppressed-skill"), { recursive: true });
    writeFileSync(
      join(noSyncVault, "suppressed-skill", "SKILL.md"),
      "---\nname: suppressed-skill\ndescription: A test skill.\n---\n",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "init",
        "--vault",
        noSyncVault,
        "--agent",
        "claude-code",
        "--core",
        "suppressed-skill",
        "--yes",
        "--no-sync",
      ],
      {
        env: {
          ...(process.env as Record<string, string>),
          HOME: noSyncHome,
          SKILLMUX_CONFIG: noSyncConfig,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    const target = join(noSyncHome, ".claude", "skills");
    expect(existsSync(join(target, ".skillmux"))).toBe(true);
    expect(existsSync(join(target, "suppressed-skill"))).toBe(false);
    expect(stdout).toContain("next: skillmux sync");

    rmSync(noSyncRoot, { recursive: true, force: true });
  });
});

