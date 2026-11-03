import { describe, expect, test } from "bun:test";
import {
  isMcpRegistrable,
  MCP_PROJECT_REGISTRABLE_AGENTS,
  MCP_REGISTRABLE_AGENTS,
  registerMcpServer,
} from "../src/mcp-registration";

function fakeStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("MCP_REGISTRABLE_AGENTS", () => {
  test("only lists agents with a verified CLI registration command", () => {
    expect(MCP_REGISTRABLE_AGENTS).toEqual(["claude-code", "codex", "pi", "amp"]);
  });

  test("isMcpRegistrable matches the registrable set", () => {
    expect(isMcpRegistrable("claude-code")).toBe(true);
    expect(isMcpRegistrable("codex")).toBe(true);
    expect(isMcpRegistrable("windsurf")).toBe(false);
    expect(isMcpRegistrable("goose")).toBe(false);
  });
});

describe("MCP_PROJECT_REGISTRABLE_AGENTS", () => {
  test("only lists agents whose own CLI has a project MCP scope", () => {
    // codex's mcp add has no --scope flag at all (always global), so only
    // claude-code (--scope project) qualifies here.
    expect(MCP_PROJECT_REGISTRABLE_AGENTS).toEqual(["claude-code"]);
  });
});

describe("registerMcpServer", () => {
  test("runs claude-code's exact verified command", async () => {
    let capturedCmd: string[] = [];
    const result = await registerMcpServer("claude-code", {
      spawn: (cmd) => {
        capturedCmd = cmd;
        return { exited: Promise.resolve(0), stderr: fakeStream("") };
      },
    });
    expect(capturedCmd).toEqual([
      "claude",
      "mcp",
      "add",
      "-s",
      "user",
      "skillmux",
      "--",
      "skillmux",
      "serve",
    ]);
    expect(result).toEqual({ agent: "claude-code", ok: true });
  });

  test("runs codex's exact verified command", async () => {
    let capturedCmd: string[] = [];
    const result = await registerMcpServer("codex", {
      spawn: (cmd) => {
        capturedCmd = cmd;
        return { exited: Promise.resolve(0), stderr: fakeStream("") };
      },
    });
    expect(capturedCmd).toEqual([
      "codex",
      "mcp",
      "add",
      "skillmux",
      "--",
      "skillmux",
      "serve",
    ]);
    expect(result).toEqual({ agent: "codex", ok: true });
  });

  test("reports failure with stderr on a non-zero exit code", async () => {
    const result = await registerMcpServer("claude-code", {
      spawn: () => ({
        exited: Promise.resolve(1),
        stderr: fakeStream("server \"skillmux\" already exists\n"),
      }),
    });
    expect(result).toEqual({
      agent: "claude-code",
      ok: false,
      error: 'server "skillmux" already exists',
    });
  });

  test("reports a clear error when the agent's CLI is not installed", async () => {
    const result = await registerMcpServer("codex", {
      spawn: () => {
        throw new Error("spawn codex ENOENT");
      },
    });
    expect(result).toEqual({
      agent: "codex",
      ok: false,
      error: '"codex" is not installed or not on PATH',
    });
  });

  test("rejects an agent with no known registration command", async () => {
    const result = await registerMcpServer("goose");
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no MCP registration command known for agent "goose"');
  });

  test("runs claude-code's project-scoped command with the project directory as cwd", async () => {
    let capturedCmd: string[] = [];
    let capturedCwd: string | undefined;
    const result = await registerMcpServer("claude-code", {
      scope: "project",
      cwd: "/tmp/some-project",
      spawn: (cmd, opts) => {
        capturedCmd = cmd;
        capturedCwd = opts?.cwd;
        return { exited: Promise.resolve(0), stderr: fakeStream("") };
      },
    });
    expect(capturedCmd).toEqual([
      "claude",
      "mcp",
      "add",
      "-s",
      "project",
      "skillmux",
      "--",
      "skillmux",
      "serve",
    ]);
    expect(capturedCwd).toBe("/tmp/some-project");
    expect(result).toEqual({ agent: "claude-code", ok: true });
  });

  test("rejects codex for project scope since its CLI has no scope flag", async () => {
    const result = await registerMcpServer("codex", { scope: "project" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'no project-scoped MCP registration command known for agent "codex"',
    );
  });
});

describe("registerMcpServer with a remote HTTP endpoint", () => {
  const run = async (agent: "claude-code" | "codex", remote: { url: string; tokenEnv?: string }, scope?: "user" | "project") => {
    let capturedCmd: string[] = [];
    const result = await registerMcpServer(agent, {
      remote,
      scope,
      spawn: (cmd) => {
        capturedCmd = cmd;
        return { exited: Promise.resolve(0), stderr: fakeStream("") };
      },
    });
    return { capturedCmd, result };
  };

  test("registers claude-code over HTTP and references the token variable instead of its value", async () => {
    const { capturedCmd, result } = await run("claude-code", { url: "https://skills.example.com/mcp", tokenEnv: "SKILLMUX_TOKEN" });
    expect(capturedCmd).toEqual([
      "claude", "mcp", "add", "--transport", "http", "-s", "user", "skillmux",
      "https://skills.example.com/mcp", "-H", "Authorization: Bearer ${SKILLMUX_TOKEN}",
    ]);
    expect(result.ok).toBe(true);
  });

  test("puts the header option last, because it is variadic and would swallow the name and URL", async () => {
    const { capturedCmd } = await run("claude-code", { url: "https://skills.example.com/mcp", tokenEnv: "T" });
    expect(capturedCmd.indexOf("-H")).toBeGreaterThan(capturedCmd.indexOf("https://skills.example.com/mcp"));
  });

  test("omits the header when no token variable is given", async () => {
    const { capturedCmd } = await run("claude-code", { url: "http://127.0.0.1:3000/mcp" });
    expect(capturedCmd).toEqual([
      "claude", "mcp", "add", "--transport", "http", "-s", "user", "skillmux", "http://127.0.0.1:3000/mcp",
    ]);
  });

  test("keeps the project scope for claude-code", async () => {
    const { capturedCmd } = await run("claude-code", { url: "https://skills.example.com/mcp" }, "project");
    expect(capturedCmd.slice(5, 7)).toEqual(["-s", "project"]);
  });

  test("registers codex with --url and the token variable name", async () => {
    const { capturedCmd } = await run("codex", { url: "https://skills.example.com/mcp", tokenEnv: "SKILLMUX_TOKEN" });
    expect(capturedCmd).toEqual([
      "codex", "mcp", "add", "skillmux", "--url", "https://skills.example.com/mcp",
      "--bearer-token-env-var", "SKILLMUX_TOKEN",
    ]);
  });

  test("never puts a stdio serve command in an HTTP registration", async () => {
    const { capturedCmd } = await run("codex", { url: "https://skills.example.com/mcp" });
    expect(capturedCmd).not.toContain("serve");
    expect(capturedCmd).not.toContain("--");
  });
});
