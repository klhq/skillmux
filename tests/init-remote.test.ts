import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCOVERY_PARAGRAPH } from "../src/init";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const SECRET = "tok-supersecret-value-123";

/** An isolated HOME with fake `claude` and `codex` that record the arguments they were called with. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "skillmux-init-remote-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const calls = join(home, "calls.log");
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n{ printf '%s' "${name}"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "${calls}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const run = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const proc = Bun.spawn(["bun", CLI, "init", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_STATE_HOME: join(home, ".state"),
        SKILLMUX_TOKEN: SECRET,
        ...extraEnv,
      },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr };
  };
  const recorded = () =>
    existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line) => line.split("\t")) : [];
  return { home, run, recorded };
}

const URL_ARGS = ["--mcp-url", "https://skills.example.com/mcp", "--mcp-token-env", "SKILLMUX_TOKEN"];

describe("init with a shared HTTP server and no vault", () => {
  test("registers the HTTP endpoint and writes instructions without a config or vault", async () => {
    const { home, run, recorded } = sandbox();
    const { code, stderr } = await run(["--agent", "claude-code", ...URL_ARGS, "--yes"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);

    expect(recorded()).toEqual([
      ["claude", "mcp", "add", "--transport", "http", "-s", "user", "skillmux", "https://skills.example.com/mcp", "-H", "Authorization: Bearer ${SKILLMUX_TOKEN}"],
    ]);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain(DISCOVERY_PARAGRAPH);
    expect(existsSync(join(home, ".config", "skillmux"))).toBe(false);
  });

  test("never writes the token value anywhere", async () => {
    const { home, run, recorded } = sandbox();
    const { stdout, stderr } = await run(["--agent", "claude-code", "--agent", "codex", ...URL_ARGS, "--yes"]);
    const everything = [stdout, stderr, JSON.stringify(recorded()), readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")].join("\n");
    expect(everything).not.toContain(SECRET);
  });

  test("registers codex with --url and the variable name", async () => {
    const { run, recorded } = sandbox();
    const { code } = await run(["--agent", "codex", ...URL_ARGS, "--yes"]);
    expect(code).toBe(0);
    expect(recorded()).toEqual([
      ["codex", "mcp", "add", "skillmux", "--url", "https://skills.example.com/mcp", "--bearer-token-env-var", "SKILLMUX_TOKEN"],
    ]);
  });

  test("--dry-run changes nothing", async () => {
    const { home, run, recorded } = sandbox();
    const { code, stdout } = await run(["--agent", "claude-code", ...URL_ARGS, "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain("https://skills.example.com/mcp");
    expect(recorded()).toEqual([]);
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
  });

  test("refuses to apply without --yes when not interactive", async () => {
    const { home, run, recorded } = sandbox();
    const { code, stderr } = await run(["--agent", "claude-code", ...URL_ARGS]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("--yes");
    expect(recorded()).toEqual([]);
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
  });

  test("prints the HTTP snippet for an agent skillmux cannot register", async () => {
    const { run, recorded } = sandbox();
    const { code, stdout } = await run(["--agent", "opencode", ...URL_ARGS, "--yes"]);
    expect(code).toBe(0);
    expect(recorded()).toEqual([]);
    expect(stdout).toContain('"type": "http"');
    expect(stdout).toContain("Bearer ${SKILLMUX_TOKEN}");
    expect(stdout).not.toContain('"command": "skillmux"');
  });

  test("--json reports a remote-only plan with no vault", async () => {
    const { run } = sandbox();
    const { code, stdout } = await run(["--agent", "claude-code", ...URL_ARGS, "--yes", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(out.data.plan).toMatchObject({ mode: "remote-only", vault_path: null, mcp_url: "https://skills.example.com/mcp", register_mcp_for: ["claude-code"] });
    expect(out.data.result.mcp_registrations).toEqual([{ agent: "claude-code", ok: true }]);
  });

  test("takes the endpoint and token variable from a context", async () => {
    const { home, run, recorded } = sandbox();
    mkdirSync(join(home, ".config", "skillmux"), { recursive: true });
    writeFileSync(
      join(home, ".config", "skillmux", "contexts.toml"),
      'default_context = "local"\n\n[contexts.local]\nserver = "local"\n\n[contexts.prod]\nserver = "https://skills.example.com"\ntoken_env = "SKILLMUX_TOKEN"\n',
    );
    const { code } = await run(["--agent", "claude-code", "--mcp-context", "prod", "--yes"]);
    expect(code).toBe(0);
    expect(recorded()[0]).toContain("https://skills.example.com/mcp");
    expect(recorded()[0]).toContain("Authorization: Bearer ${SKILLMUX_TOKEN}");
  });

  test("rejects bad input before writing anything", async () => {
    const cases: Array<[string[], RegExp]> = [
      [["--mcp-url", "not a url"], /not a URL/],
      [["--mcp-url", "https://u:p@example.com/mcp"], /credentials/],
      [["--mcp-url", "https://example.com/mcp", "--mcp-token-env", SECRET], /environment variable name/],
      [["--mcp-token-env", "SKILLMUX_TOKEN"], /needs --mcp-url/],
      [["--mcp-url", "http://skills.example.com/mcp", "--mcp-token-env", "SKILLMUX_TOKEN"], /plain http/],
      [["--mcp-context", "nope"], /unknown context/],
      [["--mcp-context", "x", "--mcp-url", "https://example.com/mcp"], /cannot be combined/],
    ];
    for (const [flags, message] of cases) {
      const { home, run, recorded } = sandbox();
      const { code, stderr } = await run(["--agent", "claude-code", ...flags, "--yes"]);
      expect(code).toBe(2);
      expect(stderr).toMatch(message);
      expect(stderr).not.toContain(SECRET);
      expect(recorded()).toEqual([]);
      expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
    }
  });
});

describe("init with a shared HTTP server and a local vault", () => {
  test("keeps the vault setup and registers HTTP instead of spawning serve", async () => {
    const { home, run, recorded } = sandbox();
    const vault = join(home, "skills");
    mkdirSync(join(vault, "a-skill"), { recursive: true });
    writeFileSync(join(vault, "a-skill", "SKILL.md"), "---\nname: a-skill\ndescription: test skill\n---\nbody\n");
    const { code, stderr } = await run(["--vault", vault, "--agent", "claude-code", ...URL_ARGS, "--yes", "--no-sync"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(existsSync(join(home, ".config", "skillmux", "config.toml"))).toBe(true);
    const calls = recorded();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--transport");
    expect(calls[0]).not.toContain("serve");
  });
});
